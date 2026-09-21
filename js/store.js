import { dbAll, dbPut, dbBulk, dbDel, dbGetKV, dbSetKV } from './db.js';

const DEFAULT_MODES = [
  { id: 'work', label: 'Работа' },
  { id: 'home', label: 'Дом' },
  { id: 'study', label: 'Учёба' },
  { id: 'all', label: 'Все задачи', short: 'Все' },
];
export const MODES = DEFAULT_MODES.map(m => ({ ...m }));
export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const DAYS_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export const TYPE_LABEL = { task: 'Задача', meeting: 'Встреча', project: 'Проект', event: 'Событие', small: 'Мелочь' };
export const PRIORITY_LABEL = { 1: 'Высокий', 2: 'Средний', 3: 'Низкий' };
export const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export const MONTHS_FULL = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
export const mondayOf = s => { const d = parseISO(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
export const today = () => iso(new Date());
export const fmtD = s => `${+s.slice(8)} ${MONTHS[+s.slice(5, 7) - 1]}`;
export function isoWeek(s) {
  const d = parseISO(s);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / 864e5 - 3 + ((w1.getDay() + 6) % 7)) / 7);
}
export const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)}ч ${m % 60 ? (m % 60) + 'м' : ''}`.trim() : `${m}м`;
export function blockEnd(t) {
  const [h, mi] = String(t.blockStart).split(':').map(Number);
  const tot = h * 60 + mi + (t.blockMin || 30);
  return `${String(Math.floor(tot / 60) % 24).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`;
}
export const state = {
  mode: 'work', weekStart: mondayOf(today()), day: today(),
  tasks: [], view: 'week', widgets: ['notes', 'focus'],
  hideDone: false, // скрывать выполненные задачи в списках (неделя/день)
};
const listeners = [];
export const subscribe = fn => listeners.push(fn);
let pendingNotify = false;
const notify = () => {
  if (pendingNotify) return;
  pendingNotify = true;
  requestAnimationFrame(() => {
    pendingNotify = false;
    listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  });
};
const userChange = () => document.dispatchEvent(new CustomEvent('user-change'));
export function haptic(pattern = 8) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
}
export const hapticLight = () => haptic(6);
export const hapticMedium = () => haptic(12);
export const hapticHeavy = () => haptic([15, 30, 15]);
export const hapticSuccess = () => haptic([8, 40, 8]);

const TOMBSTONES_KEY = 'rl_tombstones';
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let tombstones = [];
function loadTombstones() {
  try {
    const raw = localStorage.getItem(TOMBSTONES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    tombstones = Array.isArray(arr) ? arr.filter(t => t && t.id) : [];
  } catch { tombstones = []; }
  pruneTombstones();
}
function saveTombstones() {
  try { localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(tombstones)); }
  catch (e) { console.error('[store] saveTombstones failed:', e); }
}
function pruneTombstones() {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const before = tombstones.length;
  tombstones = tombstones.filter(t => t.deletedAt && t.deletedAt >= cutoff);
  if (tombstones.length !== before) saveTombstones();
}
export function getTombstones() { return tombstones.map(t => t.id); }
export function getTombstonesFull() { return tombstones.slice(); }
export function addTombstone(id) {
  if (!id) return;
  if (tombstones.some(t => t.id === id)) return;
  tombstones.push({ id, deletedAt: Date.now() });
  saveTombstones();
}
export function mergeTombstones(server) {
  const arr = Array.isArray(server) ? server : [];
  const map = new Map();
  for (const t of tombstones) if (t && t.id) map.set(t.id, t);
  for (const t of arr) {
    if (!t || !t.id) continue;
    const existing = map.get(t.id);
    if (!existing || (t.deletedAt || 0) > (existing.deletedAt || 0)) map.set(t.id, t);
  }
  tombstones = [...map.values()];
  pruneTombstones();
}
export function isTombstoned(id) { return tombstones.some(t => t.id === id); }
export function removeTombstone(id) {
  const before = tombstones.length;
  tombstones = tombstones.filter(t => t.id !== id);
  if (tombstones.length !== before) saveTombstones();
}
export function clearTombstones(ids) {
  if (!ids || !ids.length) return;
  const set = new Set(ids);
  tombstones = tombstones.filter(t => !set.has(t.id));
  saveTombstones();
}
loadTombstones();

export function getTimeAtmosphere() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 10) return 'rgba(255, 200, 150, 0.18)';
  if (hour >= 10 && hour < 16) return 'rgba(200, 220, 255, 0.08)';
  if (hour >= 16 && hour < 21) return 'rgba(180, 140, 220, 0.15)';
  return 'rgba(60, 80, 160, 0.22)';
}

/* ── Кастомные названия режимов ── */
const MODE_LABELS_KEY = 'modeLabels';
let modeLabelsCustom = {};
async function loadModeLabels() {
  const saved = await dbGetKV(MODE_LABELS_KEY);
  if (saved && typeof saved === 'object') {
    modeLabelsCustom = saved;
    applyModeLabels();
  }
}
function applyModeLabels() {
  for (const m of MODES) {
    m.label = (modeLabelsCustom[m.id] || DEFAULT_MODES.find(d => d.id === m.id)?.label || m.id);
  }
}
export async function setModeLabel(id, label) {
  const trimmed = String(label || '').trim();
  if (!trimmed) return resetModeLabel(id);
  const def = DEFAULT_MODES.find(d => d.id === id);
  if (!def) return;
  if (trimmed === def.label) {
    delete modeLabelsCustom[id];
  } else {
    modeLabelsCustom[id] = trimmed;
  }
  await dbSetKV(MODE_LABELS_KEY, modeLabelsCustom);
  applyModeLabels();
  document.dispatchEvent(new CustomEvent('mode-labels-changed'));
}
export async function resetModeLabel(id) {
  delete modeLabelsCustom[id];
  await dbSetKV(MODE_LABELS_KEY, modeLabelsCustom);
  applyModeLabels();
  document.dispatchEvent(new CustomEvent('mode-labels-changed'));
}
export async function resetAllModeLabels() {
  modeLabelsCustom = {};
  await dbSetKV(MODE_LABELS_KEY, modeLabelsCustom);
  applyModeLabels();
  document.dispatchEvent(new CustomEvent('mode-labels-changed'));
}

function migrate(t) {
  if (!t || typeof t !== 'object') return null;
  if (!t.id) return null;
  if (!t.days) {
    t.days = {};
    if (t.plannedFor) {
      t.days[t.plannedFor] = t.status && t.status !== 'todo' ? t.status : 'todo';
      delete t.plannedFor; delete t.status;
    }
  }
  if (!Array.isArray(t.subtasks)) t.subtasks = [];
  if (!Array.isArray(t.sessions)) t.sessions = [];
  if (!Array.isArray(t.files)) t.files = [];
  if (t.type === 'recurring') t.type = 'task';
  if (!t.createdAt) t.createdAt = new Date().toISOString();
  if (!t.updatedAt) t.updatedAt = t.createdAt;
  return t;
}
export async function init() {
  state.tasks = (await dbAll('tasks')).map(migrate).filter(Boolean);
  await loadTagsDict();
  await loadModeLabels();
  const m = await dbGetKV('mode');
  if (MODES.some(x => x.id === m)) state.mode = m;
  state.view = 'week';
  state.hideDone = !!(await dbGetKV('hideDone'));
  await applyLocalTombstones();
}
async function applyLocalTombstones() {
  if (!tombstones.length) return;
  const ids = new Set(tombstones.map(t => t.id));
  let changed = false;
  state.tasks = state.tasks.filter(t => {
    if (ids.has(t.id)) { changed = true; return false; }
    return true;
  });
  if (changed) {
    try { await dbBulk('tasks', state.tasks); } catch (e) { console.error(e); }
  }
}

/* ── Скрытие выполненных задач (неделя/день), настройка локальная ── */
export async function setHideDone(v) {
  state.hideDone = !!v;
  await dbSetKV('hideDone', state.hideDone);
  notify();
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function isDone(t) {
  const vals = Object.values(t.days || {});
  if (!vals.length) return false;
  if (vals.some(s => s === 'todo' || s === 'started')) return false;
  return vals.some(s => s === 'done' || s === 'skipped');
}
export const visibleTasks = () => state.tasks.filter(t => !t.deleted && (state.mode === 'all' || t.mode === state.mode));
export const sortTasks = arr => arr.slice().sort((a, b) => {
  const da = isDone(a), db2 = isDone(b);
  if (da !== db2) return da ? 1 : -1;
  if (da && db2) return completionDay(a).localeCompare(completionDay(b));
  return a.priority - b.priority || a.createdAt.localeCompare(b.createdAt);
});
function completionDay(t) {
  const done = Object.entries(t.days || {}).filter(([d, s]) => s === 'done' || s === 'skipped').map(([d]) => d).sort();
  if (done.length) return done[done.length - 1];
  return String(t.doneAt || t.updatedAt || '').slice(0, 10);
}
export function tasksForDay(day) {
  let list = visibleTasks().filter(t => (t.days || {})[day]);
  if (state.hideDone) list = list.filter(t => !isDone(t));
  return sortTasks(list);
}
export function weekRows(ws) {
  const we = addDays(ws, 6);
  const cur = mondayOf(today()) === ws;
  let list = visibleTasks().filter(t => {
    const d = t.days || {};
    const keys = Object.keys(d);
    if (keys.some(k => k >= ws && k <= we)) return true;
    if (keys.length === 0) return cur;
    return false;
  });
  if (state.hideDone) list = list.filter(t => !isDone(t));
  return sortTasks(list);
}
export const getTask = id => state.tasks.find(t => t.id === id);
export async function createTask(data) {
  const now = new Date().toISOString();
  const t = {
    id: uid(), title: data.title.trim(), mode: data.mode || (state.mode === 'all' ? 'work' : state.mode),
    type: data.type || 'task', priority: data.priority || 2, receivedAt: data.receivedAt || today(),
    days: data.days || {}, blockStart: data.blockStart ?? null, blockMin: data.blockMin || 30,
    spentMin: 0, sessions: [], tags: data.tags || [], notes: '', files: [], subtasks: data.subtasks || [],
    doneAt: null, createdAt: now, updatedAt: now
  };
  removeTombstone(t.id);
  state.tasks.push(t);
  await dbPut('tasks', t);
  notify();
  userChange();
  hapticLight();
  return t;
}
export async function updateTask(id, patch) {
  const t = getTask(id);
  if (!t) return;
  Object.assign(t, patch, { updatedAt: new Date().toISOString() });
  await dbPut('tasks', t);
  notify();
  userChange();
}
export async function removeTask(id) {
  const t = getTask(id);
  if (!t) return;
  addTombstone(id);
  state.tasks = state.tasks.filter(x => x.id !== id);
  try { await dbDel('tasks', id); } catch (e) { console.error('[store] dbDel failed:', e); }
  notify();
  userChange();
  hapticMedium();
}
/* Заполняет промежуток «перенесено» между последней отметкой
   выполнено/отменено (или предыдущей отметкой вообще) и днём day.
   Работает по календарным дням, а не только по уже отмеченным, чтобы
   ряд квадратов читался непрерывно. Ограничение в 60 дней — защита от
   случайной отметки на далёкой дате. */
const GAP_LIMIT = 60;
export function fillPostponedGap(days, day) {
  const keys = Object.keys(days).filter(d => d < day).sort();
  if (!keys.length) return days;
  let anchor = null;
  for (let i = keys.length - 1; i >= 0; i--) {
    const st = days[keys[i]];
    if (st === 'done' || st === 'skipped') { anchor = keys[i]; break; }
  }
  if (!anchor) anchor = keys[0];
  const span = Math.round((parseISO(day) - parseISO(anchor)) / 86400000);
  if (span < 2 || span > GAP_LIMIT) return days;
  for (let i = 1; i < span; i++) {
    const d = addDays(anchor, i);
    const st = days[d];
    if (st === 'done' || st === 'skipped') continue;   // чужие итоги не трогаем
    days[d] = 'postponed';
  }
  return days;
}

/* ══════════════════════════════════════════════════════════════════
   Переход суток.

   В 00:00 всё, что осталось «Запланировано» на прошедшем дне,
   становится «Перенесено», а сама задача переезжает на наступивший
   день — уже как «Запланировано». Начатые задачи тоже переносятся:
   работа не закончена. Выполненное и отменённое не трогаем.
   ══════════════════════════════════════════════════════════════════ */
const ROLL_KEY = 'rl_last_rollover';
export async function rolloverDay(force) {
  const t0 = today();
  let last = '';
  try { last = localStorage.getItem(ROLL_KEY) || ''; } catch (e) {}
  if (!force && last === t0) return 0;
  let moved = 0;
  for (const t of state.tasks) {
    if (!t || t.deleted) continue;
    const days = { ...(t.days || {}) };
    let touched = false;
    for (const d of Object.keys(days)) {
      if (d >= t0) continue;                       // сегодня и будущее не трогаем
      if (days[d] !== 'todo' && days[d] !== 'started') continue;
      days[d] = 'postponed';
      touched = true;
    }
    if (!touched) continue;
    if (!days[t0]) days[t0] = 'todo';              // задача переезжает на сегодня
    await updateTask(t.id, { days });
    moved++;
  }
  try { localStorage.setItem(ROLL_KEY, t0); } catch (e) {}
  if (moved) notify();
  return moved;
}
/* Таймер до ближайшей полуночи + запас в пару секунд */
export function scheduleRollover(onDone) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 3);
  const wait = Math.max(1000, next - now);
  setTimeout(async () => {
    const n = await rolloverDay();
    if (onDone) onDone(n);
    scheduleRollover(onDone);
  }, wait);
}

export async function setEntry(id, day, status) {
  const t = getTask(id);
  if (!t) return;
  const days = { ...(t.days || {}) };
  if (status) days[day] = status; else delete days[day];
  if (status === 'postponed') { const nd = addDays(day, 1); if (!days[nd]) days[nd] = 'todo'; }
  /* Новое «Запланировано» подтягивает за собой хвост переносов:
     от последней завершённой или отменённой отметки и до этого дня
     задача считается переносившейся — иначе в ряду остаются дыры. */
  if (status === 'todo') fillPostponedGap(days, day);
  const vals = Object.values(days);
  const done = vals.length > 0 && !vals.some(s => s === 'todo' || s === 'started') && vals.some(s => s === 'done' || s === 'skipped');
  const patch = { days };
  if (done && !t.doneAt) patch.doneAt = new Date().toISOString();
  if (!done && t.doneAt) patch.doneAt = null;
  await updateTask(id, patch);
  if (status === 'done') hapticSuccess();
  else if (status === 'skipped') hapticMedium();
  else if (status) hapticLight();
}
export async function postponeFrom(id, day) {
  const t = getTask(id);
  if (!t) return;
  const days = { ...(t.days || {}) };
  days[day] = 'postponed';
  const nd = addDays(day, 1);
  if (!days[nd]) days[nd] = 'todo';
  t.days = days;
  t.doneAt = null;
  t.updatedAt = new Date().toISOString();
  await dbPut('tasks', t);
  notify();
  userChange();
  hapticLight();
}
export async function applyMerged(payload) {
  const remoteTasks = Array.isArray(payload && payload.tasks) ? payload.tasks : [];
  const remoteTombstones = Array.isArray(payload && payload.tombstones) ? payload.tombstones : [];
  mergeTombstones(remoteTombstones);
  const tombSet = new Set(tombstones.map(t => t.id));
  if (remoteTasks.length === 0 && remoteTombstones.length === 0 && state.tasks.length > 0) {
    console.warn('[store] applyMerged: server returned nothing, keeping local');
    return;
  }
  const byId = new Map();
  for (const t of state.tasks) {
    if (t && t.id && !tombSet.has(t.id)) byId.set(t.id, t);
  }
  for (const rt of remoteTasks) {
    const m = migrate(rt);
    if (!m || !m.id) continue;
    if (tombSet.has(m.id)) continue;
    const local = byId.get(m.id);
    if (!local) byId.set(m.id, m);
    else if (String(m.updatedAt || '') >= String(local.updatedAt || '')) byId.set(m.id, m);
  }
  const merged = [...byId.values()].filter(t => !t.deleted && !tombSet.has(t.id));
  state.tasks = merged;
  try { await dbBulk('tasks', state.tasks); }
  catch (err) { console.error('[store] dbBulk failed:', err); }
  notify();
}
export async function setMode(m) {
  state.mode = m;
  await dbSetKV('mode', m);
  notify();
  userChange();
  hapticLight();
}
export async function addSubtask(id, text) {
  const t = getTask(id);
  if (!t) return;
  await updateTask(id, { subtasks: [...(t.subtasks || []), { id: uid(), text, done: false }] });
}
export async function toggleSubtask(id, sid) {
  const t = getTask(id);
  if (!t) return;
  await updateTask(id, { subtasks: (t.subtasks || []).map(s => s.id === sid ? { ...s, done: !s.done } : s) });
  hapticLight();
}
export async function delSubtask(id, sid) {
  const t = getTask(id);
  if (!t) return;
  await updateTask(id, { subtasks: (t.subtasks || []).filter(s => s.id !== sid) });
}
export async function updateSubtask(id, sid, patch) {
  const t = getTask(id);
  if (!t) return;
  const s = (t.subtasks || []).find(x => x.id === sid);
  if (!s) return;
  Object.assign(s, patch);
  await updateTask(id, { subtasks: t.subtasks });
}
/* ── Полуночный авто-перенос: «Запланировано» вчера → «Перенесено», сегодня → «Запланировано» ── */
let _lastToday = today();
export function checkDayRollover() {
  const t0 = today();
  if (t0 === _lastToday) return;
  const old = _lastToday;
  _lastToday = t0;
  let changed = false;
  for (const t of state.tasks) {
    const d = t.days || {};
    if (d[old] === 'todo') {           // только «Запланировано», «Начато» не трогаем
      d[old] = 'postponed';
      if (!d[t0]) d[t0] = 'todo';
      t.doneAt = null;
      t.updatedAt = new Date().toISOString();
      dbPut('tasks', t);
      changed = true;
    }
  }
  if (changed) { notify(); userChange(); }
}

const DEFAULT_MODE_COLORS = { work: '#dc2626', home: '#16a34a', study: '#2563eb', all: '#d4a017' };
let modeColors = { ...DEFAULT_MODE_COLORS };
export const getModeColors = () => ({ ...modeColors });
export const getDefaultModeColors = () => ({ ...DEFAULT_MODE_COLORS });
export async function loadModeColors() {
  const saved = await dbGetKV('modeColors');
  if (saved && typeof saved === 'object') modeColors = { ...DEFAULT_MODE_COLORS, ...saved };
  applyModeColorsToCSS();
}
export async function setModeColor(mode, color) {
  modeColors[mode] = color;
  await dbSetKV('modeColors', modeColors);
  applyModeColorsToCSS();
  userChange();
}
export async function resetModeColors() {
  modeColors = { ...DEFAULT_MODE_COLORS };
  await dbSetKV('modeColors', modeColors);
  applyModeColorsToCSS();
  userChange();
}
function applyModeColorsToCSS() {
  const r = document.documentElement;
  r.style.setProperty('--mode-work', modeColors.work);
  r.style.setProperty('--mode-home', modeColors.home);
  r.style.setProperty('--mode-study', modeColors.study);
  r.style.setProperty('--mode-all', modeColors.all);
}

const normTag = t => (typeof t === 'string' ? { name: t, color: null } : { name: String((t && t.name) || ''), color: (t && t.color) || null });
let tagsCache = [];
let tagsDeletedCache = [];
export const getTagsDict = () => tagsCache;
export const getTagsDeleted = () => tagsDeletedCache;
export const getTagColor = name => {
  const t = tagsCache.find(x => x.name.toLowerCase() === String(name).toLowerCase());
  return t && t.color ? t.color : null;
};
async function loadTagsDict() {
  const v = await dbGetKV('tagsDict');
  tagsCache = (Array.isArray(v) ? v : []).map(normTag).filter(t => t.name);
  const d = await dbGetKV('tagsDeleted');
  tagsDeletedCache = Array.isArray(d) ? d : [];
}
export async function saveTagsMeta(tags, deleted) {
  tagsCache = (tags || []).map(normTag).filter(t => t.name);
  tagsDeletedCache = (deleted || []).filter(Boolean);
  await dbSetKV('tagsDict', tagsCache);
  await dbSetKV('tagsDeleted', tagsDeletedCache);
}
export async function addTagsToDict(names) {
  const dict = tagsCache.slice();
  const deleted = tagsDeletedCache.slice();
  let ch = false;
  for (const n of names) {
    const l = String(n).toLowerCase();
    const di = deleted.indexOf(l);
    if (di >= 0) { deleted.splice(di, 1); ch = true; }
    if (!dict.some(t => t.name.toLowerCase() === l)) { dict.push({ name: n, color: null }); ch = true; }
  }
  if (ch) {
    tagsCache = dict;
    tagsDeletedCache = deleted;
    await dbSetKV('tagsDict', dict);
    await dbSetKV('tagsDeleted', deleted);
    userChange();
  }
  return dict;
}
export async function setTagColor(name, color) {
  await saveTagsMeta(tagsCache.map(t => t.name === name ? { ...t, color } : t), tagsDeletedCache);
  userChange();
}
export async function renameTag(oldName, newName) {
  const nn = String(newName || '').trim();
  if (!nn || nn === oldName) return;
  const seen = new Set();
  const next = [];
  for (const t of tagsCache) {
    const name = t.name === oldName ? nn : t.name;
    const l = name.toLowerCase();
    if (seen.has(l)) continue;
    seen.add(l);
    next.push({ ...t, name });
  }
  await saveTagsMeta(next, tagsDeletedCache.includes(oldName.toLowerCase()) ? tagsDeletedCache : [...tagsDeletedCache, oldName.toLowerCase()]);
  for (const t of state.tasks) {
    if ((t.tags || []).includes(oldName)) {
      const s2 = new Set();
      const nt = [];
      for (const x of t.tags) {
        const name = x === oldName ? nn : x;
        const l = name.toLowerCase();
        if (!s2.has(l)) { s2.add(l); nt.push(name); }
      }
      t.tags = nt;
      t.updatedAt = new Date().toISOString();
      await dbPut('tasks', t);
    }
  }
  notify();
  userChange();
}
export async function deleteTag(name) {
  await saveTagsMeta(tagsCache.filter(t => t.name !== name), [...tagsDeletedCache, name.toLowerCase()]);
  for (const t of state.tasks) {
    if ((t.tags || []).includes(name)) {
      t.tags = t.tags.filter(x => x !== name);
      t.updatedAt = new Date().toISOString();
      await dbPut('tasks', t);
    }
  }
  notify();
  userChange();
}

/* ══════════════════════════════════════════════════════════════════
   Планирование задачи по таймлайну.

   План — это строка «дата + начало + конец». Планов у задачи может
   быть несколько: задача живёт на нескольких днях, и на каждом дне у
   неё своё окно. Источник по умолчанию — завершённые сессии
   фокусировки: начало берём у самой ранней сессии этого дня, конец —
   у самой поздней, строго в пределах одного дня. Вручную заданное
   окно приоритетнее и сессиями не перетирается.
   ══════════════════════════════════════════════════════════════════ */
export const hmToMin = hm => {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
export const minToHM = min => {
  const v = Math.max(0, Math.min(1439, Math.round(min)));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};
/* Отметка времени изменения: у сессии — момент её завершения, у
   старых записей без поля восстанавливаем из даты и времени конца. */
const stampOf = s => s && s.at ? s.at : `${s.date}T${(s.end || s.start || '00:00')}:00`;
/* Окна из сессий фокусировки, сгруппированные по дням */
export function plansFromSessions(t) {
  const byDay = new Map();
  for (const s of (t.sessions || [])) {
    if (!s || !s.date || !s.start) continue;
    const cur = byDay.get(s.date)
      || { date: s.date, start: hmToMin(s.start), end: hmToMin(s.end || s.start), at: stampOf(s) };
    cur.start = Math.min(cur.start, hmToMin(s.start));
    cur.end = Math.max(cur.end, hmToMin(s.end || s.start));
    const st = stampOf(s);
    if (st > cur.at) cur.at = st;
    byDay.set(s.date, cur);
  }
  return [...byDay.values()].map(p => ({
    date: p.date, start: minToHM(p.start), end: minToHM(Math.max(p.end, p.start + 15)),
    auto: true, at: p.at,
  }));
}
/* Итоговый список планов.

   Ручная правка и таймер фокусировки равноправны: побеждает та, что
   была позже. Поэтому у каждой строки хранится отметка времени, и на
   одну дату берётся более свежая из двух. */
export function taskPlans(t) {
  if (!t) return [];
  const out = new Map();
  for (const p of plansFromSessions(t)) out.set(p.date, p);
  for (const p of (t.plans || [])) {
    if (!p || !p.date || !p.start) continue;
    const auto = out.get(p.date);
    const manual = { ...p, auto: false, at: p.at || '' };
    if (!auto || String(manual.at) >= String(auto.at)) out.set(p.date, manual);
  }
  if (t.blockStart) {
    for (const d of Object.keys(t.days || {})) {
      if (out.has(d)) continue;
      const s = hmToMin(t.blockStart);
      out.set(d, { date: d, start: minToHM(s), end: minToHM(s + (t.blockMin || 30)), auto: true, at: '' });
    }
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}
export function plansForDay(t, day) {
  return taskPlans(t).filter(p => p.date === day);
}
export async function setTaskPlan(taskId, date, start, end) {
  const t = getTask(taskId);
  if (!t) return;
  const plans = (t.plans || []).filter(p => p && p.date !== date);
  plans.push({ date, start, end, at: new Date().toISOString() });
  plans.sort((a, b) => a.date.localeCompare(b.date));
  await updateTask(taskId, { plans });
}
export async function removeTaskPlan(taskId, date) {
  const t = getTask(taskId);
  if (!t) return;
  await updateTask(taskId, { plans: (t.plans || []).filter(p => p && p.date !== date) });
}
