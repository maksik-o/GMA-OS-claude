/* ══════════════════════════════════════════════════════════════════
   Режим «База знаний».

   Заметки, разложенные по группам, со связями между собой и
   вложенными файлами. Всё в одном сторе IndexedDB ('kb'), тип записи
   в поле kind — так же, как сделаны финансы: не нужно поднимать
   версию базы под каждую новую сущность.

   Файлы лежат отдельно, в сторе 'kbfiles' (base64). В синхронизацию
   уходят только метаданные — сами файлы остаются на устройстве,
   иначе один вложенный PDF раздул бы полезную нагрузку sync.
   ══════════════════════════════════════════════════════════════════ */
import { dbAll, dbPut, dbBulk, dbGet, dbDel } from './db.js';
import { uid, esc, MODES } from './store.js';
import { getAllNotes, updateNoteById, deleteNote } from './notes.js';
import { createGraph } from './kbgraph.js';
import { fmtSize, saveAttachment, loadAttachment, deleteAttachment, downloadBlob, limitNote } from './attach.js';

const STORE = 'kb';
const FILES = 'kbfiles';
const state = { items: [] };
const listeners = [];
export const kbSubscribe = fn => listeners.push(fn);
let pending = false;
const notify = () => {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; listeners.forEach(fn => fn()); }, 50);
};
const userChange = () => document.dispatchEvent(new CustomEvent('user-change'));

const DEFAULT_GROUPS = [
  { id: 'kb-work', name: 'Работа', color: '#dc2626' },
  { id: 'kb-home', name: 'Дом', color: '#16a34a' },
  { id: 'kb-study', name: 'Учёба', color: '#2563eb' },
];
const PALETTE = ['#ef4444', '#f59e0b', '#10b981', '#2563eb', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

const all = kind => state.items.filter(i => i.kind === kind && !i.deleted);
/* Три стандартные группы — это режимы. Их название и цвет берём из
   «Настроек режимов» при каждом показе, пока пользователь не задал
   группе свои. Иначе смена названия или цвета режима до базы знаний
   не доходила: там оставались «Работа» и старый красный. */
const MODE_OF_GROUP = { 'kb-work': 'work', 'kb-home': 'home', 'kb-study': 'study' };
function withMode(g) {
  const m = MODE_OF_GROUP[g.id];
  if (!m) return g;
  const mode = MODES.find(x => x.id === m) || {};
  return {
    ...g,
    name: g.customName ? g.name : (mode.label || g.name),
    color: g.customColor ? g.color : `var(--mode-${m})`,
  };
}
export const kbGroups = () => all('group').map(withMode).sort((a, b) => (a.order || 0) - (b.order || 0));
export const kbNotes = () => [...all('note'), ...dailyNotes()]
  .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
const rawItem = id => state.items.find(i => i.id === id);
export const kbItem = id => {
  if (isDaily(id)) return dailyNotes().find(n => n.id === id) || null;
  const it = state.items.find(i => i.id === id);
  return it && it.kind === 'group' ? withMode(it) : it;
};

export async function init() {
  state.items = await dbAll(STORE);
  if (!all('group').length) {
    for (let i = 0; i < DEFAULT_GROUPS.length; i++) {
      const g = {
        ...DEFAULT_GROUPS[i], kind: 'group', order: i,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      state.items.push(g);
      await dbPut(STORE, g);
    }
  }
}
async function put(it) {
  it.updatedAt = new Date().toISOString();
  await dbPut(STORE, it);
  notify();
  userChange();
}
export async function kbSave(kind, data, id) {
  if (isDaily(id)) {
    const patch = {};
    if ('title' in data) patch.title = data.title;
    if ('html' in data) patch.html = data.html;
    if ('groupId' in data) {
      patch.kbGroupId = data.groupId;
      const m = groupMode(data.groupId);
      if (m) patch.mode = m;   // для трёх стандартных групп заодно чиним точку в панели
    }
    if ('files' in data) patch.files = data.files;
    if ('links' in data) patch.links = data.links;
    await updateNoteById(dailyRealId(id), patch);
    notify();
    return kbItem(id);
  }
  let it = id ? rawItem(id) : null;
  if (!it) {
    it = { id: uid(), kind, createdAt: new Date().toISOString() };
    state.items.push(it);
  }
  Object.assign(it, data);
  await put(it);
  return it;
}
export async function kbRemove(id) {
  if (isDaily(id)) {
    const it = kbItem(id);
    for (const f of (it && it.files) || []) await dropFile(f);
    await deleteNote(dailyRealId(id));
    notify();
    return;
  }
  const it = rawItem(id);
  if (!it) return;
  if (it.kind === 'note') for (const f of it.files || []) await dropFile(f);
  if (it.kind === 'group') {
    /* Подгруппы и заметки поднимаются на уровень выше, а не теряются */
    const up = it.parentId || '';
    for (const x of state.items) {
      if (x.deleted) continue;
      if (x.kind === 'note' && x.groupId === id) { x.groupId = up; x.updatedAt = new Date().toISOString(); await dbPut(STORE, x); }
      if (x.kind === 'group' && x.parentId === id) { x.parentId = up; x.updatedAt = new Date().toISOString(); await dbPut(STORE, x); }
    }
    for (const n of getAllNotes()) if (n.kbGroupId === id) await updateNoteById(n.id, { kbGroupId: up });
  }
  it.deleted = true;
  await put(it);
}

/* ── Синхронизация ── */
export const getKbForSync = () => state.items.map(i =>
  i.kind === 'note' ? { ...i, files: (i.files || []).map(f => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, ...(f.src ? { src: f.src } : {}) })) } : i);
export async function applyKbMerged(list) {
  const remote = Array.isArray(list) ? list : [];
  const byId = new Map();
  for (const i of state.items) if (i && i.id) byId.set(i.id, i);
  for (const r of remote) {
    if (!r || !r.id) continue;
    const local = byId.get(r.id);
    if (!local || String(r.updatedAt || '') >= String(local.updatedAt || '')) byId.set(r.id, r);
  }
  state.items = [...byId.values()];
  try { await dbBulk(STORE, state.items); } catch (e) { console.error('[kb] dbBulk:', e); }
  notify();
}

/* ── Файлы ── */
const MAX_FILE = 8 * 1024 * 1024;
export { fmtSize };
async function attach(noteId, file) {
  const meta = await saveAttachment(file, MAX_FILE, '8 МБ');
  const n = kbItem(noteId);
  if (!n) { await deleteAttachment(meta); return; }
  await kbSave('note', { files: [...(n.files || []), meta] }, noteId);
}
/* Вложение: общий механизм (устройство/облако), а для старых —
   base64 в сторе kbfiles, только на том устройстве, где добавили */
async function openAttachment(f) {
  try {
    const blob = f.src ? await loadAttachment(f) : null;
    if (blob) { downloadBlob(blob, f.name); return; }
  } catch (e) { alert('Не удалось открыть: ' + ((e && e.message) || e)); return; }
  const rec = await dbGet(FILES, f.id).catch(() => null);
  if (!rec || !rec.data) { alert('Файл доступен только на устройстве, где его добавили.'); return; }
  const a = document.createElement('a');
  a.href = rec.data;
  a.download = f.name || 'file';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
const dropFile = f => (f.src ? deleteAttachment(f) : dbDel(FILES, f.id)).catch(() => {});

/* ══════════════ ПРЕДСТАВЛЕНИЕ ══════════════

   Раньше каждый вызов перерисовывал всю вкладку через innerHTML —
   а вызывался он на каждое автосохранение (kbSave → notify →
   renderCurrent). Редактор пересоздавался прямо под пальцами: терялись
   курсор, выделение и только что набранные буквы.

   Теперь каркас (боковая панель + основная область) строится один раз,
   а дальше обновляется по частям:
   • список и группы — только если их разметка действительно изменилась;
   • открытая заметка — редактор не трогаем, пока она открыта; чужие
     правки (синхронизация) подставляем, лишь когда поле не в фокусе;
   • миниатюра текущей заметки в списке меняется прямо при наборе,
     без перерисовки. */
let curGroup = '';     // '' — все
const LOOSE = '__none';   // заметки без группы (в т.ч. с удалённой группой)
const openGroups = new Set();
let curNote = null;
let notesOpen = false;      // колонка заметок выбранной группы: скрыта, пока группу не выбрали
let query = '';
let _host = null;
let view = 'note';         // 'note' | 'graph'
let graphScope = 'all';    // 'all' | 'local'
let graphDepth = 1;
let hideOrphans = false;
let graph = null;
/* Открытая в редакторе заметка: { id, title, ed, lastTitle, lastHtml, srcHtml, frozenAt, timer } */
let editing = null;

const plain = html => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const titleOf = n => (n.title || '').trim() || plain(n.html).slice(0, 40) || 'Без названия';

/* ── Ежедневные заметки из панели-виджета ──
   Они живут в своём сторе ('notes') и раньше в базу знаний не
   попадали. Показываем их здесь как обычные заметки с префиксом id;
   правки уходят обратно в тот же стор, так что панель и база всегда
   показывают одно и то же. Группа выводится из режима заметки:
   перенос в другую группу меняет режим — и точку в панели. */
const DAILY = 'daily:';
const isDaily = id => typeof id === 'string' && id.startsWith(DAILY);
const dailyRealId = id => String(id).slice(DAILY.length);
const modeGroup = m => 'kb-' + (m || 'work');
const groupMode = gid => (MODES.find(m => 'kb-' + m.id === gid) || {}).id || '';
function dailyNotes() {
  return getAllNotes().filter(n => plain(n.html) || (n.title || '').trim()).map(n => ({
    id: DAILY + n.id,
    kind: 'note',
    title: (n.title || '').trim() || `Заметка ${n.day || ''}`.trim(),
    html: n.html || '',
    /* Своя группа базы знаний важнее режима: иначе перенос в
       произвольную группу не «прилипал» — режима с таким id нет,
       и заметка возвращалась туда, где была. */
    groupId: n.kbGroupId || modeGroup(n.mode),
    files: n.files || [], links: n.links || [], daily: true, day: n.day,
    createdAt: n.createdAt, updatedAt: n.updatedAt,
  }));
}

/* ── Связи ──
   Два вида: явные (поле links, двусторонние, ставятся кнопкой
   «Связать») и ссылки прямо в тексте — [[Название]], которые
   редактор превращает в <a class="kb-ref" data-kbref="id">.
   Для графа и «Упоминаний» берём оба. */
const REF_RE = /data-kbref="([^"]+)"/g;
const refsOf = n => {
  const out = [];
  String((n && n.html) || '').replace(REF_RE, (_, id) => { out.push(id); return ''; });
  return out;
};
const outLinks = n => [...new Set([...(n.links || []), ...refsOf(n)])].filter(id => id !== n.id);
const backlinksOf = (id, notes) => notes.filter(x => x.id !== id && refsOf(x).includes(id));
const groupColor = gid => { const g = gid && kbItem(gid); return g ? g.color : 'var(--dim)'; };

async function setLink(aId, bId, on) {
  const toggle = (x, other) => {
    const l = new Set(x.links || []);
    if (on) l.add(other); else l.delete(other);
    return [...l];
  };
  const a = kbItem(aId), b = kbItem(bId);
  /* Связь двусторонняя: иначе из второй заметки первую не найти */
  if (a) await kbSave('note', { links: toggle(a, bId) }, aId);
  if (b) await kbSave('note', { links: toggle(b, aId) }, bId);
}

/* ── Каркас ── */
export function renderKbView(el) {
  if (!el) return;
  if (_host !== el || !el.querySelector(':scope > .kb-side')) buildShell(el);
  _host = el;
  if (curNote && !kbItem(curNote)) curNote = null;
  renderSide();
  renderMain();
}

function buildShell(el) {
  el.innerHTML = `
    <aside class="kb-side">
      <div class="kb-search"><input class="kb-q" type="search" placeholder="Поиск по базе" value="${esc(query)}"></div>
      <div class="kb-tools">
        <button type="button" class="btn mini kb-tool kb-to-graph" title="Граф связей между заметками">◉ Граф</button>
        <button type="button" class="btn mini kb-tool kb-to-struct" title="Структура: группы колонками, заметки раскладываются перетаскиванием">▦ Структура</button>
      </div>
      <div class="kb-groups"></div>
    </aside>
    <section class="kb-notes" aria-label="Заметки группы">
      <div class="kb-notes-in">
        <header class="kb-notes-head"><button type="button" class="kb-notes-back" title="К группам" aria-label="К группам">‹</button><span class="kb-notes-dot"></span><b class="kb-notes-title"></b><span class="kb-notes-n"></span></header>
        <div class="kb-list"></div>
        <button type="button" class="kb-notes-grip" title="Свернуть список заметок" aria-label="Свернуть список заметок"></button>
      </div>
    </section>
    <main class="kb-main"></main>
    <section class="kb-board" data-drop="${LOOSE}" aria-label="Структура базы знаний"></section>`;
  const side = el.querySelector('.kb-side');
  const qi = side.querySelector('.kb-q');
  qi.oninput = () => { query = qi.value; if (query.trim()) notesOpen = true; renderSide(); };
  qi.onkeydown = e => {
    if (e.key !== 'Enter') return;
    const first = el.querySelector('.kb-list .kb-item');
    if (first) openNote(first.dataset.id);
  };
  side.addEventListener('click', onSideClick);
  el.querySelector('.kb-notes').addEventListener('click', onSideClick);
  bindNotesGrip(el);
  bindNoteDrag(el, el);
  bindGroupDrag(side);
  el.querySelector('.kb-board').addEventListener('click', onBoardClick);
  bindBoardDrag(el.querySelector('.kb-board'));
  /* Название новой группы: сохраняем по Enter или когда поле теряет фокус */
  const boardEl = el.querySelector('.kb-board');
  const saveName = async inp => {
    const v = inp.value.trim();
    if (!v || inp._saved) return;
    inp._saved = true;
    if (freshId === inp.dataset.gid) freshId = null;
    await kbSave('group', { name: v }, inp.dataset.gid);
  };
  boardEl.addEventListener('keydown', e => { if (e.target.classList.contains('kb-bcol-input') && e.key === 'Enter') { e.preventDefault(); saveName(e.target); } });
  boardEl.addEventListener('focusout', e => { if (e.target.classList.contains('kb-bcol-input')) saveName(e.target); });
}

/* Ручка колонки заметок: тап — свернуть, свайп влево — колонка едет
   за пальцем и уезжает, если протянули достаточно далеко. */
function bindNotesGrip(el) {
  const grip = el.querySelector('.kb-notes-grip');
  const panel = el.querySelector('.kb-notes-in');
  let sx = 0, dx = 0, pid = null, moved = false;
  grip.addEventListener('pointerdown', e => {
    pid = e.pointerId; sx = e.clientX; dx = 0; moved = false;
    try { grip.setPointerCapture(pid); } catch {}
  });
  grip.addEventListener('pointermove', e => {
    if (e.pointerId !== pid) return;
    dx = Math.min(0, e.clientX - sx);
    if (!moved && dx > -6) return;
    moved = true;
    panel.style.transition = 'none';
    panel.style.transform = `translateX(${dx}px)`;
  });
  const end = e => {
    if (e.pointerId !== pid) return;
    pid = null;
    panel.style.transition = '';
    panel.style.transform = '';
    /* Тап или достаточно длинный свайп — сворачиваем; короткий — пружиним назад */
    if (!moved || dx < -50) { notesOpen = false; renderSide(); }
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

/* На телефоне основная область стоит под списком — подкручиваем к ней */
function revealMain() {
  if (!_host || !matchMedia('(max-width: 720px)').matches) return;
  const main = _host.querySelector('.kb-main');
  if (main) main.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function openNote(id, focusEditor) {
  flushEditor();
  curNote = id;
  view = 'note';
  renderKbView(_host);
  revealMain();
  if (focusEditor && _host) {
    const t = _host.querySelector('.kb-title');
    if (t) t.focus();
  }
}

let dragGuard = 0;   // после перетаскивания браузер шлёт click — его пропускаем
function onSideClick(e) {
  if (Date.now() - dragGuard < 250) return;
  const t = e.target;
  if (t.closest('.kb-to-graph')) {
    flushEditor();
    if (view === 'structure') { setStructure(false); return; }
    /* Окно заметки уезжает вправо, на его место выезжает граф (и обратно) */
    swapMainAnimated(() => {
      view = view === 'graph' ? 'note' : 'graph';
      renderKbView(_host);
      if (view === 'graph') revealMain();
    });
    return;
  }
  if (t.closest('.kb-to-struct')) { setStructure(view !== 'structure'); return; }
  if (t.closest('.kb-notes-back')) { notesOpen = false; renderSide(); return; }
  if (t.closest('.kb-notes-grip')) return;   // сворачивает обработчик ручки (тап и свайп)
  if (t.closest('.kb-g-new')) { openGroupSheet(null, _host); return; }
  const item = t.closest('.kb-item');
  if (item) { openNote(item.dataset.id); return; }
  const g = t.closest('.kb-g[data-g]');
  if (!g) return;
  const gid = g.dataset.g;
  if (t.classList.contains('kb-g-caret')) {
    if (openGroups.has(gid)) openGroups.delete(gid);
    else openGroups.add(gid);
    renderSide();
    return;
  }
  /* И карандаш, и сам кружок ведут в одно окно: там же меняется
     и название, и цвет. */
  if (t.classList.contains('kb-g-edit') || t.classList.contains('kb-g-dot')) {
    if (gid && gid !== LOOSE) openGroupSheet(gid, _host);
    return;
  }
  /* Повторный тап по открытой группе прячет колонку заметок */
  if (curGroup === gid && notesOpen) notesOpen = false;
  else { curGroup = gid; notesOpen = true; }
  renderSide();
  if (view === 'graph') renderMain();
}

/* Порядок «свежие сверху», но открытая заметка держит место, пока её
   правят: иначе она прыгала бы в начало списка на первой же букве. */
const sortKey = n => (editing && editing.id === n.id ? editing.frozenAt : String(n.updatedAt || ''));
const setHTML = (node, html) => { if (node && node._html !== html) { node._html = html; node.innerHTML = html; } };

function itemHTML(n) {
  const nl = outLinks(n).length;
  return `<button type="button" class="kb-item${curNote === n.id ? ' on' : ''}" data-id="${n.id}">
    <span class="kb-item-bar" style="background:${groupColor(n.groupId)}"></span>
    <span class="kb-item-body">
      <b>${esc(titleOf(n))}</b>
      <i>${esc(plain(n.html).slice(0, 70) || 'Пусто')}</i>
      <em>${esc(String(n.updatedAt || '').slice(0, 10))}${(n.files || []).length ? ` · 📎${n.files.length}` : ''}${nl ? ` · 🔗${nl}` : ''}</em>
    </span></button>`;
}

/* ── Группы: дерево с подгруппами ──
   parentId у группы — её родитель. Заметки группы — её собственные и
   всех вложенных подгрупп. */
const childGroups = (gid, groups) => groups.filter(g => (g.parentId || '') === gid && g.id !== gid);
function groupBranch(gid, groups = kbGroups()) {
  const ids = new Set([gid]);
  let grew = true;
  while (grew) {   // обход вширь; защита от цикла — ids уже посещённые
    grew = false;
    for (const g of groups) if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) { ids.add(g.id); grew = true; }
  }
  return ids;
}

function renderSide() {
  if (!_host) return;
  const side = _host.querySelector('.kb-side');
  const groups = kbGroups();
  const known = new Set(groups.map(g => g.id));
  const allNotes = kbNotes().sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  const q = query.trim().toLowerCase();
  let notes = allNotes;
  if (curGroup && curGroup !== LOOSE && !known.has(curGroup)) curGroup = '';
  const isLoose = n => !n.groupId || !known.has(n.groupId);
  if (curGroup === LOOSE) notes = notes.filter(isLoose);
  else if (curGroup) { const br = groupBranch(curGroup, groups); notes = notes.filter(n => br.has(n.groupId)); }
  const looseN = allNotes.filter(isLoose).length;
  if (q) notes = notes.filter(n => (titleOf(n) + ' ' + plain(n.html)).toLowerCase().includes(q));
  const countIn = gid => { const br = groupBranch(gid, groups); return allNotes.filter(n => br.has(n.groupId)).length; };

  const row = (g, depth) => {
    const kids = childGroups(g.id, groups);
    const open = openGroups.has(g.id);
    return `<div class="kb-gwrap${open ? ' open' : ''}" data-drop="${g.id}" style="--depth:${depth}">
      <button type="button" class="kb-g${curGroup === g.id ? ' on' : ''}" data-g="${g.id}" style="--gc:${g.color || '#94a3b8'}">
        <span class="kb-g-caret${kids.length ? (open ? ' open' : '') : ' none'}" title="${open ? 'Свернуть подгруппы' : 'Показать подгруппы'}"></span>
        <span class="kb-g-dot"></span><span class="kb-g-name">${esc(g.name || 'Без названия')}</span>
        <span class="kb-g-n">${countIn(g.id)}</span>
        <span class="kb-g-edit" title="Изменить или добавить подгруппу">✎</span></button>
      ${open && kids.length ? `<div class="kb-sub">${kids.map(k => row(k, depth + 1)).join('')}</div>` : ''}
    </div>`;
  };
  /* Корни — группы без родителя или с удалённым родителем */
  const roots = groups.filter(g => !g.parentId || !known.has(g.parentId));

  side.querySelector('.kb-to-graph').classList.toggle('on', view === 'graph');
  side.querySelector('.kb-to-struct').classList.toggle('on', view === 'structure');
  setHTML(side.querySelector('.kb-groups'), `
    <button type="button" class="kb-g${curGroup === '' ? ' on' : ''}" data-g="" style="--gc:var(--dim)">
      <span class="kb-g-caret none"></span>
      <span class="kb-g-dot"></span><span class="kb-g-name">Все заметки</span><span class="kb-g-n">${allNotes.length}</span></button>
    ${roots.map(g => row(g, 0)).join('')}
    ${looseN ? `<div class="kb-gwrap kb-loose-row" data-drop="${LOOSE}" style="--depth:0">
      <button type="button" class="kb-g${curGroup === LOOSE ? ' on' : ''}" data-g="${LOOSE}" style="--gc:#94a3b8">
        <span class="kb-g-caret none"></span><span class="kb-g-dot"></span><span class="kb-g-name">Без группы</span><span class="kb-g-n">${looseN}</span></button></div>` : ''}
    <button type="button" class="kb-g-new">＋ Группа</button>`);

  /* Колонка заметок выбранной группы */
  const col = _host.querySelector('.kb-notes');
  const cg = curGroup ? groups.find(g => g.id === curGroup) : null;
  col.querySelector('.kb-notes-title').textContent = q ? 'Поиск' : curGroup === LOOSE ? 'Без группы' : cg ? (cg.name || 'Без названия') : 'Все заметки';
  col.querySelector('.kb-notes-n').textContent = notes.length;
  col.style.setProperty('--gc', q ? 'var(--accent)' : cg ? (cg.color || '#94a3b8') : 'var(--dim)');
  setHTML(col.querySelector('.kb-list'), notes.length
    ? notes.map(itemHTML).join('')
    : `<p class="empty">${q ? 'Ничего не найдено' : 'В группе пока нет заметок — кнопка «+» внизу создаст новую'}</p>`);
  _host.classList.toggle('kb-notes-open', notesOpen);
}

/* Миниатюра открытой заметки — прямо при наборе, без перерисовки */
function updateThumb() {
  if (!editing || !_host) return;
  const title = editing.title.value.trim();
  const text = plain(editing.ed.innerHTML);
  const label = title || text.slice(0, 40) || 'Без названия';
  _host.querySelectorAll(`.kb-list [data-id="${CSS.escape(editing.id)}"]`).forEach(node => {
    const b = node.querySelector('b'), i = node.querySelector('i');
    if (b) b.textContent = label;
    if (i) i.textContent = text.slice(0, 70) || 'Пусто';
  });
}

/* ── Основная область ── */
function renderMain() {
  if (!_host) return;
  if (view === 'structure') { renderBoard(false); return; }
  const main = _host.querySelector('.kb-main');
  const note = curNote ? kbItem(curNote) : null;
  const key = view === 'graph' ? 'graph' : note ? 'note:' + note.id : 'blank';
  const fresh = main.dataset.key !== key;
  if (fresh) {
    flushEditor();
    editing = null;
    if (graph) { graph.destroy(); graph = null; }
    main.dataset.key = key;
  }
  main.classList.toggle('kb-main-graph', view === 'graph');
  if (view === 'graph') { fresh ? buildGraph(main) : updateGraph(main); return; }
  if (!note) {
    if (fresh) main.innerHTML = `<div class="kb-blank">
      <b>База знаний</b>
      <span>Выберите заметку слева или создайте новую. Заметки можно раскладывать по группам,
      связывать между собой — кнопкой «Связать» или прямо в тексте через <code>[[</code> — и смотреть связи на графе.</span>
    </div>`;
    return;
  }
  if (fresh) buildNote(main, note);
  else softUpdateNote(main, note);
}

function groupOptions(n) {
  return `<option value="">Без группы</option>
    ${kbGroups().map(g => `<option value="${g.id}"${n.groupId === g.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}`;
}

function buildNote(main, n) {
  main.innerHTML = `
    <header class="kb-nhead">
      <input class="kb-title" type="text" maxlength="120" placeholder="Название заметки" value="${esc(n.title || '')}">
      <button type="button" class="icon-btn kb-del" title="Удалить заметку">✕</button>
    </header>
    <div class="kb-meta">
      <select class="kb-group-sel">${groupOptions(n)}</select>
      ${n.daily ? '<span class="kb-daily-tag">Заметка дня</span>' : ''}
      <label class="kb-attach"${limitNote() ? ` title="${esc(limitNote())}"` : ''}>📎 Файл<input type="file" class="kb-file" hidden multiple></label>
      <button type="button" class="btn mini kb-link">🔗 Связать</button>
      <button type="button" class="btn mini kb-local-graph" title="Граф вокруг этой заметки">◉ Граф</button>
    </div>
    <div class="kb-edit-wrap">
      <div class="kb-editor" contenteditable="true" spellcheck="true"
        data-ph="Текст заметки… Наберите [[ чтобы сослаться на другую заметку"></div>
    </div>
    <div class="kb-extra"></div>`;
  const title = main.querySelector('.kb-title');
  const ed = main.querySelector('.kb-editor');
  ed.innerHTML = n.html || '';
  refreshRefs(ed);
  editing = {
    id: n.id, title, ed,
    lastTitle: title.value, lastHtml: ed.innerHTML, srcHtml: n.html || '',
    frozenAt: String(n.updatedAt || ''), timer: null,
  };
  renderExtra(main, n);
  bindNote(main, n);
}

function softUpdateNote(main, n) {
  const e = editing;
  if (!e) return;
  /* Чужая правка (синхронизация, панель заметок) — подставляем, но
     только в поле без фокуса и без несохранённого ввода. */
  const dirty = e.timer != null;
  if (!dirty && document.activeElement !== e.title && (n.title || '') !== e.lastTitle) {
    e.title.value = n.title || '';
    e.lastTitle = e.title.value;
  }
  if (!dirty && document.activeElement !== e.ed && (n.html || '') !== e.srcHtml) {
    e.ed.innerHTML = n.html || '';
    refreshRefs(e.ed);
    e.srcHtml = n.html || '';
    e.lastHtml = e.ed.innerHTML;
  } else {
    refreshRefs(e.ed);
  }
  const sel = main.querySelector('.kb-group-sel');
  if (sel && document.activeElement !== sel) setHTML(sel, groupOptions(n));
  renderExtra(main, n);
}

/* Подписи ссылок [[…]] — по текущим названиям: заметку могли
   переименовать или удалить. */
function refreshRefs(ed) {
  ed.querySelectorAll('.kb-ref').forEach(a => {
    const t = kbItem(a.dataset.kbref);
    a.classList.toggle('broken', !t);
    a.contentEditable = 'false';
    if (t) { const label = titleOf(t); if (a.textContent !== label) a.textContent = label; }
  });
}

function renderExtra(main, n) {
  const all = kbNotes();
  const links = (n.links || []).map(id => kbItem(id)).filter(Boolean);
  const inText = refsOf(n).filter(id => !(n.links || []).includes(id)).map(id => kbItem(id)).filter(Boolean);
  const back = backlinksOf(n.id, all).filter(x => !(n.links || []).includes(x.id));
  const chip = (l, removable) => `<button type="button" class="kb-linkchip" data-id="${l.id}" style="--lc:${groupColor(l.groupId)}">
    <span class="kbl-dot"></span>${esc(titleOf(l))}${removable ? '<i class="kbl-x" title="Убрать связь">✕</i>' : ''}</button>`;
  const uniq = arr => [...new Map(arr.map(x => [x.id, x])).values()];
  setHTML(main.querySelector('.kb-extra'), `
    ${limitNote() ? `<p class="file-limit">⚠ ${esc(limitNote())}</p>` : ''}
    ${(n.files || []).length ? `<div class="kb-files">${n.files.map(f => `<div class="kb-file-row" data-fid="${f.id}">
      <span class="kbf-name">${esc(f.name)}</span><span class="kbf-size">${fmtSize(f.size)}</span>
      <button type="button" class="kbf-del" title="Открепить">✕</button></div>`).join('')}</div>` : ''}
    <div class="kb-links"><span class="kb-links-cap">Связи</span>
      ${links.map(l => chip(l, true)).join('')}
      <button type="button" class="kb-linkadd">＋ Связать</button></div>
    ${inText.length ? `<div class="kb-links"><span class="kb-links-cap">Ссылки в тексте</span>
      ${uniq(inText).map(l => chip(l, false)).join('')}</div>` : ''}
    ${back.length ? `<div class="kb-links"><span class="kb-links-cap">Упоминается в</span>
      ${back.map(l => chip(l, false)).join('')}</div>` : ''}`);
}

/* ── Сохранение ── */
function scheduleSave() {
  if (!editing) return;
  clearTimeout(editing.timer);
  editing.timer = setTimeout(flushEditor, 600);
}
function flushEditor() {
  const e = editing;
  if (!e) return null;
  clearTimeout(e.timer);
  e.timer = null;
  const title = e.title.value, html = e.ed.innerHTML;
  if (title === e.lastTitle && html === e.lastHtml) return null;   // без правок — не трогаем updatedAt
  e.lastTitle = title;
  e.lastHtml = html;
  e.srcHtml = html;
  return kbSave('note', { title, html }, e.id);
}

function bindNote(main, n) {
  const { title, ed } = editing;
  const onEdit = () => { scheduleSave(); updateThumb(); };
  title.oninput = onEdit;
  title.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ed.focus(); } };
  title.onblur = flushEditor;
  ed.addEventListener('input', () => { onEdit(); acUpdate(ed, n); });
  ed.addEventListener('blur', () => { flushEditor(); setTimeout(acClose, 150); });
  ed.addEventListener('keydown', e => acKey(e, ed, n));
  ed.addEventListener('click', e => {
    const a = e.target.closest('.kb-ref');
    if (!a) return;
    e.preventDefault();
    if (kbItem(a.dataset.kbref)) openNote(a.dataset.kbref);
  });

  main.querySelector('.kb-group-sel').onchange = async e => {
    flushEditor();
    await kbSave('note', { groupId: e.target.value }, n.id);
  };
  main.querySelector('.kb-del').onclick = async () => {
    if (!confirm(n.daily
      ? 'Удалить заметку дня вместе с вложениями? Она пропадёт и из панели заметок.'
      : 'Удалить заметку вместе с вложениями?')) return;
    editing = null;
    await kbRemove(n.id);
    curNote = null;
    renderKbView(_host);
  };
  const file = main.querySelector('.kb-file');
  file.onchange = async () => {
    flushEditor();
    for (const f of file.files) {
      try { await attach(n.id, f); }
      catch (err) { alert(err.message || 'Не удалось прикрепить файл'); }
    }
    file.value = '';
  };
  const pick = () => { flushEditor(); openLinkPicker(n.id); };
  main.querySelector('.kb-link').onclick = pick;
  main.querySelector('.kb-local-graph').onclick = () => {
    flushEditor();
    graphScope = 'local';
    view = 'graph';
    renderKbView(_host);
    revealMain();
  };
  /* Нижняя часть перерисовывается, поэтому слушаем делегированием */
  main.querySelector('.kb-extra').addEventListener('click', e => {
    const t = e.target;
    if (t.closest('.kb-linkadd')) { pick(); return; }
    const row = t.closest('.kb-file-row');
    if (row) {
      const note = kbItem(n.id);
      const f = ((note && note.files) || []).find(x => x.id === row.dataset.fid);
      if (t.classList.contains('kbf-del')) {
        if (f) dropFile(f);
        kbSave('note', { files: (note.files || []).filter(x => x.id !== row.dataset.fid) }, n.id);
        return;
      }
      if (f) openAttachment(f);
      return;
    }
    const c = t.closest('.kb-linkchip');
    if (!c) return;
    if (t.classList.contains('kbl-x')) { flushEditor(); setLink(n.id, c.dataset.id, false); return; }
    openNote(c.dataset.id);
  });
}

/* ── [[ — автодополнение ссылок в тексте ── */
let ac = null;   // { box, ctx, items, sel }
function caretCtx(ed) {
  const s = getSelection();
  if (!s.rangeCount || !s.isCollapsed) return null;
  const node = s.anchorNode;
  if (!node || node.nodeType !== 3 || !ed.contains(node)) return null;
  const before = node.data.slice(0, s.anchorOffset);
  const m = before.match(/\[\[([^[\]\n]{0,60})$/);
  if (!m) return null;
  return { node, start: s.anchorOffset - m[0].length, end: s.anchorOffset, q: m[1] };
}
function acClose() { if (ac) { ac.box.remove(); ac = null; } }
function acUpdate(ed, n) {
  const ctx = caretCtx(ed);
  if (!ctx) { acClose(); return; }
  const q = ctx.q.trim().toLowerCase();
  const found = kbNotes().filter(x => x.id !== n.id && (!q || titleOf(x).toLowerCase().includes(q)))
    .sort((a, b) => (titleOf(b).toLowerCase().startsWith(q) ? 1 : 0) - (titleOf(a).toLowerCase().startsWith(q) ? 1 : 0))
    .slice(0, 8);
  const items = found.map(x => ({ id: x.id, label: titleOf(x), color: groupColor(x.groupId) }));
  if (q && !found.some(x => titleOf(x).toLowerCase() === q)) items.push({ create: ctx.q.trim(), label: `Создать «${ctx.q.trim()}»` });
  if (!items.length) { acClose(); return; }
  if (!ac) {
    const box = document.createElement('div');
    box.className = 'kb-ac glass';
    box.addEventListener('mousedown', e => e.preventDefault());   // фокус остаётся в редакторе
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-i]');
      if (b && ac) acPick(ed, n, +b.dataset.i);
    });
    document.body.appendChild(box);
    ac = { box };
  }
  ac.ctx = ctx;
  ac.items = items;
  ac.sel = Math.min(ac.sel || 0, items.length - 1);
  acDraw();
  const r = document.createRange();
  r.setStart(ctx.node, ctx.start);
  r.setEnd(ctx.node, ctx.end);
  const rect = r.getBoundingClientRect();
  const w = Math.min(300, innerWidth - 24);
  ac.box.style.width = w + 'px';
  ac.box.style.left = Math.max(12, Math.min(rect.left, innerWidth - w - 12)) + 'px';
  const below = rect.bottom + 6;
  const h = ac.box.offsetHeight;
  ac.box.style.top = (below + h > innerHeight - 8 ? Math.max(8, rect.top - h - 6) : below) + 'px';
}
function acDraw() {
  ac.box.innerHTML = `<div class="kb-ac-cap">Ссылка на заметку</div>` + ac.items.map((it, i) =>
    `<button type="button" class="kb-ac-item${i === ac.sel ? ' on' : ''}${it.create ? ' create' : ''}" data-i="${i}">
      ${it.create ? '<span class="kb-ac-plus">＋</span>' : `<span class="kbl-dot" style="--lc:${it.color}"></span>`}
      <span>${esc(it.label)}</span></button>`).join('');
}
function acKey(e, ed, n) {
  if (!ac) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const d = e.key === 'ArrowDown' ? 1 : -1;
    ac.sel = (ac.sel + d + ac.items.length) % ac.items.length;
    acDraw();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    acPick(ed, n, ac.sel);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    acClose();
  }
}
async function acPick(ed, n, i) {
  const it = ac && ac.items[i];
  if (!it) return;
  const { ctx } = ac;
  acClose();
  let id = it.id, label = it.label;
  if (it.create) {
    const cur = kbItem(n.id);
    const nn = await kbSave('note', {
      title: it.create, html: '', groupId: (cur && cur.groupId) || curGroup || '',
      files: [], links: [], tags: [],
    });
    id = nn.id;
    label = it.create;
  }
  if (!ctx.node.isConnected) return;
  const r = document.createRange();
  r.setStart(ctx.node, ctx.start);
  r.setEnd(ctx.node, Math.min(ctx.end, ctx.node.length));
  r.deleteContents();
  const a = document.createElement('a');
  a.className = 'kb-ref';
  a.dataset.kbref = id;
  a.contentEditable = 'false';
  a.textContent = label;
  r.insertNode(a);
  const sp = document.createTextNode(' ');
  a.after(sp);
  const s = getSelection();
  const r2 = document.createRange();
  r2.setStart(sp, 1);
  r2.collapse(true);
  s.removeAllRanges();
  s.addRange(r2);
  ed.focus();
  scheduleSave();
  updateThumb();
}

/* ── Окно «Связать»: поиск, отметки, создание ──
   Не закрывается после выбора — можно отметить сразу несколько.
   Повторное нажатие снимает связь. */
function openLinkPicker(noteId) {
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay';
  ov.innerHTML = `<div class="notes-list-modal glass kb-picker">
    <header class="notes-list-head"><h3>Связать заметку</h3><button type="button" class="notes-list-close">✕</button></header>
    <input class="kb-q kb-pick-q" type="search" placeholder="Найти или создать заметку…">
    <div class="notes-list-content kb-pick-list"></div>
    <div class="ne-actions"><span class="kb-pick-hint">Нажмите, чтобы связать или развязать</span>
      <span class="spacer"></span><button type="button" class="btn primary kb-pick-done">Готово</button></div>
  </div>`;
  document.body.appendChild(ov);
  const list = ov.querySelector('.kb-pick-list');
  const qi = ov.querySelector('.kb-pick-q');
  const draw = () => {
    const me = kbItem(noteId);
    if (!me) { close(); return; }
    const linked = new Set(me.links || []);
    const q = qi.value.trim().toLowerCase();
    const notes = kbNotes().filter(x => x.id !== noteId && (!q || titleOf(x).toLowerCase().includes(q)))
      .sort((a, b) => (linked.has(b.id) ? 1 : 0) - (linked.has(a.id) ? 1 : 0));
    const exact = q && kbNotes().some(x => titleOf(x).toLowerCase() === q);
    list.innerHTML = (q && !exact ? `<button type="button" class="kb-pick kb-pick-create">＋ Создать и связать «${esc(qi.value.trim())}»</button>` : '') +
      (notes.length ? notes.map(x => {
        const g = kbItem(x.groupId);
        return `<button type="button" class="kb-pick${linked.has(x.id) ? ' on' : ''}" data-id="${x.id}">
          <span class="kb-pick-check">${linked.has(x.id) ? '✓' : ''}</span>
          <span class="kbl-dot" style="--lc:${groupColor(x.groupId)}"></span>
          <span class="kb-pick-t">${esc(titleOf(x))}</span>
          ${g ? `<span class="kb-pick-g">${esc(g.name)}</span>` : ''}</button>`;
      }).join('') : (q ? '' : '<p class="empty">Нет других заметок</p>'));
  };
  const close = () => { ov.remove(); };
  ov.querySelector('.notes-list-close').onclick = close;
  ov.querySelector('.kb-pick-done').onclick = close;
  ov.onclick = e => { if (e.target === ov) close(); };
  qi.oninput = draw;
  qi.onkeydown = e => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') { const b = list.querySelector('.kb-pick'); if (b) b.click(); }
  };
  list.addEventListener('click', async e => {
    const b = e.target.closest('.kb-pick');
    if (!b) return;
    if (b.classList.contains('kb-pick-create')) {
      const me = kbItem(noteId);
      const nn = await kbSave('note', {
        title: qi.value.trim(), html: '', groupId: (me && me.groupId) || '', files: [], links: [], tags: [],
      });
      await setLink(noteId, nn.id, true);
      qi.value = '';
    } else {
      const me = kbItem(noteId);
      await setLink(noteId, b.dataset.id, !(me.links || []).includes(b.dataset.id));
    }
    draw();
    qi.focus();
  });
  draw();
  setTimeout(() => qi.focus(), 60);
}

/* ── Граф ── */
function graphData() {
  const all = kbNotes();
  const adj = new Map(all.map(n => [n.id, new Set()]));
  const pairs = [];
  for (const n of all) for (const id of outLinks(n)) {
    if (!adj.has(id)) continue;
    adj.get(n.id).add(id);
    adj.get(id).add(n.id);
    pairs.push([n.id, id]);
  }
  let ids;
  const local = graphScope === 'local' && curNote && adj.has(curNote);
  if (local) {
    ids = new Set([curNote]);
    let front = [curNote];
    for (let d = 0; d < graphDepth; d++) {
      const next = [];
      for (const id of front) for (const nb of adj.get(id)) if (!ids.has(nb)) { ids.add(nb); next.push(nb); }
      front = next;
    }
  } else {
    const br = curGroup ? groupBranch(curGroup) : null;
    ids = new Set(all.filter(n => !br || br.has(n.groupId)).map(n => n.id));
  }
  if (hideOrphans) {
    for (const id of [...ids]) {
      if (id === curNote && local) continue;
      if (![...adj.get(id)].some(nb => ids.has(nb))) ids.delete(id);
    }
  }
  const nodes = all.filter(n => ids.has(n.id)).map(n => ({ id: n.id, label: titleOf(n), color: groupColor(n.groupId) }));
  return { nodes, links: pairs.filter(([a, b]) => ids.has(a) && ids.has(b)), local };
}

function buildGraph(main) {
  main.innerHTML = `
    <div class="kb-gbar">
      <div class="kb-seg kb-gscope">
        <button type="button" data-scope="all">Вся база</button>
        <button type="button" data-scope="local">Вокруг заметки</button>
      </div>
      <label class="kb-gdepth">Глубина
        <select>${[1, 2, 3].map(d => `<option value="${d}"${d === graphDepth ? ' selected' : ''}>${d}</option>`).join('')}</select></label>
      <label class="kb-gorph"><input type="checkbox"${hideOrphans ? ' checked' : ''}> Без одиночных</label>
      <span class="spacer"></span>
      <button type="button" class="btn mini kb-gfit" title="Вписать в экран">⤢</button>
      <button type="button" class="btn mini kb-gclose" title="Вернуться к заметке">✕</button>
    </div>
    <div class="kb-graph-wrap">
      <canvas class="kb-graph"></canvas>
      <div class="kb-gempty" hidden></div>
      <div class="kb-legend"></div>
      <div class="kb-ghint">Колесо или щипок — масштаб · тяните фон, чтобы двигать · клик по точке — открыть</div>
    </div>`;
  graph = createGraph(main.querySelector('.kb-graph'), { onOpen: id => openNote(id) });
  main.querySelector('.kb-gscope').addEventListener('click', e => {
    const b = e.target.closest('[data-scope]');
    if (!b || b.disabled) return;
    graphScope = b.dataset.scope;
    updateGraph(main, true);
  });
  main.querySelector('.kb-gdepth select').onchange = e => { graphDepth = +e.target.value; updateGraph(main, true); };
  main.querySelector('.kb-gorph input').onchange = e => { hideOrphans = e.target.checked; updateGraph(main, true); };
  main.querySelector('.kb-gfit').onclick = () => graph && graph.fit();
  main.querySelector('.kb-gclose').onclick = () => { view = 'note'; renderKbView(_host); };
  updateGraph(main, true);
}

function updateGraph(main, refit) {
  if (!graph) return;
  const { nodes, links, local } = graphData();
  const canLocal = !!(curNote && kbItem(curNote));
  main.querySelectorAll('.kb-gscope button').forEach(b => {
    b.classList.toggle('on', b.dataset.scope === (local ? 'local' : 'all'));
    if (b.dataset.scope === 'local') {
      b.disabled = !canLocal;
      b.title = canLocal ? `Связи «${titleOf(kbItem(curNote))}»` : 'Сначала откройте заметку';
    }
  });
  main.querySelector('.kb-gdepth').hidden = !local;
  const empty = main.querySelector('.kb-gempty');
  empty.hidden = nodes.length > 0;
  empty.textContent = 'Здесь пока пусто. Свяжите заметки кнопкой «Связать» или ссылкой [[…]] в тексте.';
  const used = new Set(nodes.map(n => kbItem(n.id)).filter(Boolean).map(n => n.groupId || ''));
  setHTML(main.querySelector('.kb-legend'), kbGroups().filter(g => used.has(g.id))
    .map(g => `<span><i style="--lc:${g.color}" class="kbl-dot"></i>${esc(g.name)}</span>`).join('') +
    (used.has('') ? '<span><i style="--lc:var(--dim)" class="kbl-dot"></i>Без группы</span>' : ''));
  graph.setData(nodes, links, curNote);
  if (refit) graph.autoFit();
}

/* ── Окно группы ── */
function openGroupSheet(id, host, parentPreset = '') {
  const g = id ? kbItem(id) : null;
  const all = kbGroups();
  /* Родителем нельзя выбрать саму группу и её же подгруппы — иначе цикл */
  const banned = id ? groupBranch(id, all) : new Set();
  const parentNow = g ? (g.parentId || '') : parentPreset;
  const depthOf = gr => { let d = 0, p = gr.parentId; const seen = new Set(); while (p && !seen.has(p)) { seen.add(p); d++; p = (all.find(x => x.id === p) || {}).parentId; } return d; };
  const g0 = g ? kbGroups().find(x => x.id === g.id) || g : null;
  const resolved = c => {
    if (!c || !String(c).startsWith('var(')) return c;
    const v = getComputedStyle(document.documentElement).getPropertyValue(String(c).slice(4, -1)).trim();
    return v || '#94a3b8';
  };
  const color = resolved((g0 && g0.color)) || PALETTE[kbGroups().length % PALETTE.length];
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay';
  ov.innerHTML = `<div class="notes-list-modal glass kb-gsheet">
    <header class="notes-list-head"><h3>${g ? 'Группа' : 'Новая группа'}</h3>
      <button type="button" class="notes-list-close">✕</button></header>
    <div class="fin-form">
      <label class="fin-field"><span>Название</span>
        <input class="fin-in kg-name" type="text" maxlength="40" value="${g0 ? esc(g0.name) : ''}" placeholder="Например, Проекты"></label>
      <div class="fin-field"><span>Цвет</span>
        <div class="kg-colors">${PALETTE.map(c =>
          `<button type="button" class="kg-dot${c.toLowerCase() === String(color).toLowerCase() ? ' on' : ''}" data-c="${c}" style="--c:${c}"></button>`).join('')}
          <input class="kg-custom" type="color" value="${color}" title="Свой цвет"></div></div>
      <label class="fin-field"><span>Внутри группы</span>
        <select class="fin-in kg-parent">
          <option value="">— верхний уровень —</option>
          ${all.filter(x => !banned.has(x.id)).map(x => `<option value="${x.id}"${x.id === parentNow ? ' selected' : ''}>${'  '.repeat(depthOf(x))}${esc(x.name)}</option>`).join('')}
        </select></label>
    </div>
    <div class="ne-actions">
      ${g && !['kb-work', 'kb-home', 'kb-study'].includes(g.id)
        ? '<button type="button" class="btn danger kg-del">Удалить</button>' : ''}
      ${g ? '<button type="button" class="btn kg-sub">＋ Подгруппа</button>' : ''}
      <span class="spacer"></span>
      <button type="button" class="btn primary kg-save">Сохранить</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.notes-list-close').onclick = close;
  ov.onclick = e => { if (e.target === ov) close(); };
  let picked = color;
  const custom = ov.querySelector('.kg-custom');
  ov.querySelectorAll('.kg-dot').forEach(d => d.onclick = () => {
    picked = d.dataset.c;
    custom.value = picked;
    ov.querySelectorAll('.kg-dot').forEach(x => x.classList.toggle('on', x === d));
  });
  custom.oninput = () => {
    picked = custom.value;
    ov.querySelectorAll('.kg-dot').forEach(x => x.classList.remove('on'));
  };
  const nameEl = ov.querySelector('.kg-name');
  ov.querySelector('.kg-save').onclick = async () => {
    const name = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    const patch = { name: name.slice(0, 40), color: picked, order: g ? g.order : kbGroups().length,
      parentId: ov.querySelector('.kg-parent').value };
    if (id && MODE_OF_GROUP[id]) {
      const mode = MODES.find(x => x.id === MODE_OF_GROUP[id]) || {};
      patch.customName = name !== mode.label;
      patch.customColor = !String(picked).startsWith('var(');
    }
    const saved = await kbSave('group', patch, id);
    if (!id) { curGroup = saved.id; notesOpen = true; }
    if (patch.parentId) openGroups.add(patch.parentId);   // показать новую подгруппу в дереве
    close();
    renderKbView(host);
  };
  const del = ov.querySelector('.kg-del');
  if (del) del.onclick = async () => {
    if (!confirm('Удалить группу? Её заметки и подгруппы перейдут на уровень выше.')) return;
    await kbRemove(id);
    if (curGroup === id) curGroup = '';
    close();
    renderKbView(host);
  };
  const sub = ov.querySelector('.kg-sub');
  if (sub) sub.onclick = () => { close(); openGroupSheet(null, host, id); };
  setTimeout(() => nameEl.focus(), 60);
}

/* ── Перенос заметки в группу ──
   Pointer-события, а не нативный drag-and-drop: на iOS он в вебе не
   работает. Тянем карточку из списка, группа под курсором
   подсвечивается, отпустили — заметка сменила группу. Слушатель
   один, делегированием на панели: список перерисовывается, а
   привязка остаётся. */
function bindNoteDrag(el, side) {
  let src = null, ghost = null, over = null, started = false, sx = 0, sy = 0, gx = 0, gy = 0, board = null, slot = null;
  const dropAt = (x, y) => {
    const n = document.elementFromPoint(x, y);
    return n ? n.closest('[data-drop]') : null;
  };
  const clearOver = () => { if (over) over.classList.remove('kb-drop-over'); over = null; };
  const move = e => {
    if (!src) return;
    if (!started) {
      if (Math.abs(e.clientX - sx) < 7 && Math.abs(e.clientY - sy) < 7) return;
      started = true;
      const r = src.getBoundingClientRect();
      gx = sx - r.left;
      gy = sy - r.top;
      /* Тянем миниатюру самой заметки — так, как она нарисована в колонке */
      ghost = src.cloneNode(true);
      ghost.classList.remove('on', 'dragging');
      ghost.classList.add('kb-drag-card');
      ghost.style.width = r.width + 'px';
      ghost.style.height = r.height + 'px';
      document.body.appendChild(ghost);
      src.classList.add('dragging');
      document.body.classList.add('kb-dragging');
      try { navigator.vibrate(8); } catch {}
    }
    const inTrash = trackTrash(e.clientX, e.clientY);
    /* над корзиной миниатюра сжимается к курсору — поле «Удалить» видно */
    ghost.style.transformOrigin = `${gx}px ${gy}px`;
    ghost.style.transform = `translate(${e.clientX - gx}px, ${e.clientY - gy}px) rotate(2deg)${inTrash ? ' scale(.35)' : ''}`;
    ghost.classList.toggle('kb-to-trash', inTrash);
    if (view === 'structure' && board) {
      /* на доске: место между элементами или середина группы */
      slot = inTrash ? null : slotAt(board, e.clientX, e.clientY, null, true);
      showSlot(board, slot);
      return;
    }
    const d = inTrash ? null : dropAt(e.clientX, e.clientY);
    if (d !== over) { clearOver(); if (d) { over = d; d.classList.add('kb-drop-over'); } }
  };
  const up = async e => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    document.removeEventListener('touchmove', block);
    document.body.classList.remove('kb-dragging');
    const ghostRect = ghost ? ghost.getBoundingClientRect() : null;
    if (ghost) { ghost.remove(); ghost = null; }
    if (src) src.classList.remove('dragging');
    const toTrash = started && trackTrash(e.clientX, e.clientY);
    resetTrash();
    if (started && board && view === 'structure' && !toTrash) {
      const sl = slot, node = src;
      const snaps = snapBoard(board);
      if (ghostRect) snaps.set(node.dataset.id, ghostRect);
      dragGuard = Date.now();
      src = null; started = false; slot = null;
      if (!sl) { showSlot(board, null); return; }
      const nid = node.dataset.id;
      const to = sl.into || '';
      if (!sl.into) placeInLayout(board, nid, sl);
      await settleBoard(board, snaps, async () => {
        const n = kbItem(nid);
        if (n && (n.groupId || '') !== to) {
          if (editing && editing.id === nid) flushEditor();
          await kbSave('note', { groupId: to }, nid);
        }
      });
      return;
    }
    const target = started && !toTrash ? dropAt(e.clientX, e.clientY) : null;
    const gid = target ? target.dataset.drop : null;
    const node = src;
    if (started) dragGuard = Date.now();
    clearOver();
    src = null;
    started = false;
    if (node && toTrash) { await trashNote(node.dataset.id); return; }
    if (node && gid != null) {
      const to = gid === LOOSE ? '' : gid;   // на свободное место доски — заметка без группы
      const n = kbItem(node.dataset.id);
      if (n && (n.groupId || '') !== to) {
        if (editing && editing.id === node.dataset.id) flushEditor();
        await kbSave('note', { groupId: to }, node.dataset.id);
      }
    }
  };
  const block = e => { if (started && e.cancelable) e.preventDefault(); };
  side.addEventListener('pointerdown', e => {
    const node = e.target.closest('.kb-item');
    if (!node || e.button > 0) return;
    if (node.closest('.kb-loose')) return;   // отдельная заметка на доске тянется за ручку
    board = node.closest('.kb-board');
    slot = null;
    src = node;
    sx = e.clientX;
    sy = e.clientY;
    started = false;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('touchmove', block, { passive: false });
  });
}

/* ══════════════ Структура ══════════════
   Колонка заметок и окно заметки каскадом падают вниз, панель групп
   уходит вверх, а группы — в своём порядке — поднимаются колонками.
   Заметки перетаскиваются между колонками (тот же механизм, что и
   перенос заметки на группу: колонка — цель [data-drop]). */
let structBusy = false;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function flatGroups() {
  const groups = kbGroups();
  const known = new Set(groups.map(g => g.id));
  const out = [];
  const walk = (g, depth, path) => {
    out.push({ g, depth, path });
    childGroups(g.id, groups).forEach(k => walk(k, depth + 1, [...path, g.name]));
  };
  groups.filter(g => !g.parentId || !known.has(g.parentId)).forEach(g => walk(g, 0, []));
  return out;
}
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
const LOOSE_HANDLE = '<svg class="dock-handle kb-loose-handle" viewBox="0 0 32 32" aria-hidden="true"><path d="M2 22 A20 20 0 0 1 22 2" pathLength="100" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
const BCOL_HANDLE = '<svg class="dock-handle kb-bcol-handle" viewBox="0 0 32 32" aria-hidden="true"><path d="M2 22 A20 20 0 0 1 22 2" pathLength="100" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
let freshId = null;   // только что созданная группа — сразу дать ввести название
function renderBoard(animate, force) {
  if (!_host) return;
  const board = _host.querySelector('.kb-board');
  const notes = kbNotes();
  const known = new Set(kbGroups().map(g => g.id));
  let i = 0;   // порядок элементов: раскладка по столбцам переставляет узлы
  const cols = flatGroups().map(({ g, path }) => {
    const list = notes.filter(n => n.groupId === g.id);
    const name = g.name
      ? `${path.length ? `<i>${esc(path.join(' › '))} ›</i> ` : ''}${esc(g.name)}`
      : `<input class="kb-bcol-input" data-gid="${g.id}" type="text" maxlength="60" placeholder="Введите наименование">`;
    return `<div class="kb-bcol" data-i="${i++}" data-bid="${g.id}" data-drop="${g.id}" data-col="${g.id}" style="--gc:${g.color || '#94a3b8'}">${BCOL_HANDLE}
      <header class="kb-bcol-head"><button type="button" class="kb-g-dot kb-bcol-dot" data-gid="${g.id}" title="Цвет группы"></button>
        <span class="kb-bcol-name">${name}</span>
        <span class="kb-g-n">${list.length}</span></header>
      <div class="kb-bcol-list">${list.map(itemHTML).join('') || '<p class="empty">Перетащите сюда заметку</p>'}</div>
    </div>`;
  }).join('');
  /* Заметки без группы — отдельными серыми плашками после групп; тянутся
     за ручку, как колонки, и бросаются в группу */
  const loose = notes.filter(n => !n.groupId || !known.has(n.groupId))
    .map(n => `<div class="kb-loose" data-i="${i++}" data-bid="${n.id}" data-note="${n.id}" style="--gc:#94a3b8">${LOOSE_HANDLE}${itemHTML(n)}</div>`).join('');
  const html = `<header class="kb-board-head"><b>Структура</b>
      <span class="kb-board-hint">Перетаскивайте заметки между колонками или на свободное место, колонки и отдельные заметки — за ручку в углу</span>
      <button type="button" class="btn mini kb-board-close">✕ Закрыть</button></header>
    <div class="kb-board-cols" data-drop="${LOOSE}">${cols}${loose}${cols || loose ? '' : '<p class="empty">Пусто — нажмите «+», чтобы создать группу или заметку</p>'}</div>
    <div class="btn danger kb-trash" aria-hidden="true">${TRASH_SVG}<span>Удалить</span></div>`;
  const changed = board._html !== html;
  setHTML(board, html);
  if (changed || force) layoutBoard(board);
  const inp = board.querySelector('.kb-bcol-input');
  if (inp && freshId && inp.dataset.gid === freshId && document.activeElement !== inp) inp.focus();
  if (animate) cascadeIn([...board.querySelectorAll('.kb-board-head, .kb-bcol, .kb-loose')]);
}
/* ── Корзина «Структуры» (левый нижний угол) ──
   Пока тянем заметку или группу, корзина следит за курсором: поднесли
   ближе — разворачивается в поле «Удалить», курсор над полем —
   поле подсвечено, отпустили над ним — элемент удаляется сразу, без
   подтверждения. Только группа с заметками спрашивает, что делать с
   заметками. */
const TRASH_NEAR = 110;   // px от корзины, с которых она разворачивается
function boardTrash() {
  const t = view === 'structure' && _host && _host.querySelector('.kb-trash');
  return t && t.offsetWidth ? t : null;
}
function trackTrash(x, y) {
  const t = boardTrash();
  if (!t) return false;
  const r = t.getBoundingClientRect();
  const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
  const hot = t.classList.contains('open') && dx === 0 && dy === 0;
  const open = Math.hypot(dx, dy) < TRASH_NEAR;
  t.classList.toggle('open', open);
  t.classList.toggle('hot', hot);
  document.body.classList.toggle('kb-trash-open', open);   // нижнее меню сужается (style.css)
  return hot;
}
function resetTrash() {
  const t = _host && _host.querySelector('.kb-trash');
  if (t) t.classList.remove('open', 'hot');
  document.body.classList.remove('kb-trash-open');
}
async function trashNote(id) {
  if (editing && editing.id === id) editing = null;
  if (curNote === id) curNote = null;
  await kbRemove(id);
}
async function trashGroup(gid, from) {
  const inside = kbNotes().filter(n => n.groupId === gid);
  const choice = inside.length ? await askGroupDelete() : 'group';
  if (!choice) return;
  if (choice === 'all') {
    for (const n of inside) await trashNote(n.id);
  } else {
    /* заметки остаются — без группы, со своими названиями */
    for (const n of inside) {
      if (editing && editing.id === n.id) flushEditor();
      await kbSave('note', { groupId: '' }, n.id);
    }
  }
  await kbRemove(gid);
  if (curGroup === gid) curGroup = '';
  renderBoard(false);
  if (choice === 'group' && from) flyOut(inside.map(n => n.id), from);
}
/* Заметки «вылетают» из удалённой группы и встают на свои места */
function flyOut(ids, from) {
  if (reduceMotion() || !_host) return;
  const cx = from.left + from.width / 2, cy = from.top + Math.min(from.height, 120) / 2;
  ids.forEach((id, k) => {
    const el = _host.querySelector(`.kb-loose[data-note="${CSS.escape(id)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    el.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(.35)`, opacity: 0 },
      { transform: `translate(${dx * .15}px, ${dy * .15 - 30}px) scale(1.04)`, opacity: 1, offset: .6 },
      { transform: 'none', opacity: 1 }
    ], { duration: 620, delay: k * 70, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' });
  });
}
function askGroupDelete() {
  return new Promise(done => {
    const ov = document.createElement('div');
    ov.className = 'notes-list-overlay';
    ov.innerHTML = `<div class="notes-list-modal glass kb-del-dlg" role="dialog" aria-modal="true">
      <p class="kb-del-text">В группе, которую вы хотите удалить, содержатся заметки</p>
      <div class="kb-del-actions">
        <button type="button" class="btn danger" data-a="all">Удалить вместе с содержимым</button>
        <button type="button" class="btn" data-a="group">Удалить только группу</button>
      </div></div>`;
    document.body.appendChild(ov);
    const close = v => { ov.remove(); document.removeEventListener('keydown', esc); done(v); };
    const esc = e => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', esc);
    ov.onclick = e => {
      if (e.target === ov) { close(null); return; }
      const b = e.target.closest('[data-a]');
      if (b) close(b.dataset.a);
    };
  });
}

/* ── Раскладка доски по столбцам ──
   Где что стоит, запоминается на устройстве (столбец и место в нём):
   перенесённая группа или заметка остаётся там, куда её положили.
   Новые элементы сначала занимают пустые столбцы (первый ряд), потом
   ложатся в самый левый столбец, где до низа экрана ещё есть место;
   если не помещается нигде — в самый короткий. */
const BOARD_GAP = 12;
const LAYOUT_KEY = 'rl_kb_board';
function loadLayout() {
  try { const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveLayout(lists) { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(lists)); } catch {} }
function layoutBoard(board) {
  const wrap = board && board.querySelector('.kb-board-cols');
  if (!wrap || !wrap.offsetWidth) return;
  const items = [...wrap.querySelectorAll('.kb-bcol, .kb-loose')].sort((a, b) => a.dataset.i - b.dataset.i);
  if (!items.length) return;
  const min = innerWidth <= 720 ? 160 : 230;
  const n = Math.max(1, Math.floor((wrap.clientWidth + BOARD_GAP) / (min + BOARD_GAP)));
  const cols = Array.from({ length: n }, () => Object.assign(document.createElement('div'), { className: 'kb-mcol' }));
  /* все столбцы одной ширины — высоту меряем, поставив элементы в первый */
  wrap.replaceChildren(...cols);
  cols[0].append(...items);
  const byId = new Map(items.map(el => [el.dataset.bid, el]));
  const hs = new Map(items.map(el => [el.dataset.bid, el.offsetHeight]));
  const lists = cols.map(() => []);
  const placed = new Set();
  loadLayout().slice(0, n).forEach((ids, c) => (Array.isArray(ids) ? ids : []).forEach(id => {
    if (byId.has(id) && !placed.has(id)) { lists[c].push(id); placed.add(id); }
  }));
  const limit = innerHeight - wrap.getBoundingClientRect().top - 16;
  const fill = lists.map(l => l.reduce((h, id, k) => h + (k ? BOARD_GAP : 0) + hs.get(id), 0));
  items.forEach(el => {
    const id = el.dataset.bid;
    if (placed.has(id)) return;
    let c = fill.indexOf(0);
    if (c < 0) c = fill.findIndex(h => h + BOARD_GAP + hs.get(id) <= limit);
    if (c < 0) c = fill.indexOf(Math.min(...fill));
    lists[c].push(id);
    fill[c] += (fill[c] ? BOARD_GAP : 0) + hs.get(id);
  });
  lists.forEach((ids, c) => cols[c].append(...ids.map(id => byId.get(id))));
  saveLayout(lists);
}
/* ── Перенос по доске (как виджеты на экране задач) ──
   Пока тянем, место вставки показывают соседи: элементы ниже него
   в столбце расступаются. Отпустили — всё плавно встаёт по местам, а
   перенесённый элемент «падает» в освободившееся место (FLIP). */
const SLOT_SHIFT = 28;
const colItems = (mcol, skip) => [...mcol.children].filter(x => x.dataset.bid && x.dataset.bid !== skip);
function slotAt(board, x, y, skip, canInto) {
  const wrap = board.querySelector('.kb-board-cols');
  if (!wrap) return null;
  const br = wrap.getBoundingClientRect();
  if (x < br.left - 24 || x > br.right + 24 || y < br.top - 30) return null;
  const cols = [...wrap.querySelectorAll('.kb-mcol')];
  if (!cols.length) return { c: 0, k: 0 };
  let c = cols.findIndex(m => x < m.getBoundingClientRect().right + BOARD_GAP / 2);
  if (c < 0) c = cols.length - 1;
  const items = colItems(cols[c], skip);
  for (let k = 0; k < items.length; k++) {
    const el = items[k];
    const r = el.getBoundingClientRect();
    const top = r.top - (el._shift || 0);
    /* заметку на середину группы — положить в группу */
    if (canInto && el.classList.contains('kb-bcol') && y > top + r.height * .2 && y < top + r.height * .8) return { into: el.dataset.col, el };
    if (y < top + r.height / 2) return { c, k };
  }
  return { c, k: items.length };
}
function showSlot(board, slot, skip) {
  board.querySelectorAll('.kb-drop-over').forEach(x => x.classList.remove('kb-drop-over'));
  board.querySelectorAll('.kb-mcol').forEach((m, c) => colItems(m, skip).forEach((el, k) => {
    const sh = slot && !slot.into && slot.c === c ? (k >= slot.k ? SLOT_SHIFT : k === slot.k - 1 ? -6 : 0) : 0;
    if ((el._shift || 0) !== sh) { el._shift = sh; el.style.transform = sh ? `translateY(${sh}px)` : ''; }
  }));
  if (slot && slot.into) slot.el.classList.add('kb-drop-over');
}
function snapBoard(board) {
  const m = new Map();
  board.querySelectorAll('[data-bid]').forEach(el => m.set(el.dataset.bid, el.getBoundingClientRect()));
  return m;
}
function flipBoard(board, snaps, ms = 440) {
  if (reduceMotion()) return;
  board.querySelectorAll('[data-bid]').forEach(el => {
    const sn = snaps.get(el.dataset.bid);
    if (!sn) return;
    const r = el.getBoundingClientRect();
    const dx = sn.left - r.left, dy = sn.top - r.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: ms, easing: 'cubic-bezier(.32,.72,.28,1)' });
  });
}
/* Запомнить раскладку: текущие столбцы, bid вставлен на место slot */
function placeInLayout(board, bid, slot) {
  const lists = [...board.querySelectorAll('.kb-mcol')].map(m => colItems(m, bid).map(x => x.dataset.bid));
  if (slot && !slot.into && lists.length) lists[Math.min(slot.c, lists.length - 1)].splice(slot.k, 0, bid);
  saveLayout(lists);
}
/* Отпустили: соседи без «двойного» сдвига, данные, раскладка, FLIP */
async function settleBoard(board, snaps, work) {
  board.classList.add('kb-settling');
  showSlot(board, null);
  board.querySelectorAll('[data-bid]').forEach(el => { el._shift = 0; el.style.transform = ''; });
  if (work) await work();
  renderBoard(false, true);
  flipBoard(board, snaps);
  requestAnimationFrame(() => board.classList.remove('kb-settling'));
}
let boardW = 0;
addEventListener('resize', () => {
  const board = view === 'structure' && _host && _host.querySelector('.kb-board');
  if (!board || board.offsetWidth === boardW) return;
  boardW = board.offsetWidth;
  layoutBoard(board);
});
/* Цвета групп: новая группа получает ещё не занятый цвет */
const GROUP_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#2563eb', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
  '#f97316', '#6366f1', '#14b8a6', '#e879f9', '#eab308', '#0ea5e9', '#22c55e', '#f43f5e'];
function freeColor() {
  const used = new Set(kbGroups().map(g => String(g.color || '').toLowerCase()));
  return GROUP_COLORS.find(c => !used.has(c)) || `hsl(${Math.floor(Math.random() * 360)} 70% 55%)`;
}
async function createBoardGroup() {
  const roots = kbGroups().filter(g => !g.parentId);
  const order = roots.reduce((m, g) => Math.max(m, g.order || 0), 0) + 10;
  const g = await kbSave('group', { name: '', color: freeColor(), order, parentId: '' });
  freshId = g.id;
  renderBoard(false);
}
async function createBoardNote() {
  await kbSave('note', { title: '', html: '', groupId: '', files: [], links: [], tags: [] });
  renderBoard(false);
}
/* Меню над кнопкой «+»: «+ Группа» / «+ Заметка» */
let addMenu = null;
function closeAddMenu() { if (addMenu) { addMenu.remove(); addMenu = null; } }
function toggleAddMenu(anchor) {
  if (addMenu) { closeAddMenu(); return; }
  addMenu = document.createElement('div');
  addMenu.className = 'kb-add-menu glass';
  addMenu.innerHTML = '<button type="button" class="btn" data-add="group">＋ Группа</button><button type="button" class="btn" data-add="note">＋ Заметка</button>';
  document.body.appendChild(addMenu);
  const r = anchor ? anchor.getBoundingClientRect() : { top: innerHeight - 80, right: innerWidth - 16 };
  addMenu.style.right = Math.max(8, innerWidth - r.right) + 'px';
  addMenu.style.bottom = (innerHeight - r.top + 10) + 'px';
  addMenu.onclick = e => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    closeAddMenu();
    if (b.dataset.add === 'group') createBoardGroup(); else createBoardNote();
  };
  setTimeout(() => {
    const away = e => {
      if (addMenu && !addMenu.contains(e.target) && !(anchor && anchor.contains(e.target))) { closeAddMenu(); document.removeEventListener('pointerdown', away); }
    };
    document.addEventListener('pointerdown', away);
  }, 0);
}
/* Выбор цвета группы по точке в колонке */
function openColorPop(dot) {
  document.querySelectorAll('.kb-color-pop').forEach(x => x.remove());
  const gid = dot.dataset.gid;
  const g = rawItem(gid);
  if (!g) return;
  const pop = document.createElement('div');
  pop.className = 'kb-color-pop glass';
  pop.innerHTML = GROUP_COLORS.map(c => `<button type="button" class="kg-dot${String(g.color).toLowerCase() === c ? ' on' : ''}" data-c="${c}" style="--c:${c}"></button>`).join('')
    + `<input type="color" class="kg-custom" value="${/^#[0-9a-f]{6}$/i.test(g.color || '') ? g.color : '#94a3b8'}" title="Свой цвет">`;
  document.body.appendChild(pop);
  const r = dot.getBoundingClientRect();
  pop.style.left = Math.min(innerWidth - pop.offsetWidth - 8, Math.max(8, r.left - 8)) + 'px';
  pop.style.top = (r.bottom + 8) + 'px';
  const set = async c => { pop.remove(); await kbSave('group', { color: c, customColor: true }, gid); };
  pop.onclick = e => { const b = e.target.closest('[data-c]'); if (b) set(b.dataset.c); };
  pop.querySelector('.kg-custom').onchange = e => set(e.target.value);
  setTimeout(() => {
    const away = e => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', away); } };
    document.addEventListener('pointerdown', away);
  }, 0);
}
/* Окно заметки уезжает вправо, на его место выезжает другое (граф) */
async function swapMainAnimated(apply) {
  const main = _host && _host.querySelector('.kb-main');
  if (!main || reduceMotion() || !main.offsetWidth) { apply(); return; }
  const off = innerWidth - main.getBoundingClientRect().left + 40;
  const out = main.animate([{ transform: 'none' }, { transform: `translateX(${off}px)` }],
    { duration: 300, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
  await out.finished.catch(() => {});
  apply();
  out.cancel();
  main.animate([{ transform: `translateX(${off}px)` }, { transform: 'none' }],
    { duration: 440, easing: 'cubic-bezier(.32,.72,.28,1)', fill: 'backwards' });
}
/* ── Каскад «как кубики» ──
   Панели группируются в ряды по положению на экране. Въезд — снизу,
   ряд за рядом (следующий ряд не ждёт весь предыдущий — небольшая
   задержка на ряд и на место в ряду). Падение — вниз, начиная с
   нижнего ряда. Сдвиг у всех один и тот же (высота экрана), поэтому
   панели одной колонки никогда не наезжают друг на друга. */
function rowsOf(els) {
  const items = els.map(el => ({ el, r: el.getBoundingClientRect() })).filter(o => o.r.width > 0);
  items.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(it.r.top - row.top) < 24) row.items.push(it);
    else rows.push({ top: it.r.top, items: [it] });
  }
  rows.forEach(r => r.items.sort((a, b) => a.r.left - b.r.left));
  return rows.map(r => r.items.map(i => i.el));
}
function cascadeIn(els) {
  if (reduceMotion()) return Promise.resolve();
  const X = innerHeight;
  const anims = [];
  rowsOf(els).forEach((row, ri) => row.forEach((el, ci) => anims.push(el.animate(
    [{ transform: `translateY(${X}px)` }, { transform: 'none' }],
    { duration: 620, delay: ri * 120 + ci * 55, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' }))));
  return Promise.all(anims.map(a => a.finished.catch(() => {})));
}
async function cascadeOut(els) {
  if (reduceMotion()) return;
  const X = innerHeight;
  const anims = [];
  rowsOf(els).reverse().forEach((row, ri) => row.forEach((el, ci) => anims.push(el.animate(
    [{ transform: 'none' }, { transform: `translateY(${X}px)` }],
    { duration: 480, delay: ri * 100 + ci * 45, easing: 'cubic-bezier(.55,0,.85,.35)', fill: 'forwards' }))));
  await Promise.all(anims.map(a => a.finished.catch(() => {})));
  return anims;
}
async function setStructure(on) {
  if (!_host || structBusy) return;
  structBusy = true;
  const side = _host.querySelector('.kb-side');
  const notesEl = _host.querySelector('.kb-notes');
  const main = _host.querySelector('.kb-main');
  const board = _host.querySelector('.kb-board');
  const visible = el => el && el.offsetWidth > 0 && getComputedStyle(el).visibility !== 'hidden';
  try {
    if (on) {
      flushEditor();
      if (graph) { graph.destroy(); graph = null; main.dataset.key = ''; }
      /* Все три панели падают вниз — так же, как окно заметки */
      const falling = [visible(side) ? side : null, notesOpen && visible(notesEl) ? notesEl : null, main].filter(Boolean);
      const anims = await cascadeOut(falling);
      view = 'structure';
      _host.classList.add('kb-structure');
      (anims || []).forEach(a => a.cancel());
      renderSide();
      renderBoard(true);
    } else {
      closeAddMenu();
      /* Шапка падает последней — после всех рядов колонок и поверх них */
      const items = [...board.querySelectorAll('.kb-bcol, .kb-loose')];
      const head = board.querySelector('.kb-board-head');
      const nRows = rowsOf(items).length;
      let headAnim = null;
      if (head && !reduceMotion()) {
        head.style.position = 'relative'; head.style.zIndex = '6';
        headAnim = head.animate([{ transform: 'none' }, { transform: `translateY(${innerHeight}px)` }],
          { duration: 480, delay: nRows * 100 + 60, easing: 'cubic-bezier(.55,0,.85,.35)', fill: 'forwards' });
      }
      const colAnims = await cascadeOut(items);
      if (headAnim) await headAnim.finished.catch(() => {});
      const anims = [...(colAnims || []), ...(headAnim ? [headAnim] : [])];
      view = 'note';
      _host.classList.remove('kb-structure');
      board.innerHTML = ''; board._html = '';
      (anims || []).forEach(a => a.cancel());
      renderKbView(_host);
      cascadeIn([notesOpen ? notesEl : side, main].filter(Boolean));
    }
  } finally { structBusy = false; }
}
/* Колонки-группы и отдельные заметки переносятся за ручку: элемент
   «поднимается» над доской, остальные смыкаются; место вставки
   показывают расступившиеся соседи. Отдельную заметку можно бросить
   на середину группы — она уйдёт в эту группу. */
function bindBoardDrag(board) {
  let el = null, id = '', note = false, gx = 0, gy = 0, slot = null, home = null, trash = false;
  const move = e => {
    if (!el) return;
    trash = trackTrash(e.clientX, e.clientY);
    el.style.left = (e.clientX - gx) + 'px';
    el.style.top = (e.clientY - gy) + 'px';
    el.style.transform = `rotate(1.5deg)${trash ? ' scale(.3)' : ''}`;
    el.classList.toggle('kb-to-trash', trash);
    slot = trash ? null : slotAt(board, e.clientX, e.clientY, id, note);
    showSlot(board, slot, id);
  };
  const up = async () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    if (!el) return;
    const from = el.getBoundingClientRect();
    const snaps = snapBoard(board);
    snaps.set(id, from);
    el.classList.remove('kb-lifted', 'kb-to-trash');
    el.style.left = el.style.top = el.style.width = el.style.transform = el.style.transformOrigin = '';
    resetTrash();
    dragGuard = Date.now();
    const src = id, isNote = note, toTrash = trash, sl = slot || home;
    el = null; trash = false; slot = null;
    if (toTrash) {
      showSlot(board, null);
      if (isNote) await trashNote(src); else await trashGroup(src, from);
      renderBoard(false, true);
      return;
    }
    if (sl.into) {
      await settleBoard(board, snaps, async () => {
        if (editing && editing.id === src) flushEditor();
        await kbSave('note', { groupId: sl.into }, src);
      });
      return;
    }
    placeInLayout(board, src, sl);
    await settleBoard(board, snaps);
  };
  board.addEventListener('pointerdown', e => {
    const h = e.target.closest('.kb-bcol-handle, .kb-loose-handle');
    if (!h || e.button > 0) return;
    e.preventDefault();
    note = h.classList.contains('kb-loose-handle');
    el = h.closest('[data-bid]');
    id = el.dataset.bid;
    const mcol = el.parentElement;
    home = { c: [...board.querySelectorAll('.kb-mcol')].indexOf(mcol), k: colItems(mcol).indexOf(el) };
    const r = el.getBoundingClientRect();
    gx = e.clientX - r.left; gy = e.clientY - r.top;
    const snaps = snapBoard(board);
    el.style.width = r.width + 'px';
    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
    el.style.transformOrigin = `${gx}px ${gy}px`;   // над корзиной сжимается к курсору
    el.classList.add('kb-lifted');
    flipBoard(board, snaps, 260);   // столбец смыкается на месте поднятого элемента
    slot = home;
    showSlot(board, slot, id);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
}
async function onBoardClick(e) {
  if (Date.now() - dragGuard < 250) return;
  if (e.target.closest('.kb-board-close')) { setStructure(false); return; }
  const dot = e.target.closest('.kb-bcol-dot');
  if (dot) { openColorPop(dot); return; }
  if (e.target.closest('.kb-bcol-input')) return;
  const item = e.target.closest('.kb-item');
  if (!item) return;
  const id = item.dataset.id;
  const n = kbItem(id);
  if (n && n.groupId) curGroup = n.groupId;
  notesOpen = true;
  await setStructure(false);
  openNote(id);
}

/* ══════════════ Перетаскивание групп ══════════════
   Тянем группу за строку: верхняя треть строки-цели — поставить перед
   ней, нижняя — после неё (тот же уровень), середина — вложить в неё
   подгруппой. На телефоне перетаскивание начинается после короткого
   удержания, чтобы не мешать прокрутке списка. */
function bindGroupDrag(side) {
  let src = null, srcId = '', ghost = null, started = false, sx = 0, sy = 0, holdT = null, target = null, zone = '';
  const clearMark = () => { side.querySelectorAll('.kb-g.drop-before, .kb-g.drop-after, .kb-g.drop-into').forEach(x => x.classList.remove('drop-before', 'drop-after', 'drop-into')); };
  const begin = (x, y) => {
    started = true;
    ghost = document.createElement('div');
    ghost.className = 'kb-note-ghost kb-group-ghost';
    ghost.textContent = (src.querySelector('.kb-g-name') || src).textContent;
    ghost.style.width = Math.min(220, src.offsetWidth) + 'px';
    document.body.appendChild(ghost);
    src.classList.add('dragging');
    document.body.classList.add('kb-dragging');
    try { navigator.vibrate(10); } catch {}
    place(x, y);
  };
  const place = (x, y) => {
    ghost.style.transform = `translate(${x + 10}px, ${y - 14}px)`;
    clearMark();
    target = null; zone = '';
    const el = document.elementFromPoint(x, y);
    const row = el && el.closest('.kb-g[data-g]');
    if (!row || !row.dataset.g || row.dataset.g === LOOSE || row.dataset.g === srcId) return;
    if (groupBranch(srcId).has(row.dataset.g)) return;   // в себя или в свою подгруппу нельзя
    const r = row.getBoundingClientRect();
    const f = (y - r.top) / r.height;
    zone = f < .3 ? 'before' : f > .7 ? 'after' : 'into';
    target = row.dataset.g;
    row.classList.add('drop-' + zone);
  };
  const move = e => {
    if (!src) return;
    if (!started) {
      const far = Math.abs(e.clientX - sx) > 7 || Math.abs(e.clientY - sy) > 7;
      if (e.pointerType === 'touch') { if (far) cancel(); return; }   // палец сдвинулся до удержания — это прокрутка
      if (!far) return;
      begin(e.clientX, e.clientY);
    }
    place(e.clientX, e.clientY);
  };
  const block = e => { if (started && e.cancelable) e.preventDefault(); };
  const cancel = () => {
    if (holdT) { clearTimeout(holdT); holdT = null; }
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    document.removeEventListener('touchmove', block);
    if (ghost) { ghost.remove(); ghost = null; }
    if (src) src.classList.remove('dragging');
    document.body.classList.remove('kb-dragging');
    clearMark();
    src = null;
  };
  const up = async () => {
    const wasStarted = started, tgt = target, z = zone, id = srcId;
    if (started) dragGuard = Date.now();
    started = false;
    cancel();
    if (wasStarted && tgt && z) await moveGroup(id, tgt, z);
  };
  side.addEventListener('pointerdown', e => {
    const row = e.target.closest('.kb-g[data-g]');
    if (!row || !row.dataset.g || row.dataset.g === LOOSE || e.button > 0) return;
    if (e.target.closest('.kb-g-caret, .kb-g-edit')) return;
    src = row; srcId = row.dataset.g; sx = e.clientX; sy = e.clientY; started = false;
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('touchmove', block, { passive: false });
    if (e.pointerType === 'touch') holdT = setTimeout(() => { holdT = null; if (src) begin(sx, sy); }, 380);
  });
}
async function moveGroup(id, targetId, zone) {
  const groups = kbGroups();
  const target = groups.find(g => g.id === targetId);
  if (!target) return;
  const parent = zone === 'into' ? target.id : (target.parentId || '');
  const sibs = groups.filter(g => (g.parentId || '') === parent && g.id !== id);
  let idx = zone === 'into' ? sibs.length : sibs.findIndex(g => g.id === targetId) + (zone === 'after' ? 1 : 0);
  if (idx < 0) idx = sibs.length;
  sibs.splice(idx, 0, { id });
  for (let i = 0; i < sibs.length; i++) {
    const g = rawItem(sibs[i].id);
    if (!g) continue;
    const order = (i + 1) * 10;
    if (g.order !== order || (g.parentId || '') !== parent) await kbSave('group', { order, parentId: parent }, g.id);
  }
  if (zone === 'into') openGroups.add(target.id);
  renderSide();
}

/* Кнопка «+» приложения в этом режиме заводит заметку */
export async function newKbNote(anchor) {
  if (view === 'structure') { toggleAddMenu(anchor || document.getElementById('addBtn')); return; }
  flushEditor();
  const n = await kbSave('note', {
    title: '', html: '', groupId: curGroup === LOOSE ? '' : (curGroup || (kbGroups()[0] || {}).id || ''),
    files: [], links: [], tags: [],
  });
  notesOpen = true;   // новая заметка видна в колонке своей группы
  openNote(n.id, true);
}


/* ══════════════════════════════════════════════════════════════════
   Расписание — повседневные дела («Обед», «Сон», «Дорога»).

   Это не задачи: у них нет статусов, квадратов и переносов, в списке
   задач их нет, и выполнять их не нужно. Они видны только в Timeline
   как фон дня. Хранятся здесь, в сторе базы знаний, с kind: 'routine'
   — так они бесплатно получают синхронизацию, а интерфейс базы знаний
   их не видит, потому что отбирает записи по kind.
   ══════════════════════════════════════════════════════════════════ */
export const getRoutines = () => all('routine')
  .sort((a, b) => String(a.start).localeCompare(String(b.start)));
/* Будни по номерам: 1 = пн … 7 = вс */
export const routinesForDay = iso => {
  const d = new Date(iso + 'T00:00:00');
  const wd = ((d.getDay() + 6) % 7) + 1;
  return getRoutines().filter(r => (r.days || []).includes(wd));
};
export const saveRoutine = (data, id) => kbSave('routine', data, id);
export const removeRoutine = id => kbRemove(id);
