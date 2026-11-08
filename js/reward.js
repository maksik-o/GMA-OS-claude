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
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" pathLength="1"/></svg>';

function burst(el, color, find) {
  el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.22)', offset: .3 }, { transform: 'scale(1)' }], { duration: SLOW, easing: EASE });
  const host = document.createElement('span');
  host.className = 'rw-fx';
  host.style.setProperty('--rw', color);
  host.innerHTML = '<i class="rw-ring"></i>' + CHECK;
  const r = el.getBoundingClientRect();
  Object.assign(host.style, { borderRadius: getComputedStyle(el).borderRadius, left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  document.body.appendChild(host);
  host.querySelector('.rw-ring').animate(
    [{ transform: 'scale(.7)', opacity: .9 }, { transform: 'scale(1.9)', opacity: 0 }],
    { duration: SLOW + 140, easing: EASE, fill: 'forwards' });
  const path = host.querySelector('path');
  path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: BASE, delay: 60, easing: EASE, fill: 'both' });
  host.querySelector('svg').animate(
    [{ opacity: 1, transform: 'scale(1)' }, { opacity: 1, transform: 'scale(1)', offset: .6 }, { opacity: 0, transform: 'scale(1.1)' }],
    { duration: 760, easing: 'linear', fill: 'forwards' }).finished.then(() => host.remove(), () => host.remove());
  /* строка может переехать (выполненные уходят вниз) или перерисоваться —
     эффект едет за ней */
  const follow = () => {
    if (!host.isConnected) return;
    const cur = (el.isConnected ? el : find()) || el;
    el = cur;
    const q = cur.getBoundingClientRect();
    if (q.width) host.style.transform = `translate(${q.left - r.left}px, ${q.top - r.top}px)`;
    requestAnimationFrame(follow);
  };
  requestAnimationFrame(follow);
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
    const { id, day, mode } = e.detail || {};
    const color = `var(--mode-${mode || 'all'}, var(--accent))`;
    const prev = before; before = null;
    /* ждём перерисовку экранов после сохранения */
    setTimeout(() => requestAnimationFrame(() => {
      const sels = [`.cell[data-id="${esc(id)}"][data-day="${esc(day)}"]`, `[data-id="${esc(id)}"]:not([data-day]) .status`, `[data-id="${esc(id)}"]:not([data-day]) .hm-check`];
      let n = 0;
      for (const sel of sels) for (const el of document.querySelectorAll(sel)) {
        if (n >= 3 || !shown(el)) continue;
        n++;
        burst(el, color, () => [...document.querySelectorAll(sel)].find(shown));
      }
      if (prev) document.querySelectorAll('.hm-prog-t').forEach((el, i) => { if (Number.isFinite(prev[i])) bumpCounter(el, prev[i]); });
    }), 60);
  });
}
