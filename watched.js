/* watched.js — lista de episodios "vistos hoy", con reset automático
   cuando cambia el día (hora local del equipo que corre el servidor).

   Se guarda en disco (cache/watched.json) para sobrevivir a un reinicio
   del servidor durante el mismo día, y para que la lista sea compartida
   entre todos los dispositivos que usan el servidor (celular, laptop,
   TV) — si ya viste un episodio desde el celular, tampoco te va a
   salir al azar desde la TV. */

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
const FILE = path.join(CACHE_DIR, 'watched.json');

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw.day === 'string' && Array.isArray(raw.items)) return raw;
  } catch (e) { /* archivo ausente o corrupto: arranca en blanco */ }
  return { day: todayKey(), items: [] };
}

let state = load();

function ensureFreshDay() {
  const today = todayKey();
  if (state.day !== today) {
    state = { day: today, items: [] };
    save();
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(state));
    } catch (e) { /* no crítico */ }
  }, 300);
}

function getWatched() {
  ensureFreshDay();
  return state;
}

function markWatched(id, title) {
  ensureFreshDay();
  if (!state.items.some(it => it.id === id)) {
    state.items.push({ id, title, watchedAt: Date.now() });
    save();
  }
  return state;
}

/* Revisión periódica: así el reset ocurre solo con que pase la
   medianoche, sin depender de que llegue un pedido justo en ese
   momento (el servidor puede quedar corriendo días sin que nadie lo
   toque). */
setInterval(ensureFreshDay, 60 * 1000);

module.exports = { getWatched, markWatched, ensureFreshDay, todayKey };
