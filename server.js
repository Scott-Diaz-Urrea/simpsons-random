/* Servidor local de streaming — Randomizer de Episodios (modo servidor).

   Arquitectura: cada episodio se sirve por HLS (.m3u8 + segmentos .ts),
   generado bajo demanda por ffmpeg (probe.js decide remux vs transcode,
   transcode.js genera, hlsCache.js administra el caché en disco) — ver
   README.md para el detalle completo. El archivo original SOLO se lee,
   nunca se escribe/renombra/borra.

   ADVERTENCIA DE SEGURIDAD: este servidor no tiene autenticación propia.
   Está pensado para correr solo dentro de una red de confianza (tu WiFi
   de casa, o una red privada tipo Tailscale) — nunca lo expongas
   directo a internet (sin port-forwarding ni túneles públicos), porque
   cualquiera que alcance el puerto podría ver/descargar los videos. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { probe } = require('./probe.js');
const { startJob } = require('./transcode.js');
const cache = require('./hlsCache.js');
const watched = require('./watched.js');

const PORT = process.env.PORT || 8090;
const ROOT = __dirname;
const VIDEOS_DIR = path.join(ROOT, 'videos');
const VIDEO_EXT = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
const SEGMENT_NAME_RE = /^seg_\d{5}\.ts$/;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8'
};

/* id (hash corto y estable de la ruta relativa) -> ruta relativa real
   dentro de videos/. Se reconstruye cada vez que se pide /api/episodes,
   y también bajo demanda si llega un id que no está en el mapa (p.ej.
   tras reiniciar el servidor con un link ya guardado). */
let idToRelPath = new Map();

function walkVideos(dir, baseDir) {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkVideos(full, baseDir));
    } else if (VIDEO_EXT.includes(path.extname(entry.name).toLowerCase())) {
      const rel = path.relative(baseDir, full).split(path.sep).join('/');
      out.push({ name: entry.name, path: rel });
    }
  }
  return out;
}

/* Misma lógica de reconocimiento de nombre que app.js, portada a Node. */
function parseEpisodeInfo(entry) {
  const base = entry.name.replace(/\.[^.]+$/, '');
  let season = null, episode = null;

  let m = base.match(/[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})/);
  if (m) { season = parseInt(m[1], 10); episode = parseInt(m[2], 10); }

  if (season === null) {
    m = base.match(/\b(\d{1,2})x(\d{1,3})\b/);
    if (m) { season = parseInt(m[1], 10); episode = parseInt(m[2], 10); }
  }

  if (season === null) {
    const seasonMatch = entry.path.match(/(?:temporada|season)\s*(\d{1,2})/i);
    const epMatch = base.match(/(?:cap[ií]tulo|episodio|episode|ep)\s*\.?\s*(\d{1,3})/i) || base.match(/\b(\d{1,3})\b/);
    if (seasonMatch) season = parseInt(seasonMatch[1], 10);
    if (epMatch) episode = parseInt(epMatch[1], 10);
  }

  const title = (season != null && episode != null)
    ? 'Temporada ' + season + ', Episodio ' + episode
    : base;

  return { name: entry.name, path: entry.path, season, episode, title };
}

function compareEpisodes(a, b) {
  if (a.season != null && b.season != null && a.season !== b.season) return a.season - b.season;
  if (a.season != null && b.season != null && a.episode !== b.episode) return (a.episode || 0) - (b.episode || 0);
  if (a.season == null && b.season != null) return 1;
  if (a.season != null && b.season == null) return -1;
  return a.path.localeCompare(b.path);
}

function rebuildIndex() {
  const found = walkVideos(VIDEOS_DIR, VIDEOS_DIR).map(parseEpisodeInfo);
  found.sort(compareEpisodes);
  idToRelPath = new Map();
  for (const ep of found) idToRelPath.set(cache.idFor(ep.path), ep.path);
  return found;
}

/* Resuelve un id a {relPath, sourcePath}, reconstruyendo el índice una
   vez si hace falta (servidor recién reiniciado, link guardado viejo).
   Valida que la ruta resuelta quede dentro de VIDEOS_DIR. */
function resolveId(id) {
  let relPath = idToRelPath.get(id);
  if (!relPath) { rebuildIndex(); relPath = idToRelPath.get(id); }
  if (!relPath) return null;
  const sourcePath = path.normalize(path.join(VIDEOS_DIR, relPath));
  if (!sourcePath.startsWith(VIDEOS_DIR)) return null;
  return { relPath, sourcePath };
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const safePath = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('No encontrado'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* Dispara (si hace falta) el procesamiento de un episodio y devuelve su
   estado actual — llamada tanto por /api/status/:id como internamente
   antes de servir el playlist. */
async function ensureJobStarted(id, sourcePath) {
  let status = cache.getStatus(id);
  if (status.status !== 'idle') return status;

  const info = await probe(sourcePath, id);
  if (!info.ok) {
    cache.jobs.set(id, { status: 'error', error: info.error });
    return { status: 'error', error: info.error };
  }
  startJob(id, sourcePath, { videoOk: info.videoOk, audioOk: info.audioOk });
  return cache.getStatus(id);
}

async function handleStatus(req, res, id) {
  const resolved = resolveId(id);
  if (!resolved) { sendJSON(res, 404, { status: 'error', error: 'Episodio no encontrado.' }); return; }
  cache.touchAccess(id);
  const status = await ensureJobStarted(id, resolved.sourcePath);
  const hasPlaylist = fs.existsSync(cache.playlistPathFor(id));
  sendJSON(res, 200, Object.assign({}, status, { hasPlaylist }));
}

function handlePlaylist(req, res, id) {
  const resolved = resolveId(id);
  if (!resolved) { res.writeHead(404); res.end('Episodio no encontrado.'); return; }
  cache.touchAccess(id);
  const p = cache.playlistPathFor(id);
  fs.stat(p, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('El video todavía no está listo.'); return; }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(p).pipe(res);
  });
}

function handleWatchedGet(req, res) {
  sendJSON(res, 200, watched.getWatched());
}

function handleWatchedMark(req, res, id) {
  if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
  const resolved = resolveId(id);
  if (!resolved) { sendJSON(res, 404, { error: 'Episodio no encontrado.' }); return; }
  const title = parseEpisodeInfo({ name: path.basename(resolved.relPath), path: resolved.relPath }).title;
  sendJSON(res, 200, watched.markWatched(id, title));
}

function handleSegment(req, res, id, segmentName) {
  if (!SEGMENT_NAME_RE.test(segmentName)) { res.writeHead(400); res.end('Nombre de segmento inválido.'); return; }
  const resolved = resolveId(id);
  if (!resolved) { res.writeHead(404); res.end('Episodio no encontrado.'); return; }
  cache.touchAccess(id);
  const p = cache.segmentPath(id, segmentName);
  fs.stat(p, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Segmento no encontrado.'); return; }
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=31536000, immutable' // un segmento .ts, una vez generado, nunca cambia
    });
    fs.createReadStream(p).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];

  if (pathname === '/api/episodes') {
    const found = rebuildIndex();
    const withUrl = found.map(function (ep) {
      const id = cache.idFor(ep.path);
      return Object.assign({}, ep, { id, url: '/hls/' + id + '/playlist.m3u8' });
    });
    sendJSON(res, 200, withUrl);
    return;
  }

  const statusMatch = pathname.match(/^\/api\/status\/([a-f0-9]{16})$/);
  if (statusMatch) { handleStatus(req, res, statusMatch[1]).catch(err => { sendJSON(res, 500, { status: 'error', error: 'Error interno.' }); }); return; }

  if (pathname === '/api/watched') { handleWatchedGet(req, res); return; }

  const watchedMatch = pathname.match(/^\/api\/watched\/([a-f0-9]{16})$/);
  if (watchedMatch) { handleWatchedMark(req, res, watchedMatch[1]); return; }

  const playlistMatch = pathname.match(/^\/hls\/([a-f0-9]{16})\/playlist\.m3u8$/);
  if (playlistMatch) { handlePlaylist(req, res, playlistMatch[1]); return; }

  const segmentMatch = pathname.match(/^\/hls\/([a-f0-9]{16})\/([^/]+)$/);
  if (segmentMatch) { handleSegment(req, res, segmentMatch[1], segmentMatch[2]); return; }

  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Randomizer de Episodios (modo servidor) escuchando en:');
  console.log('  http://localhost:' + PORT + '/');
  console.log('Alcanzable desde otros dispositivos de tu red (o tu red Tailscale) en el puerto ' + PORT + '.');
  console.log('Recuerda: sin autenticación propia — nunca expongas este puerto directo a internet.');
});
