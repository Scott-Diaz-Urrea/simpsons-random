/* transcode.js — genera HLS (playlist.m3u8 + segmentos .ts) a partir de
   un archivo de video original. ffmpeg SOLO LEE el archivo fuente y
   escribe en la carpeta de caché — el original nunca se abre en modo
   escritura, nunca se renombra, nunca se borra.

   Usa playlist tipo "event": el reproductor puede ir pidiendo
   segmentos a medida que aparecen, sin esperar a que termine todo el
   episodio. ffmpeg agrega automáticamente #EXT-X-ENDLIST al final
   cuando el proceso termina bien — ahí hlsCache.isReady() empieza a
   devolver true. */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cache = require('./hlsCache.js');

const SEGMENT_SECONDS = 6;

/* Si ya hay un job en curso para este id, los pedidos concurrentes se
   enganchan al mismo proceso en vez de lanzar un ffmpeg duplicado. */
function startJob(id, sourcePath, plan) {
  const existing = cache.jobs.get(id);
  if (existing && existing.status === 'processing') return existing;

  cache.ensureDir(id);
  const outDir = cache.dirFor(id);
  const playlistPath = cache.playlistPathFor(id);

  // Limpiar restos de un intento previo fallido antes de reintentar.
  try {
    for (const f of fs.readdirSync(outDir)) {
      if (f.endsWith('.ts') || f.endsWith('.m3u8')) fs.unlinkSync(path.join(outDir, f));
    }
  } catch (e) { /* carpeta recién creada, puede no tener nada aún */ }

  const args = ['-y', '-i', sourcePath, '-map', '0:v:0', '-map', '0:a:0?'];
  if (plan === 'remux') {
    args.push('-c:v', 'copy', '-c:a', 'copy');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  }
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
    '-hls_flags', 'independent_segments',
    playlistPath
  );

  const job = { status: 'processing', startedAt: Date.now(), plan };
  cache.jobs.set(id, job);

  let proc;
  try {
    proc = spawn('ffmpeg', args, { windowsHide: true });
  } catch (e) {
    job.status = 'error';
    job.error = 'No se pudo iniciar el procesamiento de video.';
    job.detail = String(e.message || e);
    return job;
  }
  job.process = proc;

  let stderrTail = '';
  proc.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-2000); });

  proc.on('close', code => {
    if (code === 0 && cache.isReady(id)) {
      job.status = 'ready';
      cache.enforceCacheLimit();
    } else if (job.status !== 'error') {
      job.status = 'error';
      job.error = 'No se pudo procesar este episodio para reproducirlo.';
      job.detail = stderrTail;
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e2) { /* no crítico */ }
    }
  });

  proc.on('error', err => {
    job.status = 'error';
    job.error = 'No se pudo iniciar ffmpeg — ¿está instalado?';
    job.detail = String(err.message || err);
  });

  return job;
}

module.exports = { startJob, SEGMENT_SECONDS };
