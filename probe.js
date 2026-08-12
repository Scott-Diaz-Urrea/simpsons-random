/* probe.js — sondeo de códecs vía ffprobe, con caché en disco.

   Decide, para cada archivo, si alcanza con un REMUX (reempaquetar los
   streams tal cual a HLS, rápido y sin pérdida — cuando el video ya es
   H.264 y el audio ya es AAC/nulo) o si hace falta un TRANSCODE real
   (recodificar video/audio — cuando el códec original no es compatible
   con navegadores, ej. XviD/DivX viejos). En ambos casos el resultado
   final es HLS: no existe un modo "servir tal cual" porque el
   contenedor .mkv en sí no reproduce en navegadores de celular aunque
   los códecs internos sean compatibles (comprobado en la práctica). */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'probe-cache.json');
const COMPATIBLE_VIDEO = new Set(['h264']);
const COMPATIBLE_AUDIO = new Set(['aac']);

let cache = loadCache();

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { return {}; }
}

let saveTimer = null;
function saveCache() {
  // Debounce: si llegan varios probe() seguidos, no reescribir el
  // archivo de caché por cada uno.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch (e) { /* si falla guardar la caché, no es fatal */ }
  }, 500);
}

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
    let proc;
    try { proc = spawn('ffprobe', args, { windowsHide: true }); }
    catch (e) { reject(e); return; }
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', reject); // ffprobe no encontrado en PATH, etc.
    proc.on('close', code => {
      if (code !== 0) { reject(new Error('ffprobe salió con código ' + code + ': ' + err.slice(0, 500))); return; }
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error('ffprobe devolvió una salida inválida')); }
    });
  });
}

/* Analiza un archivo y devuelve el plan de reproducción. Cachea por
   ruta + mtime + tamaño — si el archivo fuente no cambió, no se vuelve
   a invocar ffprobe (importante para una biblioteca de 500+ episodios:
   el sondeo es bajo demanda, nunca eager sobre toda la biblioteca). */
async function probe(filePath, cacheKey) {
  let stat;
  try { stat = fs.statSync(filePath); }
  catch (e) { return { ok: false, error: 'No se encontró el archivo original.' }; }

  const key = cacheKey + '|' + stat.mtimeMs + '|' + stat.size;
  if (cache[key]) return cache[key];

  let info;
  try {
    info = await runFfprobe(filePath);
  } catch (e) {
    const result = { ok: false, error: 'No se pudo analizar el archivo de video (posiblemente corrupto o incompleto).', detail: String(e.message || e) };
    cache[key] = result;
    saveCache();
    return result;
  }

  const streams = info.streams || [];
  const videoStream = streams.find(s => s.codec_type === 'video');
  const audioStream = streams.find(s => s.codec_type === 'audio');

  if (!videoStream) {
    const result = { ok: false, error: 'El archivo no tiene una pista de video válida.' };
    cache[key] = result;
    saveCache();
    return result;
  }

  const videoCodec = videoStream.codec_name || 'unknown';
  const audioCodec = audioStream ? (audioStream.codec_name || 'unknown') : null;
  const container = (info.format && info.format.format_name) || '';
  const duration = info.format && info.format.duration ? parseFloat(info.format.duration) : null;

  const videoOk = COMPATIBLE_VIDEO.has(videoCodec);
  const audioOk = audioCodec == null || COMPATIBLE_AUDIO.has(audioCodec);
  /* videoOk/audioOk se evalúan por separado — un archivo con video ya
     compatible pero audio no (ej. H.264 + MP3, bastante común en esta
     biblioteca) solo necesita recodificar el audio; forzar también un
     recodificado de video ahí sería carísimo en CPU para nada (ver
     transcode.js, que arma los argumentos de ffmpeg usando estos dos
     valores de forma independiente). "plan" queda solo como etiqueta
     legible para logs/depuración. */
  const plan = (videoOk && audioOk) ? 'copy' : (!videoOk && !audioOk) ? 'transcode' : (!videoOk ? 'video-encode' : 'audio-encode');

  const result = {
    ok: true, plan, videoOk, audioOk, videoCodec, audioCodec, container, duration,
    width: videoStream.width || null, height: videoStream.height || null
  };
  cache[key] = result;
  saveCache();
  return result;
}

module.exports = { probe };
