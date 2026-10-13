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
import { uid, esc, today, MODES } from './store.js';
import { getAllNotes, updateNoteById, deleteNote } from './notes.js';
import { createGraph } from './kbgraph.js';

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
    for (const f of (it && it.files) || []) await dbDel(FILES, f.id).catch(() => {});
    await deleteNote(dailyRealId(id));
    notify();
    return;
  }
  const it = rawItem(id);
  if (!it) return;
  if (it.kind === 'note') for (const f of it.files || []) await dbDel(FILES, f.id).catch(() => {});
  if (it.kind === 'group') {
    for (const n of all('note')) {
      if (n.groupId === id) { n.groupId = ''; await dbPut(STORE, n); }
    }
  }
  it.deleted = true;
  await put(it);
}

/* ── Синхронизация ── */
export const getKbForSync = () => state.items.map(i =>
  i.kind === 'note' ? { ...i, files: (i.files || []).map(f => ({ id: f.id, name: f.name, size: f.size, mime: f.mime })) } : i);
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
export const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ';
async function attach(noteId, file) {
  if (file.size > MAX_FILE) throw new Error('Файл больше 8 МБ');
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const rec = { id: uid(), data };
  await dbPut(FILES, rec);
  const n = kbItem(noteId);
  if (!n) return;
  const files = [...(n.files || []), { id: rec.id, name: file.name, size: file.size, mime: file.type }];
  await kbSave('note', { files }, noteId);
}
async function openAttachment(fid, name) {
  const rec = await dbGet(FILES, fid).catch(() => null);
  if (!rec || !rec.data) { alert('Файл доступен только на устройстве, где его добавили.'); return; }
  const a = document.createElement('a');
  a.href = rec.data;
  a.download = name || 'file';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

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
const openGroups = new Set();
let curNote = null;
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
export const refreshKbView = () => { if (_host && !_host.hidden) renderKbView(_host); };

function buildShell(el) {
  el.innerHTML = `
    <aside class="kb-side">
      <div class="kb-search"><input class="kb-q" type="search" placeholder="Поиск по базе" value="${esc(query)}"></div>
      <div class="kb-tools">
        <button type="button" class="kb-tool kb-to-graph" title="Граф связей между заметками">◉ Граф</button>
        <button type="button" class="kb-tool kb-to-new" title="Новая заметка">＋ Заметка</button>
      </div>
      <div class="kb-groups"></div>
      <div class="kb-list"></div>
    </aside>
    <main class="kb-main"></main>`;
  const side = el.querySelector('.kb-side');
  const qi = side.querySelector('.kb-q');
  qi.oninput = () => { query = qi.value; renderSide(); };
  qi.onkeydown = e => {
    if (e.key !== 'Enter') return;
    const first = side.querySelector('.kb-list .kb-item');
    if (first) openNote(first.dataset.id);
  };
  side.addEventListener('click', onSideClick);
  bindNoteDrag(el, side);
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
    view = view === 'graph' ? 'note' : 'graph';
    renderKbView(_host);
    if (view === 'graph') revealMain();
    return;
  }
  if (t.closest('.kb-to-new')) { newKbNote(); return; }
  if (t.closest('.kb-g-new')) { openGroupSheet(null, _host); return; }
  const item = t.closest('.kb-item, .kb-subitem');
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
    if (gid) openGroupSheet(gid, _host);
    return;
  }
  curGroup = gid;
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

function renderSide() {
  if (!_host) return;
  const side = _host.querySelector('.kb-side');
  const groups = kbGroups();
  const allNotes = kbNotes().sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  const q = query.trim().toLowerCase();
  let notes = allNotes;
  if (curGroup) notes = notes.filter(n => n.groupId === curGroup);
  if (q) notes = notes.filter(n => (titleOf(n) + ' ' + plain(n.html)).toLowerCase().includes(q));
  const countIn = gid => allNotes.filter(n => n.groupId === gid).length;

  side.querySelector('.kb-to-graph').classList.toggle('on', view === 'graph');
  setHTML(side.querySelector('.kb-groups'), `
    <button type="button" class="kb-g${curGroup === '' ? ' on' : ''}" data-g="" style="--gc:var(--dim)">
      <span class="kb-g-dot"></span><span class="kb-g-name">Все заметки</span><span class="kb-g-n">${allNotes.length}</span></button>
    ${groups.map(g => {
      const inside = allNotes.filter(n => n.groupId === g.id);
      const open = openGroups.has(g.id);
      return `<div class="kb-gwrap${open ? ' open' : ''}" data-drop="${g.id}">
        <button type="button" class="kb-g${curGroup === g.id ? ' on' : ''}" data-g="${g.id}" style="--gc:${g.color || '#94a3b8'}">
          <span class="kb-g-caret">${open ? '▾' : '▸'}</span>
          <span class="kb-g-dot"></span><span class="kb-g-name">${esc(g.name)}</span>
          <span class="kb-g-n">${countIn(g.id)}</span>
          <span class="kb-g-edit" title="Переименовать">✎</span></button>
        ${open ? `<div class="kb-sub">${inside.length
          ? inside.map(n => `<button type="button" class="kb-subitem${curNote === n.id ? ' on' : ''}" data-id="${n.id}" data-drag="1">${esc(titleOf(n))}</button>`).join('')
          : '<span class="kb-sub-empty">Пусто</span>'}</div>` : ''}
      </div>`;
    }).join('')}
    <button type="button" class="kb-g-new">＋ Группа</button>`);
  setHTML(side.querySelector('.kb-list'),
    notes.length ? notes.map(itemHTML).join('') : '<p class="empty">Ничего не найдено</p>');
}

/* Миниатюра открытой заметки — прямо при наборе, без перерисовки */
function updateThumb() {
  if (!editing || !_host) return;
  const title = editing.title.value.trim();
  const text = plain(editing.ed.innerHTML);
  const label = title || text.slice(0, 40) || 'Без названия';
  _host.querySelectorAll(`.kb-side [data-id="${CSS.escape(editing.id)}"]`).forEach(node => {
    if (node.classList.contains('kb-subitem')) { node.textContent = label; return; }
    const b = node.querySelector('b'), i = node.querySelector('i');
    if (b) b.textContent = label;
    if (i) i.textContent = text.slice(0, 70) || 'Пусто';
  });
}

/* ── Основная область ── */
function renderMain() {
  if (!_host) return;
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
      <label class="kb-attach">📎 Файл<input type="file" class="kb-file" hidden multiple></label>
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
        dbDel(FILES, row.dataset.fid).catch(() => {});
        kbSave('note', { files: (note.files || []).filter(x => x.id !== row.dataset.fid) }, n.id);
        return;
      }
      openAttachment(row.dataset.fid, f ? f.name : '');
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
    ids = new Set(all.filter(n => !curGroup || n.groupId === curGroup).map(n => n.id));
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
function openGroupSheet(id, host) {
  const g = id ? kbItem(id) : null;
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
    </div>
    <div class="ne-actions">
      ${g && !['kb-work', 'kb-home', 'kb-study'].includes(g.id)
        ? '<button type="button" class="btn danger kg-del">Удалить</button>' : ''}
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
    const patch = { name: name.slice(0, 40), color: picked, order: g ? g.order : kbGroups().length };
    if (id && MODE_OF_GROUP[id]) {
      const mode = MODES.find(x => x.id === MODE_OF_GROUP[id]) || {};
      patch.customName = name !== mode.label;
      patch.customColor = !String(picked).startsWith('var(');
    }
    const saved = await kbSave('group', patch, id);
    if (!id) { curGroup = saved.id; openGroups.add(saved.id); }
    close();
    renderKbView(host);
  };
  const del = ov.querySelector('.kg-del');
  if (del) del.onclick = async () => {
    if (!confirm('Удалить группу? Заметки останутся, но без группы.')) return;
    await kbRemove(id);
    if (curGroup === id) curGroup = '';
    close();
    renderKbView(host);
  };
  setTimeout(() => nameEl.focus(), 60);
}

/* ── Перенос заметки в группу ──
   Pointer-события, а не нативный drag-and-drop: на iOS он в вебе не
   работает. Тянем карточку из списка, группа под курсором
   подсвечивается, отпустили — заметка сменила группу. Слушатель
   один, делегированием на панели: список перерисовывается, а
   привязка остаётся. */
function bindNoteDrag(el, side) {
  let src = null, ghost = null, over = null, started = false, sx = 0, sy = 0, gx = 0, gy = 0;
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
      ghost = document.createElement('div');
      ghost.className = 'kb-note-ghost';
      ghost.textContent = (src.querySelector('b') || src).textContent;
      ghost.style.width = r.width + 'px';
      document.body.appendChild(ghost);
      src.classList.add('dragging');
      document.body.classList.add('kb-dragging');
      try { navigator.vibrate(8); } catch {}
    }
    ghost.style.transform = `translate(${e.clientX - gx}px, ${e.clientY - gy}px)`;
    const d = dropAt(e.clientX, e.clientY);
    if (d !== over) { clearOver(); if (d) { over = d; d.classList.add('kb-drop-over'); } }
  };
  const up = async e => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    document.removeEventListener('touchmove', block);
    document.body.classList.remove('kb-dragging');
    if (ghost) { ghost.remove(); ghost = null; }
    if (src) src.classList.remove('dragging');
    const target = started ? dropAt(e.clientX, e.clientY) : null;
    const gid = target ? target.dataset.drop : null;
    const node = src;
    if (started) dragGuard = Date.now();
    clearOver();
    src = null;
    started = false;
    if (node && gid) {
      const n = kbItem(node.dataset.id);
      if (n && n.groupId !== gid) {
        if (editing && editing.id === node.dataset.id) flushEditor();
        await kbSave('note', { groupId: gid }, node.dataset.id);
      }
    }
  };
  const block = e => { if (started && e.cancelable) e.preventDefault(); };
  side.addEventListener('pointerdown', e => {
    const node = e.target.closest('[data-drag], .kb-item');
    if (!node || e.button > 0) return;
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

/* Кнопка «+» приложения в этом режиме заводит заметку */
export async function newKbNote() {
  flushEditor();
  const n = await kbSave('note', {
    title: '', html: '', groupId: curGroup || (kbGroups()[0] || {}).id || '',
    files: [], links: [], tags: [],
  });
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
