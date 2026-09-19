import { state, today, addDays, iso, isoWeek, tasksForDay } from './store.js';
/* Названия месяцев в именительном падеже, с большой буквы */
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
function dayMark(d) {
  const list = tasksForDay(d);
  if (!list.length) return '';
  const open = list.some(t => { const s = (t.days || {})[d]; return s === 'todo' || s === 'started'; });
  return open ? 'open' : 'done';
}
export const calTitle = a => `${MONTHS_NOM[a.getMonth()]} ${a.getFullYear()}`;
/* ── БАРАБАН МЕСЯЦЕВ v2: лента без подписей у месяцев ── */
const DRUM = { gap: 4, monthGap: 28 };
/* Высота месяца = ровно 6 рядов + отступ до следующего месяца (фолбэк) */
const monthH = cellH => 6 * (cellH + DRUM.gap) + DRUM.monthGap;
const addMonths = (a, k) => new Date(a.getFullYear(), a.getMonth() + k, 1);
const monthDiff = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
/* Настройки колеса ПК: медленно, ~1 месяц за оборот */
const WHEEL_K = 0.22, V_MAX = 26, FRICTION = 0.90, STOP_V = 0.4;
export function createCalDrum(el, o) {
  el.classList.add('cal-drum');
  let H = monthH(o.cellH || 32);
  const now0 = new Date();
  const base = new Date((o.anchor || now0).getFullYear(), (o.anchor || now0).getMonth(), 1);
  let offset = 0, v = 0, raf = null, suppress = false, lastIdx = 0;
  const blocks = new Map();
  function buildMonth(k) {
    const a = addMonths(base, k);
    const y = a.getFullYear(), m = a.getMonth();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const start = addDays(iso(new Date(y, m, 1)), -lead);
    const t0 = today();
    const ws = state.weekStart, we = addDays(ws, 6);
    const b = document.createElement('div');
    b.className = 'cal-month';
    let html = '';
    for (let w = 0; w < 6; w++) {
      const wStart = addDays(start, w * 7);
      /* Выбранная неделя — подложка на всю строку, а не обводка
         каждого дня: читается спокойнее и сразу видно диапазон. */
      html += `<div class="cal-row${wStart === ws ? ' wk-on' : ''}">`;
      if (o.week !== false) html += `<button type="button" class="cal-weekbtn${wStart === ws ? ' on' : ''}" data-ws="${wStart}" title="Показать эту неделю">${isoWeek(wStart)}</button>`;
      for (let i = 0; i < 7; i++) {
        const d = addDays(wStart, i);
        const mark = dayMark(d);
        const extra = o.markDay ? (o.markDay(d) || '') : '';
        html += `<button type="button" class="cal-day${+d.slice(5, 7) === m + 1 ? '' : ' out'}${d === t0 ? ' tdy' : ''}${d >= ws && d <= we ? ' inweek' : ''}${i >= 5 ? ' we' : ''}${extra ? ' ' + extra : ''}" data-d="${d}"><span class="cd-num">${+d.slice(8)}</span>${mark ? `<i class="cd-dot ${mark}"></i>` : ''}</button>`;
      }
      html += '</div>';
    }
    b.innerHTML = html;
    return b;
  }
  const centerIdx = () => Math.round(offset / H);
  const settleMonth = () => addMonths(base, centerIdx());
  /* ── Самонастройка геометрии ──
     Высоту месяца берём из DOM. Раньше замер делался ТОЛЬКО в момент
     создания блока: если панель в этот миг была скрыта, ещё не встала
     в док или шрифт не догрузился — барабан застывал «скукоженным»
     до первого взаимодействия. Теперь мерим на каждом layout. */
  function measure() {
    const b = blocks.values().next().value;
    if (!b) return false;
    const mh = b.offsetHeight;
    if (mh <= 40) return false;              // скрыт — мерить нечего
    const nh = mh + DRUM.monthGap;
    if (Math.abs(nh - H) < 0.5) return false;
    const ci = centerIdx();
    H = nh;
    el.style.height = mh + 'px';             // окно барабана = ровно один месяц
    offset = ci * H;                         // тот же месяц остаётся в окне
    return true;
  }
  function layout() {
    const vh = el.clientHeight || H;
    const k0 = Math.floor(offset / H) - 1;
    const k1 = Math.floor((offset + vh) / H) + 1;
    for (const [k, b] of blocks) if (k < k0 || k > k1) { b.remove(); blocks.delete(k); }
    for (let k = k0; k <= k1; k++) {
      let b = blocks.get(k);
      if (!b) {
        b = buildMonth(k);
        blocks.set(k, b);
        el.appendChild(b);
      }
      b.style.transform = `translateY(${(k * H - offset).toFixed(1)}px)`;
    }
    if (measure()) { requestAnimationFrame(layout); return; }
    const ci = centerIdx();
    if (ci !== lastIdx) { lastIdx = ci; o.onCenter && o.onCenter(settleMonth()); }
  }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
  function tick() {
    offset += v;
    v *= FRICTION;
    if (Math.abs(v) < STOP_V) { snap(); return; }
    layout();
    raf = requestAnimationFrame(tick);
  }
  function snap() { stop(); animateTo(centerIdx() * H); }
  function animateTo(target) {
    stop();
    const from = offset, d = target - from, t0 = performance.now(), dur = 340;
    const ease = t => 1 - Math.pow(1 - t, 3);
    const step = n => {
      const p = Math.min(1, (n - t0) / dur);
      offset = from + d * ease(p);
      layout();
      if (p < 1) raf = requestAnimationFrame(step);
      else { offset = target; layout(); o.onSettle && o.onSettle(settleMonth()); }
    };
    raf = requestAnimationFrame(step);
  }
  /* ПК — только колесо (мышью не таскаем), замедленно */
  el.addEventListener('wheel', e => {
    e.preventDefault();
    stop();
    v = Math.max(-V_MAX, Math.min(V_MAX, v + e.deltaY * WHEEL_K));
    raf = requestAnimationFrame(tick);
  }, { passive: false });
  /* Тач — барабан крутится пальцем */
  let dragging = false, py = 0, downY = 0, lastDy = 0, moved = 0;
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return; // на ПК мышью не таскаем
    dragging = true;
    py = downY = e.clientY;
    lastDy = 0; moved = 0; v = 0;
    stop();
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dy = e.clientY - py;
    py = e.clientY;
    moved = Math.max(moved, Math.abs(e.clientY - downY));
    if (moved > 6) { lastDy = dy; offset -= dy; layout(); }
  });
  const up = () => {
    if (!dragging) return;
    dragging = false;
    if (moved > 6) {
      suppress = true;
      setTimeout(() => { suppress = false; }, 80);
      v = Math.max(-V_MAX, Math.min(V_MAX, -lastDy * 0.9));
      raf = requestAnimationFrame(tick);
    } else snap();
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  /* Клики по дням и номерам недель */
  el.addEventListener('click', e => {
    if (suppress) { e.preventDefault(); e.stopPropagation(); return; }
    const wb = e.target.closest('.cal-weekbtn');
    if (wb) { e.stopPropagation(); o.onWeek && o.onWeek(wb.dataset.ws); return; }
    const cd = e.target.closest('.cal-day');
    if (cd) o.onDay && o.onDay(cd.dataset.d);
  });
  layout();
  /* Барабан догоняет реальную геометрию: показ панели, смена ширины,
     догрузка шрифта, первые кадры после старта. */
  const relayout = () => { if (!raf) layout(); };
  if (typeof ResizeObserver !== 'undefined') {
    const host = el.parentElement || el;
    new ResizeObserver(relayout).observe(host);
  }
  requestAnimationFrame(relayout);
  setTimeout(relayout, 60);
  setTimeout(relayout, 400);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout).catch(() => {});
  window.addEventListener('resize', relayout);
  return {
    step(dir) { animateTo((centerIdx() + dir) * H); },
    goCurrent() { animateTo(monthDiff(base, new Date(new Date().getFullYear(), new Date().getMonth(), 1)) * H); },
    refresh() { blocks.forEach(b => b.remove()); blocks.clear(); layout(); },
    relayout,
    currentMonth: settleMonth,
  };
}
