/* Показываем итоговую отметку до сортировки строк. */
import { reduced, BASE, EASE } from './anim.js';

const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : s;
const shown = el => el && el.isConnected && el.getClientRects().length > 0;
const statuses = ['todo', 'started', 'done', 'skipped', 'postponed'];

export async function previewEntry(id, day, status, source) {
  const key = '[data-id="' + esc(id) + '"]';
  const targets = source ? [source] : document.querySelectorAll(
    '.cell' + key + '[data-day="' + esc(day) + '"], ' +
    '.hm-check[data-toggle="' + esc(id) + '"], ' + key + ' .status'
  );
  await Promise.all(Array.from(targets).filter(shown).map(async el => {
    if (el.matches('.cell')) {
      el.classList.remove('none', 'c-wait', ...statuses.map(s => 'c-' + s));
      el.classList.add(status ? 'c-' + status : 'none');
    } else if (el.matches('.status')) {
      const row = el.closest('.task');
      if (!row) return;
      row.classList.remove(...statuses.map(s => 'st-' + s));
      row.classList.add('st-' + (status || 'todo'));
    } else {
      const done = status === 'done';
      el.textContent = done ? '✓' : '';
      if (done) {
        el.style.setProperty('background', 'var(--c-done)', 'important');
        el.style.setProperty('color', '#fff', 'important');
        el.style.boxShadow = 'none';
      }
    }
    el.classList.remove('pp-arrow', 'pp-dash');
    if (status === 'postponed') {
      const adjacent = el.nextElementSibling;
      el.classList.add(adjacent?.matches('.cell.c-postponed') ? 'pp-dash' : 'pp-arrow');
    }
    if (status === 'done' && el.matches('.cell') && !reduced() && el.animate) {
      const mark = document.createElement('span');
      mark.setAttribute('aria-hidden', 'true');
      Object.assign(mark.style, {position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', pointerEvents: 'none', zIndex: '1'});
      mark.innerHTML = '<svg viewBox="0 0 24 24" width="90%" height="90%" fill="none" stroke="var(--text)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path pathLength="1" stroke-dasharray="1" d="M4 12l5 5L20 6"/></svg>';
      el.append(mark);
      try {
        await mark.querySelector('path').animate(
          [{strokeDashoffset: 1}, {strokeDashoffset: 0, offset: .55}, {strokeDashoffset: 0}],
          {duration: 420, easing: EASE}
        ).finished.catch(() => {});
      } finally {
        mark.remove();
      }
      return;
    }
    if (!reduced() && el.animate) {
      await el.animate([{scale: '.92'}, {scale: '1'}], {duration: BASE, easing: EASE}).finished.catch(() => {});
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
