/* hlsCache.js — gestión del caché de streams HLS ya generados.

   Cada episodio tiene un ID estable (hash corto de su ruta relativa
   dentro de videos/) que nombra su carpeta dentro de cache/hls/<id>/.
   Ahí viven playlist.m3u8 + los segmentos .ts. Este módulo NO genera
   los streams (eso es trabajo de transcode.js) — solo resuelve rutas,
   trackea el último acceso, decide si un stream ya está listo, y
   expulsa lo menos usado cuando el caché supera el límite de tamaño. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_ROOT = path.join(__dirname, 'cache', 'hls');
const MAX_CACHE_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB por defecto

/* Coordinación de jobs en progreso: id -> {status:'processing'|'error',
   error?, process?}. Vive en memoria (se pierde si el servidor se
   reinicia, lo cual está bien — un job a medias se retoma desde cero
   la próxima vez que se pida ese episodio). */
const jobs = new Map();

function idFor(relPath) {
  return crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 16);
}

function dirFor(id) {
  return path.join(CACHE_ROOT, id);
}

function playlistPathFor(id) {
  return path.join(dirFor(id), 'playlist.m3u8');
}

function ensureDir(id) {
  fs.mkdirSync(dirFor(id), { recursive: true });
}

function touchAccess(id) {
  try { fs.writeFileSync(path.join(dirFor(id), '.lastaccess'), String(Date.now())); }
  catch (e) { /* no crítico */ }
}

function lastAccessOf(dir) {
  try { return parseInt(fs.readFileSync(path.join(dir, '.lastaccess'), 'utf8'), 10) || 0; }
  catch (e) {
    try { return fs.statSync(dir).mtimeMs; } catch (e2) { return 0; }
  }
}

function isReady(id) {
  const p = playlistPathFor(id);
  if (!fs.existsSync(p)) return false;
  try { return fs.readFileSync(p, 'utf8').includes('#EXT-X-ENDLIST'); }
  catch (e) { return false; }
}

function hasAnySegments(id) {
  const dir = dirFor(id);
  if (!fs.existsSync(dir)) return false;
  try { return fs.readdirSync(dir).some(f => f.endsWith('.ts')); }
  catch (e) { return false; }
}

/* Estado combinado: primero mira si hay un job activo en memoria
   (fuente de verdad más reciente); si no, infiere del disco (útil tras
   reiniciar el servidor con un caché ya parcialmente generado). */
function getStatus(id) {
  const job = jobs.get(id);
  if (job) {
    if (job.status === 'error') return { status: 'error', error: job.error };
    if (job.status === 'processing') return { status: 'processing' };
  }
  if (isReady(id)) return { status: 'ready' };
  if (hasAnySegments(id)) return { status: 'processing' };
  return { status: 'idle' };
}

function segmentPath(id, segmentName) {
  return path.join(dirFor(id), segmentName);
}

function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return 0; }
  for (const f of entries) {
    try { total += fs.statSync(path.join(dir, f)).size; } catch (e) { /* archivo pudo borrarse en paralelo */ }
  }
  return total;
}

/* Expulsión tipo LRU: si el caché total supera MAX_CACHE_BYTES, borra
   las carpetas menos usadas recientemente hasta volver a estar bajo el
   límite. Nunca toca una carpeta con un job activo (processing). */
function enforceCacheLimit() {
  let ids;
  try { ids = fs.readdirSync(CACHE_ROOT); } catch (e) { return; }

  const entries = ids
    .filter(id => !jobs.has(id) || jobs.get(id).status !== 'processing')
    .map(id => {
      const dir = dirFor(id);
      return { id, dir, size: dirSizeBytes(dir), lastAccess: lastAccessOf(dir) };
    });

  let total = entries.reduce((sum, e) => sum + e.size, 0);
  // sumar también el tamaño de las carpetas EN uso (cuentan para el total,
  // aunque no sean candidatas a borrar)
  for (const id of ids) {
    if (jobs.has(id) && jobs.get(id).status === 'processing') {
      total += dirSizeBytes(dirFor(id));
    }
  }
  if (total <= MAX_CACHE_BYTES) return;

  entries.sort((a, b) => a.lastAccess - b.lastAccess); // más viejo primero
  for (const e of entries) {
    if (total <= MAX_CACHE_BYTES) break;
    try {
      fs.rmSync(e.dir, { recursive: true, force: true });
      total -= e.size;
    } catch (err) { /* si falla borrar una carpeta puntual, seguir con las demás */ }
  }
}

module.exports = {
  CACHE_ROOT, MAX_CACHE_BYTES, jobs,
  idFor, dirFor, playlistPathFor, ensureDir, touchAccess,
  isReady, hasAnySegments, getStatus, segmentPath, enforceCacheLimit
};
