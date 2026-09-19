/* ══════════════════════════════════════════════════════════════════
   Блок «Timeline» — задачи на временнóй сетке.

   Живёт на месте Running-list и канбана, переключается тем же
   селектором. Показывает 1, 3 или 7 дней вертикальными столбиками.
   Источник размещения — планы задачи (см. store.js): либо заданные
   вручную, либо выведенные из завершённых сессий фокусировки.
   ══════════════════════════════════════════════════════════════════ */
import {
  state, getTask, tasksForDay, visibleTasks, isDone, esc, createTask,
  today, addDays, parseISO, WEEKDAYS, MONTHS,
  plansForDay, setTaskPlan, hmToMin, minToHM,
  hapticLight, hapticMedium, subscribe,
} from './store.js';
import { openSheet } from './sheet.js';

const HOUR = 46;        // высота часа, px
const SNAP = 5;         // шаг привязки, мин
const MIN_LEN = 15;
const DAY_MIN = 24 * 60;

export const TL_RANGES = [
  { id: 1, label: '1 день' },
  { id: 3, label: '3 дня' },
  { id: 7, label: 'Неделя' },
];
let tlRange = 3;
/* Смещение первого показанного дня внутри недели из шапки (0 = пн).
   Таймлайн — это ещё один способ показать ТУ ЖЕ неделю, что
   Running-list и канбан, поэтому собственной «своей» даты у него нет:
   он всегда стоит на state.weekStart. */
let tlOffset = null;
let _panel = null;
let _scroll = null;
/* По умолчанию видно окно в 8 часов, а линия «сейчас» держится по
   центру: едет не линия по панели, а панель под линией. */
const WINDOW_H = 8;
let expanded = false;
let _recenter = null;
let _userScrolledAt = 0;
export const timelineExpanded = () => expanded;
export function toggleExpanded() {
  expanded = !expanded;
  renderTimeline(_panel);
}

const maxOffset = () => Math.max(0, 7 - tlRange);
function offset() {
  if (tlOffset == null) {
    const i = Math.round((parseISO(today()) - parseISO(state.weekStart)) / 86400000);
    tlOffset = (i >= 0 && i <= 6) ? i : 0;   // при открытии стоим на сегодня
  }
  return Math.max(0, Math.min(maxOffset(), tlOffset));
}
export const timelineRange = () => tlRange;
export function setTimelineRange(n) {
  tlRange = Number(n) || 1;
  tlOffset = Math.max(0, Math.min(maxOffset(), offset()));
  renderTimeline(_panel);
}
/* Дошли до края недели — переводим саму неделю, а не уезжаем из неё */
export function shiftTimeline(dir, shiftWeek) {
  const next = offset() + dir * tlRange;
  if (next > maxOffset()) {
    tlOffset = 0;
    if (shiftWeek) shiftWeek(1);
  } else if (next < 0) {
    tlOffset = maxOffset();
    if (shiftWeek) shiftWeek(-1);
  } else {
    tlOffset = next;
  }
  return () => renderTimeline(_panel);
}
const snap = m => Math.round(m / SNAP) * SNAP;

function days() {
  const start = addDays(state.weekStart, tlRange === 7 ? 0 : offset());
  return Array.from({ length: tlRange }, (_, i) => addDays(start, i));
}
export function timelineLabel() {
  const d = days();
  const a = d[0], b = d[d.length - 1];
  if (tlRange === 1) return `${+a.slice(8)} ${MONTHS[+a.slice(5, 7) - 1]}`;
  return `${+a.slice(8)} ${MONTHS[+a.slice(5, 7) - 1]} – ${+b.slice(8)} ${MONTHS[+b.slice(5, 7) - 1]}`;
}

/* Раскладка пересечений внутри одного дня: колонки, как в календаре */
function layout(items) {
  const sorted = items.slice().sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  let cluster = [], end = -1;
  const flush = () => {
    if (!cluster.length) return;
    const cols = [];
    for (const b of cluster) {
      let ci = cols.findIndex(c => c[c.length - 1].e <= b.s);
      if (ci < 0) { cols.push([b]); ci = cols.length - 1; }
      else cols[ci].push(b);
      b.col = ci;
    }
    cluster.forEach(b => { b.cols = cols.length; out.push(b); });
    cluster = [];
    end = -1;
  };
  for (const b of sorted) {
    if (cluster.length && b.s >= end) flush();
    cluster.push(b);
    end = Math.max(end, b.e);
  }
  flush();
  return out;
}

/* Задача попадает в день, если на этот день есть план — даже когда
   самого дня нет в её квадратах. Раньше бралось только tasksForDay,
   поэтому запланированные вручную задачи в таймлайн не попадали. */
function dayItems(day) {
  const items = [];
  const seen = new Set();
  const add = t => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const p of plansForDay(t, day)) {
      const s = hmToMin(p.start);
      const e = Math.max(s + MIN_LEN, hmToMin(p.end || p.start));
      items.push({ t, s, e: Math.min(DAY_MIN, e), auto: !!p.auto });
    }
  };
  for (const t of tasksForDay(day)) add(t);
  for (const t of visibleTasks()) {
    if (state.hideDone && isDone(t)) continue;
    if (plansForDay(t, day).length) add(t);
  }
  return layout(items);
}

export function renderTimeline(panel) {
  if (!panel) return;
  _panel = panel;
  const list = days();
  const t0 = today();
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  /* 25 меток: и 00:00 сверху, и 24:00 снизу. Верхняя и нижняя
     прижимаются к краю, иначе половина подписи уходит за границу. */
  const hours = Array.from({ length: 25 }, (_, h) => h);

  panel.innerHTML =
    '<div class="kb-head kb-head-hold">' +
      '<div class="kb-row">' +
        '<button type="button" class="kb-board-title" id="tlTitle" title="Выбор вида: Running-list / kanban / Timeline">Timeline</button>' +
        '<div class="kb-rangenav">' +
          '<button type="button" class="kb-arrow" id="tlPrev" title="Назад">‹</button>' +
          `<button type="button" class="kb-rangelabel" id="tlRangeChip" title="Диапазон таймлайна">${esc(timelineLabel())}</button>` +
          '<button type="button" class="kb-arrow" id="tlNext" title="Вперёд">›</button>' +
        '</div>' +
        '<div class="kb-right"></div>' +
      '</div>' +
    '</div>' +
    '<div class="tl-body">' +
      '<div class="tl-gutter">' +
        '<div class="tl-corner"></div>' +
        `<div class="tl-hours" style="height:${24 * HOUR + 1}px">` +
          hours.map(h => `<span class="${h === 0 ? 'first' : h === 24 ? 'last' : ''}" style="top:${h * HOUR}px">${String(h).padStart(2, '0')}:00</span>`).join('') +
        '</div>' +
      '</div>' +
      '<div class="tl-cols">' +
        list.map(d => {
          const items = dayItems(d);
          const wd = WEEKDAYS[(parseISO(d).getDay() + 6) % 7];
          return `<section class="tl-col${d === t0 ? ' today' : ''}" data-day="${d}">
            <header class="tl-colhead"><span class="tl-wd">${wd}</span><b>${+d.slice(8)}</b><i>${MONTHS[+d.slice(5, 7) - 1]}</i></header>
            <div class="tl-area" style="height:${24 * HOUR}px">
              ${hours.map(h => `<i class="tl-line" style="top:${h * HOUR}px"></i>${h < 24 ? `<i class="tl-line half" style="top:${h * HOUR + HOUR / 2}px"></i>` : ''}`).join('')}
              ${items.map(b => blockHTML(b, d)).join('')}
              ${d === t0 ? `<div class="tl-now" style="top:${(nowMin / 60) * HOUR}px"><i></i></div>` : ''}
            </div>
          </section>`;
        }).join('') +
      '</div>' +
    '</div>';

  panel.querySelectorAll('.tl-block').forEach(n => bindBlock(n));
  panel.querySelectorAll('.tl-area').forEach(a => bindArea(a));

  const body = panel.querySelector('.tl-body');
  panel.classList.toggle('tl-expanded', expanded);
  if (expanded) {
    body.style.maxHeight = '';
    if (_scroll != null) body.scrollTop = _scroll;
    else centerNow(body);
  } else {
    /* Окно на 8 часов: панель не растёт на весь экран и не мешает
       странице скроллиться. */
    body.style.maxHeight = (WINDOW_H * HOUR + 42) + 'px';
    centerNow(body);
  }
  body.addEventListener('scroll', () => {
    _scroll = body.scrollTop;
    _userScrolledAt = Date.now();
  }, { passive: true });
  clearInterval(_recenter);
  if (!expanded) {
    _recenter = setInterval(() => {
      const b = _panel && _panel.querySelector('.tl-body');
      if (!b || !b.isConnected) { clearInterval(_recenter); return; }
      if (Date.now() - _userScrolledAt < 20000) return;   // не мешаем ручной прокрутке
      centerNow(b, true);
    }, 30000);
  }
}
function centerNow(body, smooth) {
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const top = Math.max(0, (now / 60) * HOUR - (WINDOW_H / 2) * HOUR);
  if (smooth && body.scrollTo) body.scrollTo({ top, behavior: 'smooth' });
  else body.scrollTop = top;
  _scroll = top;
}
export const refreshTimeline = () => { if (_panel && !_panel.hidden) renderTimeline(_panel); };

function blockHTML(b, day) {
  const t = b.t;
  const w = 100 / b.cols;
  const len = b.e - b.s;
  const short = len < 40;
  return `<div class="tl-block m-${esc(t.mode)} p${t.priority}${isDone(t) ? ' done' : ''}${short ? ' short' : ''}${b.auto ? ' auto' : ''}"
      data-id="${esc(t.id)}" data-day="${day}"
      style="top:${(b.s / 60) * HOUR}px;height:${(len / 60) * HOUR}px;left:${b.col * w}%;width:calc(${w}% - 3px)"
      title="${esc(t.title)}">
    <div class="tlb-body">
      <b>${esc(t.title)}</b>
      <span>${minToHM(b.s)}–${minToHM(b.e)}</span>
    </div>
    <span class="tlb-grip top"></span><span class="tlb-grip bottom"></span>
  </div>`;
}

/* ── Выделение диапазона на пустом месте ──
   Тянем по пустой области — рисуется полоса от начала до конца
   выделения. Отпустили — выбираем, какую задачу поставить в это окно,
   или заводим новую прямо с этим временем. */
function bindArea(area) {
  let band = null, y0 = 0, s0 = 0, cur = 0, active = false;
  const day = area.closest('.tl-col').dataset.day;
  const minAt = y => {
    const r = area.getBoundingClientRect();
    return Math.max(0, Math.min(DAY_MIN, ((y - r.top + area.parentElement.scrollTop * 0) / HOUR) * 60));
  };
  const paint = () => {
    const a = Math.min(s0, cur), b = Math.max(s0, cur);
    band.style.top = `${(a / 60) * HOUR}px`;
    band.style.height = `${Math.max(2, ((b - a) / 60) * HOUR)}px`;
    band.querySelector('span').textContent = `${minToHM(a)}–${minToHM(Math.max(b, a + MIN_LEN))}`;
  };
  const onMove = e => {
    cur = snap(minAt(e.clientY));
    if (!active && Math.abs(e.clientY - y0) < 5) return;
    if (!active) {
      active = true;
      band = document.createElement('div');
      band.className = 'tl-band';
      band.innerHTML = '<span></span>';
      area.appendChild(band);
      document.body.classList.add('tl-dragging');
      hapticLight();
    }
    paint();
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('tl-dragging');
    if (!active) { if (band) band.remove(); band = null; return; }
    active = false;
    const a = Math.min(s0, cur);
    const b = Math.max(Math.max(s0, cur), a + MIN_LEN);
    if (band) { band.remove(); band = null; }
    openPlanPicker(day, minToHM(a), minToHM(b));
  };
  area.addEventListener('pointerdown', e => {
    if (e.target.closest('.tl-block')) return;
    if (e.button === 1 || e.button === 2) return;
    e.preventDefault();
    y0 = e.clientY;
    s0 = snap(minAt(e.clientY));
    cur = s0 + 60;
    active = false;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });
}

function openPlanPicker(day, start, end) {
  const free = tasksForDay(day).filter(t => !isDone(t) && !plansForDay(t, day).length);
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay';
  ov.innerHTML = `<div class="notes-list-modal glass">
    <header class="notes-list-head"><h3>${esc(start)}–${esc(end)}</h3>
      <button type="button" class="notes-list-close">✕</button></header>
    <div class="tl-newrow">
      <input class="tl-newtitle" type="text" maxlength="200" placeholder="Новая задача на это время">
      <button type="button" class="btn primary tl-newbtn">＋</button>
    </div>
    <div class="notes-list-content">${free.length
      ? free.map(t => `<button type="button" class="kb-pick" data-id="${esc(t.id)}">${esc(t.title)}</button>`).join('')
      : '<p class="empty">Все задачи этого дня уже стоят в таймлайне</p>'}</div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.notes-list-close').onclick = close;
  ov.onclick = e => { if (e.target === ov) close(); };
  ov.querySelectorAll('.kb-pick').forEach(b => b.onclick = async () => {
    close();
    await setTaskPlan(b.dataset.id, day, start, end);
    refreshTimeline();
  });
  const inp = ov.querySelector('.tl-newtitle');
  const add = async () => {
    const v = inp.value.trim();
    if (!v) { inp.focus(); return; }
    const t = await createTask({
      title: v,
      mode: state.mode === 'all' ? 'work' : state.mode,
      days: { [day]: 'todo' },
    });
    close();
    await setTaskPlan(t.id, day, start, end);
    refreshTimeline();
  };
  ov.querySelector('.tl-newbtn').onclick = add;
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  setTimeout(() => inp.focus(), 60);
}

/* ── Перетаскивание и растягивание ── */
function bindBlock(node) {
  let mode = null, sy = 0, s0 = 0, len0 = 0, moved = false, raf = null, lastY = 0;
  const scroller = node.closest('.tl-body');
  const apply = (s, len) => {
    node.style.top = `${(s / 60) * HOUR}px`;
    node.style.height = `${(len / 60) * HOUR}px`;
    const lab = node.querySelector('.tlb-body span');
    if (lab) lab.textContent = `${minToHM(s)}–${minToHM(s + len)}`;
  };
  const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = null; } };
  const tick = () => {
    raf = null;
    if (!mode || !scroller) return;
    const r = scroller.getBoundingClientRect();
    const EDGE = 56;
    let v = 0;
    if (lastY < r.top + EDGE) v = -11;
    else if (lastY > r.bottom - EDGE) v = 11;
    if (v) {
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, before + v));
      sy -= scroller.scrollTop - before;   // блок остаётся под пальцем
      onMove({ clientY: lastY });
    }
    raf = requestAnimationFrame(tick);
  };
  const onMove = e => {
    lastY = e.clientY;
    if (!moved && Math.abs(e.clientY - sy) < 4) return;
    moved = true;
    node.classList.add('dragging');
    const d = snap(((e.clientY - sy) / HOUR) * 60);
    if (mode === 'move') apply(Math.max(0, Math.min(DAY_MIN - len0, s0 + d)), len0);
    else if (mode === 'bottom') apply(s0, Math.max(MIN_LEN, Math.min(DAY_MIN - s0, len0 + d)));
    else {
      const s = Math.max(0, Math.min(s0 + len0 - MIN_LEN, s0 + d));
      apply(s, s0 + len0 - s);
    }
  };
  const onUp = async () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('tl-dragging');
    stop();
    node.classList.remove('dragging');
    mode = null;
    if (!moved) { openSheet(getTask(node.dataset.id)); return; }
    const s = Math.round((parseFloat(node.style.top) / HOUR) * 60);
    const len = Math.max(MIN_LEN, Math.round((parseFloat(node.style.height) / HOUR) * 60));
    hapticMedium();
    await setTaskPlan(node.dataset.id, node.dataset.day, minToHM(s), minToHM(s + len));
    refreshTimeline();
  };
  node.addEventListener('pointerdown', e => {
    if (e.button === 1 || e.button === 2) return;
    e.preventDefault();
    const t = getTask(node.dataset.id);
    if (!t) return;
    const grip = e.target.closest('.tlb-grip');
    mode = grip ? (grip.classList.contains('top') ? 'top' : 'bottom') : 'move';
    sy = e.clientY;
    lastY = e.clientY;
    s0 = Math.round((parseFloat(node.style.top) / HOUR) * 60);
    len0 = Math.max(MIN_LEN, Math.round((parseFloat(node.style.height) / HOUR) * 60));
    moved = false;
    hapticLight();
    document.body.classList.add('tl-dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    if (scroller) tick();
  });
}

/* Любая правка задачи (в том числе блок «Планирование» в редакторе)
   должна тут же отражаться на сетке */
document.addEventListener('focus-session', () => refreshTimeline());
subscribe(() => refreshTimeline());
