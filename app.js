/* Randomizer de Episodios — modo local o modo servidor.
   Modo local: el acceso a archivos ocurre en el navegador (File System
   Access API, con fallback a <input webkitdirectory>); ningún archivo se
   sube ni se envía a ningún servidor.
   Modo servidor: si la página se sirve desde server.js (ver README), al
   cargar se detecta el endpoint /api/episodes y los episodios se
   reproducen por HLS (generado bajo demanda por el servidor — remux o
   transcodificación real según el códec original, ver probe.js/
   transcode.js) — funciona en cualquier navegador, sin instalar nada:
   Safari/iOS lo soporta nativo, el resto usa hls.js (vendor/hls.min.js,
   alojado localmente, sin depender de ningún CDN externo).

   "Vistos hoy": "Reproducir al azar" nunca repite un episodio ya visto
   en el día actual — se registran en una lista visible y se resetean
   solos al cambiar la fecha (ver watched.js del lado servidor, o
   localStorage del lado cliente en modo local).

   Transmitir a TV: AirPlay usa la API nativa de Safari (sin
   dependencias, funciona en cualquier modo). Google Cast necesita el
   SDK oficial de Google (cast_sender.js, cargado en index.html desde
   gstatic.com — no se puede alojar localmente, el descubrimiento de
   Chromecast/Android TV depende de la infraestructura de Google) y
   solo tiene sentido en modo servidor: el TV necesita poder pedirle el
   video directo al servidor por red, algo que un archivo local
   (blob: URL) nunca puede ofrecerle a otro dispositivo. */

const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v'];
const STATUS_POLL_MS = 1500;
const WATCHED_LS_KEY = 'simpsons_watched_v1';

let episodes = [];      // {file,path,name,season,episode,title} o {id,url,path,name,season,episode,title}
let currentUrl = null;  // object URL activo (solo modo local), para revocarlo al cambiar de video
let serverMode = false; // true si /api/episodes respondió al cargar la página
let hls = null;         // instancia activa de Hls.js (si el navegador la necesita)
let statusPollTimer = null;
let watchedIds = new Set(); // claves (ep.id o ep.path) ya vistas "hoy"
let watchedItems = [];      // [{id,title,watchedAt}] para mostrar la lista
let playHistory = [];       // índices en `episodes`, en el orden en que se fueron reproduciendo
let historyPos = -1;        // posición actual dentro de playHistory (permite "Anterior")

const pickBtn = document.getElementById('pickBtn');
const compatWarning = document.getElementById('compatWarning');
const pickStage = document.getElementById('pickStage');
const libraryStage = document.getElementById('libraryStage');
const epCount = document.getElementById('epCount');
const watchedCount = document.getElementById('watchedCount');
const allWatchedMsg = document.getElementById('allWatchedMsg');
const rescanBtn = document.getElementById('rescanBtn');
const randomBtn = document.getElementById('randomBtn');
const nextRandomBtn = document.getElementById('nextRandomBtn');
const prevBtn = document.getElementById('prevBtn');
const playerWrap = document.getElementById('playerWrap');
const player = document.getElementById('player');
const nowTitle = document.getElementById('nowTitle');
const episodeList = document.getElementById('episodeList');
const modeBadge = document.getElementById('modeBadge');
const playerStatus = document.getElementById('playerStatus');
const watchedDetails = document.getElementById('watchedDetails');
const watchedListCount = document.getElementById('watchedListCount');
const watchedList = document.getElementById('watchedList');
const airplayBtn = document.getElementById('airplayBtn');
const castBtn = document.getElementById('castBtn');

let castContext = null; // instancia de cast.framework.CastContext, una vez que el SDK de Google carga
let castApiReady = false;

if(!window.showDirectoryPicker){
  compatWarning.hidden = false;
}

pickBtn.addEventListener('click', handlePickFolder);
rescanBtn.addEventListener('click', function(){
  if(serverMode) loadServerLibrary(); else handlePickFolder();
});
randomBtn.addEventListener('click', playRandom);
nextRandomBtn.addEventListener('click', playRandom);
prevBtn.addEventListener('click', playPrevious);

if(player.webkitShowPlaybackTargetPicker){
  airplayBtn.hidden = false;
  airplayBtn.addEventListener('click', function(){ player.webkitShowPlaybackTargetPicker(); });
}

/* Google Cast: window.__onGCastApiAvailable (definido en index.html,
   antes de que cargue el SDK) reenvía acá este evento apenas el SDK
   de Google termina de cargar. Nunca se muestra en modo local (ver
   updateCastVisibility): un archivo local (blob: URL) no existe fuera
   de esta pestaña, así que ningún Chromecast podría reproducirlo. */
window.addEventListener('gcast-available', function(e){
  if(!e.detail || !window.cast || !window.chrome || !chrome.cast) return;
  castApiReady = true;
  castContext = cast.framework.CastContext.getInstance();
  castContext.setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
  });
  castContext.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, function(evt){
    const started = evt.sessionState === cast.framework.SessionState.SESSION_STARTED
      || evt.sessionState === cast.framework.SessionState.SESSION_RESUMED;
    if(started) castCurrentEpisode();
  });
  updateCastVisibility();
});
function updateCastVisibility(){
  castBtn.hidden = !(castApiReady && serverMode);
}

function currentEpisode(){
  if(historyPos < 0) return null;
  return episodes[playHistory[historyPos]] || null;
}
/* Envía el episodio que se está viendo ahora mismo al TV conectado —
   se llama tanto al iniciar/retomar una sesión de Cast (arriba) como
   cada vez que arranca un episodio nuevo mientras ya se está
   transmitiendo (ver playServerEpisode), para que "Siguiente al azar"/
   "Anterior" también avancen en la TV, no solo en este dispositivo. */
function castCurrentEpisode(){
  const ep = currentEpisode();
  if(ep) castEpisode(ep);
}
function castEpisode(ep){
  if(!castContext || !ep || !ep.url) return;
  const session = castContext.getCurrentSession();
  if(!session) return;
  const absoluteUrl = location.origin + ep.url;
  const mediaInfo = new chrome.cast.media.MediaInfo(absoluteUrl, 'application/x-mpegURL');
  mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;
  const metadata = new chrome.cast.media.GenericMediaMetadata();
  metadata.title = ep.title;
  mediaInfo.metadata = metadata;
  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  session.loadMedia(request).catch(function(err){
    console.warn('No se pudo transmitir este episodio a la TV.', err);
  });
}

loadServerLibrary(); // detecta modo servidor al cargar; si no hay servidor, no hace nada

async function loadServerLibrary(){
  let list;
  try{
    const res = await fetch('/api/episodes', { cache:'no-store' });
    if(!res.ok) return;
    list = await res.json();
    if(!Array.isArray(list)) return;
  }catch(e){
    return; // no hay servidor corriendo (p.ej. GitHub Pages) — se queda en modo local
  }
  serverMode = true;
  if(modeBadge) modeBadge.hidden = false;
  rescanBtn.textContent = 'Actualizar biblioteca';
  episodes = list;
  updateCastVisibility();
  await loadWatchedServer();
  renderLibrary();
}

async function handlePickFolder(){
  const files = window.showDirectoryPicker ? await pickFolderNative() : await pickFolderFallback();
  if(!files || files.length === 0) return;
  episodes = files.map(parseEpisodeInfo).sort(compareEpisodes);
  loadWatchedLocal();
  renderLibrary();
}

async function pickFolderNative(){
  let dirHandle;
  try{
    dirHandle = await window.showDirectoryPicker();
  }catch(e){
    return null; // el usuario canceló el selector
  }
  return collectFilesFromHandle(dirHandle, '');
}
async function collectFilesFromHandle(dirHandle, path){
  let out = [];
  for await (const [name, handle] of dirHandle.entries()){
    const fullPath = path ? path+'/'+name : name;
    if(handle.kind === 'file'){
      if(isVideoFile(name)){
        const file = await handle.getFile();
        out.push({ file, path: fullPath, name });
      }
    } else if(handle.kind === 'directory'){
      out = out.concat(await collectFilesFromHandle(handle, fullPath));
    }
  }
  return out;
}
function pickFolderFallback(){
  return new Promise(function(resolve){
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.addEventListener('change', function(){
      const files = Array.from(input.files)
        .filter(function(f){ return isVideoFile(f.name); })
        .map(function(f){ return { file:f, path: f.webkitRelativePath || f.name, name: f.name }; });
      resolve(files);
    });
    input.click();
  });
}
function isVideoFile(name){
  const ext = name.split('.').pop().toLowerCase();
  return VIDEO_EXT.indexOf(ext) !== -1;
}

/* Reconoce varios formatos de nombre comunes: "S01E02", "1x02", o una
   carpeta contenedora tipo "Temporada 1"/"Season 1" combinada con un
   número de episodio suelto en el archivo. Si no reconoce nada, el
   episodio igual se agrega a la lista (season/episode quedan null) para
   no bloquear al usuario mientras ordena su carpeta. */
function parseEpisodeInfo(entry){
  const base = entry.name.replace(/\.[^.]+$/, '');
  let season = null, episode = null;

  let m = base.match(/[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})/);
  if(m){ season = parseInt(m[1],10); episode = parseInt(m[2],10); }

  if(season===null){
    m = base.match(/\b(\d{1,2})x(\d{1,3})\b/);
    if(m){ season = parseInt(m[1],10); episode = parseInt(m[2],10); }
  }

  if(season===null){
    const seasonMatch = entry.path.match(/(?:temporada|season)\s*(\d{1,2})/i);
    const epMatch = base.match(/(?:cap[ií]tulo|episodio|episode|ep)\s*\.?\s*(\d{1,3})/i) || base.match(/\b(\d{1,3})\b/);
    if(seasonMatch) season = parseInt(seasonMatch[1],10);
    if(epMatch) episode = parseInt(epMatch[1],10);
  }

  const title = (season!=null && episode!=null)
    ? 'Temporada '+season+', Episodio '+episode
    : base;

  return { file: entry.file, path: entry.path, name: entry.name, season, episode, title };
}
function compareEpisodes(a, b){
  if(a.season!=null && b.season!=null && a.season!==b.season) return a.season-b.season;
  if(a.season!=null && b.season!=null && a.episode!==b.episode) return (a.episode||0)-(b.episode||0);
  if(a.season==null && b.season!=null) return 1;
  if(a.season!=null && b.season==null) return -1;
  return a.path.localeCompare(b.path);
}

function watchKeyOf(ep){ return ep.id || ep.path; }

function renderLibrary(){
  pickStage.hidden = true;
  libraryStage.hidden = false;
  epCount.textContent = episodes.length;
  episodeList.innerHTML = episodes.map(function(ep, i){
    const key = watchKeyOf(ep);
    const isWatched = watchedIds.has(key);
    return '<button class="episode-row'+(isWatched?' watched':'')+'" data-i="'+i+'" data-key="'+escapeHtml(key)+'">'+
      '<span class="ep-title">'+(isWatched?'✓ ':'')+escapeHtml(ep.title)+'</span>'+
      '<span class="ep-file">'+escapeHtml(ep.name)+'</span>'+
    '</button>';
  }).join('');
  episodeList.querySelectorAll('.episode-row').forEach(function(btn){
    btn.addEventListener('click', function(){
      playEpisode(Number(btn.getAttribute('data-i')));
    });
  });
  renderWatchedList();
}
function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* --- "Vistos hoy": no repetir episodios ya vistos, con reset diario ---
   Modo servidor: persistido en el servidor (compartido entre todos los
   dispositivos que usan el mismo servidor — /api/watched, ver
   watched.js). Modo local: persistido en localStorage de este
   navegador únicamente (no hay servidor donde guardarlo). En ambos
   casos la clave del día (YYYY-MM-DD) determina el reset: si cambió
   desde la última vez, la lista arranca vacía de nuevo. */
function todayKey(){
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
async function loadWatchedServer(){
  try{
    const res = await fetch('/api/watched', { cache:'no-store' });
    const data = await res.json();
    watchedItems = Array.isArray(data.items) ? data.items : [];
  }catch(e){
    watchedItems = [];
  }
  watchedIds = new Set(watchedItems.map(function(it){ return it.id; }));
}
function loadWatchedLocal(){
  let saved = null;
  try{ saved = JSON.parse(localStorage.getItem(WATCHED_LS_KEY) || 'null'); }catch(e){ saved = null; }
  if(!saved || saved.day !== todayKey()) saved = { day: todayKey(), items: [] };
  watchedItems = saved.items;
  watchedIds = new Set(watchedItems.map(function(it){ return it.id; }));
}
function markWatched(ep){
  const key = watchKeyOf(ep);
  if(watchedIds.has(key)) return;
  watchedIds.add(key);
  markRowWatched(key);
  if(serverMode){
    fetch('/api/watched/'+key, { method:'POST' })
      .then(function(res){ return res.json(); })
      .then(function(data){ watchedItems = Array.isArray(data.items) ? data.items : watchedItems; renderWatchedList(); })
      .catch(function(){ /* si falla la marca en el servidor, igual queda excluida localmente por esta sesión */ });
  } else {
    watchedItems.push({ id: key, title: ep.title, watchedAt: Date.now() });
    try{ localStorage.setItem(WATCHED_LS_KEY, JSON.stringify({ day: todayKey(), items: watchedItems })); }catch(e){}
    renderWatchedList();
  }
}
function markRowWatched(key){
  const row = episodeList.querySelector('[data-key="'+CSS.escape(key)+'"]');
  if(row && !row.classList.contains('watched')){
    row.classList.add('watched');
    const titleEl = row.querySelector('.ep-title');
    if(titleEl) titleEl.textContent = '✓ ' + titleEl.textContent;
  }
}
function renderWatchedList(){
  const n = watchedItems.length;
  watchedCount.hidden = n === 0;
  watchedCount.textContent = n + (n===1 ? ' episodio visto hoy' : ' episodios vistos hoy');
  watchedDetails.hidden = n === 0;
  watchedListCount.textContent = n;
  watchedList.innerHTML = watchedItems.slice().reverse().map(function(it){
    const time = new Date(it.watchedAt).toLocaleTimeString('es-CL', { hour:'2-digit', minute:'2-digit' });
    return '<div class="episode-row watched"><span class="ep-title">'+escapeHtml(it.title)+'</span>'+
      '<span class="ep-file">'+time+'</span></div>';
  }).join('');
}

/* "Reproducir al azar" solo elige entre episodios no vistos hoy. Si ya
   se vieron todos, muestra un mensaje en vez de repetir alguno. */
function playRandom(){
  if(episodes.length === 0) return;
  const pool = [];
  for(let i=0;i<episodes.length;i++){ if(!watchedIds.has(watchKeyOf(episodes[i]))) pool.push(i); }
  if(pool.length === 0){
    allWatchedMsg.hidden = false;
    return;
  }
  allWatchedMsg.hidden = true;
  const idx = pool[Math.floor(Math.random()*pool.length)];
  playEpisode(idx);
}
/* Historial de reproducción: permite "⏮ Anterior" sin depender de que
   el azar vuelva a elegir lo mismo. Si se viene navegando "para atrás"
   y se elige algo nuevo (azar o de la lista), se corta el tramo hacia
   adelante que había quedado — mismo criterio que el back/forward de
   un navegador. */
function pushHistory(idx){
  playHistory = playHistory.slice(0, historyPos + 1);
  playHistory.push(idx);
  historyPos = playHistory.length - 1;
  prevBtn.disabled = historyPos <= 0;
}
function playPrevious(){
  if(historyPos <= 0) return;
  historyPos--;
  prevBtn.disabled = historyPos <= 0;
  playEpisode(playHistory[historyPos], true);
}
function playEpisode(idx, fromHistory){
  const ep = episodes[idx];
  if(!ep) return;
  if(!fromHistory) pushHistory(idx);
  if(currentUrl){ URL.revokeObjectURL(currentUrl); currentUrl = null; }
  stopStatusPoll();
  destroyHls();

  if(ep.url){
    playServerEpisode(ep);
  } else {
    player.hidden = false;
    playerStatus.hidden = true;
    currentUrl = URL.createObjectURL(ep.file);
    player.src = currentUrl;
    player.play().catch(function(){ /* el navegador puede pedir interacción manual */ });
    markWatched(ep);
  }
  nowTitle.textContent = ep.title;
  playerWrap.hidden = false;
  playerWrap.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function stopStatusPoll(){
  if(statusPollTimer){ clearTimeout(statusPollTimer); statusPollTimer = null; }
}
function destroyHls(){
  if(hls){ hls.destroy(); hls = null; }
}

/* Modo servidor: el video se sirve por HLS, generado bajo demanda por
   el servidor (remux rápido o transcodificación real, según el códec
   original — ver README/probe.js/transcode.js). Mientras se prepara,
   se muestra un estado amigable en vez de un reproductor roto; recién
   arranca cuando el procesamiento está 100% listo (duración total
   conocida, seek funcionando en toda la barra desde el inicio). */
function playServerEpisode(ep){
  player.hidden = true;
  player.removeAttribute('src');
  player.load();
  playerStatus.hidden = false;
  playerStatus.className = 'player-status';
  playerStatus.textContent = '⏳ Preparando video…';

  const statusUrl = '/api/status/' + ep.id;

  function poll(){
    fetch(statusUrl, { cache: 'no-store' })
      .then(function(res){ return res.json(); })
      .then(function(data){
        if(data.status === 'error'){
          playerStatus.className = 'player-status error';
          playerStatus.textContent = '⚠️ No se pudo reproducir este episodio. Probá con otro.';
          return;
        }
        /* Se espera a 'ready' (no solo a que exista el playlist) para
           que el reproductor siempre reciba un HLS ya cerrado (con
           #EXT-X-ENDLIST) — así muestra la duración total y permite
           adelantar/rebobinar en toda la barra desde el arranque, en
           vez de comportarse como una transmisión en vivo mientras el
           servidor todavía está procesando. */
        if(data.status === 'ready'){
          markWatched(ep);
          startHlsPlayback(ep.url);
          castCurrentEpisode(); // si ya hay una TV conectada, la sigue también
          return;
        }
        statusPollTimer = setTimeout(poll, STATUS_POLL_MS);
      })
      .catch(function(){
        // Interrupción de red momentánea: reintenta solo, sin mostrar
        // detalles técnicos.
        statusPollTimer = setTimeout(poll, STATUS_POLL_MS);
      });
  }
  poll();
}

function startHlsPlayback(playlistUrl){
  playerStatus.hidden = true;
  player.hidden = false;

  if(player.canPlayType('application/vnd.apple.mpegurl')){
    // Safari/iOS: soporte nativo de HLS, sin ninguna librería.
    player.src = playlistUrl;
    player.play().catch(function(){});
    return;
  }
  if(window.Hls && Hls.isSupported()){
    hls = new Hls();
    hls.loadSource(playlistUrl);
    hls.attachMedia(player);
    hls.on(Hls.Events.MANIFEST_PARSED, function(){ player.play().catch(function(){}); });
    hls.on(Hls.Events.ERROR, function(evt, data){
      if(!data.fatal) return; // hls.js ya reintenta solo los errores no fatales (red, buffer)
      player.hidden = true;
      playerStatus.hidden = false;
      playerStatus.className = 'player-status error';
      playerStatus.textContent = '⚠️ Hubo un problema reproduciendo este episodio. Probá con otro.';
    });
    return;
  }
  player.hidden = true;
  playerStatus.hidden = false;
  playerStatus.className = 'player-status error';
  playerStatus.textContent = '⚠️ Este navegador no puede reproducir este video.';
}
