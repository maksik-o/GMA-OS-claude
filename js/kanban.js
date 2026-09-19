/* ============================================================
   GMA OS — Канбан: вид-доска для задач.
   Доски: Приоритет / Теги / Тип / Статус — выбираются кликом по
   ВЕРТИКАЛЬНОМУ ТРОЕТОЧИЮ в шапке канбана.
   Клик по ЗАГОЛОВКУ шапки (Running-list / Kanban-доска) открывает
   селектор вида. В неделе троеточие открывает меню скрытия.
   На доски попадают ВСЕ задачи диапазона, кроме тех, у которых в
   диапазоне только «Перенесено». Доска «Статус»: Запланировано /
   Начато / Выполнено / Пропущено.
   Диапазон: Сегодня / 3 дня / Неделя / Всё — рейндж-навигация в шапке
   (стрелки + текст-селектор); надпись недели сокращается по тем же
   правилам, что и в Running-list.
   Настройки вида храним локально (localStorage).
============================================================ */
import {
  state, visibleTasks, isDone, getTask, getTagsDict, getTagColor, addTagsToDict,
  updateTask, setEntry, subscribe, MODES, setHideDone,
  TYPE_LABEL, PRIORITY_LABEL, today, addDays, mondayOf, parseISO,
  isoWeek, MONTHS, MONTHS_FULL, esc, fmtD, hapticLight,
} from './store.js';
import { openSheet } from './sheet.js';
import { squaresMode, setSquaresMode, blockSwap, renderAll } from './week.js';
import { renderTimeline, refreshTimeline, setTimelineRange, timelineRange, shiftTimeline, toggleExpanded, timelineExpanded, TL_RANGES } from './timeline.js';
import { contentFade } from './anim.js';


const $ = id => document.getElementById(id);
const LS_KEY = 'rl_kanban_v1';

/* ── Локальные настройки ── */
let kb = { view: 'prio', rangeMode: 'week', anchor: today(), hiddenTags: [], showHidden: false, colOrder: {} };
try {
  const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
  if (s && typeof s === 'object') {
    kb = Object.assign(kb, s);
    if (!kb.rangeMode && s.period) kb.rangeMode = s.period;
    if (!['today', '3d', 'week', 'all'].includes(kb.rangeMode)) kb.rangeMode = 'week';
    if (!kb.anchor) kb.anchor = today();
    if (!kb.colOrder || typeof kb.colOrder !== 'object') kb.colOrder = {};
  }
} catch (e) { /* игнор */ }
const saveKb = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(kb)); } catch (e) {} };

let isOpen = false;
let blockKind = 'week';   // week | kanban | day — какой блок стоит на месте сетки
export const currentBlock = () => blockKind;
let animBusy = false;
let boardBusy = false;
let modeAnimBusy = false;
let exitAnims = [];

export const kanbanOpen = () => isOpen;

/* ── Диапазон ── */
const EPOCH = '2000-01-01';
function page3Start(d) {
  const diff = Math.round((parseISO(d) - parseISO(EPOCH)) / 864e5);
  return addDays(EPOCH, 3 * Math.floor(diff / 3));
}
function rangeBounds() {
  if (kb.rangeMode === 'today') return [kb.anchor, kb.anchor];
  if (kb.rangeMode === '3d') { const s = page3Start(kb.anchor); return [s, addDays(s, 2)]; }
  if (kb.rangeMode === 'week') { const s = mondayOf(kb.anchor); return [s, addDays(s, 6)]; }
  return null;
}
function repStatus(t, r) {
  const days = t.days || {};
  const keys = Object.keys(days);
  const use = r ? keys.filter(k => k >= r[0] && k <= r[1]) : keys;
  for (const st of ['started', 'todo', 'done', 'skipped']) {
    const day = use.filter(k => days[k] === st).sort()[0];
    if (day) return { st, day };
  }
  return null;
}
function shiftRange(dir) {
  if (kb.rangeMode === 'today') kb.anchor = addDays(kb.anchor, dir);
  else if (kb.rangeMode === '3d') kb.anchor = addDays(page3Start(kb.anchor), dir * 3);
  else if (kb.rangeMode === 'week') kb.anchor = addDays(mondayOf(kb.anchor), dir * 7);
  else return;
  /* Стрелки диапазона: доска остаётся на месте, меняются карточки */
  contentFade(() => { saveKb(); renderKanban(); }, { dir });
}

/* ── Надпись диапазона ── */
const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const fullD = d => cap(+d.slice(8) + ' ' + MONTHS_FULL[+d.slice(5, 7) - 1]);
function rangeSpanLabel(s, e) {
  const da = +s.slice(8), db = +e.slice(8);
  const ma = +s.slice(5, 7), mb = +e.slice(5, 7);
  return ma === mb
    ? da + '–' + db + ' ' + MONTHS_FULL[ma - 1]
    : da + ' ' + MONTHS_FULL[ma - 1] + ' – ' + db + ' ' + MONTHS_FULL[mb - 1];
}
function rangeLabel() {
  if (kb.rangeMode === 'all') return 'Все задачи в текущем режиме';
  if (kb.rangeMode === 'today') return kb.anchor === today() ? 'Сегодня' : fullD(kb.anchor);
  if (kb.rangeMode === '3d') { const s = page3Start(kb.anchor); return rangeSpanLabel(s, addDays(s, 2)); }
  const s = mondayOf(kb.anchor);
  return 'Неделя ' + isoWeek(s) + ' · ' + rangeSpanLabel(s, addDays(s, 6));
}
/* ── Надпись недели: те же стадии сокращения, что в Running-list ── */
function weekChipHTML() {
  const s = mondayOf(kb.anchor);
  const e = addDays(s, 6);
  const da = +s.slice(8), db = +e.slice(8);
  const ma = +s.slice(5, 7), mb = +e.slice(5, 7);
  const short = ma === mb ? `${da}–${db} ${MONTHS[ma - 1]}` : `${da} ${MONTHS[ma - 1]} – ${db} ${MONTHS[mb - 1]}`;
  const full = ma === mb ? `${da} – ${db} ${MONTHS_FULL[ma - 1]}` : `${da} ${MONTHS_FULL[ma - 1]} – ${db} ${MONTHS_FULL[mb - 1]}`;
  return '<span class="wl-num">Неделя ' + isoWeek(s) + ' · </span>' +
    '<span class="wl-full">' + full + '</span>' +
    '<span class="wl-short">' + short + '</span>';
}
function rangeChipHTML() {
  if (kb.rangeMode === 'week') return weekChipHTML();
  return esc(rangeLabel());
}

/* ── Сортировка карточек ── */
const firstDay = t => { const k = Object.keys(t.days || {}).sort(); return k[0] || '9999-99-99'; };
const colSort = (a, b) => {
  const da = isDone(a), db = isDone(b);
  if (da !== db) return da ? 1 : -1;
  const fa = firstDay(a), fb = firstDay(b);
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
};

/* ── Колонки текущей доски ── */
function applyOrder(cols) {
  const order = (kb.colOrder || {})[kb.view] || [];
  if (!order.length) return cols;
  return cols.slice().sort((a, b) => {
    const ia = order.indexOf(a.value), ib = order.indexOf(b.value);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
}
function buildColumns() {
  const r = rangeBounds();
  const withRep = visibleTasks()
    .map(t => ({ t, rep: repStatus(t, r) }))
    .filter(x => x.rep);
  const tasks = withRep.map(x => x.t);
  if (kb.view === 'prio') {
    return applyOrder([1, 2, 3].map(p => ({
      kind: 'prio', value: String(p), title: PRIORITY_LABEL[p], prio: p,
      tasks: tasks.filter(t => (t.priority || 2) === p).sort(colSort),
    })));
  }
  if (kb.view === 'type') {
    return applyOrder(Object.keys(TYPE_LABEL).map(tp => ({
      kind: 'type', value: tp, title: TYPE_LABEL[tp],
      tasks: tasks.filter(t => (t.type || 'task') === tp).sort(colSort),
    })));
  }
  if (kb.view === 'status') {
    const defs = [
      ['todo', 'Запланировано', '#ffffff', 'kb-dot-w'],
      ['started', 'Начато', 'var(--c-started)', ''],
      ['done', 'Выполнено', 'var(--c-done)', ''],
      ['skipped', 'Пропущено', 'var(--c-skipped)', ''],
    ];
    return applyOrder(defs.map(([v, l, c, dc]) => ({
      kind: 'status', value: v, title: l, color: c, dotClass: dc,
      tasks: withRep.filter(x => x.rep.st === v).map(x => x.t).sort(colSort),
    })));
  }
  const cols = [];
  for (const tg of getTagsDict()) {
    if (kb.hiddenTags.includes(tg.name)) continue;
    cols.push({
      kind: 'tag', value: tg.name, title: tg.name, color: tg.color, hideable: true,
      tasks: tasks.filter(t => (t.tags || []).includes(tg.name)).sort(colSort),
    });
  }
  if (!kb.hiddenTags.includes('__none')) {
    cols.push({
      kind: 'tag', value: '__none', title: 'Без тега', hideable: true,
      tasks: tasks.filter(t => !(t.tags || []).length).sort(colSort),
    });
  }
  return applyOrder(cols);
}

/* ── HTML карточки и колонки ── */
function metaBits(t) {
  const bits = [];
  if (kb.view !== 'type') bits.push('<span class="kb-type">' + (TYPE_LABEL[t.type || 'task'] || 'Задача') + '</span>');
  if (kb.view !== 'tags') {
    bits.push((t.tags || []).slice(0, 3).map(tg => {
      const c = getTagColor(tg);
      return '<span class="tag-pill"' + (c ? ' style="--tc:' + c + '"' : '') + '>' + esc(tg) + '</span>';
    }).join(''));
  }
  const k = Object.keys(t.days || {}).sort();
  if (k[0]) bits.push('<span class="m-time">📅 ' + fmtD(k[0]) + '</span>');
  return bits.join(' ');
}
function cardHTML(t) {
  return '<div class="kb-card m-' + t.mode + (isDone(t) ? ' done' : '') + '" data-id="' + esc(t.id) + '">' +
    '<i class="prio p' + (t.priority || 2) + '"></i>' +
    '<div class="kb-cbody"><div class="kb-ctitle">' + esc(t.title) + '</div>' +
    '<div class="g-meta">' + metaBits(t) + '</div></div></div>';
}
const COL_HANDLE = '<svg class="dock-handle kb-col-handle" viewBox="0 0 32 32" aria-hidden="true"><path d="M2 22 A20 20 0 0 1 12 4.68" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
function colHTML(c) {
  const head =
    (c.color ? '<i class="kb-dot' + (c.dotClass ? ' ' + c.dotClass : '') + '" style="background:' + c.color + '"></i>' : '') +
    (c.kind === 'prio' ? '<i class="prio p' + c.prio + '"></i>' : '') +
    '<span class="kb-col-title">' + esc(c.title) + '</span>' +
    '<span class="kb-count">' + c.tasks.length + '</span>' +
    (c.hideable ? '<button type="button" class="kb-eye" data-hide="' + esc(c.value) + '" title="Скрыть столбик">👁</button>' : '');
  return '<div class="kb-col" data-kind="' + c.kind + '" data-value="' + esc(c.value) + '">' +
    COL_HANDLE +
    '<div class="kb-col-head">' + head + '</div>' +
    '<div class="kb-col-body">' + c.tasks.map(cardHTML).join('') +
    (c.tasks.length ? '' : '<p class="empty kb-empty">Пусто</p>') + '</div></div>';
}

/* ── Анимация смены ДОСКИ ── */
function animateBoardFlip(prevRects, panel) {
  const cols = [...panel.querySelectorAll('.kb-col')];
  cols.forEach((c, i) => {
    const prev = prevRects.get(c.dataset.value);
    if (prev) {
      const now = c.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        c.animate([
          { transform: 'translate(' + dx + 'px, ' + dy + 'px)' },
          { transform: 'translate(0, 0)' }
        ], { duration: 320, easing: 'cubic-bezier(.32,.72,.28,1)' });
      }
    } else {
      c.animate([
        { transform: 'translateY(34px)', opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 }
      ], { duration: 340, delay: i * 50, easing: 'cubic-bezier(.32,.72,.28,1)', fill: 'backwards' });
    }
  });
}
async function switchBoard(v) {
  if (boardBusy || v === kb.view) return;
  const panel = $('kanbanPanel');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!panel || reduce) { kb.view = v; saveKb(); renderKanban(); return; }
  boardBusy = true;
  hapticLight();
  const prevRects = new Map([...panel.querySelectorAll('.kb-col')].map(c => [c.dataset.value, c.getBoundingClientRect()]));
  kb.view = v;
  saveKb();
  renderKanban();
  animateBoardFlip(prevRects, panel);
  boardBusy = false;
}

/* ── Смена РЕЖИМА работы в канбане ── */
async function animateKanbanModeSwitch(fromMode, toMode) {
  const panel = $('kanbanPanel');
  if (!panel || modeAnimBusy) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { renderKanban(); return; }
  const order = MODES.map(m => m.id);
  const back = order.indexOf(toMode) < order.indexOf(fromMode);
  const exitSign = back ? -1 : 1;
  const enterSign = -exitSign;
  const off = panel.offsetWidth + 60;
  modeAnimBusy = true;
  const exit = panel.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(' + exitSign * off + 'px)' }],
    { duration: 240, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }
  );
  await exit.finished.catch(() => {});
  if (!isOpen) { exit.cancel(); modeAnimBusy = false; return; }
  renderKanban();
  exit.cancel();
  const enter = panel.animate(
    [{ transform: 'translateX(' + enterSign * off + 'px)' }, { transform: 'translateX(0)' }],
    { duration: 320, easing: 'cubic-bezier(.32,.72,.28,1)', fill: 'backwards' }
  );
  await enter.finished.catch(() => {});
  modeAnimBusy = false;
}

/* ── Плавная высота панели ── */
function animatePanelHeight(panel) {
  if (panel.hidden || !panel.offsetHeight) return;
  const h0 = panel.offsetHeight;
  panel.style.height = 'auto';
  const h1 = panel.offsetHeight;
  panel.style.height = h0 + 'px';
  if (h1 === h0) { panel.style.height = ''; return; }
  panel.style.overflow = 'hidden';
  const a = panel.animate(
    [{ height: h0 + 'px' }, { height: h1 + 'px' }],
    { duration: 320, easing: 'cubic-bezier(.4,0,.2,1)' }
  );
  a.onfinish = a.oncancel = () => { panel.style.height = ''; panel.style.overflow = ''; };
}

/* ── Рендер панели ── */
export function renderKanban() {
  const panel = $('kanbanPanel');
  if (!panel || !isOpen) return;
  const names = getTagsDict().map(t => t.name).concat('__none');
  const hb = kb.hiddenTags.filter(n => names.includes(n));
  if (hb.length !== kb.hiddenTags.length) { kb.hiddenTags = hb; saveKb(); }
  const colsElPrev = panel.querySelector('.kb-cols');
  const scroll = colsElPrev ? colsElPrev.scrollLeft : 0;
  const oldRight = panel.querySelector('.kb-right');
  const kept = oldRight ? [...oldRight.children] : [];
  const vbKeep = viewBtnEl && panel.contains(viewBtnEl) ? viewBtnEl : null;
  if (vbKeep) vbKeep.remove();
  let tagActions = '';
  if (kb.view === 'tags') {
    tagActions += '<button type="button" class="kb-addcol" id="kbAddCol">＋ столбик</button>';
    if (kb.hiddenTags.length) {
      tagActions += '<button type="button" class="kb-addcol' + (kb.showHidden ? ' on' : '') + '" id="kbHiddenBtn">Скрытые (' + kb.hiddenTags.length + ')</button>';
    }
  }
  let tray = '';
  if (kb.view === 'tags' && kb.showHidden && kb.hiddenTags.length) {
    tray = '<div class="kb-hidden-tray">' + kb.hiddenTags.map(n =>
      '<button type="button" class="chip" data-restore="' + esc(n) + '" title="Вернуть столбик">⟲ ' +
      (n === '__none' ? 'Без тега' : esc(n)) + '</button>').join('') + '</div>';
  }
  const noArrows = kb.rangeMode === 'all';
  panel.innerHTML =
    '<div class="kb-head kb-head-hold">' +
    '<div class="kb-row">' +
    '<button type="button" class="kb-board-title" id="kbBoardTitle" title="Выбор вида: Running-list / kanban-доска">Kanban-доска</button>' +
    tagActions +
    '<div class="kb-rangenav">' +
    '<button type="button" class="kb-arrow" id="kbPrev"' + (noArrows ? ' hidden' : '') + ' title="Назад">‹</button>' +
    '<button type="button" class="kb-rangelabel" id="kbRangeChip" title="Выбор диапазона">' + rangeChipHTML() + '</button>' +
    '<button type="button" class="kb-arrow" id="kbNext"' + (noArrows ? ' hidden' : '') + ' title="Вперёд">›</button>' +
    '</div>' +
    '<div class="kb-right"></div>' +
    '</div>' + tray +
    '</div>' +
    '<div class="kb-cols">' + buildColumns().map(colHTML).join('') + '</div>';
  const newRight = panel.querySelector('.kb-right');
  kept.forEach(el => newRight.appendChild(el));
  if (vbKeep) {
    const bt0 = panel.querySelector('#kbBoardTitle');
    if (bt0) bt0.insertAdjacentElement('beforebegin', vbKeep);
  }
  /* привязки шапки */
  const bt = panel.querySelector('#kbBoardTitle');
  if (bt) bt.onclick = e => { e.stopPropagation(); closeAllMenus(); openViewMenu(bt); };
  const pv = panel.querySelector('#kbPrev'), nx = panel.querySelector('#kbNext');
  if (pv) pv.onclick = () => shiftRange(-1);
  if (nx) nx.onclick = () => shiftRange(1);
  const chip = panel.querySelector('#kbRangeChip');
  if (chip) chip.onclick = e => { e.stopPropagation(); closeAllMenus(); openRangeMenu(chip); };
  const ac = panel.querySelector('#kbAddCol');
  if (ac) ac.onclick = async () => {
    const v = prompt('Название нового тега-столбика:');
    const name = (v || '').trim();
    if (!name) return;
    await addTagsToDict([name]);
    renderKanban();
  };
  const hbBtn = panel.querySelector('#kbHiddenBtn');
  if (hbBtn) hbBtn.onclick = () => { kb.showHidden = !kb.showHidden; saveKb(); renderKanban(); };
  panel.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => {
    kb.hiddenTags = kb.hiddenTags.filter(n => n !== b.dataset.restore);
    saveKb(); renderKanban();
  });
  panel.querySelectorAll('[data-hide]').forEach(b => b.onclick = () => {
    const v = b.dataset.hide;
    if (!kb.hiddenTags.includes(v)) kb.hiddenTags.push(v);
    saveKb(); renderKanban();
  });
  const colsEl = panel.querySelector('.kb-cols');
  if (colsEl) colsEl.scrollLeft = scroll;
  animatePanelHeight(panel);
}

/* ── Меню: единое управление видимостью ── */
function closeAllMenus() {
  ['viewMenu', 'boardMenu', 'rangeMenu', 'hideMenu', 'tlMenu', 'tlRangeMenu'].forEach(id => {
    const m = document.getElementById(id);
    if (m) { m.classList.remove('open'); m.style.display = ''; }
  });
}
function ensureMenu(id) {
  let m = document.getElementById(id);
  if (!m) {
    m = document.createElement('div');
    m.id = id;
    m.className = 'cmenu';
    document.body.appendChild(m);
  }
  return m;
}
function placeMenu(m, anchor) {
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth || 200; // реальная ширина: широкое меню не уезжает за экран
  const mh = m.offsetHeight || 120;
  const x = Math.min(Math.max(8, r.left - 4), innerWidth - mw - 8);
  let y = r.bottom + 8;
  if (y + mh > innerHeight - 8) y = r.top - mh - 8;
  m.style.left = x + 'px';
  m.style.top = Math.max(8, y) + 'px';
}
function showMenu(m) {
  closeAllMenus();
  m.classList.add('open');
  m.style.display = 'flex';
}

/* ── Пункты меню троеточия недели: скрытие выполненных + квадраты недели ── */
const ICON_EYE = '<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><line x1="5" y1="19" x2="20" y2="5"/></svg>';
const ICON_GRID = '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="4" height="14" rx="1.5"/><rect x="10" y="5" width="4" height="14" rx="1.5"/><rect x="16" y="5" width="4" height="14" rx="1.5"/></svg>';
const ICON_GRID_OFF = '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="4" height="14" rx="1.5"/><rect x="10" y="5" width="4" height="14" rx="1.5"/><rect x="16" y="5" width="4" height="14" rx="1.5"/><line x1="4" y1="20" x2="20" y2="4"/></svg>';
function hideItemHTML() {
  return state.hideDone
    ? '<button type="button" data-hide-done="0">' + ICON_EYE + '<span>Показать скрытые задачи</span></button>'
    : '<button type="button" data-hide-done="1">' + ICON_EYE_OFF + '<span>Скрыть выполненные задачи</span></button>';
}
/* Цикл: развёрнуто → полоски → убрано → развёрнуто */
const SQ_NEXT = { full: 'bars', bars: 'hidden', hidden: 'full' };
const SQ_ITEM = {
  full:   ['Свернуть квадраты недели', () => ICON_BARS],
  bars:   ['Убрать квадраты недели', () => ICON_GRID_OFF2],
  hidden: ['Развернуть квадраты недели', () => ICON_EXPAND],
};
function squaresItemHTML() {
  const cur = squaresMode();
  const [label, ico] = SQ_ITEM[cur] || SQ_ITEM.full;
  return '<button type="button" data-sq-next="' + SQ_NEXT[cur] + '"><span class="cm-ico">' + ico() + '</span><span>' + label + '</span></button>';
}
function bindHideItem(m) {
  const b = m.querySelector('[data-hide-done]');
  if (!b) return;
  b.onclick = e => {
    e.stopPropagation();
    closeAllMenus();
    setHideDone(b.dataset.hideDone === '1');
  };
}
function bindSquaresItem(m) {
  const b = m.querySelector('[data-sq-next]');
  if (!b) return;
  b.onclick = e => {
    e.stopPropagation();
    closeAllMenus();
    setSquaresMode(b.dataset.sqNext);
  };
}
/* ── Меню троеточия в неделе ── */
function openHideMenu(anchor) {
  const m = ensureMenu('hideMenu');
  /* На ПК квадраты всегда развёрнуты — управлять нечем, остаётся
     только показ выполненных. */
  const mobile = matchMedia('(max-width: 720px)').matches;
  m.innerHTML = hideItemHTML() + (mobile ? '<div class="cm-sep"></div>' + squaresItemHTML() : '');
  showMenu(m);
  placeMenu(m, anchor);
  bindHideItem(m);
  bindSquaresItem(m);
}

/* ── Селектор доски (троеточие в канбане) ── */
const BOARD_MENU = [
  ['prio', '🚩', 'Приоритет'],
  ['status', '✅', 'Статус'],
  ['tags', '🏷️', 'Теги'],
  ['type', '📂', 'Тип'],
];
function openBoardMenu(anchorEl) {
  const m = ensureMenu('boardMenu');
  m.innerHTML = BOARD_MENU.map(([v, ico, l]) =>
    '<button type="button" data-v="' + v + '" class="' + (kb.view === v ? 'on' : '') + '">' +
    '<span class="cm-ico">' + ico + '</span><span>' + l + '</span></button>').join('');
  showMenu(m);
  placeMenu(m, anchorEl);
  m.querySelectorAll('button').forEach(b => b.onclick = e => {
    e.stopPropagation();
    closeAllMenus();
    switchBoard(b.dataset.v);
  });
}

/* ── Селектор диапазона ── */
function openRangeMenu(anchorEl) {
  const m = ensureMenu('rangeMenu');
  const opts = [['today', 'Сегодня'], ['3d', '3 дня'], ['week', 'Неделя'], ['all', 'Всё']];
  m.innerHTML = opts.map(([v, l]) =>
    '<button type="button" data-v="' + v + '" class="' + (kb.rangeMode === v ? 'on' : '') + '"><span>' + l + '</span></button>').join('');
  showMenu(m);
  placeMenu(m, anchorEl);
  m.querySelectorAll('button').forEach(b => b.onclick = e => {
    e.stopPropagation();
    closeAllMenus();
    kb.rangeMode = b.dataset.v;
    kb.anchor = today();
    saveKb();
    renderKanban();
  });
}

/* ── Селектор вида: Running-list / kanban-доска ── */
const VIEW_ICON_WEEK = '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="3.6" height="3.6" rx="1.1"/><line x1="10.5" y1="6.8" x2="20" y2="6.8"/><rect x="4" y="15.4" width="3.6" height="3.6" rx="1.1"/><line x1="10.5" y1="17.2" x2="20" y2="17.2"/></svg>';
const ICON_BARS = '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="2.6" rx="1.3"/><rect x="3" y="13" width="18" height="2.6" rx="1.3"/></svg>';
const ICON_GRID_OFF2 = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="3"/><line x1="5" y1="19" x2="19" y2="5"/></svg>';
const ICON_EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V5a1 1 0 0 1 1-1h4"/><path d="M20 9V5a1 1 0 0 0-1-1h-4"/><path d="M4 15v4a1 1 0 0 0 1 1h4"/><path d="M20 15v4a1 1 0 0 1-1 1h-4"/></svg>';
const ICON_SQUARES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/></svg>';
const VIEW_ICON_DAY = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.4" fill="none" stroke="currentColor" stroke-width="2"/><rect x="6" y="7.5" width="9" height="3" rx="1.2"/><rect x="6" y="13" width="12" height="3" rx="1.2"/></svg>';
const VIEW_ICON_KANBAN = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="4.6" height="16" rx="1.6"/><rect x="9.7" y="4" width="4.6" height="10.5" rx="1.6"/><rect x="15.4" y="4" width="4.6" height="13.5" rx="1.6"/></svg>';
function openViewMenu(anchor) {
  const m = ensureMenu('viewMenu');
  m.innerHTML =
    '<button type="button" data-v="week" class="' + (blockKind === 'week' ? 'on' : '') + '"><span class="cm-ico">' + VIEW_ICON_WEEK + '</span><span>Running-list</span></button>' +
    '<button type="button" data-v="kanban" class="' + (blockKind === 'kanban' ? 'on' : '') + '"><span class="cm-ico">' + VIEW_ICON_KANBAN + '</span><span>kanban-доска</span></button>' +
    '<button type="button" data-v="day" class="' + (blockKind === 'day' ? 'on' : '') + '"><span class="cm-ico">' + VIEW_ICON_DAY + '</span><span>Timeline</span></button>';
  showMenu(m);
  placeMenu(m, anchor);
  m.querySelectorAll('button[data-v]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    closeAllMenus();
    setBlock(b.dataset.v);
  });
}

/* ── Вертикальное троеточие перед заголовком панели. ── */
const VIEW_ICON = '<svg viewBox="9.8 0 4.4 24"><circle cx="12" cy="5" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="12" cy="19" r="2.2"/></svg>';
let viewBtnEl = null;
function ensureViewBtn() {
  if (viewBtnEl && viewBtnEl.isConnected) return viewBtnEl;
  let b = $('viewBtn');
  if (b) { viewBtnEl = b; }
  else {
    b = document.createElement('button');
    b.type = 'button';
    b.id = 'viewBtn';
    b.className = 'view-toggle';
    b.innerHTML = VIEW_ICON;
    b.title = 'Меню панели';
    document.body.appendChild(b);
    viewBtnEl = b;
  }
  b.onclick = e => {
    e.stopPropagation();
    closeAllMenus();
    if (blockKind === 'day') openTimelinePanelMenu(b);
    else if (isOpen) openBoardMenu(b);
    else openHideMenu(b); // в неделе троеточие = меню скрытия
  };
  return b;
}

/* ── Drag-and-drop карточек ── */
let drag = null;
function startDrag(card, x, y) {
  const col = card.closest('.kb-col');
  const ghost = card.cloneNode(true);
  ghost.className = 'kb-card kb-ghost m-' + (getTask(card.dataset.id) || {}).mode;
  ghost.style.width = card.offsetWidth + 'px';
  document.body.appendChild(ghost);
  drag = {
    id: card.dataset.id,
    fromKind: col ? col.dataset.kind : '',
    fromValue: col ? col.dataset.value : '',
    ghost, w: card.offsetWidth,
  };
  card.classList.add('kb-dragging');
  document.body.classList.add('kb-drag');
  moveGhost(x, y);
}
function moveGhost(x, y) {
  if (!drag) return;
  drag.ghost.style.left = (x - drag.w / 2) + 'px';
  drag.ghost.style.top = (y - 30) + 'px';
  const panel = $('kanbanPanel');
  const colsEl = panel && panel.querySelector('.kb-cols');
  if (colsEl) {
    const r = colsEl.getBoundingClientRect();
    if (x < r.left + 44) colsEl.scrollLeft -= 14;
    else if (x > r.right - 44) colsEl.scrollLeft += 14;
  }
  const app = $('app');
  if (app) {
    if (y < 70) app.scrollTop -= 10;
    else if (y > innerHeight - 70) app.scrollTop += 10;
  }
  const under = document.elementFromPoint(x, y);
  const col = under && under.closest ? under.closest('.kb-col') : null;
  document.querySelectorAll('.kb-col.kb-over').forEach(c => { if (c !== col) c.classList.remove('kb-over'); });
  if (col) col.classList.add('kb-over');
}
function endDragVisual() {
  if (!drag) return;
  drag.ghost.remove();
  document.querySelectorAll('.kb-card.kb-dragging').forEach(c => c.classList.remove('kb-dragging'));
  document.querySelectorAll('.kb-col.kb-over').forEach(c => c.classList.remove('kb-over'));
  document.body.classList.remove('kb-drag');
}
async function applyDrop(colEl, d) {
  if (!d || !colEl) return;
  const kind = colEl.dataset.kind, value = colEl.dataset.value;
  const t = getTask(d.id);
  if (!t) return;
  if (kind === 'prio') {
    if (String(t.priority || 2) !== value) await updateTask(t.id, { priority: +value });
  } else if (kind === 'type') {
    if ((t.type || 'task') !== value) await updateTask(t.id, { type: value });
  } else if (kind === 'status') {
    const rep = repStatus(t, rangeBounds());
    if (!rep || rep.st === value) return;
    await setEntry(t.id, rep.day, value);
  } else if (kind === 'tag') {
    if (value === d.fromValue) return;
    let tags = [...(t.tags || [])];
    if (d.fromValue && d.fromValue !== '__none') tags = tags.filter(x => x !== d.fromValue);
    if (value !== '__none') {
      if (!tags.includes(value)) tags.push(value);
      await addTagsToDict([value]);
    }
    await updateTask(t.id, { tags });
  }
  hapticLight();
}
function bindDnD() {
  document.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
  document.addEventListener('pointerdown', e => {
    const card = e.target.closest('.kb-card');
    if (!card || e.target.closest('button') || e.target.closest('.kb-col-handle')) return;
    const sx = e.clientX, sy = e.clientY;
    const isMouse = e.pointerType === 'mouse';
    let started = false, cancelled = false, hold = null;
    if (!isMouse) hold = setTimeout(() => { hold = null; started = true; hapticLight(); startDrag(card, sx, sy); }, 220);
    const move = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!started) {
        if (isMouse && Math.hypot(dx, dy) > 5) { started = true; startDrag(card, ev.clientX, ev.clientY); }
        else if (!isMouse && Math.hypot(dx, dy) > 10) { cancelled = true; if (hold) { clearTimeout(hold); hold = null; } cleanup(); }
      }
      if (started && drag) moveGhost(ev.clientX, ev.clientY);
    };
    const up = ev => {
      if (hold) { clearTimeout(hold); hold = null; }
      if (started && drag) {
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const col = under && under.closest ? under.closest('.kb-col') : null;
        endDragVisual();
        const d = drag; drag = null;
        if (col) applyDrop(col, d).then(renderKanban);
        else renderKanban();
      } else if (!cancelled && !started) {
        const t = getTask(card.dataset.id);
        if (t) openSheet(t);
      }
      cleanup();
    };
    const cancel = () => { if (hold) clearTimeout(hold); endDragVisual(); drag = null; cleanup(); };
    const cleanup = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
  });
}

/* ── Перетаскивание СТОЛБИКОВ за ручку-дугу ── */
function flipCols(colsEl, mutate) {
  const first = new Map([...colsEl.children].map(k => [k, k.getBoundingClientRect().left]));
  mutate();
  [...colsEl.children].forEach(k => {
    const f = first.get(k);
    if (f == null) return;
    const d = f - k.getBoundingClientRect().left;
    if (Math.abs(d) > 1) {
      k.animate([{ transform: 'translateX(' + d + 'px)' }, { transform: 'translateX(0)' }],
        { duration: 200, easing: 'cubic-bezier(.32,.72,.28,1)' });
    }
  });
}
function bindColDnD() {
  document.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.kb-col-handle');
    if (!handle) return;
    const col = handle.closest('.kb-col');
    const colsEl = col && col.parentNode;
    if (!col || !colsEl || !colsEl.classList.contains('kb-cols')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let started = false;
    const move = ev => {
      const x = ev.clientX, y = ev.clientY;
      if (!started) {
        if (Math.hypot(x - sx, y - sy) > 8) {
          started = true;
          col.classList.add('kb-coldragging');
          document.body.classList.add('kb-drag');
          hapticLight();
        } else return;
      }
      const r = colsEl.getBoundingClientRect();
      if (x < r.left + 44) colsEl.scrollLeft -= 14;
      else if (x > r.right - 44) colsEl.scrollLeft += 14;
      const kids = [...colsEl.children].filter(k => k !== col);
      let idx = kids.length;
      for (let i = 0; i < kids.length; i++) {
        const kr = kids[i].getBoundingClientRect();
        if (x < kr.left + kr.width / 2) { idx = i; break; }
      }
      const ref = idx < kids.length ? kids[idx] : null;
      const same = ref ? col.nextSibling === ref : colsEl.lastElementChild === col;
      if (!same) {
        flipCols(colsEl, () => { if (ref) colsEl.insertBefore(col, ref); else colsEl.appendChild(col); });
      }
    };
    const up = () => {
      cleanup();
      if (started) {
        col.classList.remove('kb-coldragging');
        document.body.classList.remove('kb-drag');
        kb.colOrder = kb.colOrder || {};
        kb.colOrder[kb.view] = [...colsEl.children].map(c => c.dataset.value);
        saveKb();
      }
    };
    const cancel = () => {
      cleanup();
      col.classList.remove('kb-coldragging');
      document.body.classList.remove('kb-drag');
    };
    const cleanup = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
  });
}

/* ── Панель канбана ── */
function ensureDayPanel() {
  let p = $('dayPanel');
  if (p) return p;
  const grid = $('grid');
  if (!grid) return null;
  p = document.createElement('section');
  p.id = 'dayPanel';
  p.className = 'pane glass kanban-panel timeline-panel';
  p.hidden = true;
  grid.parentNode.insertBefore(p, grid.nextSibling);
  return p;
}
function ensurePanel() {
  let p = $('kanbanPanel');
  if (p) return p;
  const grid = $('grid');
  if (!grid) return null;
  p = document.createElement('section');
  p.id = 'kanbanPanel';
  p.className = 'pane glass kanban-panel';
  p.hidden = true;
  grid.parentNode.insertBefore(p, grid.nextSibling);
  return p;
}

/* ── Переключение вида с анимацией «кирпичики» ── */
const visiblePane = (grid, sel) => { const el = grid.querySelector(sel); return el && el.offsetWidth > 0 ? el : null; };
const setTopbarKb = on => { const tb = document.querySelector('.topbar'); if (tb) tb.classList.toggle('kanban-active', on); };
export const toggleKanbanView = () => setBlock(blockKind === 'kanban' ? 'week' : 'kanban');
export const toggleDayBlock = () => setBlock(blockKind === 'day' ? 'week' : 'day');

/* ── Блоки недели: Running-list, Канбан и День ──
   Все три живут на одном месте и сменяют друг друга одним движением:
   старый блок уезжает влево, новый приезжает справа. Раньше здесь был
   бинарный переключатель неделя ↔ канбан; теперь это выбор из трёх,
   а сама анимация и разметка общие. */
const blockNode = kind => kind === 'kanban' ? ensurePanel() : kind === 'day' ? ensureDayPanel() : $('grid');
function renderBlock(kind) {
  if (kind === 'kanban') renderKanban();
  else if (kind === 'day') renderTimelinePanel();
}
/* Троеточие и заголовок у таймлайна работают так же, как у канбана:
   заголовок — выбор вида, троеточие — настройки самого блока. */
function renderTimelinePanel() {
  const p = ensureDayPanel();
  const vbKeep = viewBtnEl && p.contains(viewBtnEl) ? viewBtnEl : null;
  if (vbKeep) vbKeep.remove();
  renderTimeline(p);
  const title = p.querySelector('#tlTitle');
  if (vbKeep && title) title.insertAdjacentElement('beforebegin', vbKeep);
  if (title) title.onclick = e => { e.stopPropagation(); closeAllMenus(); openViewMenu(title); };
  const chip = p.querySelector('#tlRangeChip');
  if (chip) chip.onclick = e => { e.stopPropagation(); closeAllMenus(); openTimelineMenu(chip); };
  const pv = p.querySelector('#tlPrev'), nx = p.querySelector('#tlNext');
  /* Дошли до края недели — стрелка переводит саму неделю, и шапка
     приложения уезжает вместе с таймлайном. */
  const step = dir => {
    let weekMoved = false;
    const go = shiftTimeline(dir, d => { state.weekStart = addDays(state.weekStart, d * 7); weekMoved = true; });
    contentFade(() => {
      if (weekMoved) renderAll();
      go();
    }, { dir, selector: weekMoved ? '.pane, .dock-panel' : '#dayPanel' });
  };
  if (pv) pv.onclick = () => step(-1);
  if (nx) nx.onclick = () => step(1);
}
/* Троеточие таймлайна — развернуть/свернуть саму панель */
export function openTimelinePanelMenu(anchor) {
  const m = ensureMenu('tlMenu');
  m.innerHTML = '<button type="button" data-x="1" class="' + (timelineExpanded() ? 'on' : '') + '">' +
    '<span class="cm-ico">' + (timelineExpanded() ? ICON_BARS : ICON_EXPAND) + '</span>' +
    '<span>' + (timelineExpanded() ? 'Свернуть панель' : 'Развернуть панель') + '</span></button>';
  showMenu(m);
  placeMenu(m, anchor);
  m.querySelector('button[data-x]').onclick = e => {
    e.stopPropagation();
    closeAllMenus();
    toggleExpanded();
    renderTimelinePanel();
  };
}
export function openTimelineMenu(anchor) {
  const m = ensureMenu('tlRangeMenu');
  m.innerHTML = TL_RANGES.map(r =>
    '<button type="button" data-r="' + r.id + '" class="' + (timelineRange() === r.id ? 'on' : '') + '">' +
    '<span class="cm-ico">' + VIEW_ICON_DAY + '</span><span>' + r.label + '</span></button>').join('');
  showMenu(m);
  placeMenu(m, anchor);
  m.querySelectorAll('button[data-r]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    closeAllMenus();
    setTimelineRange(+b.dataset.r);
    renderTimelinePanel();
  });
}
export async function setBlock(kind) {
  if (animBusy || state.view !== 'week' || kind === blockKind) return;
  closeAllMenus();
  const grid = $('grid');
  if (!grid) return;
  const fromKind = blockKind;
  const from = blockNode(fromKind);
  const to = blockNode(kind);
  if (!to) return;
  blockKind = kind;
  isOpen = kind === 'kanban';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const off = innerWidth + 60;
  const EXIT = { duration: 240, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' };

  const showTarget = () => {
    if (from && from !== to) from.hidden = true;
    to.hidden = false;
    renderBlock(kind);
    document.dispatchEvent(new CustomEvent('grid-rendered'));
    setTopbarKb(kind !== 'week');
  };

  /* Уезжающие элементы: у сетки это её панели, у блоков — сам блок */
  const leaving = fromKind === 'week'
    ? [visiblePane(grid, '.p-left') || visiblePane(grid, '.p-mobile'), visiblePane(grid, '.p-right')].filter(Boolean)
    : [from].filter(Boolean);
  if (reduce || !leaving.length) { showTarget(); return; }

  animBusy = true;
  exitAnims.forEach(a => a.cancel());
  exitAnims = leaving.map((el, i) => el.animate(
    [{ transform: 'translateX(0)' }, { transform: `translateX(${-off}px)` }],
    Object.assign({ delay: i * 110 }, EXIT)));
  await Promise.all(exitAnims.map(a => a.finished.catch(() => {})));
  exitAnims.forEach(a => a.cancel());
  exitAnims = [];
  showTarget();

  const entering = kind === 'week'
    ? [visiblePane(grid, '.p-left') || visiblePane(grid, '.p-mobile'), visiblePane(grid, '.p-right')].filter(Boolean)
    : [to];
  const EN = { duration: 320, easing: 'cubic-bezier(.32,.72,.28,1)', fill: 'backwards' };
  entering.forEach((el, i) => {
    if (el.getAnimations) el.getAnimations().forEach(x => x.cancel());
    el.animate([{ transform: `translateX(${off}px)` }, { transform: 'translateX(0)' }],
      Object.assign({ delay: i * 110 }, EN));
  });
  animBusy = false;
}
export function kanbanForceClose() {
  if (blockKind === 'week') return;
  isOpen = false;
  blockKind = 'week';
  const dp = $('dayPanel');
  if (dp) dp.hidden = true;
  exitAnims.forEach(x => x.cancel());
  exitAnims = [];
  const panel = $('kanbanPanel'), grid = $('grid');
  if (panel) {
    if (panel.getAnimations) panel.getAnimations().forEach(a => a.cancel());
    panel.hidden = true;
  }
  if (grid) {
    grid.hidden = false;
    grid.querySelectorAll('.pane').forEach(el => { if (el.getAnimations) el.getAnimations().forEach(x => x.cancel()); });
  }
  document.dispatchEvent(new CustomEvent('grid-rendered'));
  setTopbarKb(false);
}

/* ── Инициализация ── */
export function kanbanInit() {
  ensurePanel();
  ensureViewBtn();
  bindDnD();
  bindColDnD();
  /* Клик по заголовку недели ИЛИ канбана — селектор вида */
  document.addEventListener('click', e => {
    const wt = e.target.closest('.r-head .kb-board-title, .m-head .kb-board-title');
    if (wt) { e.stopPropagation(); closeAllMenus(); openViewMenu(wt); }
  });
  /* Закрытие меню: клик мимо, Esc */
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.cmenu')) closeAllMenus();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAllMenus();
  });
  document.addEventListener('grid-rendered', () => {
    if (blockKind === 'day') renderTimelinePanel();
    if (viewBtnEl && !viewBtnEl.isConnected) document.body.appendChild(viewBtnEl);
  });
  /* Смена режима работы: вся панель канбана уезжает/въезжает перерисованной */
  let lastMode = state.mode;
  subscribe(() => {
    if (!isOpen) { lastMode = state.mode; return; }
    if (lastMode === state.mode) return;
    const from = lastMode;
    lastMode = state.mode;
    animateKanbanModeSwitch(from, state.mode);
  });
}
