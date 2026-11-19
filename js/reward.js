/* ══════════════════════════════════════════════════════════════════
   НАГРАДА ЗА ВЫПОЛНЕНИЕ. Когда задача отмечена «Выполнено»:
   • квадрат дня / кружок статуса коротко «вздувается», от него
     расходится кольцо цвета режима задачи;
   • поверх рисуется галочка (штрих протягивается и гаснет);
   • вибрация — hapticSuccess в store.setEntry;
   • счётчик «N из M» на главной докручивается и подпрыгивает.
   Движение — только transform и opacity (штрих галочки — SVG).
   ══════════════════════════════════════════════════════════════════ */
import { reduced, BASE, SLOW, EASE } from './anim.js';

const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
const shown = el => el && el.isConnected && el.getClientRects().length > 0;
const marks = {
  todo: 'M6 4H18Q20 4 20 6V18Q20 20 18 20H6Q4 20 4 18V6Q4 4 6 4Z',
  started: 'M6 18L18 6',
  done: 'M5 12.5L9.5 17L19 7.5',
  skipped: 'M6 6L18 18M18 6L6 18',
  postponed: 'M4 12H19M13 6L19 12L13 18'
};

export async function previewEntry(id, day, status, source) {
  if (reduced()) return;
  const key = '[data-id="' + esc(id) + '"]';
  const targets = source ? [source] : document.querySelectorAll('.cell' + key + '[data-day="' + esc(day) + '"], ' + key + ' .hm-check, ' + key + ' .status');
  await Promise.all(Array.from(targets).filter(shown).map(async el => {
    if (!el.animate) return;
    if (!status) {
      await el.animate([{opacity: 1}, {opacity: 0, transform: 'scale(.65)'}], {duration: BASE, easing: EASE}).finished.catch(() => {});
      return;
    }
    const host = document.createElement('span');
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, {position:'absolute', inset:'0', display:'grid', placeItems:'center', pointerEvents:'none', zIndex:'2', borderRadius:'inherit', background:'var(--panel-solid, #171719)', color:'var(--c-' + status + ', currentColor)'});
    const position = el.style.position;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    host.innerHTML = '<svg viewBox="0 0 24 24" width="90%" height="90%" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path pathLength="1" stroke-dasharray="1" d="' + marks[status] + '"/></svg>';
    el.append(host);
    try {
      await host.querySelector('path').animate([{strokeDashoffset:1}, {strokeDashoffset:0, offset:.7}, {strokeDashoffset:0}], {duration:420, easing:EASE}).finished.catch(() => {});
    } finally {
      host.remove();
      el.style.position = position;
    }
  }));
}

function bumpCounter(el, from) {
  const m = el.textContent.match(/^(\d+)(.*)$/s);
  if (!m) return;
  const to = +m[1], rest = m[2];
  if (from === to) return;
  /* число докручивается от прежнего значения */
  const t0 = performance.now(), dur = BASE + 120;
  const step = now => {
    const p = Math.min(1, (now - t0) / dur);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))) + rest;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  el.animate([{ transform: 'translateY(0) scale(1)' }, { transform: 'translateY(-3px) scale(1.2)', offset: .35 }, { transform: 'none' }], { duration: SLOW, easing: EASE });
}

export function rewardInit() {
  let before = null;
  /* store.setEntry сообщает до сохранения (запоминаем счётчики) и после */
  document.addEventListener('task-done-before', () => {
    before = [...document.querySelectorAll('.hm-prog-t')].map(el => parseInt(el.textContent, 10));
  });
  document.addEventListener('task-done', e => {
    if (reduced()) return;
    const prev = before; before = null;
    /* ждём перерисовку экранов после сохранения */
    setTimeout(() => requestAnimationFrame(() => {
      if (prev) document.querySelectorAll('.hm-prog-t').forEach((el, i) => { if (Number.isFinite(prev[i])) bumpCounter(el, prev[i]); });
    }), 60);
  });
}
