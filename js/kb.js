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
import { morph, exit, enter, enterDeep, fadeRemove, pop, EASE, EASE_IN } from './anim.js';
import { dbAll, dbPut, dbBulk, dbGet, dbDel } from './db.js';
import { uid, esc, MODES, safeHtml } from './store.js';
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
let curNote = null;
let query = '';
let _host = null;
let view = 'note';         // что в панели справа: 'note' | 'graph'
let panel = false;         // панель справа (заметка или граф) открыта
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
/* Перерисовка «на месте» с движением (anim.morph); сама отрисовка — ниже */
export function renderKbView(el) { morph(el, () => renderKbViewNow(el)); }
function renderKbViewNow(el) {
  if (!el) return;
  if (_host !== el || !el.querySelector(':scope > .kb-board')) buildShell(el);
  _host = el;
  if (curNote && !kbItem(curNote)) curNote = null;
  renderBoard();
  renderMain();
}

/* Окно базы знаний — доска папок. Шапка (название, поиск, граф) живёт
   отдельно от перерисовываемого тела, чтобы поле поиска не теряло фокус.
   Заметка и граф открываются в панели справа (на телефоне — поверх). */
function buildShell(el) {
  el.innerHTML = `
    <section class="kb-board" data-drop="${LOOSE}" aria-label="База знаний">
      <header class="kb-board-head"><b>База знаний</b>
        <label class="kb-bsearch">${ICON_SEARCH}<input class="kb-q" type="search" placeholder="Поиск по заметкам" value="${esc(query)}"></label>
        <button type="button" class="btn mini kb-to-graph" title="Граф связей между заметками">◉ Граф</button>
      </header>
      <div class="kb-board-body"></div>
      <div class="btn danger kb-trash" aria-hidden="true">${TRASH_SVG}<span>Удалить</span></div>
    </section>
    <main class="kb-main"></main>`;
  panel = false;
  const boardNode = el.querySelector('.kb-board');
  const qi = boardNode.querySelector('.kb-q');
  qi.oninput = () => { query = qi.value; renderBoard(); };
  qi.onkeydown = e => {
    if (e.key === 'Escape') { qi.value = ''; query = ''; renderBoard(); return; }
    if (e.key !== 'Enter') return;
    const first = boardNode.querySelector('.kb-board-body .kb-item');
    if (first) openNote(first.dataset.id);
  };
  boardNode.addEventListener('click', onBoardClick);
  bindBoardDrag(boardNode);
  /* Название новой папки: сохраняем по Enter или когда поле теряет фокус */
  const saveName = async inp => {
    const v = inp.value.trim();
    if (inp._saved) return;
    const g = rawItem(inp.dataset.gid);
    if (!v) { if (g && g.name) renderBoard(true); return; }   // переименование отменено
    inp._saved = true;
    if (freshId === inp.dataset.gid) freshId = null;
    if (g && g.name === v) { renderBoard(true); return; }
    await kbSave('group', { name: v }, inp.dataset.gid);
  };
  boardNode.addEventListener('keydown', e => {
    if (!e.target.classList.contains('kb-bcol-input')) return;
    if (e.key === 'Enter') { e.preventDefault(); saveName(e.target); }
    else if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); }
  });
  boardNode.addEventListener('focusout', e => { if (e.target.classList.contains('kb-bcol-input')) saveName(e.target); });
}

/* ── Панель справа ──
   Открывается — доска сужается, папки плавно переезжают в новые
   столбцы (FLIP), панель выезжает справа. Закрывается — наоборот. */
let panelBusy = false;
const isPhone = () => matchMedia('(max-width: 720px)').matches;
async function setPanel(open) {
  if (!_host) return;
  const main = _host.querySelector('.kb-main');
  const board = _host.querySelector('.kb-board');
  const was = _host.classList.contains('kb-panel-open');
  panel = open;
  if (was === open || panelBusy) { if (open) renderMain(); return; }
  panelBusy = true;
  try {
    if (!open) {
      flushEditor();
      acClose();
      if (!reduceMotion()) await main.animate(
        [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: isPhone() ? 'translateX(40%)' : 'translateX(32px)' }],
        { duration: 220, easing: EASE_IN, fill: 'forwards' }).finished.catch(() => {});
    }
    const snaps = snapBoard(board);
    _host.classList.toggle('kb-panel-open', open);
    document.body.classList.toggle('kb-panel-on', open);
    if (open) renderMain();
    else {
      editing = null;
      if (graph) { graph.destroy(); graph = null; }
      main.dataset.key = '';
      main.innerHTML = '';
      main.getAnimations().forEach(a => a.cancel());
    }
    if (!isPhone()) { layoutBoard(board); boardW = board.offsetWidth; flipBoard(board, snaps, 460); }
    if (open && !reduceMotion()) main.animate(
      [{ opacity: 0, transform: isPhone() ? 'translateX(40%)' : 'translateX(32px)' }, { opacity: 1, transform: 'none' }],
      { duration: 440, easing: EASE });
  } finally { panelBusy = false; }
  if (!open) renderBoard();   // снять подсветку открытой заметки
}

function openNote(id, focusEditor) {
  flushEditor();
  curNote = id;
  view = 'note';
  if (!panel) setPanel(true); else renderMain();
  renderBoard();
  if (focusEditor && _host) {
    const t = _host.querySelector('.kb-title');
    if (t) t.focus();
  }
}
function closeNote() { curNote = null; setPanel(false); }
function toggleGraph() {
  flushEditor();
  if (panel && view === 'graph') { if (curNote) { view = 'note'; renderMain(); } else setPanel(false); return; }
  graphScope = 'all';
  view = 'graph';
  if (!panel) setPanel(true); else renderMain();
}

let dragGuard = 0;   // после перетаскивания браузер шлёт click — его пропускаем

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


/* Миниатюра открытой заметки — прямо при наборе, без перерисовки */
function updateThumb() {
  if (!editing || !_host) return;
  const title = editing.title.value.trim();
  const text = plain(editing.ed.innerHTML);
  const label = title || text.slice(0, 40) || 'Без названия';
  _host.querySelectorAll(`.kb-board [data-id="${CSS.escape(editing.id)}"]`).forEach(node => {
    const b = node.querySelector('b'), i = node.querySelector('i');
    if (b) b.textContent = label;
    if (i) i.textContent = text.slice(0, 70) || 'Пусто';
  });
}

/* ── Основная область ── */
function renderMain() {
  if (!_host) return;
  const gb = _host.querySelector('.kb-to-graph');
  if (gb) gb.classList.toggle('on', panel && view === 'graph');
  if (!panel) return;
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
  if (!note) {   // заметку удалили (здесь или на другом устройстве) — панель закрывается
    if (!panelBusy) setTimeout(closeNote, 0);
    return;
  }
  if (fresh) buildNote(main, note);
  else softUpdateNote(main, note);
}

function groupOptions(n) {
  return `<option value="">Без папки</option>
    ${flatGroups().map(({ g, depth }) => `<option value="${g.id}"${n.groupId === g.id ? ' selected' : ''}>${'\u2003'.repeat(depth)}${esc(g.name || 'Новая папка')}</option>`).join('')}`;
}

function buildNote(main, n) {
  main.innerHTML = `
    <header class="kb-nhead">
      <button type="button" class="kf-hbtn kb-pclose" title="Закрыть заметку" aria-label="Закрыть заметку">${ICON_BACK}</button>
      <input class="kb-title" type="text" maxlength="120" placeholder="Название заметки" value="${esc(n.title || '')}">
      <button type="button" class="kf-hbtn kb-del" title="Удалить заметку" aria-label="Удалить заметку">${TRASH_SVG}</button>
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
  ed.innerHTML = safeHtml(n.html);
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
    e.ed.innerHTML = safeHtml(n.html);
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
    closeNote();
  };
  main.querySelector('.kb-pclose').onclick = closeNote;
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
    renderMain();
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
  const close = () => { fadeRemove(ov); };
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
      <button type="button" class="kf-hbtn kb-gclose" title="Закрыть граф" aria-label="Закрыть граф"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
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
  main.querySelector('.kb-gclose').onclick = toggleGraph;
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
    (used.has('') ? '<span><i style="--lc:var(--dim)" class="kbl-dot"></i>Без папки</span>' : ''));
  graph.setData(nodes, links, curNote);
  if (refit) graph.autoFit();
}



/* ══════════════ Структура ══════════════
   Колонка заметок и окно заметки каскадом падают вниз, панель групп
   уходит вверх, а группы — в своём порядке — поднимаются колонками.
   Заметки перетаскиваются между колонками (тот же механизм, что и
   перенос заметки на группу: колонка — цель [data-drop]). */
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
let freshId = null;   // только что созданная группа — сразу дать ввести название
/* ── Папки ──
   Группа верхнего уровня лежит на доске папкой: сзади цветная вкладка,
   из-под матового «стекла» выглядывают листы — подпапки и заметки.
   Наведение — листы веером приподнимаются, стекло отклоняется. Клик —
   папка на этом же месте раскрывается в колонку: подпапки в ней снова
   папками (их можно открыть, перетащить в другую папку или вытащить на
   доску отдельной папкой), ниже — заметки. Что открыто, помнит устройство. */
const OPEN_KEY = 'rl_kb_open';
function loadOpen() { try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
let openMap = loadOpen();   // id папки на доске → id открытой в её колонке (подпапки)
const saveOpen = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(openMap)); } catch {} };
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 6-6 6 6 6"/></svg>';
const ICON_FOLD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>';
function folderInfo(gid, groups, notes) {
  const subs = childGroups(gid, groups);
  const own = notes.filter(n => n.groupId === gid);
  return { subs, own, count: subs.length + own.length };
}
function nameHTML(g, cls) {
  return g.name ? `<b class="${cls}">${esc(g.name)}</b>`
    : `<input class="kb-bcol-input ${cls}" data-gid="${g.id}" type="text" maxlength="60" placeholder="Название папки">`;
}
/* Папка: back — вкладка, papers — листы, front — стекло с названием */
function foldHTML(g, groups, notes, mini) {
  const { subs, own, count } = folderInfo(g.id, groups, notes);
  const papers = [
    ...subs.map(x => ({ t: x.name || 'Новая папка', m: `Папка · ${folderInfo(x.id, groups, notes).count}`, c: x.color })),
    ...own.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .map(n => ({ t: titleOf(n), m: String(n.updatedAt || '').slice(5, 10).split('-').reverse().join('.') })),
  ].slice(0, mini ? 2 : 3).reverse();
  return `<div class="kb-fold${mini ? ' mini' : ''}" data-fold="${g.id}" data-into="${g.id}" style="--gc:${g.color || '#94a3b8'}">
      <div class="kf-back"></div>
      <div class="kf-papers">${papers.map((x, k) => { const z = papers.length - 1 - k; return `<div class="kf-paper" style="--k:${z};--r:${[0, -3, 2.5][z]}"><b>${x.c ? `<svg class="kf-pico" viewBox="0 0 24 24" style="color:${x.c}" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor"/></svg>` : ''}${esc(x.t)}</b><em>${esc(x.m)}</em><i></i><i></i><i></i></div>`; }).join('')}</div>
      <div class="kf-shade"></div>
      <div class="kf-front">
        ${nameHTML(g, 'kf-name')}
        <em class="kf-meta">${count} ${plural(count, 'элемент', 'элемента', 'элементов')}</em>
        ${mini ? '' : `<button type="button" class="kf-add" data-add="${g.id}" title="Добавить" aria-label="Добавить в папку">${ICON_PLUS}</button>`}
      </div>
    </div>`;
}
/* Раскрытая папка: вкладка сверху, стекло-колонка с подпапками и заметками */
function colHTML(root, cur, groups, notes) {
  const { subs, own, count } = folderInfo(cur.id, groups, notes);
  const list = own.slice().sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  return `<div class="kb-fcol" data-into="${cur.id}" style="--gc:${cur.color || '#94a3b8'}">
      <div class="kf-back"></div>
      <div class="kf-glass">
        <header class="kf-head">
          ${cur.id !== root.id ? `<button type="button" class="kf-hbtn kf-up" title="Назад" aria-label="Назад">${ICON_BACK}</button>` : ''}
          <button type="button" class="kb-g-dot kb-bcol-dot" data-gid="${cur.id}" title="Цвет папки" style="background:${cur.color || '#94a3b8'}"></button>
          <span class="kf-title">${cur.id !== root.id ? `<i>${esc(root.name || '')} ›</i>` : ''}${nameHTML(cur, 'kf-hname')}</span>
          <span class="kb-g-n">${count}</span>
          <button type="button" class="kf-hbtn kf-plus" data-add="${cur.id}" title="Добавить" aria-label="Добавить в папку">${ICON_PLUS}</button>
          <button type="button" class="kf-hbtn kf-close" title="Свернуть папку" aria-label="Свернуть папку">${ICON_FOLD}</button>
        </header>
        <div class="kf-body">
          ${subs.length ? `<div class="kf-subs">${subs.map(x => `<div class="kf-sub" data-sub="${x.id}">${foldHTML(x, groups, notes, true)}</div>`).join('')}</div>` : ''}
          <div class="kb-bcol-list">${list.map(itemHTML).join('')}</div>
          ${count ? '' : '<p class="empty">Перетащите сюда заметку или папку</p>'}
        </div>
      </div>
    </div>`;
}
function renderBoard(force) {
  if (!_host) return;
  const board = _host.querySelector('.kb-board');
  const body = board.querySelector('.kb-board-body');
  const q = query.trim().toLowerCase();
  if (q) {   // поиск: найденные заметки списком вместо папок
    const found = kbNotes().filter(n => (titleOf(n) + ' ' + plain(n.html)).toLowerCase().includes(q))
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    const html = `<div class="kb-found"><p class="kb-found-cap">${found.length ? `Найдено: ${found.length}` : 'Ничего не найдено'}</p>
      <div class="kb-found-list">${found.map(n => {
        const g = kbItem(n.groupId);
        return `<div class="kb-found-it">${g ? `<span class="kb-found-g" style="--gc:${g.color || '#94a3b8'}">${esc(g.name || '')}</span>` : ''}${itemHTML(n)}</div>`;
      }).join('')}</div></div>`;
    setHTML(body, html);
    return;
  }
  const notes = kbNotes();
  const groups = kbGroups();
  const known = new Set(groups.map(g => g.id));
  const roots = groups.filter(g => !g.parentId || !known.has(g.parentId));
  /* открытое — только существующее и внутри своей папки */
  for (const k of Object.keys(openMap)) {
    if (!roots.some(r => r.id === k)) delete openMap[k];
    else if (!groupBranch(k, groups).has(openMap[k])) openMap[k] = k;
  }
  let i = 0;   // порядок элементов: раскладка по столбцам переставляет узлы
  const items = roots.map(g => {
    const cur = openMap[g.id] ? groups.find(x => x.id === openMap[g.id]) || g : null;
    return `<div class="kb-fi${cur ? ' open' : ''}" data-i="${i++}" data-bid="${g.id}" data-root="${g.id}">${cur ? colHTML(g, cur, groups, notes) : foldHTML(g, groups, notes, false)}</div>`;
  }).join('');
  /* Заметки без папки — отдельными плашками после папок */
  const loose = notes.filter(n => !n.groupId || !known.has(n.groupId))
    .map(n => `<div class="kb-loose" data-i="${i++}" data-bid="${n.id}" data-note="${n.id}" style="--gc:#94a3b8">${itemHTML(n)}</div>`).join('');
  const html = `<div class="kb-board-cols" data-drop="${LOOSE}">${items}${loose}${items || loose ? '' : '<p class="empty">Пусто — нажмите «+», чтобы создать папку или заметку</p>'}</div>`;
  saveOpen();
  const changed = body._html !== html;
  setHTML(body, html);
  if (changed || force) layoutBoard(board);
  const inp = board.querySelector('.kb-bcol-input');
  if (inp && freshId && inp.dataset.gid === freshId && document.activeElement !== inp) inp.focus();
}
/* ── Папка раскрывается в колонку на своём месте ──
   Колонка растёт из прямоугольника папки (clip-path), соседи ниже
   плавно расступаются, содержимое поднимается каскадом. Закрытие —
   наоборот: содержимое гаснет, колонка сжимается до размера папки. */
let foldBusy = false;
const FOLD_AR = 1.45;   // ширина / высота папки (style.css: .kb-fold)
function boardEl() { return _host && !query.trim() ? _host.querySelector('.kb-board') : null; }
const fiOf = (board, id) => board.querySelector(`.kb-fi[data-root="${CSS.escape(id)}"]`);
function growFrom(el, fromH, ms = 520) {
  const H = el.offsetHeight;
  if (reduceMotion() || H <= fromH) return Promise.resolve();
  return el.animate([{ clipPath: `inset(0 0 ${H - fromH}px 0 round 22px)` }, { clipPath: 'inset(0 0 0 0 round 22px)' }],
    { duration: ms, easing: EASE }).finished.catch(() => {});
}
async function openFolder(id, sub) {
  const board = boardEl();
  if (!board || foldBusy) return;
  foldBusy = true;
  try {
    const fi = fiOf(board, id);
    const fromH = fi ? fi.offsetHeight : 0;
    const snaps = snapBoard(board);
    openMap[id] = sub || id;
    renderBoard(true);
    flipBoard(board, snaps, 520);
    const now = fiOf(board, id);
    const col = now && now.querySelector('.kb-fcol');
    if (!col) return;
    enter([...col.querySelectorAll('.kf-head, .kf-sub, .kb-item, .kf-body > .empty')], { delay: 90, stagger: 30 });
    await growFrom(col, fromH);
  } finally { foldBusy = false; }
}
async function closeFolder(id) {
  const board = boardEl();
  if (!board || foldBusy) return;
  foldBusy = true;
  try {
    const fi = fiOf(board, id);
    const col = fi && fi.querySelector('.kb-fcol');
    if (col && !reduceMotion()) {
      const H = col.offsetHeight, toH = Math.round(col.offsetWidth / FOLD_AR);
      const outs = await exit([...col.querySelectorAll('.kf-body > *')], { y: -4 });
      if (H > toH) await col.animate([{ clipPath: 'inset(0 0 0 0 round 22px)' }, { clipPath: `inset(0 0 ${H - toH}px 0 round 22px)` }],
        { duration: 340, easing: EASE_IN, fill: 'forwards' }).finished.catch(() => {});
      outs.forEach(a => a.cancel && a.cancel());
    }
    const snaps = snapBoard(board);
    delete openMap[id];
    renderBoard(true);
    flipBoard(board, snaps, 420);
    const now = fiOf(board, id);
    const papers = now ? [...now.querySelectorAll('.kf-paper')] : [];
    papers.forEach((p, k) => p.animate([{ transform: 'translateY(40%)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 420, delay: 60 + k * 50, easing: EASE, fill: 'backwards' }));
  } finally { foldBusy = false; }
}
/* Переход в подпапку и назад — внутри колонки: содержимое уезжает
   в сторону, новое приезжает с другой, высота колонки — плавно */
async function drillTo(rootId, gid, dir) {
  const board = boardEl();
  if (!board || foldBusy) return;
  foldBusy = true;
  try {
    const fi = fiOf(board, rootId);
    const col = fi && fi.querySelector('.kb-fcol');
    const oldH = col ? col.offsetHeight : 0;
    if (col && !reduceMotion()) {
      await Promise.all([...col.querySelectorAll('.kf-body > *, .kf-title')].map(n => n.animate(
        [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-24 * dir}px)` }],
        { duration: 160, easing: EASE_IN, fill: 'forwards' }).finished.catch(() => {})));
    }
    const snaps = snapBoard(board);
    openMap[rootId] = gid;
    renderBoard(true);
    flipBoard(board, snaps, 460);
    const now = fiOf(board, rootId);
    const c2 = now && now.querySelector('.kb-fcol');
    if (!c2 || reduceMotion()) return;
    [...c2.querySelectorAll('.kf-title, .kf-sub, .kb-item, .kf-body > .empty')].forEach((n, k) => n.animate(
      [{ opacity: 0, transform: `translateX(${28 * dir}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 380, delay: Math.min(k * 28, 280), easing: EASE, fill: 'backwards' }));
    const H = c2.offsetHeight;
    if (Math.abs(H - oldH) > 2) c2.animate(H > oldH
      ? [{ clipPath: `inset(0 0 ${H - oldH}px 0 round 22px)` }, { clipPath: 'inset(0 0 0 0 round 22px)' }]
      : [{ clipPath: 'inset(0 0 0 0 round 22px)' }, { clipPath: 'inset(0 0 0 0 round 22px)' }], { duration: 420, easing: EASE });
  } finally { foldBusy = false; }
}
/* ── Корзина «Структуры» (левый нижний угол) ──
   Пока тянем заметку или группу, корзина следит за курсором: поднесли
   ближе — разворачивается в поле «Удалить», курсор над полем —
   поле подсвечено, отпустили над ним — элемент удаляется сразу, без
   подтверждения. Только группа с заметками спрашивает, что делать с
   заметками. */
const TRASH_NEAR = 110;   // px от корзины, с которых она разворачивается
function boardTrash() {
  const t = _host && _host.querySelector('.kb-trash');
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
  renderBoard();
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
    const close = v => { fadeRemove(ov); document.removeEventListener('keydown', esc); done(v); };
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
  const items = [...wrap.querySelectorAll('.kb-fi, .kb-loose')].sort((a, b) => a.dataset.i - b.dataset.i);
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
    /* на середину папки — положить в папку */
    if (canInto && el.classList.contains('kb-fi') && y > top + r.height * .2 && y < top + r.height * .8) {
      const t = el.querySelector('[data-into]');
      return { into: t.dataset.into, el: t };
    }
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
  renderBoard(true);
  flipBoard(board, snaps);
  requestAnimationFrame(() => board.classList.remove('kb-settling'));
}
let boardW = 0;
addEventListener('resize', () => {
  const board = _host && _host.isConnected && _host.querySelector('.kb-board');
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
async function createBoardGroup(parent = '') {
  const sibs = kbGroups().filter(g => (g.parentId || '') === parent);
  const order = sibs.reduce((m, g) => Math.max(m, g.order || 0), 0) + 10;
  const g = await kbSave('group', { name: '', color: freeColor(), order, parentId: parent });
  freshId = g.id;
  renderBoard();
}
async function createBoardNote(gid = '') {
  const n = await kbSave('note', { title: '', html: '', groupId: gid, files: [], links: [], tags: [] });
  openNote(n.id, true);   // новая заметка сразу открывается в панели
}
/* Меню над кнопкой «+»: «+ Группа» / «+ Заметка» */
let addMenu = null;
function closeAddMenu() { if (addMenu) { addMenu.remove(); addMenu = null; } }
function toggleAddMenu(anchor, gid = '') {
  if (addMenu) { closeAddMenu(); return; }
  addMenu = document.createElement('div');
  addMenu.className = 'kb-add-menu glass';
  addMenu.innerHTML = `<button type="button" class="btn" data-add="group">＋ ${gid ? 'Подпапка' : 'Папка'}</button><button type="button" class="btn" data-add="note">＋ Заметка</button>`;
  document.body.appendChild(addMenu);
  const r = anchor ? anchor.getBoundingClientRect() : { top: innerHeight - 80, right: innerWidth - 16 };
  addMenu.style.right = Math.max(8, innerWidth - r.right) + 'px';
  /* у кнопки в папке меню ниже кнопки, у общей «+» — над ней */
  if (gid && r.bottom + 110 < innerHeight) { addMenu.style.top = (r.bottom + 8) + 'px'; addMenu.style.transformOrigin = 'top right'; }
  else addMenu.style.bottom = (innerHeight - r.top + 10) + 'px';
  addMenu.onclick = async e => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    closeAddMenu();
    if (b.dataset.add !== 'group') { createBoardNote(gid); return; }
    if (!gid) { createBoardGroup(); return; }
    /* подпапка: папка раскрывается (если была закрыта) и в ней поле названия */
    const g = kbGroups();
    let root = gid, guard = 0;
    for (let x = g.find(q => q.id === gid); x && x.parentId && guard++ < 50; x = g.find(q => q.id === x.parentId)) root = x.parentId;
    await createBoardGroup(gid);
    if (!openMap[root]) await openFolder(root, gid); else if (openMap[root] !== gid) await drillTo(root, gid, 1);
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
/* ── Перенос по доске ──
   Тянуть можно папку (закрытую — целиком, открытую — за шапку),
   подпапку из колонки, заметку из колонки и отдельную заметку. Мышью —
   сразу после сдвига, пальцем — после короткого удержания (иначе не
   прокрутить доску). Цели:
   • папка или подпапка под курсором, открытая колонка — положить внутрь
     (подпапка уезжает вместе со своими заметками);
   • промежуток между элементами доски — встать туда: подпапка становится
     отдельной папкой, заметка — отдельной заметкой;
   • корзина — удалить. */
function bindBoardDrag(board) {
  let d = null;   // { kind: 'note'|'group', id, src, rootItem, ghost, gx, gy, started, hold, sx, sy }
  const ancestorsOk = (gid, into) => !groupBranch(gid).has(into);
  const targetAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const inCol = el && el.closest('.kb-fcol');
    if (inCol && !(d.rootItem && d.src.contains(inCol))) {
      const t = el.closest('.kb-fold.mini') || inCol;
      return { into: t.dataset.into, el: t };
    }
    const sl = slotAt(board, x, y, d.rootItem ? d.id : null, true);
    return sl;
  };
  const valid = t => {
    if (!t || !t.into) return true;
    if (d.kind === 'group') return t.into !== d.id && ancestorsOk(d.id, t.into);
    return true;
  };
  const begin = () => {
    d.started = true;
    const r = d.src.getBoundingClientRect();
    d.gx = d.sx - r.left; d.gy = d.sy - r.top;
    const g = d.src.cloneNode(true);
    g.classList.add('kb-drag-card', 'kb-drag-fold');
    g.classList.remove('dragging', 'on');
    g.style.width = r.width + 'px';
    g.style.height = r.height + 'px';
    document.body.appendChild(g);
    d.ghost = g;
    const snaps = snapBoard(board);
    if (d.rootItem) { d.src.classList.add('kb-lifting'); flipBoard(board, snaps, 260); }   // столбец смыкается
    else d.src.classList.add('dragging');
    document.body.classList.add('kb-dragging');
    try { navigator.vibrate(8); } catch {}
  };
  const move = e => {
    if (!d) return;
    if (!d.started) {
      const far = Math.abs(e.clientX - d.sx) > 6 || Math.abs(e.clientY - d.sy) > 6;
      if (e.pointerType === 'touch') { if (far && d.hold) { clearTimeout(d.hold); d.hold = null; cancel(); } return; }
      if (!far) return;
      begin();
    }
    const inTrash = trackTrash(e.clientX, e.clientY);
    d.ghost.style.transformOrigin = `${d.gx}px ${d.gy}px`;
    d.ghost.style.transform = `translate(${e.clientX - d.gx}px, ${e.clientY - d.gy}px) rotate(2deg)${inTrash ? ' scale(.35)' : ''}`;
    d.ghost.classList.toggle('kb-to-trash', inTrash);
    d.trash = inTrash;
    let t = inTrash ? null : targetAt(e.clientX, e.clientY);
    if (!valid(t)) t = null;
    d.slot = t;
    showSlot(board, t && !t.into ? t : null, d.rootItem ? d.id : null);
    board.querySelectorAll('.kb-drop-over').forEach(x => x.classList.remove('kb-drop-over'));
    if (t && t.into) t.el.classList.add('kb-drop-over');
  };
  const block = e => { if (d && d.started && e.cancelable) e.preventDefault(); };
  const cancel = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    document.removeEventListener('touchmove', block);
    if (d && d.hold) clearTimeout(d.hold);
    d = null;
  };
  const up = async () => {
    const c = d;
    cancel();
    if (!c || !c.started) return;
    dragGuard = Date.now();
    document.body.classList.remove('kb-dragging');
    board.querySelectorAll('.kb-drop-over').forEach(x => x.classList.remove('kb-drop-over'));
    resetTrash();
    const gr = c.ghost.getBoundingClientRect();
    const t = c.slot;
    const snaps = snapBoard(board);
    const done = () => { c.ghost.remove(); c.src.classList.remove('kb-lifting', 'dragging'); };
    if (c.trash) {
      done(); showSlot(board, null);
      if (c.kind === 'note') await trashNote(c.id); else await trashGroup(c.id, gr);
      renderBoard(true);
      return;
    }
    if (!t) {   // отпустили мимо — всё возвращается на место
      if (!reduceMotion()) {
        const r = c.src.classList.contains('kb-lifting') ? null : c.src.getBoundingClientRect();
        if (r) await c.ghost.animate([{ transform: c.ghost.style.transform }, { transform: `translate(${r.left}px, ${r.top}px)` }],
          { duration: 280, easing: EASE, fill: 'forwards' }).finished.catch(() => {});
      }
      done(); showSlot(board, null);
      if (c.rootItem) { snaps.set(c.id, gr); renderBoard(true); flipBoard(board, snaps); }
      return;
    }
    if (t.into) {
      /* «проглатывание»: миниатюра ныряет в папку */
      const tr = t.el.getBoundingClientRect();
      if (!reduceMotion()) await c.ghost.animate([
        { transform: c.ghost.style.transform, opacity: 1 },
        { transform: `translate(${tr.left + tr.width / 2 - gr.width * .1}px, ${tr.top + Math.min(tr.height, 120) * .35}px) scale(.2)`, opacity: 0 }],
        { duration: 300, easing: EASE_IN, fill: 'forwards' }).finished.catch(() => {});
      done(); showSlot(board, null);
      await settleBoard(board, snaps, async () => {
        if (c.kind === 'note') {
          if (editing && editing.id === c.id) flushEditor();
          await kbSave('note', { groupId: t.into }, c.id);
        } else {
          const sibs = kbGroups().filter(g => (g.parentId || '') === t.into && g.id !== c.id);
          const order = sibs.reduce((m, g) => Math.max(m, g.order || 0), 0) + 10;
          await kbSave('group', { parentId: t.into, order }, c.id);
          if (openMap[c.id]) delete openMap[c.id];
        }
      });
      const fold = board.querySelector(`[data-into="${CSS.escape(t.into)}"]`);
      if (fold) pop(fold);
      return;
    }
    /* промежуток на доске */
    done();
    snaps.set(c.id, gr);
    placeInLayout(board, c.id, t);
    await settleBoard(board, snaps, async () => {
      if (c.kind === 'note') {
        const n = kbItem(c.id);
        if (n && n.groupId) { if (editing && editing.id === c.id) flushEditor(); await kbSave('note', { groupId: '' }, c.id); }
      } else if (!c.rootItem) {
        const roots = kbGroups().filter(g => !g.parentId);
        await kbSave('group', { parentId: '', order: roots.reduce((m, g) => Math.max(m, g.order || 0), 0) + 10 }, c.id);
      }
    });
  };
  board.addEventListener('pointerdown', e => {
    if (e.button > 0 || d || foldBusy) return;
    if (e.target.closest('button:not(.kb-item), input, .kb-board-head')) return;
    let src = null, kind = '', id = '', rootItem = false;
    const item = e.target.closest('.kb-item');
    const head = e.target.closest('.kf-head');
    const mini = e.target.closest('.kf-sub');
    const fi = e.target.closest('.kb-fi');
    if (item) {
      const loose = item.closest('.kb-loose');
      src = loose || item; kind = 'note'; id = item.dataset.id; rootItem = !!loose;
    } else if (mini) { src = mini; kind = 'group'; id = mini.dataset.sub; }
    else if (fi && (head || !fi.classList.contains('open'))) { src = fi; kind = 'group'; id = fi.dataset.root; rootItem = true; }
    if (!src) return;
    d = { src, kind, id, rootItem, sx: e.clientX, sy: e.clientY, started: false };
    if (e.pointerType !== 'touch') e.preventDefault();
    else d.hold = setTimeout(() => { if (d) { d.hold = null; begin(); } }, 360);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('touchmove', block, { passive: false });
  });
}
async function onBoardClick(e) {
  if (Date.now() - dragGuard < 250) return;
  if (e.target.closest('.kb-to-graph')) { toggleGraph(); return; }
  const dot = e.target.closest('.kb-bcol-dot');
  if (dot) { openColorPop(dot); return; }
  if (e.target.closest('.kb-bcol-input')) return;
  const add = e.target.closest('[data-add]');
  if (add) { toggleAddMenu(add, add.dataset.add); return; }
  const fi = e.target.closest('.kb-fi');
  const root = fi && fi.dataset.root;
  if (e.target.closest('.kf-close')) { closeFolder(root); return; }
  if (e.target.closest('.kf-up')) {
    const cur = kbGroups().find(g => g.id === openMap[root]);
    drillTo(root, (cur && cur.parentId) || root, -1);
    return;
  }
  /* название в шапке колонки — переименовать */
  const hn = e.target.closest('b.kf-hname');
  if (hn) {
    const gid = e.target.closest('.kb-fcol').dataset.into;
    const inp = document.createElement('input');
    inp.className = 'kb-bcol-input kf-hname';
    inp.dataset.gid = gid; inp.maxLength = 60; inp.value = hn.textContent;
    hn.replaceWith(inp); inp.focus(); inp.select();
    return;
  }
  const sub = e.target.closest('.kf-sub');
  if (sub) { drillTo(root, sub.dataset.sub, 1); return; }
  if (fi && !fi.classList.contains('open') && e.target.closest('.kb-fold')) { openFolder(root); return; }
  const item = e.target.closest('.kb-item');
  if (!item) return;
  const id = item.dataset.id;
  if (panel && view === 'note' && curNote === id) { closeNote(); return; }   // повторный клик — закрыть
  openNote(id);
}


/* Кнопка «+» приложения в этом режиме заводит заметку */
export function newKbNote(anchor) {
  toggleAddMenu(anchor || document.getElementById('addBtn'));
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
