import { dbAll, dbPut, dbBulk } from './db.js';
import { uid, today, addDays, mondayOf, parseISO, fmtD, esc, MONTHS_FULL, state as appState, MODES } from './store.js';

const STORE = 'notes';
const state = { notes: [] };
const listeners = [];
let currentWeekStart = mondayOf(today());
let currentDay = today();
let _panelEl = null;
let _editorEl = null;
let _saveTimer = null;
let _currentNote = null;
let _selBound = false;

const TEXT_COLORS = ['#000000', '#ffffff', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#2563eb', '#7c3aed', '#db2777'];
const HILITE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff'];

export const notesSubscribe = fn => listeners.push(fn);
let pending = false;
const notify = () => {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    listeners.forEach(fn => fn());
  }, 100);
};
const userChange = () => document.dispatchEvent(new CustomEvent('user-change'));
const modeOf = n => (n && n.mode) || 'work';
export const modeColorOf = n => `var(--mode-${modeOf(n)})`;
export const modeNameOf = n => {
  const m = MODES.find(x => x.id === modeOf(n));
  return m ? m.label : modeOf(n);
};
const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/* ── Prune: удалённые заметки старше 30 дней вычищаются ── */
const NOTE_PRUNE_MS = 30 * 24 * 60 * 60 * 1000;
async function pruneDeletedNotes() {
  const cutoff = Date.now() - NOTE_PRUNE_MS;
  const before = state.notes.length;
  state.notes = state.notes.filter(n =>
    !(n.deleted && Date.parse(n.updatedAt || n.createdAt || 0) < cutoff)
  );
  if (state.notes.length !== before) {
    try { await dbBulk(STORE, state.notes); }
    catch (e) { console.error('[notes] prune failed:', e); }
  }
}

/* ── Данные ── */
export async function init() {
  state.notes = (await dbAll(STORE)).map(m => {
    if (!m.day) m.day = m.weekStart || today();
    if (!m.weekStart) m.weekStart = mondayOf(m.day);
    if (!m.favorite) m.favorite = false;
    if (!m.html) m.html = '';
    if (!m.title) m.title = '';
    return m;
  });
  /* Миграция: старый отдельный заголовок встаёт первой строкой текста */
  for (const n of state.notes) {
    if (n.title && n.html && !n.html.replace(/<[^>]+>/g, '').trimStart().startsWith(n.title)) {
      n.html = '<div class="nn-h">' + esc(n.title) + '</div>' + n.html;
      await dbPut(STORE, n);
    }
  }
  await pruneDeletedNotes();
}

const dayForWeek = ws => {
  const idx = Math.round((parseISO(today()) - parseISO(mondayOf(today()))) / 864e5);
  return addDays(ws, idx);
};
export function setWeekStart(ws) {
  currentWeekStart = ws;
  currentDay = dayForWeek(ws);
}
export function getNote(ws, day) {
  return state.notes.find(n => !n.deleted && n.weekStart === ws && n.day === day);
}
const safeSort = arr => arr.slice().sort((a, b) => String(b.day || '').localeCompare(String(a.day || '')));
export const getAllNotes = () => safeSort(state.notes.filter(n => !n.deleted));
export const getNoteById = id => state.notes.find(n => n.id === id && !n.deleted);
/* Точечное обновление заметки снаружи (используется базой знаний) */
export async function updateNoteById(id, patch) {
  const n = state.notes.find(x => x.id === id);
  if (!n) return null;
  Object.assign(n, patch, { updatedAt: new Date().toISOString() });
  await dbPut(STORE, n);
  notify();
  userChange();
  return n;
}
export const getFavoriteNotes = () => safeSort(state.notes.filter(n => !n.deleted && n.favorite));

async function ensureNote() {
  if (_currentNote && !_currentNote.deleted) return _currentNote;
  const existing = getNote(currentWeekStart, currentDay);
  if (existing) { _currentNote = existing; return existing; }
  const now = new Date().toISOString();
  const n = {
    id: uid(), weekStart: currentWeekStart, day: currentDay,
    /* Режим, в котором заметку завели. Меняется переносом между
       группами в базе знаний; в панели показан точкой. */
    mode: appState.mode === 'all' ? 'work' : appState.mode,
    title: '', html: '', favorite: false, createdAt: now, updatedAt: now
  };
  state.notes.push(n);
  await dbPut(STORE, n);
  _currentNote = n;
  userChange();
  return n;
}
async function updateNote(id, patch) {
  const n = state.notes.find(x => x.id === id);
  if (!n) return;
  Object.assign(n, patch, { updatedAt: new Date().toISOString() });
  await dbPut(STORE, n);
  userChange();
}
export async function deleteNote(id) {
  const n = state.notes.find(x => x.id === id);
  if (!n) return;
  n.deleted = true;
  n.updatedAt = new Date().toISOString();
  await dbPut(STORE, n);
  if (_currentNote && _currentNote.id === id) _currentNote = null;
  notify();
  userChange();
}
async function toggleFavorite(id) {
  const n = state.notes.find(x => x.id === id);
  if (!n) return;
  n.favorite = !n.favorite;
  n.updatedAt = new Date().toISOString();
  await dbPut(STORE, n);
  userChange();
}

/* ── Авто-рост панели: высота = контент + 1 строка, плавно.
   min-height на время замера сбрасываем, иначе панель вырастает
   на +1 строку ПОВЕРХ минимума (минимум = высота фокус-панели). ── */
const LINE_PX = 24;

/* ── Пунктирная рамка поля ввода ──
   Без viewBox проценты в <rect> считаются от CSS-бокса самого SVG,
   поэтому штрих (stroke-dasharray) не растягивается и шаг остаётся ровным
   при любой ширине панели — в отличие от border: dashed, где длину
   штриха выбирает браузер. */
const FRAME_SVG = '<svg class="ne-frame" preserveAspectRatio="none" aria-hidden="true"><rect width="100%" height="100%" rx="12" ry="12"/></svg>';

/* Пустое поле → пунктирная разлиновка (снимается при фокусе через :focus в CSS) */
function refreshEmpty(ed) {
  if (!ed) return;
  const txt = (ed.textContent || '').replace(/[\s\u200b\u00a0]/g, '');
  ed.classList.toggle('is-empty', txt === '');
}

function autoGrow(instant) {
  const c = _panelEl;
  if (!c || !_editorEl) return;
  const prev = c.offsetHeight;
  c.style.height = 'auto';
  const minH = c.style.minHeight;
  c.style.minHeight = '0px';
  const target = c.scrollHeight + LINE_PX;
  c.style.minHeight = minH;
  c.style.height = prev + 'px';
  if (prev === target) return;
  if (instant) {
    c.style.transition = 'none';
    c.style.height = target + 'px';
    void c.offsetHeight;
    c.style.transition = '';
    return;
  }
  requestAnimationFrame(() => { c.style.height = target + 'px'; });
}

/* ── Первая строка = заголовок: держим класс nn-h на первом блоке ── */
function ensureHeadLine() {
  const ed = _editorEl;
  if (!ed) return;
  const first = ed.firstChild;
  if (!first) return;
  if (first.nodeType === 3 && first.textContent.trim() !== '') {
    const div = document.createElement('div');
    div.className = 'nn-h';
    ed.insertBefore(div, first);
    div.appendChild(first);
  } else if (first.nodeType === 1) {
    first.classList.add('nn-h');
  }
  ed.querySelectorAll('.nn-h').forEach(el => {
    if (el !== ed.firstElementChild) el.classList.remove('nn-h');
  });
  markHeadMode();
}
/* ── Точка режима после заголовка ──
   Рисуется псевдоэлементом на строке заголовка, поэтому не попадает в
   текст заметки и не мешает вводу. Появляется только когда заголовок
   действительно набран, и красится в цвет режима, в котором заметку
   завели. */
function markHeadMode() {
  const ed = _editorEl;
  if (!ed) return;
  const head = ed.firstElementChild;
  if (!head || !head.classList.contains('nn-h')) return;
  const has = head.textContent.trim() !== '';
  head.classList.toggle('has-mode', has);
  head.style.setProperty('--nc', modeColorOf(_currentNote));
  head.title = has ? 'Создано в режиме: ' + modeNameOf(_currentNote) : '';
}
const firstLineText = ed => {
  if (!ed) return '';
  const el = ed.firstElementChild;
  return (el ? el.textContent : ed.textContent.split('\n')[0] || '').trim();
};

/* ── Синхронизация ── */
export const getNotesForSync = () => state.notes;
export const getNoteTombstones = () => state.notes.filter(n => n.deleted).map(n => n.id);
export async function applyNotesMerged(notes) {
  const remote = Array.isArray(notes) ? notes : [];
  const byId = new Map();
  for (const n of state.notes) if (n && n.id) byId.set(n.id, n);
  for (const rn of remote) {
    if (!rn || !rn.id) continue;
    if (!rn.day) rn.day = rn.weekStart || today();
    if (!rn.weekStart) rn.weekStart = mondayOf(rn.day);
    if (!rn.title) rn.title = '';
    const local = byId.get(rn.id);
    if (!local) byId.set(rn.id, rn);
    else if (String(rn.updatedAt || '') >= String(local.updatedAt || '')) byId.set(rn.id, rn);
  }
  state.notes = [...byId.values()];
  try { await dbBulk(STORE, state.notes); }
  catch (err) { console.error('[notes] dbBulk failed:', err); }
  notify();
}

/* ── Сохранение: заголовок = первая строка ── */
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveNow, 500);
}
async function saveNow() {
  if (!_editorEl) return;
  const html = _editorEl.innerHTML;
  const title = firstLineText(_editorEl);
  if (!title && !_editorEl.textContent.trim()) return;
  const n = await ensureNote();
  await updateNote(n.id, { title, html });
}

/* ── Палитры цветов ── */
const closeColorPopup = container => {
  const old = container.querySelector('.nc-popup');
  if (old) old.remove();
};
function openColorPopup(container, anchor, colors, onPick) {
  closeColorPopup(container);
  const m = document.createElement('div');
  m.className = 'nc-popup';
  m.innerHTML = colors.map(c =>
    '<button type="button" class="nc-dot" data-c="' + c + '" style="background:' + c + '" title="' + c + '"></button>'
  ).join('') + '<button type="button" class="nc-clear">Сброс</button>';
  container.appendChild(m);
  const pr = container.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  const cx = ar.left - pr.left + ar.width / 2;
  m.style.left = cx + 'px';
  m.style.top = (ar.top - pr.top - 8) + 'px';
  requestAnimationFrame(() => {
    const half = m.offsetWidth / 2;
    const minX = 8 + half;
    const maxX = Math.max(minX, pr.width - 8 - half);
    m.style.left = Math.min(Math.max(cx, minX), maxX) + 'px';
  });
  m.querySelectorAll('.nc-dot').forEach(d => {
    d.onclick = () => {
      onPick(d.dataset.c);
      closeColorPopup(container);
      if (_editorEl) _editorEl.focus();
    };
  });
  m.querySelector('.nc-clear').onclick = () => {
    onPick(null);
    closeColorPopup(container);
    if (_editorEl) _editorEl.focus();
  };
  setTimeout(() => {
    const close = e => {
      if (!m.contains(e.target)) {
        closeColorPopup(container);
        document.removeEventListener('pointerdown', close);
      }
    };
    document.addEventListener('pointerdown', close);
  }, 0);
}
function applyFontSize(px) {
  document.execCommand('fontSize', false, '7');
  _editorEl.querySelectorAll('font[size="7"]').forEach(f => {
    const span = document.createElement('span');
    span.style.fontSize = px + 'px';
    span.innerHTML = f.innerHTML;
    f.replaceWith(span);
  });
}

/* ── Рендер панели ── */
export function renderNotesPanel(container) {
  if (!container) return;
  _panelEl = container;
  const key = currentWeekStart + '|' + currentDay;
  if (container.dataset.built) {
    if (container.contains(document.activeElement)) return; // не ломаем ввод
    if (container.dataset.key === key) return;
  }
  container.dataset.built = '1';
  container.dataset.key = key;
  _currentNote = getNote(currentWeekStart, currentDay) || null;
  const isToday = currentDay === today();
  const fav = !!(_currentNote && _currentNote.favorite);
  const dayNum = +currentDay.slice(8);
  const monthCap = cap(MONTHS_FULL[+currentDay.slice(5, 7) - 1]);
  container.innerHTML = `<svg class="dock-handle" data-dock="notes" viewBox="0 0 32 32" aria-hidden="true"><path d="M2 22 A20 20 0 0 1 12 4.68" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>
<div class="notes-header">
<span class="notes-day-label"><b class="nd-num">${dayNum}</b> ${monthCap}${isToday ? '<i class="nd-today">· сегодня</i>' : ''}</span>
<div class="notes-actions">
<button type="button" class="icon-btn notes-favorite${fav ? ' on' : ''}" title="В избранное">${fav ? '★' : '☆'}</button>
<button type="button" class="icon-btn notes-list" title="Все заметки">☰</button>
</div>
</div>
<div class="notes-toolbar">
<button type="button" data-cmd="bold" title="Жирный"><b>B</b></button>
<button type="button" data-cmd="italic" title="Курсив"><i>I</i></button>
<button type="button" data-cmd="underline" title="Подчёркнутый"><u>U</u></button>
<button type="button" data-cmd="strikeThrough" title="Зачёркнутый"><s>S</s></button>
<select class="nt-font" title="Шрифт">
<option value="sans-serif">Без засечек</option>
<option value="serif">С засечками</option>
<option value="monospace">Моно</option>
<option value="cursive">Рукописный</option>
</select>
<select class="nt-size" title="Размер шрифта">
<option value="12">12</option>
<option value="14">14</option>
<option value="16" selected>16</option>
<option value="20">20</option>
<option value="24">24</option>
</select>
<button type="button" class="nt-fcolor" title="Цвет текста">А</button>
<button type="button" class="nt-hcolor" title="Цвет выделения">🖍</button>
<button type="button" class="notes-delete" title="Удалить заметку">🗑</button>
</div>
<div class="notes-edit-wrap">${FRAME_SVG}<div class="notes-editor" contenteditable="true">${_currentNote ? _currentNote.html : ''}</div></div>`;
  _editorEl = container.querySelector('.notes-editor');
  ensureHeadLine();
  refreshEmpty(_editorEl);
  bindNotesEvents(container);
  autoGrow(true);
}

/* ── Тулбар НАД выделением ── */
function positionToolbar() {
  const c = _panelEl, ed = _editorEl;
  if (!c || !ed) return;
  const bar = c.querySelector('.notes-toolbar');
  if (!bar) return;
  const sel = document.getSelection();
  const inEditor = !!sel && sel.rangeCount > 0 &&
    ed.contains(sel.anchorNode) && ed.contains(sel.focusNode) && !sel.isCollapsed;
  if (!inEditor) { c.classList.remove('editing'); return; }
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (!r || (r.width === 0 && r.height === 0)) { c.classList.remove('editing'); return; }
  c.classList.add('editing');
  const pr = c.getBoundingClientRect();
  const tw = bar.offsetWidth, th = bar.offsetHeight;
  let x = r.left - pr.left + r.width / 2 - tw / 2;
  x = Math.max(6, Math.min(x, pr.width - tw - 6));
  let y = r.top - pr.top - th - 8;
  if (y < 4) y = r.bottom - pr.top + 8;
  bar.style.left = x + 'px';
  bar.style.top = y + 'px';
}
function bindNotesEvents(container) {
  container.querySelector('.notes-favorite').onclick = async () => {
    const n = await ensureNote();
    await toggleFavorite(n.id);
    const btn = container.querySelector('.notes-favorite');
    btn.classList.toggle('on', n.favorite);
    btn.textContent = n.favorite ? '★' : '☆';
  };
  container.querySelector('.notes-list').onclick = showNotesList;
  container.querySelectorAll('.notes-toolbar [data-cmd]').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.onclick = () => {
      document.execCommand(btn.dataset.cmd, false, null);
      _editorEl.focus();
    };
  });
  container.querySelector('.nt-font').onchange = e => {
    document.execCommand('fontName', false, e.target.value);
    _editorEl.focus();
  };
  container.querySelector('.nt-size').onchange = e => {
    applyFontSize(e.target.value);
    _editorEl.focus();
    autoGrow(false);
  };
  const fcBtn = container.querySelector('.nt-fcolor');
  const hcBtn = container.querySelector('.nt-hcolor');
  fcBtn.addEventListener('mousedown', e => e.preventDefault());
  hcBtn.addEventListener('mousedown', e => e.preventDefault());
  fcBtn.onclick = () => openColorPopup(container, fcBtn, TEXT_COLORS, c => {
    const def = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000000';
    document.execCommand('foreColor', false, c || def);
  });
  hcBtn.onclick = () => openColorPopup(container, hcBtn, HILITE_COLORS, c => {
    document.execCommand('hiliteColor', false, c || 'transparent');
  });
  container.querySelector('.notes-delete').onclick = async () => {
    if (_currentNote && confirm('Удалить эту заметку?')) {
      await deleteNote(_currentNote.id);
      if (_editorEl) _editorEl.innerHTML = '';
      container.classList.remove('editing');
      autoGrow(false);
    }
  };
  /* Тулбар по выделению */
  if (!_selBound) {
    _selBound = true;
    document.addEventListener('selectionchange', positionToolbar);
  }
  /* Ввод: заголовок-первая строка + автосохранение + рост */
  _editorEl.addEventListener('input', () => {
    ensureHeadLine();
    refreshEmpty(_editorEl);
    scheduleSave();
    autoGrow(false);
  });
  _editorEl.addEventListener('blur', () => refreshEmpty(_editorEl));
  _editorEl.addEventListener('keyup', positionToolbar);
  _editorEl.addEventListener('mouseup', positionToolbar);
}

/* ── Список заметок ── */
function noteListItemHTML(n) {
  const title = n.title ? esc(n.title) : 'Без названия';
  const prev = (n.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `<div class="note-list-item" data-id="${n.id}">
<div class="nli-body">
<div class="nli-title">${title}${n.favorite ? '<span class="nli-star">★</span>' : ''}</div>
<div class="nli-meta">${fmtD(n.day)}${prev ? ' · ' + esc(prev) : ''}</div>
</div>
<button type="button" class="nli-del" title="Удалить">🗑</button>
</div>`;
}
function refreshList(overlay) {
  const all = getAllNotes(), fav = getFavoriteNotes();
  overlay.querySelector('.notes-list-items[data-tab="all"]').innerHTML =
    all.length ? all.map(noteListItemHTML).join('') : '<p class="empty">Пока нет заметок</p>';
  overlay.querySelector('.notes-list-items[data-tab="fav"]').innerHTML =
    fav.length ? fav.map(noteListItemHTML).join('') : '<p class="empty">Нет избранных</p>';
  overlay.querySelector('.tab[data-tab="all"]').textContent = 'Все (' + all.length + ')';
  overlay.querySelector('.tab[data-tab="fav"]').textContent = 'Избранные (' + fav.length + ')';
  bindListItems(overlay);
}
function bindListItems(overlay) {
  overlay.querySelectorAll('.note-list-item').forEach(item => {
    const id = item.dataset.id;
    item.querySelector('.nli-del').onclick = async e => {
      e.stopPropagation();
      if (confirm('Удалить заметку?')) {
        await deleteNote(id);
        refreshList(overlay);
      }
    };
    item.onclick = e => {
      if (e.target.closest('.nli-del')) return;
      if (item.dataset.swiped === '1') { item.dataset.swiped = ''; return; }
      const n = state.notes.find(x => x.id === id);
      if (!n) return;
      openNoteEditor(n, overlay);
    };
    let sx = 0, dx = 0, dragging = false;
    item.addEventListener('pointerdown', e => {
      if (e.target.closest('.nli-del')) return;
      dragging = true; sx = e.clientX; dx = 0;
      try { item.setPointerCapture(e.pointerId); } catch (err) {}
    });
    item.addEventListener('pointermove', e => {
      if (!dragging) return;
      dx = Math.max(0, e.clientX - sx);
      item.style.transform = 'translateX(' + Math.min(dx, 140) + 'px)';
    });
    const end = async () => {
      if (!dragging) return;
      dragging = false;
      item.style.transform = '';
      if (dx > 40) {
        item.dataset.swiped = '1';
        setTimeout(() => { item.dataset.swiped = ''; }, 150);
      }
      if (dx > 90 && confirm('Удалить заметку?')) {
        await deleteNote(id);
        refreshList(overlay);
      }
      dx = 0;
    };
    item.addEventListener('pointerup', end);
    item.addEventListener('pointercancel', end);
  });
}
function showNotesList() {
  const overlay = document.createElement('div');
  overlay.className = 'notes-list-overlay';
  overlay.innerHTML = `<div class="notes-list-modal glass">
<header class="notes-list-head">
<h3>Заметки</h3>
<button type="button" class="notes-list-close">✕</button>
</header>
<div class="notes-list-tabs">
<button type="button" class="tab active" data-tab="all">Все</button>
<button type="button" class="tab" data-tab="fav">Избранные</button>
</div>
<div class="notes-list-content">
<div class="notes-list-items" data-tab="all"></div>
<div class="notes-list-items" data-tab="fav" style="display:none"></div>
</div>
</div>`;
  document.body.appendChild(overlay);
  overlay.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      overlay.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      overlay.querySelectorAll('.notes-list-items').forEach(items => {
        items.style.display = items.dataset.tab === tab.dataset.tab ? 'block' : 'none';
      });
    };
  });
  refreshList(overlay);
  overlay.querySelector('.notes-list-close').onclick = () => overlay.remove();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
}

/* ── Просмотр и редактирование заметки из списка (без отдельного заголовка) ── */
function openNoteEditor(n, listOverlay) {
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay';
  ov.innerHTML = `<div class="notes-list-modal glass note-editor-modal">
<header class="notes-list-head">
<h3>${fmtD(n.day)}</h3>
<button type="button" class="notes-list-close ne-close">✕</button>
</header>
<div class="notes-edit-wrap">${FRAME_SVG}<div class="notes-editor ne-body" contenteditable="true">${n.html || ''}</div></div>
<div class="ne-actions">
<button type="button" class="btn danger ne-del">Удалить</button>
<span class="spacer"></span>
<button type="button" class="btn primary ne-save">Сохранить</button>
</div>
</div>`;
  document.body.appendChild(ov);
  const bodyEl = ov.querySelector('.ne-body');
  refreshEmpty(bodyEl);
  bodyEl.addEventListener('input', () => refreshEmpty(bodyEl));
  bodyEl.addEventListener('blur', () => refreshEmpty(bodyEl));
  const close = () => ov.remove();
  const after = async () => {
    if (listOverlay) refreshList(listOverlay);
    if (_panelEl && (!_currentNote || _currentNote.id === n.id)) {
      delete _panelEl.dataset.key;
      renderNotesPanel(_panelEl);
    }
  };
  ov.querySelector('.ne-close').onclick = close;
  ov.onclick = e => { if (e.target === ov) close(); };
  ov.querySelector('.ne-del').onclick = async () => {
    if (!confirm('Удалить заметку?')) return;
    await deleteNote(n.id);
    close();
    await after();
  };
  ov.querySelector('.ne-save').onclick = async () => {
    await updateNote(n.id, { html: bodyEl.innerHTML, title: firstLineText(bodyEl) });
    close();
    await after();
  };
}
