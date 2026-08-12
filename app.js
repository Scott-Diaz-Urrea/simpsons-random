/* Randomizer de Episodios — modo local o modo servidor.
   Modo local: el acceso a archivos ocurre en el navegador (File System
   Access API, con fallback a <input webkitdirectory>); ningún archivo se
   sube ni se envía a ningún servidor.
   Modo servidor: si la página se sirve desde server.js (ver README), al
   cargar se detecta el endpoint /api/episodes y los videos se transmiten
   por streaming HTTP en vez de leerse del disco de este dispositivo —
   así se puede ver la biblioteca desde otro dispositivo (celular) en la
   misma red o vía Tailscale mientras el servidor está corriendo. */

const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v'];

let episodes = [];      // {file,path,name,season,episode,title} o {url,path,name,season,episode,title}
let shuffleBag = [];    // índices pendientes por reproducir en la ronda actual
let currentUrl = null;  // object URL activo (solo modo local), para revocarlo al cambiar de video
let serverMode = false; // true si /api/episodes respondió al cargar la página

const pickBtn = document.getElementById('pickBtn');
const compatWarning = document.getElementById('compatWarning');
const pickStage = document.getElementById('pickStage');
const libraryStage = document.getElementById('libraryStage');
const epCount = document.getElementById('epCount');
const rescanBtn = document.getElementById('rescanBtn');
const randomBtn = document.getElementById('randomBtn');
const nextRandomBtn = document.getElementById('nextRandomBtn');
const playerWrap = document.getElementById('playerWrap');
const player = document.getElementById('player');
const nowTitle = document.getElementById('nowTitle');
const episodeList = document.getElementById('episodeList');
const modeBadge = document.getElementById('modeBadge');

if(!window.showDirectoryPicker){
  compatWarning.hidden = false;
}

pickBtn.addEventListener('click', handlePickFolder);
rescanBtn.addEventListener('click', function(){
  if(serverMode) loadServerLibrary(); else handlePickFolder();
});
randomBtn.addEventListener('click', playRandom);
nextRandomBtn.addEventListener('click', playRandom);

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
  resetShuffleBag();
  renderLibrary();
}

async function handlePickFolder(){
  const files = window.showDirectoryPicker ? await pickFolderNative() : await pickFolderFallback();
  if(!files || files.length === 0) return;
  episodes = files.map(parseEpisodeInfo).sort(compareEpisodes);
  resetShuffleBag();
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

function resetShuffleBag(){
  shuffleBag = shuffle(episodes.map(function(_, i){ return i; }));
}
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    const tmp=a[i]; a[i]=a[j]; a[j]=tmp;
  }
  return a;
}

function renderLibrary(){
  pickStage.hidden = true;
  libraryStage.hidden = false;
  epCount.textContent = episodes.length;
  episodeList.innerHTML = episodes.map(function(ep, i){
    return '<button class="episode-row" data-i="'+i+'">'+
      '<span class="ep-title">'+escapeHtml(ep.title)+'</span>'+
      '<span class="ep-file">'+escapeHtml(ep.name)+'</span>'+
    '</button>';
  }).join('');
  episodeList.querySelectorAll('.episode-row').forEach(function(btn){
    btn.addEventListener('click', function(){
      playEpisode(Number(btn.getAttribute('data-i')));
    });
  });
}
function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* Sistema de "bolsa sin repetición": se vacía la bolsa completa de
   episodios antes de volver a repetir alguno, en vez de un random puro
   (que podría repetir el mismo episodio varias veces seguidas). */
function playRandom(){
  if(episodes.length === 0) return;
  if(shuffleBag.length === 0) resetShuffleBag();
  const idx = shuffleBag.pop();
  playEpisode(idx);
}
function playEpisode(idx){
  const ep = episodes[idx];
  if(!ep) return;
  if(currentUrl){ URL.revokeObjectURL(currentUrl); currentUrl = null; }
  if(ep.url){
    player.src = ep.url; // modo servidor: streaming HTTP directo, con soporte de Range/seek
  } else {
    currentUrl = URL.createObjectURL(ep.file);
    player.src = currentUrl;
  }
  player.play().catch(function(){ /* el navegador puede pedir interacción manual */ });
  nowTitle.textContent = ep.title;
  playerWrap.hidden = false;
  playerWrap.scrollIntoView({ behavior:'smooth', block:'nearest' });
}
