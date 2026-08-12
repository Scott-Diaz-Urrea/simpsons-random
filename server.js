/* Servidor local de streaming — Randomizer de Episodios (modo servidor).
   Sin dependencias externas: solo módulos nativos de Node.

   Sirve la carpeta videos/ por HTTP con soporte de Range requests (para
   poder adelantar/rebobinar el video, no solo reproducirlo de corrido),
   y expone /api/episodes con la lista de episodios ya reconocidos
   (misma lógica de nombre que el modo local: S01E02 / 1x02 / carpeta
   "Temporada N").

   ADVERTENCIA DE SEGURIDAD: este servidor no tiene autenticación propia.
   Está pensado para correr solo dentro de una red de confianza (tu WiFi
   de casa, o una red privada tipo Tailscale) — nunca lo expongas
   directo a internet (sin port-forwarding ni túneles públicos), porque
   cualquiera que alcance el puerto podría ver/descargar los videos. */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8090;
const ROOT = __dirname;
const VIDEOS_DIR = path.join(ROOT, 'videos');
const VIDEO_EXT = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];

const MIME = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8'
};

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

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveStream(req, res, encodedRelPath) {
  const decoded = decodeURIComponent(encodedRelPath);
  const filePath = path.normalize(path.join(VIDEOS_DIR, decoded));
  if (!filePath.startsWith(VIDEOS_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('No encontrado'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? parseInt(match[1], 10) : 0;
      let end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (isNaN(start) || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
        res.end();
        return;
      }
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];

  if (pathname === '/api/episodes') {
    const found = walkVideos(VIDEOS_DIR, VIDEOS_DIR).map(parseEpisodeInfo);
    found.sort(compareEpisodes);
    const withUrl = found.map(function (ep) {
      return Object.assign({}, ep, {
        url: '/stream/' + ep.path.split('/').map(encodeURIComponent).join('/')
      });
    });
    sendJSON(res, 200, withUrl);
    return;
  }

  if (pathname.indexOf('/stream/') === 0) {
    serveStream(req, res, pathname.slice('/stream/'.length));
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Randomizer de Episodios (modo servidor) escuchando en:');
  console.log('  http://localhost:' + PORT + '/');
  console.log('Alcanzable desde otros dispositivos de tu red (o tu red Tailscale) en el puerto ' + PORT + '.');
  console.log('Recuerda: sin autenticación propia — nunca expongas este puerto directo a internet.');
});
