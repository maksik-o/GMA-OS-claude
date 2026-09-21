/* ══════════════════════════════════════════════════════════════════
   Анимации перерисовки. Всё на WAAPI — inline-стили не трогаем,
   убирать после завершения нечего, следующая перерисовка не ломается.

   Здесь осталось ровно два движения, которые реально используются:
   rowBrickSwap — смена содержимого «кирпичиками» по рядам,
   contentFade — мягкая подмена содержимого без сдвига блоков.
   Прежние slideIn / stagger / popIn / swapContent / brickSwap /
   viewSwap были вытеснены движком blockSwap из week.js и удалены.
   ══════════════════════════════════════════════════════════════════ */
const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ══════════════════════════════════════════════════════════════════
   Построчный обмен блоков.

   Задача: ряд, который опустел, должен заполняться новыми блоками
   СРАЗУ, не дожидаясь, пока уедет весь вид. Проблема в том, что
   перерисовка контейнера одна на всё — нельзя перерисовать один ряд.

   Решение: снимаем «фотографию» старых блоков — клонируем их в
   абсолютно спозиционированный слой поверх контейнера, — затем
   перерисовываем контент под ним. Дальше старые копии уезжают, а
   новые блоки приезжают с теми же задержками, ряд за рядом, блок за
   блоком. Визуально ряд освобождается и тут же занимается.
   ══════════════════════════════════════════════════════════════════ */
const ROW_TOL = 24;   // блоки в пределах 24px по вертикали считаем одним рядом

function groupRows(nodes) {
  const items = nodes.map(n => {
    const r = n.getBoundingClientRect();
    return { n, r };
  }).filter(o => o.r.width > 0 && o.r.height > 0);
  items.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(it.r.top - row.top) <= ROW_TOL) row.items.push(it);
    else rows.push({ top: it.r.top, items: [it] });
  }
  rows.forEach(r => r.items.sort((a, b) => a.r.left - b.r.left));
  return rows;
}

export function rowBrickSwap(container, dir, selector, render, opts) {
  const o = opts || {};
  if (!container || !container.animate || reduced()) { render(); return; }
  const STEP = o.step != null ? o.step : 70;      // задержка между блоками в ряду
  const ROW_STEP = o.rowStep != null ? o.rowStep : 90;  // задержка между рядами
  const OUT = o.outDuration || 260;
  const IN = o.inDuration || 320;
  const off = o.off || (innerWidth + 60);
  const outX = dir >= 0 ? -off : off;
  const inX = -outX;

  const oldNodes = [...container.querySelectorAll(selector)];
  const oldRows = groupRows(oldNodes);
  const delays = new Map();
  oldRows.forEach((row, ri) => row.items.forEach((it, ci) => delays.set(it.n, ri * ROW_STEP + ci * STEP)));

  /* Фотография старого состояния: копии живут в fixed-слое и не мешают
     новому контенту занять своё место. */
  let layer = null;
  if (oldNodes.length) {
    layer = document.createElement('div');
    layer.className = 'anim-ghost-layer';
    for (const row of oldRows) {
      for (const it of row.items) {
        const g = it.n.cloneNode(true);
        g.style.position = 'fixed';
        g.style.left = it.r.left + 'px';
        g.style.top = it.r.top + 'px';
        g.style.width = it.r.width + 'px';
        g.style.height = it.r.height + 'px';
        g.style.margin = '0';
        g.style.pointerEvents = 'none';
        layer.appendChild(g);
        g.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${outX}px)` }],
          { duration: OUT, delay: delays.get(it.n), easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
      }
    }
    document.body.appendChild(layer);
  }

  render();

  const newRows = groupRows([...container.querySelectorAll(selector)]);
  newRows.forEach((row, ri) => row.items.forEach((it, ci) => {
    /* Новый блок трогается в тот момент, когда его место освободил старый */
    it.n.animate([{ transform: `translateX(${inX}px)` }, { transform: 'translateX(0)' }],
      { duration: IN, delay: ri * ROW_STEP + ci * STEP + OUT * 0.55, easing: 'cubic-bezier(.32,.72,.28,1)', fill: 'backwards' });
  }));

  const last = oldRows.length ? Math.max(...[...delays.values()]) : 0;
  setTimeout(() => { if (layer) layer.remove(); }, last + OUT + 60);
}

/* ══════════════════════════════════════════════════════════════════
   Листание стрелками: блоки НЕ двигаются. Меняется только содержимое
   внутри них — мягким перекрёстным затуханием.
   ══════════════════════════════════════════════════════════════════ */
export function contentFade(render, opts) {
  const o = opts || {};
  const sel = o.selector || '.pane, .dock-panel, .fin-body, .kanban-panel';
  const nodes = [...document.querySelectorAll(sel)].filter(n => n.offsetWidth > 0);
  if (reduced() || !nodes.length || !nodes[0].animate) { render(); return; }
  const DUR = o.duration || 170;
  const shift = o.shift != null ? o.shift : 6;
  const dir = o.dir >= 0 ? 1 : -1;
  const outs = nodes.map(n => n.animate(
    [{ opacity: 1, transform: 'translateX(0)' },
     { opacity: 0, transform: `translateX(${-dir * shift}px)` }],
    { duration: DUR, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }));
  const go = () => {
    render();
    outs.forEach(a => a.cancel());
    [...document.querySelectorAll(sel)].filter(n => n.offsetWidth > 0).forEach(n => n.animate(
      [{ opacity: 0, transform: `translateX(${dir * shift}px)` },
       { opacity: 1, transform: 'translateX(0)' }],
      { duration: DUR + 90, easing: 'cubic-bezier(.32,.72,.28,1)' }));
  };
  let done = false;
  const once = () => { if (!done) { done = true; go(); } };
  outs[0].onfinish = once;
  outs[0].oncancel = once;
  setTimeout(once, DUR + 60);
}
