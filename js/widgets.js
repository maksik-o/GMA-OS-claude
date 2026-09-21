import { state, mondayOf, today } from './store.js';
import { renderAll, openDay } from './week.js';
import { calTitle, createCalDrum } from './cal.js';
import { renderFinanceWidget, financeSubscribe } from './finance.js';

const $ = id => document.getElementById(id);
const WIDGETS_KEY = 'rl_widgets_v1';
const DOCK_KEY = 'rl_dock_v1';
const HANDLE = id => `<svg class="dock-handle" data-dock="${id}" viewBox="0 0 32 32" aria-hidden="true"><path d="M2 22 A20 20 0 0 1 12 4.68" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`;
export const WIDGETS = [
  { id: 'notes', label: 'Заметки', icon: '📝' },
  { id: 'focus', label: 'Фокусировка', icon: '🎯' },
  { id: 'calendar', label: 'Календарь', icon: '📅' },
  { id: 'finance', label: 'Финансы', icon: '💰' },
];
/* Правила расстановки:
   SNAP_EDGE = 50px — магнит к краю страницы и к сторонам блоков;
   YIELD_DIST = 30px — сдвиги-«уступания» включаются заранее;
   INSTALL_MS — длительность плавной установки. */
const SNAP_EDGE = 50;
const YIELD_DIST = 30;
const INSTALL_MS = 430;
let dockState = {
  notes: { row: 'bottom', align: 'stretch', order: 0 },
  focus: { row: 'bottom', align: 'right', order: 1 },
  calendar: { row: 'top', align: 'left', order: 0 },
  finance: { row: 'top', align: 'right', order: 1 },
};
let _storage = null, _panel = null, _calDrum = null, _mini = null;
export const isPlaced = id => (state.widgets || []).includes(id);
const saveWidgets = () => { try { localStorage.setItem(WIDGETS_KEY, JSON.stringify(state.widgets)); } catch (e) {} };
const saveDock = () => { try { localStorage.setItem(DOCK_KEY, JSON.stringify(dockState)); } catch (e) {} };
const idOf = el => el.id === 'notesPanel' ? 'notes' : el.id === 'focusPanel' ? 'focus'
  : el.id === 'calPanel' ? 'calendar' : el.id === 'finPanel' ? 'finance' : null;
const panelEl = id => id === 'calendar' ? ensureCalPanel()
  : id === 'finance' ? ensureFinPanel()
  : $(id === 'notes' ? 'notesPanel' : 'focusPanel');
/* Заметки ВСЕГДА растянуты на всю доступную длину: сохранённый align игнорируем */
const alignOf = k => {
  const id = idOf(k);
  if (id === 'notes') return 'stretch';
  return (dockState[id] || {}).align || 'left';
};
function ensureStorage() {
  if (_storage) return _storage;
  _storage = document.createElement('div');
  _storage.id = 'widgetStorage';
  _storage.style.display = 'none';
  document.body.appendChild(_storage);
  return _storage;
}
/* ── Реальные кромки блока (без учёта сдвига-уступания) ── */
function baseRect(k) {
  const r = k.getBoundingClientRect();
  let x = r.left;
  if (k.classList.contains('yield-right')) x -= 18;
  else if (k.classList.contains('yield-left')) x += 18;
  return { left: x, right: x + r.width, width: r.width, centerX: x + r.width / 2 };
}
const rowPanels = (rowEl, exclude) =>
  [...rowEl.children].filter(k => k.classList.contains('dock-panel') && k !== exclude);
/* ── Куда целится перетаскиваемый блок ── */
function computeDrop(rowEl, x, me) {
  const kids = rowPanels(rowEl, me);
  const vr = rowEl.getBoundingClientRect();
  if (x - vr.left <= SNAP_EDGE) return { type: 'edge', side: 'left' };
  if (vr.right - x <= SNAP_EDGE) return { type: 'edge', side: 'right' };
  let best = null;
  for (const k of kids) {
    const r = baseRect(k);
    const dl = Math.abs(x - r.left);
    const dr = Math.abs(x - r.right);
    if (dl <= SNAP_EDGE && (!best || dl < best.d)) best = { type: 'side', panel: k, side: 'left', d: dl };
    if (dr <= SNAP_EDGE && (!best || dr < best.d)) best = { type: 'side', panel: k, side: 'right', d: dr };
  }
  if (best) return best;
  return { type: 'free', x: x - vr.left };
}
/* ── Сдвиги-«уступания» между блоками ряда ── */
function clearYields() {
  document.querySelectorAll('.yield-left, .yield-right').forEach(el => el.classList.remove('yield-left', 'yield-right'));
}
function updateYields(rowEl, x, me) {
  clearYields();
  const kids = rowPanels(rowEl, me);
  if (!kids.length) return;
  for (const k of kids) {
    const r = baseRect(k);
    if (Math.abs(x - r.left) <= YIELD_DIST) { k.classList.add('yield-right'); return; }
    if (Math.abs(x - r.right) <= YIELD_DIST) { k.classList.add('yield-left'); return; }
  }
  for (let i = 0; i < kids.length - 1; i++) {
    const a = baseRect(kids[i]), b = baseRect(kids[i + 1]);
    if (x > a.right && x < b.left) {
      kids[i].classList.add('yield-left');
      kids[i + 1].classList.add('yield-right');
      return;
    }
  }
}
/* ── Раскладка дока: группы по align, заметки тянутся ── */
function applyDockLayout() {
  const top = $('dockTop'), bottom = $('dockBottom');
  if (!top || !bottom) return;
  for (const w of WIDGETS) {
    const el = panelEl(w.id);
    if (!el) continue;
    if (isPlaced(w.id)) {
      const pos = dockState[w.id] || { row: 'bottom', align: 'left', order: 0 };
      (pos.row === 'top' ? top : bottom).appendChild(el);
    } else ensureStorage().appendChild(el);
  }
  for (const rowEl of [top, bottom]) {
    const kids = rowPanels(rowEl, null);
    kids.sort((a, b) => ((dockState[idOf(a)] || {}).order || 0) - ((dockState[idOf(b)] || {}).order || 0));
    kids.forEach(k => rowEl.appendChild(k));
    let i = 0;
    while (i < kids.length) {
      const a = alignOf(kids[i]);
      let j = i;
      while (j + 1 < kids.length && alignOf(kids[j + 1]) === a) j++;
      const group = kids.slice(i, j + 1);
      group.forEach((k, gi) => {
        const first = gi === 0, last = gi === group.length - 1;
        if (a === 'stretch') {
          k.style.flex = '1 1 320px';
          k.style.marginLeft = '0';
          k.style.marginRight = '0';
        } else if (a === 'custom') {
          k.style.flex = 'none';
          k.style.marginLeft = ((dockState[idOf(k)] || {}).x || 0) + 'px';
          k.style.marginRight = 'auto';
        } else if (a === 'left') {
          k.style.flex = 'none';
          k.style.marginLeft = '0';
          k.style.marginRight = last ? 'auto' : '0';
        } else if (a === 'right') {
          k.style.flex = 'none';
          k.style.marginLeft = first ? 'auto' : '0';
          k.style.marginRight = '0';
        } else { /* center */
          k.style.flex = 'none';
          k.style.marginLeft = first ? 'auto' : '0';
          k.style.marginRight = last ? 'auto' : '0';
        }
      });
      i = j + 1;
    }
    rowEl.dataset.mode = kids.length ? 'shared' : 'empty';
  }
  renderCalWidget();
}
/* ── Бросок: ряд + место по магнитам, свободное место — по ручке ── */
function applyDrop(rowEl, x, me, grabDX) {
  const kids = rowPanels(rowEl, me);
  const drop = computeDrop(rowEl, x, me);
  let index, align, xPos = null;
  if (drop.type === 'edge') {
    index = drop.side === 'left' ? 0 : kids.length;
    align = drop.side;
  } else if (drop.type === 'side') {
    const idx = kids.indexOf(drop.panel);
    index = drop.side === 'left' ? idx : idx + 1;
    const pa = alignOf(drop.panel);
    align = pa === 'stretch' ? drop.side : pa;
  } else {
    const st = kids.find(k => alignOf(k) === 'stretch');
    if (idOf(me) === 'notes' && !st) {
      index = kids.length;
      align = 'stretch';
    } else if (st) {
      const r = baseRect(st);
      const side = x < r.centerX ? 'left' : 'right';
      const idx = kids.indexOf(st);
      index = side === 'left' ? idx : idx + 1;
      align = side;
    } else {
      index = kids.filter(k => x > baseRect(k).centerX).length;
      align = 'custom';
      /* блок падает туда, где отпущен: точка захвата = ручка */
      xPos = Math.max(0, Math.round(x - (grabDX ?? me.offsetWidth / 2) - rowEl.getBoundingClientRect().left));
    }
  }
  /* Заметки не бывают справа/квадратом — только растяжение на всю длину */
  if (idOf(me) === 'notes') align = 'stretch';
  const arr = kids.slice();
  arr.splice(Math.min(index, arr.length), 0, me);
  arr.forEach((k, ii) => {
    const kp = dockState[idOf(k)] || (dockState[idOf(k)] = {});
    kp.order = ii * 10;
  });
  const pos = dockState[idOf(me)] || (dockState[idOf(me)] = {});
  pos.row = rowEl === $('dockTop') ? 'top' : 'bottom';
  pos.align = align;
  if (align === 'custom') pos.x = xPos;
  saveDock();
  applyDockLayout();
}
/* ── Средний блок между доками: сетка недели, а если она скрыта —
   панель канбана. Без этого скрытый #grid давал нулевой rect и
   все броски уходили вниз. ── */
function midBlock() {
  const g = $('grid');
  if (g && !g.hidden && g.offsetHeight) return g;
  const k = $('kanbanPanel');
  if (k && !k.hidden && k.offsetHeight) return k;
  return null;
}
function clearMidYields() {
  const g = $('grid'), k = $('kanbanPanel');
  if (g) g.classList.remove('grid-yield-top', 'grid-yield-bottom');
  if (k) k.classList.remove('kb-yield-top', 'kb-yield-bottom');
}
function dockRowAt(x, y) {
  const mid = midBlock();
  if (!mid) return null;
  const r = mid.getBoundingClientRect();
  if (y < r.top - 8) return $('dockTop');
  if (y > r.bottom + 8) return $('dockBottom');
  return null;
}
/* ── Мини-пилюля и зона «в хранилище» ── */
const inRect = (x, y, r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
function unplaceZoneRect() {
  const b = $('widgetsBtn');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { left: r.left - 186, top: r.top - 10, right: r.right + 8, bottom: r.bottom + 10 };
}
function ensureMini() {
  if (_mini) return _mini;
  _mini = document.createElement('div');
  _mini.className = 'widget-ghost';
  _mini.style.display = 'none';
  document.body.appendChild(_mini);
  return _mini;
}
function showMini(which, x, y) {
  const def = WIDGETS.find(w => w.id === which);
  if (!def) return;
  const m = ensureMini();
  m.innerHTML = `<span style="font-size:22px">${def.icon}</span><span>${def.label}</span>`;
  m.style.display = 'flex';
  m.style.left = x + 'px';
  m.style.top = y + 'px';
}
function hideMini() { if (_mini) _mini.style.display = 'none'; }
/* ── FLIP: плавная установка + одновременный разъезд/сужение остальных ── */
function flipInstall(snaps) {
  requestAnimationFrame(() => {
    snaps.forEach((s, k) => {
      if (!k.isConnected) return;
      const r = k.getBoundingClientRect();
      const dl = s.left - r.left, dt = s.top - r.top;
      if (Math.abs(dl) < 1 && Math.abs(dt) < 1 && Math.abs(s.width - r.width) < 1) return;
      k.style.transition = 'none';
      const a = k.animate(
        [{ transform: `translate(${dl}px, ${dt}px)`, width: s.width + 'px' },
         { transform: 'translate(0, 0)', width: r.width + 'px' }],
        { duration: INSTALL_MS, easing: 'cubic-bezier(.32, .72, .28, 1)' }
      );
      a.onfinish = a.oncancel = () => { k.style.transition = ''; };
    });
  });
}
/* ── Единая сессия переноса (из сетки и из меню) ── */
const EDGE_ZONE = 110;   // зона у краёв экрана, где включается автоскролл
const EDGE_SPEED = 20;   // px за кадр на максимуме
function startSession(which, panel, ev, mode) {
  const sx = ev.clientX, sy = ev.clientY;
  let grabDX, grabDY;
  if (mode === 'dock') {
    const pr = panel.getBoundingClientRect();
    grabDX = sx - pr.left;   // точка захвата = ручка, а не центр
    grabDY = sy - pr.top;
  } else {
    grabDX = 16; grabDY = 16; // ручка панели (её центр ~16,16)
  }
  const app = $('app');
  const ctx = {
    which, panel, mode, sx, sy, grabDX, grabDY,
    started: false, overBtn: false, hoverRow: null,
    app, scroll0: app ? app.scrollTop : 0,
    lastX: sx, lastY: sy, raf: null,
  };
  /* Пока тащим панель, страница не скроллится под пальцем:
     touch-action на ручке + глушим touchmove всей сессии. */
  const blockTouch = e => { if (e.cancelable) e.preventDefault(); };
  document.addEventListener('touchmove', blockTouch, { passive: false });
  document.body.classList.add('dock-grab');
  const move = e => moveDrag(e, ctx);
  const up = e => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    document.removeEventListener('touchmove', blockTouch);
    document.body.classList.remove('dock-grab');
    stopAutoScroll(ctx);
    finishDrag(e, ctx);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}
/* ── Автоскролл: панель остаётся под пальцем, контент едет под ней ── */
function stopAutoScroll(ctx) {
  if (ctx.raf) { cancelAnimationFrame(ctx.raf); ctx.raf = null; }
}
function autoScrollTick(ctx) {
  ctx.raf = null;
  const app = ctx.app;
  if (!ctx.started || !app) return;
  const h = innerHeight;
  const y = ctx.lastY;
  let v = 0;
  if (ctx.overBtn) { ctx.raf = requestAnimationFrame(() => autoScrollTick(ctx)); return; }
  if (y < EDGE_ZONE) v = -EDGE_SPEED * Math.min(1, (EDGE_ZONE - y) / EDGE_ZONE);
  else if (y > h - EDGE_ZONE) v = EDGE_SPEED * Math.min(1, (y - (h - EDGE_ZONE)) / EDGE_ZONE);
  if (v) {
    const max = Math.max(0, app.scrollHeight - app.clientHeight);
    const next = Math.max(0, Math.min(max, app.scrollTop + v));
    if (next !== app.scrollTop) {
      app.scrollTop = next;
      updateDrag(ctx); // пересчитать положение панели и подсветки под новый скролл
    }
  }
  ctx.raf = requestAnimationFrame(() => autoScrollTick(ctx));
}
function moveDrag(ev, ctx) {
  ctx.lastX = ev.clientX;
  ctx.lastY = ev.clientY;
  updateDrag(ctx);
}
function updateDrag(ctx) {
  const x = ctx.lastX, y = ctx.lastY;
  const dx = x - ctx.sx, dy = y - ctx.sy;
  if (!ctx.started) {
    const thr = ctx.mode === 'menu' ? 20 : 12; // из меню пилюля → блок через 20px
    if (Math.hypot(dx, dy) > thr) {
      ctx.started = true;
      document.body.classList.add('dock-drag');
      ctx.panel.classList.add('dock-dragging');
      if (ctx.mode === 'menu') {
        hideMini();
        const p = ctx.panel;
        document.body.appendChild(p); // из хранилища
        p.style.position = 'fixed';
        p.style.zIndex = '60';
        if (ctx.which === 'notes') p.style.width = '340px';
        p.style.left = (x - ctx.grabDX) + 'px';
        p.style.top = (y - ctx.grabDY) + 'px';
        /* трансформация из пилюли в нормальный блок */
        p.animate([{ transform: 'scale(.6)', opacity: .4 }, { transform: 'scale(1)', opacity: 1 }],
          { duration: 260, easing: 'cubic-bezier(.32, 1.18, .28, 1)' });
      }
      if (!ctx.raf) autoScrollTick(ctx);
    }
  }
  if (!ctx.started) {
    if (ctx.mode === 'menu') showMini(ctx.which, x, y);
    return;
  }
  if (ctx.mode === 'dock') {
    /* панель лежит в потоке внутри #app: чтобы не «уплыть» при автоскролле,
       к смещению пальца добавляем пройденный скролл */
    const sd = ctx.app ? ctx.app.scrollTop - ctx.scroll0 : 0;
    ctx.panel.style.transform = `translate(${dx}px, ${dy + sd}px)`;
  } else {
    ctx.panel.style.left = (x - ctx.grabDX) + 'px';
    ctx.panel.style.top = (y - ctx.grabDY) + 'px';
  }
  /* зона «в хранилище» */
  const z = unplaceZoneRect();
  const over = !!z && inRect(x, y, z);
  if (over !== ctx.overBtn) {
    ctx.overBtn = over;
    const b = $('widgetsBtn');
    if (b) b.classList.toggle('drop-hover', over);
    if (over) {
      ctx.panel.style.visibility = 'hidden';
      showMini(ctx.which, x, y);
      clearYields();
      clearMidYields();
    } else {
      ctx.panel.style.visibility = '';
      hideMini();
    }
  }
  if (over) { showMini(ctx.which, x, y); return; }
  /* ряд вставки + сдвиги между блоками */
  ctx.hoverRow = dockRowAt(x, y);
  /* Сдвиг ВНИЗ (освободить верх) — как раньше, всегда.
     Сдвиг ВВЕРХ — только если вверху есть блоки;
     если вверху пусто, панели недели/задач вверх не едут. */
  const mid = midBlock();
  if (mid) {
    const gr = mid.getBoundingClientRect();
    const near = x > gr.left - 30 && x < gr.right + 30 && y > gr.top - 30 && y < gr.bottom + 30;
    if (near) {
      const topHalf = y < gr.top + gr.height / 2;
      ctx.hoverRow = topHalf ? $('dockTop') : $('dockBottom');
      const topHas = rowPanels($('dockTop'), ctx.panel).length > 0;
      const clsTop = mid.id === 'grid' ? 'grid-yield-top' : 'kb-yield-top';
      const clsBottom = mid.id === 'grid' ? 'grid-yield-bottom' : 'kb-yield-bottom';
      mid.classList.toggle(clsTop, topHalf);
      mid.classList.toggle(clsBottom, !topHalf && topHas);
    } else {
      clearMidYields();
    }
  } else {
    clearMidYields();
  }
  if (ctx.hoverRow) updateYields(ctx.hoverRow, x, ctx.panel);
  else clearYields();
}
function finishDrag(ev, ctx) {
  document.body.classList.remove('dock-drag');
  const b = $('widgetsBtn');
  if (b) b.classList.remove('drop-hover');
  hideMini();
  clearYields();
  clearMidYields();
  const visRect = ctx.panel.getBoundingClientRect(); // где отпустили
  ctx.panel.classList.remove('dock-dragging');
  ctx.panel.style.transform = '';
  ctx.panel.style.visibility = '';
  if (ctx.mode === 'menu') {
    ctx.panel.style.position = '';
    ctx.panel.style.zIndex = '';
    ctx.panel.style.left = '';
    ctx.panel.style.top = '';
    ctx.panel.style.width = '';
  }
  if (!ctx.started) {
    if (ctx.mode === 'menu') ensureStorage().appendChild(ctx.panel);
    return;
  }
  if (ctx.overBtn) {
    if (ctx.mode === 'dock') unplace(ctx.which);
    else ensureStorage().appendChild(ctx.panel);
    return;
  }
  if (!ctx.hoverRow) {
    if (ctx.mode === 'menu') ensureStorage().appendChild(ctx.panel);
    return; // отпустил вне рядов — блок возвращается
  }
  if (ctx.mode === 'menu' && !isPlaced(ctx.which)) {
    state.widgets = Array.isArray(state.widgets) ? state.widgets : [];
    state.widgets.push(ctx.which);
    saveWidgets();
  }
  /* снапшоты всех панелей ДО перестановки — для одновременной анимации */
  const snaps = new Map();
  rowPanels($('dockTop'), null).concat(rowPanels($('dockBottom'), null)).forEach(k => {
    const r = k.getBoundingClientRect();
    snaps.set(k, { left: r.left, top: r.top, width: r.width });
  });
  snaps.set(ctx.panel, { left: visRect.left, top: visRect.top, width: visRect.width });
  applyDrop(ctx.hoverRow, ctx.lastX, ctx.panel, ctx.grabDX);
  renderWidgetsPanel();
  flipInstall(snaps);
}
/* ── Перенос панели из сетки за ручку ── */
function bindDockDrag() {
  document.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.dock-handle[data-dock]');
    if (!handle) return;
    const which = handle.dataset.dock;
    const panel = handle.closest('.dock-panel');
    if (!panel) return;
    e.preventDefault();
    startSession(which, panel, e, 'dock');
  });
}
/* ── Перетаскивание из меню виджетов (удержание плитки) ── */
function startPlacement(id, x, y) {
  showMini(id, x, y);
  startSession(id, panelEl(id), { clientX: x, clientY: y }, 'menu');
}
/* ── Виджет календаря: барабан, название месяца только в шапке ── */
function ensureCalPanel() {
  let p = $('calPanel');
  if (p) return p;
  p = document.createElement('section');
  p.id = 'calPanel';
  p.className = 'dock-panel calendar-panel glass';
  p.innerHTML = `${HANDLE('calendar')}<div class="cal-w-head"><span class="cal-w-title"></span></div><div class="cal-w-week"><span></span>${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((w, i) => `<span class="${i >= 5 ? 'we' : ''}">${w}</span>`).join('')}</div><div class="cal-w-drum"></div>`;
  document.body.appendChild(p);
  _calDrum = createCalDrum(p.querySelector('.cal-w-drum'), {
    cellH: 32,
    week: true,
    onWeek: ws => { state.weekStart = ws; renderAll(); renderCalWidget(); },
    onDay: d => { state.weekStart = mondayOf(d); renderAll(); renderCalWidget(); openDay(d); },
    onCenter: a => { const t = p.querySelector('.cal-w-title'); if (t) t.textContent = calTitle(a); },
  });
  const t = p.querySelector('.cal-w-title');
  if (t) t.textContent = calTitle(_calDrum.currentMonth());
  if (t) t.onclick = () => {
    state.weekStart = mondayOf(today());
    renderAll();
    if (_calDrum) { _calDrum.goCurrent(); _calDrum.refresh(); }
  };
  return p;
}
function ensureFinPanel() {
  let p = $('finPanel');
  if (p) return p;
  p = document.createElement('section');
  p.id = 'finPanel';
  p.className = 'dock-panel finance-panel glass';
  p.innerHTML = `${HANDLE('finance')}<div class="fw-body"></div>`;
  document.body.appendChild(p);
  renderFinWidget();
  return p;
}
export function renderFinWidget() {
  const p = $('finPanel');
  if (!p) return;
  renderFinanceWidget(p.querySelector('.fw-body'));
}
export function renderCalWidget() {
  const p = $('calPanel');
  if (!p || !_calDrum) return;
  const t = p.querySelector('.cal-w-title');
  if (t) t.textContent = calTitle(_calDrum.currentMonth());
  _calDrum.refresh();
}
/* ── Панель виджетов ── */
function ensureWidgetsPanel() {
  if (_panel) return _panel;
  _panel = document.createElement('div');
  _panel.className = 'widgets-panel glass';
  _panel.innerHTML = `<div class="wp-head">Панель виджетов</div><div class="wp-tiles"></div><div class="wp-hint">Кликни по плитке — виджет встанет вниз. Удерживай плитку и отведи на 20px — блок выйдет из пилюли и полетит как обычный. Перетащи панель за ручку на пилюлю «＋ Панель виджетов» — она вернётся в хранилище.</div>`;
  document.body.appendChild(_panel);
  return _panel;
}
export function renderWidgetsPanel() {
  const tiles = ensureWidgetsPanel().querySelector('.wp-tiles');
  tiles.innerHTML = '';
  for (const w of WIDGETS) {
    const t = document.createElement('div');
    t.className = 'w-tile' + (isPlaced(w.id) ? ' placed' : '');
    t.innerHTML = `<span class="w-ico">${w.icon}</span><span class="w-label">${w.label}</span><span class="w-status">${isPlaced(w.id) ? 'установлен' : 'в хранилище'}</span>${isPlaced(w.id) ? '<button type="button" class="w-un" title="Убрать в хранилище">✕</button>' : ''}`;
    const un = t.querySelector('.w-un');
    if (un) un.onclick = e => { e.stopPropagation(); unplace(w.id); };
    bindTileHold(t, w.id);
    tiles.appendChild(t);
  }
}
export function openWidgetsPanel(btn) {
  renderWidgetsPanel();
  const p = _panel;
  /* body[data-font] задан через zoom: getBoundingClientRect/innerWidth
     живут в координатах вьюпорта, а style.left/top — в зумленных CSS-px */
  const z = parseFloat(getComputedStyle(document.body).zoom) || 1;
  p.style.right = 'auto';
  p.style.left = '-9999px';
  p.style.top = '0px';
  p.style.maxWidth = ((innerWidth - 16) / z) + 'px';
  p.style.maxHeight = ((innerHeight - 16) / z) + 'px';
  p.classList.add('open');
  const r = btn.getBoundingClientRect();
  const pw = p.offsetWidth * z;
  const ph = p.offsetHeight * z;
  let left = r.right - pw;                                   // прижимаем правым краем к кнопке
  left = Math.min(Math.max(8, left), Math.max(8, innerWidth - pw - 8));
  let top = r.bottom + 8;
  if (top + ph > innerHeight - 8) top = Math.max(8, innerHeight - ph - 8);
  p.style.left = (left / z) + 'px';
  p.style.top = (top / z) + 'px';
  setTimeout(() => {
    const close = e => {
      if (!p.contains(e.target) && !btn.contains(e.target)) { closeWidgetsPanel(); document.removeEventListener('pointerdown', close); }
    };
    document.addEventListener('pointerdown', close);
  }, 0);
}
export function closeWidgetsPanel() { if (_panel) _panel.classList.remove('open'); }
function bindTileHold(tile, id) {
  let t = null, started = false, sx = 0, sy = 0;
  tile.addEventListener('pointerdown', e => {
    if (e.target.closest('.w-un')) return;
    sx = e.clientX; sy = e.clientY; started = false;
    t = setTimeout(() => {
      started = true;
      closeWidgetsPanel();
      startPlacement(id, sx, sy);
    }, 350);
  });
  tile.addEventListener('pointermove', e => {
    if (started) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 6) { if (t) { clearTimeout(t); t = null; } }
  });
  tile.addEventListener('pointerup', () => {
    if (t) { clearTimeout(t); t = null; }
  });
}
export function unplace(id) {
  state.widgets = (state.widgets || []).filter(w => w !== id);
  saveWidgets();
  applyDockLayout();
  renderAll();
  renderWidgetsPanel();
}
export function widgetsInit() {
  if (!Array.isArray(state.widgets)) state.widgets = ['notes', 'focus'];
  try {
    const w = JSON.parse(localStorage.getItem(WIDGETS_KEY) || 'null');
    if (Array.isArray(w)) state.widgets = w;
    const d = JSON.parse(localStorage.getItem(DOCK_KEY) || 'null');
    if (d) dockState = Object.assign(dockState, d);
  } catch (e) {}
  ensureCalPanel();
  ensureFinPanel();
  applyDockLayout();
  bindDockDrag();
  /* Полоски у дней в виджете календаря обновляются СРАЗУ
     при любом изменении задач — без тапа по шапке календаря */
  document.addEventListener('grid-rendered', renderCalWidget);
  document.addEventListener('grid-rendered', renderFinWidget);
  financeSubscribe(renderFinWidget);
}
