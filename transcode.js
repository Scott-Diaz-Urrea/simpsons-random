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
   enganchan al mismo proceso en vez de lanzar un ffmpeg duplicado.
   videoOk/audioOk (de probe.js) se evalúan por separado: un archivo con
   video ya compatible pero audio no (H.264+MP3, común en esta
   biblioteca) solo recodifica el audio — copiar el video es
   prácticamente instantáneo, mientras que recodificarlo sin necesidad
   es la parte lenta (minutos de CPU por episodio). */
function startJob(id, sourcePath, opts) {
  const videoOk = !!(opts && opts.videoOk);
  const audioOk = !!(opts && opts.audioOk);
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

  /* -loglevel error: por defecto ffmpeg imprime una línea de progreso
     por cuadro (miles de líneas en un episodio de 20+ minutos) — el
     listener de stderr de más abajo (necesario para el mensaje de
     error si algo falla) tiene que procesar cada una, y eso genera
     suficiente contrapresión en el pipe como para frenar al propio
     ffmpeg: medido en la práctica, el mismo archivo pasó de 88s a 29s
     solo con este cambio, sin tocar nada más. */
  const args = ['-y', '-loglevel', 'error', '-i', sourcePath, '-map', '0:v:0', '-map', '0:a:0?'];
  args.push('-c:v', videoOk ? 'copy' : 'libx264');
  if (!videoOk) args.push('-preset', 'veryfast', '-crf', '21');
  args.push('-c:a', audioOk ? 'copy' : 'aac');
  if (!audioOk) args.push('-b:a', '160k', '-ac', '2');
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
    '-hls_flags', 'independent_segments',
    playlistPath
  );

  const job = { status: 'processing', startedAt: Date.now(), videoOk, audioOk };
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
      return;
    }
    if (job.status === 'error') return; // ya lo marcó proc.on('error')

    /* ffmpeg puede fallar a mitad de camino por un defecto real del
       archivo fuente (ej. NAL units inválidas más adelante en el
       stream, típico de una descarga incompleta o un archivo con
       corrupción parcial) — visto en la práctica con episodios reales
       de esta biblioteca. En vez de descartar todo lo ya procesado,
       si quedaron segmentos válidos se cierra el playlist ahí (con
       #EXT-X-ENDLIST) y se sirve como un video completo hasta ese
       punto — mejor mostrar el 80% de un episodio que nada. Solo se
       trata como error real si no se generó ningún segmento. */
    const hasSegments = cache.hasAnySegments(id);
    if (hasSegments) {
      try {
        const p = cache.playlistPathFor(id);
        let content = fs.readFileSync(p, 'utf8');

        /* Aunque ffmpeg haya fallado, a veces igual alcanza a escribir
           #EXT-X-ENDLIST — así que este chequeo corre siempre, no solo
           cuando falta. Si el último segmento quedó con una duración
           sospechosamente corta, es señal de que se truncó a mitad de
           escritura justo cuando ffmpeg murió — se descarta para no
           arriesgar un error de reproducción justo al final del tramo
           que sí se procesó bien. */
        const lines = content.replace(/#EXT-X-ENDLIST\s*/, '').replace(/\s*$/, '').split('\n');
        let lastExtinfIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].indexOf('#EXTINF:') === 0) { lastExtinfIdx = i; break; }
        }
        let trimmed = false;
        if (lastExtinfIdx !== -1) {
          const m = /^#EXTINF:([\d.]+)/.exec(lines[lastExtinfIdx]);
          const dur = m ? parseFloat(m[1]) : null;
          if (dur !== null && dur < 1) {
            const segLine = (lines[lastExtinfIdx + 1] || '').trim();
            lines.splice(lastExtinfIdx, 2);
            if (segLine) { try { fs.unlinkSync(path.join(outDir, segLine)); } catch (e3) { /* no crítico */ } }
            trimmed = true;
          }
        }
        if (trimmed || !content.includes('#EXT-X-ENDLIST')) {
          content = lines.join('\n') + '\n#EXT-X-ENDLIST\n';
          fs.writeFileSync(p, content);
        }
        job.status = 'ready';
        job.partial = true;
        cache.enforceCacheLimit();
        return;
      } catch (e) {
        // si ni siquiera se pudo cerrar el playlist parcial, cae al
        // camino de error de abajo
      }
    }

    job.status = 'error';
    job.error = 'No se pudo procesar este episodio para reproducirlo.';
    job.detail = stderrTail;
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e2) { /* no crítico */ }
  });

  proc.on('error', err => {
    job.status = 'error';
    job.error = 'No se pudo iniciar ffmpeg — ¿está instalado?';
    job.detail = String(err.message || err);
  });

  return job;
}

module.exports = { startJob, SEGMENT_SECONDS };
