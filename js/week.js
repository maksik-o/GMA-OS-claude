import {
  state, MODES, WEEKDAYS, DAYS_FULL, TYPE_LABEL, MONTHS, MONTHS_FULL,
  addDays, today, isoWeek, iso, parseISO, fmtD, esc, fmtMin, blockEnd, mondayOf,
  tasksForDay, weekRows, getTask, getTagColor, isDone,
  removeTask, setEntry, postponeFrom, setMode,
  toggleSubtask, delSubtask, updateSubtask,
} from './store.js';
import { openSheet, refreshBackdrop } from './sheet.js';
import { renderNotesPanel, setWeekStart } from './notes.js';
import { calTitle, createCalDrum } from './cal.js';
import { contentFade } from './anim.js';

import * as hk from './hotkeys.js';
import * as tm from './timer.js';
import * as fc from './focus.js';

const $ = id => document.getElementById(id);
const ARROW_DOWN = '<svg viewBox="0 0 20 20"><path d="M10 2v16M4 12l6 6 6-6" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const I = {
  todo: '<svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/></svg>',
  started: '<svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><line x1="6" y1="14" x2="14" y2="6"/></svg>',
  done: '<svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><line x1="6" y1="11" x2="11" y2="6"/><line x1="7" y1="14" x2="14" y2="7"/><line x1="10" y1="15" x2="15" y2="10"/></svg>',
  skipped: '<svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><line x1="7" y1="7" x2="13" y2="13"/><line x1="13" y1="7" x2="7" y2="13"/></svg>',
  postponed: '<svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><line x1="6.5" y1="10" x2="12.5" y2="10"/><polyline points="10,7.5 12.5,10 10,12.5"/></svg>',
  remove: '<svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="13" height="13" rx="2.5" stroke-dasharray="3 3"/><line x1="5" y1="15" x2="15" y2="5"/></svg>'
};
const MENU = [
  ['todo', 'Запланировано', I.todo],
  ['started', 'Начато', I.started],
  ['done', 'Выполнено', I.done],
  ['skipped', 'Пропущено', I.skipped],
  ['postponed', 'Перенесено', I.postponed],
  [null, 'Убрать квадрат', I.remove]
];
/* ── Квадраты недели: три состояния ──
   full  — все ряды раскрыты (по умолчанию)
   bars  — свёрнуты до полосок, ряд раскрывается тапом
   hidden — убраны совсем
   Раньше состояний было два, и «свернуть» с «убрать» были одним и тем
   же действием. */
const SQ_MODES = ['full', 'bars', 'hidden'];
let sqMode = SQ_MODES.includes(localStorage.getItem('rl_sq_mode'))
  ? localStorage.getItem('rl_sq_mode')
  : (localStorage.getItem('rl_hide_squares') === '1' ? 'hidden' : 'full');
export const squaresMode = () => sqMode;
export const squaresHidden = () => sqMode === 'hidden';
export function setSquaresMode(m) {
  if (!SQ_MODES.includes(m)) return;
  sqMode = m;
  try { localStorage.setItem('rl_sq_mode', m); } catch (e) {}
  renderAll();
}
export function toggleSquares() {
  setSquaresMode(sqMode === 'hidden' ? 'full' : sqMode === 'full' ? 'bars' : 'hidden');
}
/* ── Иконки пункта «квадраты недели» ── */
const ICON_GRID = '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="4" height="14" rx="1.5"/><rect x="10" y="5" width="4" height="14" rx="1.5"/><rect x="16" y="5" width="4" height="14" rx="1.5"/></svg>';
const ICON_GRID_OFF = '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="4" height="14" rx="1.5"/><rect x="10" y="5" width="4" height="14" rx="1.5"/><rect x="16" y="5" width="4" height="14" rx="1.5"/><line x1="4" y1="20" x2="20" y2="4"/></svg>';

let expandedSub = null;
let expandedSq = null; // мобилка: чьи квадраты раскрыты из полосок
let inlineCalOpen = false;
const hasWidget = id => (state.widgets || []).includes(id);

/* ── Сторона панели квадратов: слева или справа от задач ── */
let gridSwapped = localStorage.getItem('rl_grid_side') === 'right';
function applyGridSide() {
  const g = $('grid');
  if (g) g.classList.toggle('swapped', gridSwapped);
}
/* ── Перенос панели квадратов: только горизонтально, бросок — мгновенно ── */
function bindPaneMoveHandle() {
  const grid = $('grid');
  const pane = grid && grid.querySelector('.p-left');
  if (!pane) return;
  let handle = pane.querySelector('.pane-move-handle');
  if (!handle) {
    handle = document.createElement('div');
    handle.className = 'pane-move-handle';
    handle.title = 'Перетащи, чтобы поменять сторону';
    handle.innerHTML = '<svg viewBox="0 0 32 32"><path d="M2 22 A20 20 0 0 1 12 4.68" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
    pane.appendChild(handle);
  }
  if (handle._bound) return;
  handle._bound = true;
  let sx = 0, dx = 0, started = false, targetSide = null;
  const currentSide = () => (gridSwapped ? 'right' : 'left');
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    sx = e.clientX; dx = 0; started = false; targetSide = null;
    const blockTouch = te => { if (te.cancelable) te.preventDefault(); };
    document.addEventListener('touchmove', blockTouch, { passive: false });
    document.body.classList.add('dock-grab');
    const move = ev => {
      dx = ev.clientX - sx;
      if (!started && Math.abs(dx) > 12) {
        started = true;
        pane.classList.add('dock-dragging');
      }
      if (!started) return;
      pane.style.transform = `translateX(${dx}px)`;
      const gr = grid.getBoundingClientRect();
      targetSide = ev.clientX < gr.left + gr.width / 2 ? 'left' : 'right';
      grid.classList.toggle('preview-right', targetSide === 'right' && currentSide() !== 'right');
      grid.classList.toggle('preview-left', targetSide === 'left' && currentSide() !== 'left');
    };
    const finish = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      document.removeEventListener('touchmove', blockTouch);
      document.body.classList.remove('dock-grab');
      pane.classList.remove('dock-dragging');
      pane.style.transition = 'none';
      pane.style.transform = '';
      void pane.offsetHeight;
      pane.style.transition = '';
      grid.classList.remove('preview-right', 'preview-left');
      if (!started || !targetSide) return;
      if (targetSide !== currentSide()) {
        gridSwapped = targetSide === 'right';
        localStorage.setItem('rl_grid_side', gridSwapped ? 'right' : 'left');
        applyGridSide();
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  });
}
/* ── Синхронизация высот строк ── */
let _rowResizeObserver = null;
function syncRowHeights() {
  if (_rowResizeObserver) {
    _rowResizeObserver.disconnect();
    _rowResizeObserver = null;
  }
  const grid = $('grid');
  if (!grid) return;
  const lRows = grid.querySelectorAll('.p-left .l-row');
  const rRows = grid.querySelectorAll('.p-right .r-row');
  if (!lRows.length || !rRows.length) return;
  const align = () => {
    const len = Math.min(lRows.length, rRows.length);
    for (let i = 0; i < len; i++) {
      lRows[i].style.height = '';
      const h = Math.max(rRows[i].offsetHeight, lRows[i].offsetHeight);
      lRows[i].style.height = h + 'px';
    }
  };
  align();
  if (typeof ResizeObserver !== 'undefined') {
    _rowResizeObserver = new ResizeObserver(() => requestAnimationFrame(align));
    rRows.forEach(r => _rowResizeObserver.observe(r));
  } else {
    window.addEventListener('resize', align);
  }
}
/* ── Закрытие панели подзадач по тапу/скроллу снаружи ── */
let subOutsideBound = false;
function ensureSubCollapse() {
  if (subOutsideBound) return;
  subOutsideBound = true;
  const app = $('app');
  const done = () => {
    subOutsideBound = false;
    document.removeEventListener('pointerdown', onDown);
    if (app) app.removeEventListener('scroll', onScroll);
  };
  const onDown = e => {
    if (e.target.closest('.sub-panel') || e.target.closest('.sub-arrow')) return;
    done();
    if (expandedSub) { expandedSub = null; renderAll(); }
  };
  const onScroll = () => {
    done();
    if (expandedSub) { expandedSub = null; renderAll(); }
  };
  document.addEventListener('pointerdown', onDown);
  if (app) app.addEventListener('scroll', onScroll, { passive: true });
}
export function closeCellMenu() {
  const m = document.getElementById('cellMenu');
  if (m) m.classList.remove('open');
}
function openCellMenu(cell, id, day) {
  const task = getTask(id);
  if (!task) { closeCellMenu(); return; }
  const cur = (task.days || {})[day] || null;
  const m = $('cellMenu');
  m.innerHTML = MENU.map(([st, label, ic]) =>
    `<button type="button" data-st="${st || ''}" class="${cur === st ? 'on' : ''}">${ic}<span>${label}</span></button>`
  ).join('');
  m.classList.add('open');
  const r = cell.getBoundingClientRect();
  const mw = 200;
  const mh = m.offsetHeight || 240;
  const x = Math.min(Math.max(8, r.left + r.width / 2 - mw / 2), innerWidth - mw - 8);
  let y = r.bottom + 8;
  if (y + mh > innerHeight - 8) y = r.top - mh - 8;
  m.style.left = x + 'px';
  m.style.top = Math.max(8, y) + 'px';
  m.querySelectorAll('button').forEach(b => {
    b.onclick = e => {
      e.stopPropagation();
      if (!getTask(id)) { closeCellMenu(); return; }
      setEntry(id, day, b.dataset.st || null).then(() => { closeCellMenu(); renderAll(); });
    };
  });
  setTimeout(() => {
    const close = e => {
      if (!m.contains(e.target)) {
        closeCellMenu();
        document.removeEventListener('pointerdown', close);
      }
    };
    document.addEventListener('pointerdown', close);
  }, 0);
}
let swiped = false;
function weekRangeLabels() {
  const a = state.weekStart, b = addDays(a, 6);
  const da = +a.slice(8), db = +b.slice(8);
  const ma = +a.slice(5, 7), mb = +b.slice(5, 7);
  const short = ma === mb ? `${da}–${db} ${MONTHS[ma - 1]}` : `${da} ${MONTHS[ma - 1]} – ${db} ${MONTHS[mb - 1]}`;
  const full = ma === mb ? `${da} – ${db} ${MONTHS_FULL[ma - 1]}` : `${da} ${MONTHS_FULL[ma - 1]} – ${db} ${MONTHS_FULL[mb - 1]}`;
  return { full, short };
}
export function shiftWeek(dir) {
  /* Стрелки НЕ двигают блоки: панели стоят на месте, внутри них
     плавно сменяется содержимое. Уезжание блоков осталось только
     для смены режима и смены вида. */
  contentFade(() => {
    state.weekStart = addDays(state.weekStart, dir * 7);
    renderAll();
  }, { dir });
}
export function animatePage(dir) {
  contentFade(() => renderAll(), { dir });
}
export function goToday() {
  const d = parseISO(today());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  state.weekStart = iso(d);
  if (dayOpen()) state.day = today();
  renderAll();
}
/* ── Анимация смены режима: конвейер по слоям, без наезда панелей. ── */
let modeAnimBusy = false;
function collectRowBlocks() {
  const top = [], bottom = [];
  const push = (el, arr) => { if (el && el.offsetWidth > 0) arr.push(el); };
  const t = $('dockTop'), b = $('dockBottom');
  if (t) [...t.children].forEach(k => { if (k.classList && k.classList.contains('dock-panel')) push(k, top); });
  if (b) [...b.children].forEach(k => { if (k.classList && k.classList.contains('dock-panel')) push(k, bottom); });
  return { top, bottom };
}
/* Центральный ряд — это содержимое активного режима, каким бы он ни был.
   Один набор селекторов на все режимы: неделя, канбан, день, контакты,
   финансы, база знаний. Благодаря этому движение переключения
   одинаково везде. */
const MID_SEL = [
  '#grid .p-right', '#grid .p-left', '#grid .p-mobile', '#grid .kanban-panel',
  '#dayPanel',
  '#contactsView .cgroup', '#contactsView .cgroup-new',
  '#financeView .fin-head', '#financeView .fin-body',
  '#kbView .kb-side', '#kbView .kb-main',
].join(',');
function collectMidBlocks() {
  return [...document.querySelectorAll(MID_SEL)].filter(el => el.offsetWidth > 0);
}
const orderRow = (blocks, asc) => blocks
  .map(b => { const r = b.getBoundingClientRect(); return { b, x: r.left + r.width / 2 }; })
  .sort((a, c) => (asc ? a.x - c.x : c.x - a.x))
  .map(o => o.b);
async function switchModeWithAnim(nextId) {
  const order = MODES.map(m => m.id);
  const from = order.indexOf(state.mode);
  const to = order.indexOf(nextId);
  if (to < 0 || to === from || modeAnimBusy) return;
  const modesEl0 = $('modes');
  if (modesEl0) {
    modesEl0.querySelectorAll('button').forEach(bt => bt.classList.toggle('on', bt.dataset.m === nextId));
    updateModeBlob();
    setBlobColors(nextId);
  }
  await blockSwap(to < from ? -1 : 1, async () => {
    await setMode(nextId);
    document.dispatchEvent(new CustomEvent('render-now'));
  });
}

/* ══════════════════════════════════════════════════════════════════
   Единый движок перерисовки: блоки трёх рядов (верхние виджеты,
   содержимое режима, нижние виджеты) уезжают каскадом, между уездом
   и приездом выполняется apply() — он и перестраивает DOM. Одно и то
   же движение используется при смене режима, смене вида, листании
   недель и диапазонов: раньше каждый случай анимировался по-своему,
   отсюда и рваность.
   ══════════════════════════════════════════════════════════════════ */
export async function blockSwap(dir, apply, opts) {
  const o = opts || {};
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (modeAnimBusy || reduce || !document.body.animate) {
    await apply();
    return;
  }
  modeAnimBusy = true;
  try {
    await runBlockSwap(dir, apply, o);
  } finally {
    modeAnimBusy = false;
  }
}
async function runBlockSwap(dir, apply, o) {
  const back = dir < 0;
  const exitSign = back ? -1 : 1;
  const enterSign = -exitSign;
  const off = innerWidth + 60;
  const STEP = o.step != null ? o.step : 90;
  const ROW_STEP = o.rowStep != null ? o.rowStep : 90;
  const EXIT_MS = 230, ENTER_MS = 320;
  const rows = collectRowBlocks();
  const enterRow = blocks => {
    orderRow(blocks.slice(), back).forEach((b, i) => {
      b.animate(
        [{ transform: `translateX(${enterSign * off}px)` }, { transform: 'translateX(0)' }],
        { duration: ENTER_MS, delay: i * STEP, easing: 'cubic-bezier(.32, .72, .28, 1)', fill: 'backwards' }
      );
    });
  };
  /* После перерисовки снимаем анимации ухода. Сетка недели строится
     заново и старые узлы исчезают вместе со своими анимациями, но
     панели Timeline и канбана — ОДНИ И ТЕ ЖЕ элементы: у них перерисовывается
     только содержимое. Анимация ухода с fill: forwards оставалась на
     них висеть, и после въезда панель снова отскакивала за экран —
     таймлайн «пропадал» при смене режима работы. */
  async function swapMid(exits) {
    await apply();
    (exits || []).forEach(a => a.cancel());
    enterRow(collectMidBlocks());
  }
  async function runRow(blocks, isMid, baseDelay) {
    if (!blocks.length) {
      if (isMid) await swapMid();
      return;
    }
    const ordered = orderRow(blocks.slice(), back);
    const exits = ordered.map((b, i) => b.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(${exitSign * off}px)` }],
      { duration: EXIT_MS, delay: baseDelay + i * STEP, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' }
    ));
    await Promise.all(exits.map(a => a.finished.catch(() => {})));
    if (isMid) {
      await swapMid(exits);
    } else {
      exits.forEach(a => a.cancel());
      enterRow(blocks);
    }
  }
  await Promise.all([
    runRow(rows.top, false, 0),
    runRow(collectMidBlocks(), true, ROW_STEP),
    runRow(rows.bottom, false, 2 * ROW_STEP),
  ]);
}
let _modeBlobInitialized = false;
/* ── Цвет блоба: покадровая rAF-интерполяция RGB в JS ── */
function modeColorOf(id) {
  return getComputedStyle(document.documentElement).getPropertyValue('--mode-' + id).trim() || '#dc2626';
}
function hexToRgb(hex) {
  const n = (hex || '').trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(n)) return [220, 38, 38];
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
function modeShades(id) {
  const c = hexToRgb(modeColorOf(id));
  return { a: c.map(v => Math.round(v * 0.82)), b: c.map(v => Math.round(v * 0.55)) };
}
let blobCur = { a: [220, 38, 38], b: [107, 15, 15] };
let blobRaf = null;
function paintBlob(blob) {
  blob.style.background = 'linear-gradient(135deg, rgb(' + blobCur.a.join(',') + '), rgb(' + blobCur.b.join(',') + '))';
}
function setBlobColors(modeId, instant) {
  const el = $('modes');
  const blob = el && el.querySelector('.mode-blob');
  if (!blob) return;
  const target = modeShades(modeId);
  if (blobRaf) { cancelAnimationFrame(blobRaf); blobRaf = null; }
  if (instant) { blobCur = target; paintBlob(blob); return; }
  const from = { a: blobCur.a.slice(), b: blobCur.b.slice() };
  const t0 = performance.now(), D = 700;
  const ease = t => 1 - Math.pow(1 - t, 3);
  const step = now => {
    const p = Math.min(1, (now - t0) / D), e = ease(p);
    blobCur = {
      a: from.a.map((v, i) => Math.round(v + (target.a[i] - v) * e)),
      b: from.b.map((v, i) => Math.round(v + (target.b[i] - v) * e)),
    };
    paintBlob(blob);
    blobRaf = p < 1 ? requestAnimationFrame(step) : null;
  };
  blobRaf = requestAnimationFrame(step);
}
function renderModes() {
  const el = $('modes');
  if (!el) return;
  if (!el.querySelector('.mode-blob')) {
    const blob = document.createElement('span');
    blob.className = 'mode-blob';
    el.insertBefore(blob, el.firstChild);
  }
  el.querySelectorAll('button').forEach(b => b.remove());
  MODES.forEach(m => {
    const label = m.short
      ? `<span class="m-full">${m.label}</span><span class="m-short">${m.short}</span>`
      : m.label;
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.m = m.id;
    b.innerHTML = label;
    if (m.id === state.mode) b.classList.add('on');
    b.onclick = () => switchModeWithAnim(m.id);
    el.appendChild(b);
  });
  updateModeBlob();
}
function updateModeBlob() {
  requestAnimationFrame(() => {
    const el = $('modes');
    if (!el) return;
    const blob = el.querySelector('.mode-blob');
    const active = el.querySelector('button.on');
    if (!blob || !active) {
      if (blob) blob.classList.remove('visible');
      return;
    }
    const elRect = el.getBoundingClientRect();
    const btnRect = active.getBoundingClientRect();
    const left = btnRect.left - elRect.left;
    const width = btnRect.width;
    if (!_modeBlobInitialized) {
      blob.style.transition = 'none';
      blob.style.left = left + 'px';
      blob.style.width = width + 'px';
      blob.classList.add('visible');
      blob.offsetHeight;
      blob.style.transition = '';
      setBlobColors(state.mode, true);
      _modeBlobInitialized = true;
    } else {
      blob.style.left = left + 'px';
      blob.style.width = width + 'px';
      blob.classList.add('visible');
      if (!modeAnimBusy) setBlobColors(state.mode);
    }
  });
}
window.addEventListener('resize', updateModeBlob);
function metaHTML(tk) {
  const meta = [];
  if ((tk.subtasks || []).length) {
    const dn = tk.subtasks.filter(s => s.done).length;
    meta.push(`<span class="sub-chip">${dn}/${tk.subtasks.length}</span>`);
  }
  if ((tk.tags || []).length) {
    meta.push(
      tk.tags.slice(0, 2).map(tg => {
        const c = getTagColor(tg);
        return `<span class="tag-pill"${c ? ` style="--tc:${c}"` : ''}>${esc(tg)}</span>`;
      }).join('') + (tk.tags.length > 2 ? `<span class="tag-more">+${tk.tags.length - 2}</span>` : '')
    );
  }
  if (tk.blockStart) meta.push(`<span class="m-time">⏰${tk.blockStart}</span>`);
  if (tk.spentMin) meta.push(`<span class="m-time">${fmtMin(tk.spentMin)}</span>`);
  if (tk.notes && tk.notes.trim()) meta.push('<span class="note-dot" title="Есть заметка"></span>');
  if ((tk.files || []).length) meta.push(`📎${tk.files.length}`);
  return meta.join(' ');
}
function indHTML(tk) {
  const hasSub = (tk.subtasks || []).length > 0;
  return hasSub
    ? `<button type="button" class="sub-arrow p${tk.priority}${expandedSub === tk.id ? ' open' : ''}" data-id="${esc(tk.id)}" title="Подзадачи">${ARROW_DOWN}</button>`
    : `<i class="prio p${tk.priority}" title="Приоритет"></i>`;
}
function subPanelHTML(tk) {
  return `<div class="sub-panel glass">${(tk.subtasks || []).map(s => `<div class="sub-row">
    <button type="button" class="cell sub ${s.done ? 'c-done' : 'c-todo'}" data-subtoggle="${s.id}" title="${s.done ? 'Выполнено' : 'Запланировано'}"></button>
    <span class="sub-text${s.done ? ' done' : ''}" title="Редактировать">${esc(s.text)}</span>
    <button type="button" class="sub-del" data-subdel="${s.id}" title="Удалить подзадачу">✕</button>
  </div>`).join('')}</div>`;
}
/* ── Шапка дней (ПК) + полоска-календарь ── */
function headHTML(t) {
  let h = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(state.weekStart, i);
    h += `<button type="button" class="g-hd${d === t ? ' today' : ''}" data-day="${d}" title="Открыть день">${WEEKDAYS[i]} <b>${+d.slice(8)}</b></button>`;
  }
  return h;
}
/* ── Мобилка: двухрядная липкая шапка: троеточие+заголовок+неделя / дни ── */
function mobileHeadHTML(t) {
  let days = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(state.weekStart, i);
    days += `<button type="button" class="g-hd${d === t ? ' today' : ''}" data-day="${d}" title="Открыть день">${WEEKDAYS[i]} <b>${+d.slice(8)}</b></button>`;
  }
  return '<div class="m-head-top">' +
    '<span class="kb-board-title m-title">Running-list</span>' +
    '<div class="m-head-nav"></div>' +
    '</div>' +
    '<div class="m-head-days">' + days + '</div>' +
    '';
}
/* ── Инлайн-календарь: барабан в шапке ── */
function renderInlineCal(el) {
  let head = el.querySelector('.inline-cal-head');
  if (!head) {
    head = document.createElement('div');
    head.className = 'inline-cal-head';
    head.innerHTML = '<span class="cal-title" title="К текущему месяцу"></span>';
    el.appendChild(head);
    const week = document.createElement('div');
    week.className = 'cal-m-week';
    week.innerHTML = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((w, i) => `<span class="${i >= 5 ? 'we' : ''}">${w}</span>`).join('');
    el.appendChild(week);
    const drumEl = document.createElement('div');
    drumEl.className = 'cal-drum inline-drum';
    el.appendChild(drumEl);
    const drum = createCalDrum(drumEl, {
      cellH: 28,
      week: false,
      onDay: d => { state.weekStart = mondayOf(d); renderAll(); openDay(d); },
      onCenter: a => { head.querySelector('.cal-title').textContent = calTitle(a); },
    });
    el._drum = drum;
    head.querySelector('.cal-title').textContent = calTitle(drum.currentMonth());
    head.querySelector('.cal-title').onclick = () => {
      state.weekStart = mondayOf(today());
      renderAll();
    };
  }
}
function refreshInlineCals() {
  document.querySelectorAll('.inline-cal').forEach(el => {
    el.classList.toggle('open', inlineCalOpen);
    if (inlineCalOpen) {
      renderInlineCal(el);
      if (el._drum) el._drum.refresh();
    }
  });
  const g = $('grid');
  if (g) g.classList.toggle('cal-open', inlineCalOpen);
}
/* ── Плавное открытие/закрытие инлайн-календаря БЕЗ рывков высоты ── */
function toggleInlineCal(force) {
  const open = typeof force === 'boolean' ? force : !inlineCalOpen;
  if (open === inlineCalOpen) return;
  inlineCalOpen = open;
  const g = $('grid');
  const bodies = [...document.querySelectorAll('.p-left .l-body, .p-mobile .l-body')]
    .filter(b => b.offsetHeight > 0);
  if (!bodies.length) {
    if (g) g.classList.toggle('cal-open', open);
    refreshInlineCals();
    return;
  }
  /* Анимируем не только контейнер календаря, но и подложку с квадратами:
     раньше она прыгала скачком, потому что в расчёт входила только
     высота .l-body. Теперь календарь и ряды едут согласованно. */
  const cals = bodies.map(b => b.querySelector('.inline-cal-container')).filter(Boolean);
  const rows = bodies.map(b => b.querySelector('.sq-rows')).filter(Boolean);
  const all = [...bodies, ...cals, ...rows];
  all.forEach(el => {
    if (el.getAnimations) el.getAnimations().forEach(a => { a.onfinish = null; a.oncancel = null; a.cancel(); });
  });
  const h0 = bodies.map(b => b.offsetHeight);
  bodies.forEach((b, i) => { b.style.height = h0[i] + 'px'; b.style.overflow = 'hidden'; });
  if (g) g.classList.toggle('cal-open', open);
  refreshInlineCals();
  const h1 = bodies.map(b => b.scrollHeight);
  const DUR = 340, EASE = 'cubic-bezier(.32, .72, .28, 1)';
  bodies.forEach((b, i) => {
    const done = () => { b.style.height = ''; b.style.overflow = ''; };
    if (h1[i] === h0[i]) { done(); return; }
    const a = b.animate([{ height: h0[i] + 'px' }, { height: h1[i] + 'px' }], { duration: DUR, easing: EASE });
    a.onfinish = done;
    a.oncancel = done;
  });
  cals.forEach(c => c.animate(
    open
      ? [{ opacity: 0, transform: 'translateY(-10px) scaleY(.94)' }, { opacity: 1, transform: 'none' }]
      : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px) scaleY(.94)' }],
    { duration: open ? DUR : 200, easing: EASE, fill: 'backwards' }));
  /* Ряды квадратов не «телепортируются», а доезжают вместе с высотой */
  const shift = (h1[0] || 0) - (h0[0] || 0);
  rows.forEach(r => r.animate(
    [{ transform: `translateY(${-shift}px)` }, { transform: 'none' }],
    { duration: DUR, easing: EASE, fill: 'backwards' }));
}
/* ── Любой скролл закрывает инлайн-календарь в шапку (кроме скролла самого барабана) ── */
(function bindInlineCalScrollClose() {
  const close = () => { if (inlineCalOpen) toggleInlineCal(false); };
  const app = $('app');
  if (app) app.addEventListener('scroll', close, { passive: true });
  window.addEventListener('wheel', e => {
    if (e.target && e.target.closest && e.target.closest('.inline-cal')) return;
    close();
  }, { passive: true });
})();
function leftRowHTML(tk, t) {
  let cells = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(state.weekStart, i);
    const st = (tk.days || {})[d];
    const pp = st === 'postponed' ? ((tk.days || {})[addDays(d, 1)] === 'postponed' ? ' pp-dash' : ' pp-arrow') : '';
    cells += `<button type="button" class="cell ${st ? 'c-' + st : 'none'}${pp}${d === t ? ' tdy' : ''}" data-id="${esc(tk.id)}" data-day="${d}" title="${fmtD(d)}">${tk.receivedAt === d ? '<i class="rd"></i>' : ''}</button>`;
  }
  return `<div class="l-row">${cells}</div>`;
}
/* Строка задачи: таймеры и fp-eligible только если установлен виджет «Фокус» */
function rightRowHTML(tk, t) {
  const struck = isDone(tk);
  const run = (hasWidget('focus') && tm.activeFor(tk.id)) ? ' running' : '';
  const hasSub = (tk.subtasks || []).length > 0;
  const sub = (hasSub && expandedSub === tk.id) ? subPanelHTML(tk) : '';
  const elig = hasWidget('focus') && Object.values(tk.days || {}).some(s => s === 'todo' || s === 'started');
  return `<div class="r-row m-${tk.mode}${struck ? ' st-done' : ''}${run}${elig ? ' fp-eligible' : ''}" data-id="${esc(tk.id)}">
    <button type="button" class="swipe-hint hint-done">✓ Выполнено</button>
    <button type="button" class="swipe-hint hint-move">Перенос на завтра →</button>
    ${indHTML(tk)}
    <span class="g-title">${esc(tk.title)}</span>
    <span class="g-meta">${metaHTML(tk)}</span>
    <span class="g-sp"></span>
    ${sub}
  </div>`;
}
/* ── Подзадачи: делегирование кликов (не ломается при перерисовке) ── */
let subDelegated = false;
function bindSub() {
  if (subDelegated) return;
  subDelegated = true;
  document.addEventListener('click', e => {
    const arrow = e.target.closest('.sub-arrow');
    if (arrow) {
      e.stopPropagation();
      const id = arrow.dataset.id;
      expandedSub = expandedSub === id ? null : id;
      if (expandedSub) ensureSubCollapse();
      renderAll();
      return;
    }
    const tog = e.target.closest('[data-subtoggle]');
    if (tog) {
      e.stopPropagation();
      const host = tog.closest('[data-id]');
      if (!host) return;
      toggleSubtask(host.dataset.id, tog.dataset.subtoggle).then(renderAll);
      return;
    }
    const del = e.target.closest('[data-subdel]');
    if (del) {
      e.stopPropagation();
      const host = del.closest('[data-id]');
      if (!host) return;
      delSubtask(host.dataset.id, del.dataset.subdel).then(renderAll);
      return;
    }
    const st = e.target.closest('.sub-text');
    if (st) startSubEdit(st);
  });
}
function startSubEdit(sp) {
  const rowEl = sp.closest('.sub-row');
  const host = sp.closest('[data-id]');
  if (!rowEl || !host) return;
  const tog = rowEl.querySelector('[data-subtoggle]');
  if (!tog) return;
  const taskId = host.dataset.id;
  const sid = tog.dataset.subtoggle;
  const inp = document.createElement('input');
  inp.className = 'sub-edit';
  inp.name = 'subEdit'; inp.autocomplete = 'off';
  inp.maxLength = 200;
  inp.value = sp.textContent;
  sp.replaceWith(inp);
  inp.focus();
  let closed = false;
  const commit = async save => {
    if (closed) return;
    closed = true;
    const v = inp.value.trim();
    if (save && v) await updateSubtask(taskId, sid, { text: v });
    renderAll();
  };
  inp.onkeydown = ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    if (ev.key === 'Escape') commit(false);
  };
  inp.onblur = () => commit(true);
  inp.onclick = ev => ev.stopPropagation();
}
function renderGrid() {
  const t = today();
  const rows = weekRows(state.weekStart);
  const leftRows = rows.map(r => leftRowHTML(r, t)).join('');
  const rightRows = rows.map(r => rightRowHTML(r, t)).join('');
  const mobileRows = rows.map(r => `<div class="m-task${(sqMode === 'full' || expandedSq === r.id) ? ' sq-open' : ''}">${rightRowHTML(r, t)}${sqMode === 'hidden' ? '' : leftRowHTML(r, t)}</div>`).join('');
  const empty = `<p class="empty">Пусто — добавьте задачу (кнопка «＋» или клавиша ${hk.pretty(hk.keyFor('new'))})</p>`;
  $('grid').innerHTML = `<section class="pane p-left glass">
    <div class="l-head">${headHTML(t)}</div>
    <div class="l-body">
      <div class="sq-rows">${leftRows}</div>
    </div>
  </section>
  <section class="pane p-right glass">
    <div class="r-head"><span class="kb-board-title">Running-list</span><div class="r-nav"></div><div class="r-search"></div></div>
    <div>${rightRows}</div>
    ${rows.length ? '' : empty}
  </section>
  <section class="pane p-mobile glass">
    <div class="m-head">${mobileHeadHTML(t)}</div>
    <div class="l-body">
      <div class="sq-rows">${mobileRows}</div>
    </div>
  </section>`;
  $('grid').querySelectorAll('.g-hd').forEach(h => {
    h.onclick = () => openDay(h.dataset.day);
  });
  $('grid').querySelectorAll('.head-cal-strip').forEach(s => {
    s.onclick = () => toggleInlineCal();
  });
  refreshInlineCals();
  $('grid').querySelectorAll('.cell:not(.sub)').forEach(bindCell);
  bindSub();
  bindSqOpen();
  $('grid').querySelectorAll('.r-row').forEach(row => {
    const id = row.dataset.id;
    const tsk = () => getTask(id);
    bindRowGestures(row, {
      onTap: () => {
        if (fc.tryChoose(id)) return;
        if (!swiped) {
          const task = tsk();
          if (task) openSheet(task);
        }
      },
      onRight: () => {
        const task = tsk();
        if (!task) return;
        const cur = (task.days || {})[today()];
        setEntry(id, today(), cur === 'done' ? 'todo' : 'done').then(renderAll);
      },
      onLeft: () => {
        const task = tsk();
        if (!task) return;
        if ((task.days || {})[today()]) {
          postponeFrom(id, today()).then(renderAll);
        } else {
          setEntry(id, addDays(today(), 1), 'todo').then(renderAll);
        }
      },
      onLong: () => {
        if (confirm('Удалить задачу?')) {
          removeTask(id).then(renderAll);
        }
      }
    });
  });
  applyGridSide();
  bindPaneMoveHandle();
  syncRowHeights();
}
/* ── Мобилка: после раскладки app.js доводим шапку недели:
   стрелки+неделя → .m-head-nav, троеточие → перед заголовком ── */
function adjustMobileHead() {
  const grid = $('grid');
  if (!grid || grid.hidden) return;
  if (!matchMedia('(max-width: 720px)').matches || state.view !== 'week') return;
  const nav = grid.querySelector('.m-head-nav');
  const prev = $('prevWeek'), wl = $('weekLabel'), next = $('nextWeek');
  if (nav && wl && prev && next && wl.parentNode !== nav) nav.append(prev, wl, next);
  const title = grid.querySelector('.m-head .kb-board-title');
  const vb = $('viewBtn');
  if (title && vb && vb.nextSibling !== title) title.insertAdjacentElement('beforebegin', vb);
}
/* Синхронно: setTimeout давал кадр, в котором навигация недели ещё висела
   в топбаре — шапка успевала раскрыться и «дёрнуться». */
document.addEventListener('grid-rendered', adjustMobileHead);
/* ── Ресайз и смена брейкпоинта: доводим шапку сразу, без ожидания рендера ── */
const mqMobileWeek = matchMedia('(max-width: 720px)');
const rehead = () => adjustMobileHead();
if (mqMobileWeek.addEventListener) mqMobileWeek.addEventListener('change', rehead);
let _reheadT = null;
window.addEventListener('resize', () => {
  clearTimeout(_reheadT);
  _reheadT = setTimeout(adjustMobileHead, 60);
});
/* ── Мобилка: полоски вместо квадратов; тап по полоске раскрывает квадраты ── */
const barsClosed = c => {
  const m = c.closest('.m-task');
  return !!m && !m.classList.contains('sq-open');
};
function openSqBars(cell) {
  const m = cell.closest('.m-task');
  if (!m) return;
  if (expandedSq && expandedSq !== cell.dataset.id) {
    document.querySelectorAll('.m-task.sq-open').forEach(x => x.classList.remove('sq-open'));
  }
  expandedSq = cell.dataset.id;
  m.classList.add('sq-open');
}
/* ── Мобилка: тап по ряду полосок (включая промежутки) раскрывает квадраты ── */
let sqClickBound = false;
function bindSqOpen() {
  if (sqClickBound) return;
  sqClickBound = true;
  document.addEventListener('click', e => {
    const row = e.target.closest('.p-mobile .l-row');
    if (!row) return;
    const mt = row.closest('.m-task');
    if (!mt || mt.classList.contains('sq-open')) return;
    const first = row.querySelector('.cell');
    if (first) openSqBars(first);
  });
}
function bindCell(c) {
  const id = c.dataset.id;
  const day = c.dataset.day;
  let lt = null, fired = false, sx = 0, sy = 0;
  const moved = e => Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8;
  c.addEventListener('pointerdown', e => {
    fired = false;
    sx = e.clientX;
    sy = e.clientY;
    if (barsClosed(c)) return; // долгий тап-перенос только на раскрытых квадратах
    lt = setTimeout(() => {
      fired = true;
      try { navigator.vibrate(10); } catch {}
      const task = getTask(id);
      if (task) postponeFrom(id, day).then(renderAll);
    }, 550);
  });
  c.addEventListener('pointermove', e => {
    if (lt && moved(e)) {
      clearTimeout(lt);
      lt = null;
    }
  });
  c.addEventListener('pointerup', e => {
    if (lt) {
      clearTimeout(lt);
      lt = null;
    }
    if (fired) return;
    if (moved(e)) return;
    if (barsClosed(c)) return; // раскрытие — через делегированный click
    if (getTask(id)) openCellMenu(c, id, day);
  });
  c.addEventListener('pointercancel', () => {
    if (lt) {
      clearTimeout(lt);
      lt = null;
    }
  });
  c.addEventListener('contextmenu', e => e.preventDefault());
}
/* ── Мобилка: любой скролл ленты плавно схлопывает квадраты в полоски ── */
(function bindBarsCloseOnScroll() {
  const app = $('app');
  if (!app) return;
  app.addEventListener('scroll', () => {
    if (!expandedSq && !document.querySelector('.m-task.sq-open')) return;
    expandedSq = null;
    document.querySelectorAll('.m-task.sq-open').forEach(x => x.classList.remove('sq-open'));
  }, { passive: true });
})();
(function bindGridSwipe() {
  let sx = 0, sy = 0, active = false;
  const el = $('grid');
  if (!el) return;
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('button') || e.target.closest('.r-row') || e.target.closest('.pane-move-handle')) {
      active = false;
      return;
    }
    active = true;
    sx = e.clientX;
    sy = e.clientY;
  });
  el.addEventListener('pointerup', e => {
    if (!active) return;
    active = false;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 50) {
      swiped = true;
      collapseRevealed();
      shiftWeek(dx < 0 ? 1 : -1);
      setTimeout(() => { swiped = false; }, 60);
    }
  });
})();
let revealedRow = null;
function collapseRevealed() {
  if (revealedRow) {
    revealedRow.classList.remove('rev-done', 'rev-move');
    revealedRow.style.transform = '';
    revealedRow.style.setProperty('--sw', '0');
    revealedRow = null;
  }
}
/* ── Свайпы ──
   • плашка действия проявляется пропорционально сдвигу (--sw: 0…1);
   • не дотянул до порога — строка пружинит обратно, плашка гаснет
     (раньше она залипала в состоянии rev-*, пока не ткнёшь мимо);
   • на пороге — тактильный отклик, чтобы не смотреть на экран;
   • сработало — короткая анимация подтверждения, потом перерисовка. */
const SW_TRIGGER = 88;   // порог срабатывания
const SW_MAX = 130;       // предел сдвига
function swSet(row, dx) {
  row.style.transform = dx ? `translateX(${dx}px)` : '';
  row.style.setProperty('--sw', Math.min(1, Math.abs(dx) / SW_TRIGGER).toFixed(3));
}
function swSpringBack(row) {
  const from = row.style.transform || 'translateX(0px)';
  row.style.transform = '';
  row.style.setProperty('--sw', '0');
  if (!row.animate) return;
  row.animate(
    [{ transform: from }, { transform: 'translateX(0)' }],
    { duration: 260, easing: 'cubic-bezier(.22,1.1,.36,1)' }
  );
}
function swCommit(row, dir, done) {
  const off = dir > 0 ? 26 : -26;
  if (!row.animate) { done(); return; }
  const a = row.animate(
    [{ transform: row.style.transform || 'translateX(0)' },
     { transform: `translateX(${off}px)`, offset: .45 },
     { transform: 'translateX(0)' }],
    { duration: 280, easing: 'cubic-bezier(.32,.72,.28,1)' }
  );
  row.style.transform = '';
  a.onfinish = a.oncancel = () => { row.style.setProperty('--sw', '0'); done(); };
}
function bindRowGestures(row, acts) {
  let sx = 0, sy = 0, dx = 0, dragging = false, longTimer = null, fired = false, armed = 0;
  row.style.setProperty('--sw', '0');
  row.addEventListener('contextmenu', e => e.preventDefault());
  row.querySelectorAll('.swipe-hint').forEach(h => {
    h.onclick = e => {
      e.stopPropagation();
      collapseRevealed();
      if (h.classList.contains('hint-done')) acts.onRight();
      else acts.onLeft();
    };
  });
  row.addEventListener('pointerdown', e => {
    if (e.target.closest('button') || e.target.closest('.sub-panel')) return;
    collapseRevealed();
    sx = e.clientX;
    sy = e.clientY;
    dx = 0;
    armed = 0;
    dragging = false;
    fired = false;
    longTimer = setTimeout(() => {
      longTimer = null;
      if (!dragging) {
        fired = true;
        try { navigator.vibrate(10); } catch {}
        acts.onLong();
      }
    }, 550);
  });
  row.addEventListener('pointermove', e => {
    if (!longTimer && !dragging) return;
    const ddx = e.clientX - sx;
    const ddy = e.clientY - sy;
    if (!dragging) {
      if (Math.abs(ddx) > 8 && Math.abs(ddx) > Math.abs(ddy)) {
        dragging = true;
        if (longTimer) { clearTimeout(longTimer); longTimer = null; }
        row.classList.add('swiping');
        /* пока тянем строку — лента под пальцем не скроллится */
        document.body.classList.add('row-swiping');
      } else if (Math.abs(ddy) > 8) {
        if (longTimer) { clearTimeout(longTimer); longTimer = null; }
        return;
      }
    }
    if (dragging) {
      const s = Math.sign(ddx);
      const a = Math.abs(ddx);
      /* за порогом ход тяжелеет — палец «чувствует» край */
      dx = s * Math.min(SW_MAX, a <= SW_TRIGGER ? a : SW_TRIGGER + (a - SW_TRIGGER) * 0.3);
      swSet(row, dx);
      row.classList.toggle('to-done', dx > 10);
      row.classList.toggle('to-move', dx < -10);
      const nowArmed = Math.abs(dx) >= SW_TRIGGER ? Math.sign(dx) : 0;
      if (nowArmed !== armed) {
        armed = nowArmed;
        row.classList.toggle('sw-armed', !!armed);
        if (armed) { try { navigator.vibrate(12); } catch {} }
      }
    }
  });
  const end = () => {
    if (longTimer) { clearTimeout(longTimer); longTimer = null; }
    document.body.classList.remove('row-swiping');
    if (dragging) {
      row.classList.remove('swiping', 'sw-armed');
      const d = dx;
      dragging = false;
      dx = 0;
      if (d >= SW_TRIGGER) {
        fired = true;
        swCommit(row, 1, () => {
          row.classList.remove('to-done', 'to-move');
          acts.onRight();
        });
        return;
      }
      if (d <= -SW_TRIGGER) {
        fired = true;
        swCommit(row, -1, () => {
          row.classList.remove('to-done', 'to-move');
          acts.onLeft();
        });
        return;
      }
      /* не дотянул — плашка уезжает вместе со строкой, ничего не залипает */
      if (Math.abs(d) > 2) fired = true;
      row.classList.remove('to-done', 'to-move');
      swSpringBack(row);
    }
    dragging = false;
    dx = 0;
  };
  row.addEventListener('pointerup', e => {
    end();
    const tx = Math.abs(e.clientX - sx);
    const ty = Math.abs(e.clientY - sy);
    if (!fired && !e.target.closest('button') && !e.target.closest('.sub-panel') && tx <= 8 && ty <= 8) {
      acts.onTap();
    }
  });
  row.addEventListener('pointercancel', end);
}
export const dayOpen = () => {
  const el = document.getElementById('daySheet');
  return el && el.classList.contains('open');
};
export function openDay(day) {
  state.day = day;
  const el = document.getElementById('daySheet');
  if (el) el.classList.add('open');
  refreshBackdrop();
  renderDaySheet();
}
export function closeDay() {
  const el = document.getElementById('daySheet');
  if (el) {
    el.classList.remove('open', 'drag');
    el.style.transform = '';
  }
  refreshBackdrop();
}
function dayTaskHTML(t, day) {
  const st = (t.days || {})[day] || 'todo';
  const pp = st === 'postponed' ? ((t.days || {})[addDays(day, 1)] === 'postponed' ? ' pp-dash' : ' pp-arrow') : '';
  const run = (hasWidget('focus') && tm.activeFor(t.id)) ? ' running' : '';
  const hasSub = (t.subtasks || []).length > 0;
  const sub = (hasSub && expandedSub === t.id) ? subPanelHTML(t) : '';
  const doneClass = isDone(t) ? ' task-done' : '';
  return `<li class="task m-${t.mode} st-${st}${run}${doneClass}" data-id="${esc(t.id)}">
    <button type="button" class="status${pp}"></button>
    ${indHTML(t)}
    <div class="t-body">
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-meta">${metaHTML(t) ? metaHTML(t) + ' · ' : ''}${TYPE_LABEL[t.type] || 'Задача'}${t.blockStart ? ` · ⏰ ${t.blockStart}–${blockEnd(t)}` : ''}</div>
    </div>
    ${sub}
  </li>`;
}
export function renderDaySheet() {
  const day = state.day;
  const titleEl = $('daySheetTitle');
  if (titleEl) {
    titleEl.textContent = `${DAYS_FULL[(parseISO(day).getDay() + 6) % 7]}, ${fmtD(day)}${day === today() ? ' · сегодня' : ''}`;
  }
  const list = tasksForDay(day);
  const active = list.filter(t => !isDone(t));
  const done = list.filter(t => isDone(t));
  const blocked = active.filter(t => t.blockStart).sort((a, b) => a.blockStart.localeCompare(b.blockStart));
  const restActive = active.filter(t => !t.blockStart);
  let html = '';
  if (blocked.length) {
    html += '<li class="grp">Тайм-блоки</li>' + blocked.map(t => dayTaskHTML(t, day)).join('');
  }
  if (restActive.length) {
    if (blocked.length) {
      html += '<li class="grp">Задачи</li>';
    } else {
      html += '<li class="grp">Запланировано</li>';
    }
    html += restActive.map(t => dayTaskHTML(t, day)).join('');
  }
  if (done.length) {
    html += '<li class="grp grp-done">Выполнено</li>';
    html += done.map(t => dayTaskHTML(t, day)).join('');
  }
  const listEl = $('daySheetList');
  const emptyEl = $('daySheetEmpty');
  if (listEl) listEl.innerHTML = html;
  if (emptyEl) emptyEl.hidden = list.length > 0;
  if (listEl) bindSub();
  if (listEl) {
    listEl.querySelectorAll('.task').forEach(row => {
      const id = row.dataset.id;
      const t = () => getTask(id);
      const cur = () => {
        const task = t();
        return task ? (task.days || {})[day] : null;
      };
      const statusBtn = row.querySelector('.status');
      if (statusBtn) {
        statusBtn.onclick = e => {
          e.stopPropagation();
          openCellMenu(e.currentTarget, id, day);
        };
      }
      bindRowGestures(row, {
        onTap: () => {
          if (fc.tryChoose(id)) return;
          const task = t();
          if (task) openSheet(task);
        },
        onRight: () => {
          const c = cur();
          if (c !== null) setEntry(id, day, c === 'done' ? 'todo' : 'done').then(renderAll);
        },
        onLeft: () => {
          const task = t();
          if (task) postponeFrom(id, day).then(renderAll);
        },
        onLong: () => {
          if (confirm('Удалить задачу?')) {
            removeTask(id).then(renderAll);
          }
        }
      });
    });
  }
  const dayCloseBtn = document.getElementById('dayClose');
  if (dayCloseBtn) dayCloseBtn.onclick = closeDay;
}
/* ── Панель заметок: синхронно с сеткой ── */
function renderNotesPanelSync() {
  const panel = document.getElementById('notesPanel');
  if (!panel) return;
  setWeekStart(state.weekStart);
  renderNotesPanel(panel);
}
export function renderAll() {
  closeCellMenu();
  collapseRevealed();
  document.documentElement.dataset.mode = state.mode;
  const { full, short } = weekRangeLabels();
  const wl = $('weekLabel');
  if (wl) {
    wl.innerHTML = `<span class="wl-num">Неделя ${isoWeek(state.weekStart)} · </span><span class="wl-full">${full}</span><span class="wl-short">${short}</span>`;
  }
  renderModes();
  renderGrid();
  renderNotesPanelSync();
  if (dayOpen()) renderDaySheet();
  document.dispatchEvent(new CustomEvent('grid-rendered'));
}
/* ── Лёгкое обновление «бегущих» строк без перерендера (тик таймера) ── */
export function refreshRunning() {
  const act = tm.getActive();
  const id = act ? act.taskId : null;
  const on = !!id && (state.widgets || []).includes('focus');
  document.querySelectorAll('.r-row, .task').forEach(row => {
    row.classList.toggle('running', on && row.dataset.id === id);
  });
}
