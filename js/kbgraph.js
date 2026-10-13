/* ══════════════════════════════════════════════════════════════════
   Граф связей базы знаний — как в Obsidian.

   Canvas + своя небольшая силовая раскладка: узлы отталкиваются,
   связи стягивают, слабая гравитация держит всё у центра. Без
   библиотек: на сотнях заметок O(n²) отталкивание укладывается в кадр.

   Колесо / щипок — масштаб, тянем пустое место — сдвиг, тянем узел —
   двигаем его, клик по узлу — открыть заметку. Наведение подсвечивает
   соседей и гасит остальное.

   setData() можно звать сколько угодно раз: узлы с теми же id
   сохраняют координаты, поэтому обновление базы (синхронизация,
   новая связь) не «взрывает» картинку заново.
   ══════════════════════════════════════════════════════════════════ */

export function createGraph(canvas, { onOpen } = {}) {
  const ctx = canvas.getContext('2d');
  let nodes = [];            // { id, label, color, x, y, vx, vy, deg, focus }
  let edges = [];            // { s, t } — ссылки на узлы
  let byId = new Map();
  let neighbors = new Map(); // id → Set(id)
  let alpha = 1;
  let raf = 0;
  let W = 0, H = 0, dpr = 1;
  const view = { x: 0, y: 0, k: 1 };   // экран = (мир * k) + (W/2 + x, H/2 + y)
  let hover = null, drag = null, pan = null;
  const pointers = new Map();
  let pinch = null;
  let destroyed = false;
  let autoFitting = false;   // пока раскладка устаканивается — держим всё в кадре

  const css = name => getComputedStyle(canvas).getPropertyValue(name).trim();
  let theme = {};
  const readTheme = () => {
    theme = {
      text: css('--text') || '#0f172a',
      dim: css('--dim') || 'rgba(100,116,139,.6)',
      accent: css('--accent') || '#2563eb',
    };
  };
  const resolveColor = c => {
    if (!c) return theme.dim;
    const s = String(c);
    if (!s.startsWith('var(')) return s;
    return css(s.slice(4, -1)) || theme.dim;
  };

  /* ── Размер ── */
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, r.width);
    H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    draw();
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas);

  /* ── Данные ── */
  function setData(list, links, focusId) {
    readTheme();
    const old = byId;
    byId = new Map();
    nodes = list.map((n, i) => {
      const prev = old.get(n.id);
      const a = i * 2.39996;               // золотой угол — ровная «спираль» для новых узлов
      const rr = 30 * Math.sqrt(i + 1);
      const node = prev || { x: Math.cos(a) * rr, y: Math.sin(a) * rr, vx: 0, vy: 0 };
      node.id = n.id;
      node.label = n.label;
      node.color = resolveColor(n.color);
      node.deg = 0;
      node.focus = n.id === focusId;
      byId.set(n.id, node);
      return node;
    });
    neighbors = new Map(nodes.map(n => [n.id, new Set()]));
    const seen = new Set();
    edges = [];
    for (const [a, b] of links) {
      if (a === b || !byId.has(a) || !byId.has(b)) continue;
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = byId.get(a), t = byId.get(b);
      s.deg++; t.deg++;
      neighbors.get(a).add(b);
      neighbors.get(b).add(a);
      edges.push({ s, t });
    }
    if (hover && !byId.has(hover.id)) hover = null;
    /* Полностью новая картинка — раскладываем с нуля, иначе лишь
       слегка «встряхиваем», чтобы новые узлы нашли своё место. */
    const fresh = nodes.some(n => !old.has(n.id));
    alpha = Math.max(alpha, fresh ? (old.size ? 0.6 : 1) : 0.15);
    kick();
  }

  /* ── Физика ── */
  const REPULSE = 2600, SPRING = 0.04, LEN = 70, GRAVITY = 0.012, DAMP = 0.6;
  function step() {
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
        if (d2 > 250000) continue;           // дальше 500 — уже не влияет
        const f = REPULSE / d2 * alpha;
        const d = Math.sqrt(d2);
        const fx = dx / d * f, fy = dy / d * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    for (const { s, t } of edges) {
      const dx = t.x - s.x, dy = t.y - s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - LEN) * SPRING * alpha;
      const fx = dx / d * f, fy = dy / d * f;
      s.vx += fx; s.vy += fy;
      t.vx -= fx; t.vy -= fy;
    }
    for (const p of nodes) {
      p.vx -= p.x * GRAVITY * alpha;
      p.vy -= p.y * GRAVITY * alpha;
      if (drag && drag.node === p) { p.vx = p.vy = 0; continue; }
      p.vx *= DAMP; p.vy *= DAMP;
      p.x += p.vx; p.y += p.vy;
    }
    alpha *= 0.985;
  }

  function kick() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(tick);
  }
  function tick() {
    raf = 0;
    if (destroyed) return;
    if (!canvas.isConnected) { destroy(); return; }
    if (alpha > 0.004 || drag) step();
    if (autoFitting) { if (alpha < 0.05) autoFitting = false; fit(); }
    draw();
    if (alpha > 0.004 || drag) kick();
  }

  /* ── Отрисовка ── */
  const radius = p => 4 + Math.min(10, Math.sqrt(p.deg) * 2.4);
  const toScreen = p => [p.x * view.k + W / 2 + view.x, p.y * view.k + H / 2 + view.y];
  const toWorld = (sx, sy) => [(sx - W / 2 - view.x) / view.k, (sy - H / 2 - view.y) / view.k];

  function draw() {
    if (!W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * (W / 2 + view.x), dpr * (H / 2 + view.y));

    const hi = hover ? neighbors.get(hover.id) : null;
    const isLit = p => !hover || p === hover || (hi && hi.has(p.id));

    ctx.lineWidth = 1 / view.k;
    for (const { s, t } of edges) {
      const lit = hover && (s === hover || t === hover);
      ctx.strokeStyle = lit ? theme.accent : theme.dim;
      ctx.globalAlpha = hover ? (lit ? 0.9 : 0.08) : 0.35;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }

    for (const p of nodes) {
      const r = radius(p);
      ctx.globalAlpha = isLit(p) ? 1 : 0.18;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (p.focus || p === hover) {
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = theme.accent;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3 / view.k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    /* Подписи: при крупном масштабе — все, иначе только у
       подсвеченных и у текущей заметки. Размер шрифта на экране
       постоянный, поэтому делим на k. */
    const showAll = view.k > 1.1 || nodes.length <= 25;
    ctx.font = `600 ${12 / view.k}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const p of nodes) {
      const lit = isLit(p);
      if (!(p.focus || p === hover || (hover && lit) || (showAll && !hover))) continue;
      ctx.globalAlpha = lit ? (p === hover || p.focus ? 1 : 0.85) : 0.15;
      ctx.fillStyle = theme.text;
      const label = p.label.length > 32 ? p.label.slice(0, 31) + '…' : p.label;
      ctx.fillText(label, p.x, p.y + radius(p) + 4 / view.k);
    }
    ctx.globalAlpha = 1;
  }

  /* ── Ввод ── */
  const local = e => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const hit = (sx, sy) => {
    const [wx, wy] = toWorld(sx, sy);
    let best = null, bd = Infinity;
    for (const p of nodes) {
      const r = radius(p) + 4 / view.k;
      const d = (p.x - wx) ** 2 + (p.y - wy) ** 2;
      if (d < r * r && d < bd) { best = p; bd = d; }
    }
    return best;
  };
  const zoomAt = (sx, sy, factor) => {
    const k = Math.min(4, Math.max(0.15, view.k * factor));
    const [wx, wy] = toWorld(sx, sy);
    view.k = k;
    view.x = sx - W / 2 - wx * k;
    view.y = sy - H / 2 - wy * k;
    draw();
  };

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    autoFitting = false;
    const [sx, sy] = local(e);
    zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  canvas.addEventListener('pointerdown', e => {
    autoFitting = false;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 2) {
      /* Второй палец — переходим в щипок, перетаскивание отменяем */
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: view.k };
      drag = null; pan = null;
      return;
    }
    const [sx, sy] = local(e);
    const p = hit(sx, sy);
    if (p) {
      drag = { node: p, sx, sy, moved: false };
      hover = p;
      alpha = Math.max(alpha, 0.3);
      kick();
    } else {
      pan = { sx, sy, x: view.x, y: view.y };
    }
  });
  canvas.addEventListener('pointermove', e => {
    const pt = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, pt);
    const [sx, sy] = pt;
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (pinch.k * d / pinch.d) / view.k);
      return;
    }
    if (drag) {
      if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 4) drag.moved = true;
      const [wx, wy] = toWorld(sx, sy);
      drag.node.x = wx; drag.node.y = wy;
      alpha = Math.max(alpha, 0.3);
      kick();
      return;
    }
    if (pan) {
      view.x = pan.x + sx - pan.sx;
      view.y = pan.y + sy - pan.sy;
      draw();
      return;
    }
    const p = hit(sx, sy);
    if (p !== hover) {
      hover = p;
      canvas.style.cursor = p ? 'pointer' : 'grab';
      draw();
    }
  });
  const end = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag) {
      const { node, moved } = drag;
      drag = null;
      if (!moved && onOpen) onOpen(node.id);
    }
    pan = null;
    if (e.pointerType !== 'mouse') { hover = null; draw(); }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!drag && hover) { hover = null; draw(); } });

  function fit() {
    if (!nodes.length || !W) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of nodes) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const k = Math.min(2, Math.max(0.15, Math.min((W - 80) / ((x1 - x0) || 1), (H - 80) / ((y1 - y0) || 1))));
    view.k = k;
    view.x = -((x0 + x1) / 2) * k;
    view.y = -((y0 + y1) / 2) * k;
    draw();
  }

  function destroy() {
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (ro) ro.disconnect();
  }

  resize();
  function autoFit() {
    if (alpha > 0.05) { autoFitting = true; kick(); } else fit();
  }

  return { setData, fit, autoFit, destroy, redraw: () => { readTheme(); draw(); } };
}
