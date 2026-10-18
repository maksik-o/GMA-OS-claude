/* ══════════════════════════════════════════════════════════════════
   Панель с «пупыркой» — одной фигурой.

   Фон, рамку, тени и внутреннее свечение панели рисует SVG-фигура
   «прямоугольник со скруглениями + выпуклость на одном из краёв», а у
   самой панели они выключаются (.pskinned). Так выпуклость — часть края
   панели в любой теме и при любой прозрачности: нет наложения и шва.
   Оформление фигура берёт из вычисленного стиля панели в текущей теме:
   — заливка — фон панели; размытие фона (backdrop-filter) — внутри фигуры;
   — линия края — рамка панели, а без рамки — кольцо из box-shadow;
   — внешние тени — тени панели (только снаружи фигуры, как box-shadow);
   — внутренние (inset) тени и свечение — внутри фигуры, по всему краю.
   ══════════════════════════════════════════════════════════════════ */
const NS = 'http://www.w3.org/2000/svg';
const PAD = 48;          // запас холста вокруг панели: выпуклость и тени
export const BUMP_LEN = 76, BUMP_DEPTH = 20;
let uid = 0;

/* Контур: обход по часовой стрелке от верхнего левого скругления.
   bump = { side: 'top'|'right'|'bottom'|'left', at: центр вдоль края, d: выступ } */
function shapePath(x0, y0, x1, y1, r, bump) {
  const [tl, tr, br, bl] = r.map(v => Math.max(0, Math.min(v, (x1 - x0) / 2, (y1 - y0) / 2)));
  const b = bump && bump.d > 0.01 ? bump : null;
  const h = BUMP_LEN / 2;
  /* профиль выпуклости вдоль края: −38 … +38 от центра, наружу на d */
  const prof = (side, c, d) => {
    const P = (along, out) => {
      if (side === 'top') return `${c + along} ${y0 - out}`;
      if (side === 'right') return `${x1 + out} ${c + along}`;
      if (side === 'bottom') return `${c - along} ${y1 + out}`;
      return `${x0 - out} ${c - along}`;
    };
    return `L${P(-h, 0)}C${P(-h + 12, 0)} ${P(-h + 8, d)} ${P(-h + 22, d)}L${P(h - 22, d)}C${P(h - 8, d)} ${P(h - 12, 0)} ${P(h, 0)}`;
  };
  const edge = side => (b && b.side === side ? prof(side, b.at, b.d) : '');
  return `M${x0 + tl} ${y0}${edge('top')}L${x1 - tr} ${y0}` +
    (tr ? `A${tr} ${tr} 0 0 1 ${x1} ${y0 + tr}` : '') + `${edge('right')}L${x1} ${y1 - br}` +
    (br ? `A${br} ${br} 0 0 1 ${x1 - br} ${y1}` : '') + `${edge('bottom')}L${x0 + bl} ${y1}` +
    (bl ? `A${bl} ${bl} 0 0 1 ${x0} ${y1 - bl}` : '') + `${edge('left')}L${x0} ${y0 + tl}` +
    (tl ? `A${tl} ${tl} 0 0 1 ${x0 + tl} ${y0}` : '') + 'Z';
}

function splitList(v) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of v || '') {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function parseShadow(sh) {
  const color = (sh.match(/(rgba?\([^)]*\)|color\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8})/i) || [])[0] || '';
  const [x, y, blur, spread] = (sh.replace(color, '').match(/-?[\d.]+px/g) || []).map(parseFloat).concat([0, 0, 0, 0]);
  const clear = !color || /rgba\([^)]*,\s*0\)|\/\s*0\)/.test(color);
  return { inset: /\binset\b/.test(sh), x, y, blur, spread, color, clear };
}

export function skinPanel(panel, getBump) {
  const id = ++uid;
  const root = document.createElement('div');
  root.className = 'pskin';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `<svg class="pskin-shadow"><defs><filter id="psh${id}" filterUnits="userSpaceOnUse"></filter></defs><path fill="#000"/></svg>
    <div class="pskin-glass"></div>
    <svg class="pskin-body"><defs><filter id="pin${id}" filterUnits="userSpaceOnUse"></filter></defs><path class="pskin-fill"/></svg>
    <div class="pskin-img"></div>
    <svg class="pskin-edge"><path class="pskin-line" fill="none"/></svg>`;
  panel.prepend(root);
  /* слои снизу вверх: внешние тени, размытие фона, заливка (+ inset-тени),
     фоновая картинка/градиент панели, линия края */
  const [shSvg, glass, bodySvg, img, edgeSvg] = root.children;
  const shPath = shSvg.querySelector('path'), fillPath = bodySvg.querySelector('.pskin-fill'), linePath = edgeSvg.querySelector('.pskin-line');
  const shFilter = shSvg.querySelector('filter'), inFilter = bodySvg.querySelector('filter');
  let st = null;   // прочитанное оформление панели
  let depth = 0;

  /* прочитать оформление панели как оно есть в теме (без .pskinned) */
  function read() {
    panel.classList.add('pskin-read');
    panel.classList.remove('pskinned');
    const cs = getComputedStyle(panel);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const shadows = splitList(cs.boxShadow === 'none' ? '' : cs.boxShadow).map(parseShadow).filter(s => !s.clear);
    let line = '', lw = 0, lineOut = false;
    if (bw > 0 && cs.borderTopStyle !== 'none') { line = cs.borderTopColor; lw = bw; }
    const outer = [], inner = [];
    for (const s of shadows) {
      if (s.inset) { inner.push(s); continue; }
      if (!s.x && !s.y && !s.blur && s.spread > 0) { if (!lw) { line = s.color; lw = s.spread; lineOut = true; } continue; }
      outer.push(s);
    }
    st = {
      bw, line, lw, lineOut, outer, inner,
      bg: cs.backgroundColor, bgImg: cs.backgroundImage !== 'none' ? cs.backgroundImage : '',
      backdrop: cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : (cs.webkitBackdropFilter || ''),
      r: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(v => parseFloat(v) || 0),
    };
    panel.classList.add('pskinned');
    void panel.offsetWidth;
    panel.classList.remove('pskin-read');
    buildFilters();
  }
  function buildFilters() {
    /* внешние тени: тень фигуры минус сама фигура — как у box-shadow */
    let f = '', merge = '';
    st.outer.forEach((s, k) => {
      f += `<feOffset in="SourceAlpha" dx="${s.x}" dy="${s.y}" result="o${k}"/>`;
      if (s.spread) f += `<feMorphology in="o${k}" operator="${s.spread > 0 ? 'dilate' : 'erode'}" radius="${Math.abs(s.spread)}" result="o${k}"/>`;
      f += `<feGaussianBlur in="o${k}" stdDeviation="${s.blur / 2}" result="b${k}"/><feFlood flood-color="${s.color}"/><feComposite in2="b${k}" operator="in" result="s${k}"/>`;
      merge += `<feMergeNode in="s${k}"/>`;
    });
    shFilter.innerHTML = st.outer.length ? f + `<feMerge result="all">${merge}</feMerge><feComposite in="all" in2="SourceAlpha" operator="out"/>` : '';
    shSvg.style.display = st.outer.length ? '' : 'none';
    /* внутренние: цвет снаружи фигуры, сдвиг, размытие, внутри фигуры */
    f = ''; merge = '<feMergeNode in="SourceGraphic"/>';
    st.inner.forEach((s, k) => {
      f += `<feFlood flood-color="${s.color}"/><feComposite in2="SourceAlpha" operator="out" result="v${k}"/>` +
        /* разлёт: положительный — тень глубже внутрь, отрицательный — тоньше у края */
        (s.spread ? `<feMorphology in="v${k}" operator="${s.spread > 0 ? 'dilate' : 'erode'}" radius="${Math.abs(s.spread)}" result="v${k}"/>` : '') +
        `<feOffset in="v${k}" dx="${s.x}" dy="${s.y}" result="w${k}"/><feGaussianBlur in="w${k}" stdDeviation="${Math.max(0.01, s.blur / 2)}" result="g${k}"/>` +
        `<feComposite in="g${k}" in2="SourceAlpha" operator="in" result="i${k}"/>`;
      merge += `<feMergeNode in="i${k}"/>`;
    });
    inFilter.innerHTML = st.inner.length ? f + `<feMerge>${merge}</feMerge>` : '';
    fillPath.setAttribute('filter', st.inner.length ? `url(#pin${id})` : '');
    shPath.setAttribute('filter', st.outer.length ? `url(#psh${id})` : '');
    fillPath.style.fill = st.bg;
    linePath.style.stroke = st.line || 'transparent';
    linePath.style.strokeWidth = st.lw;
    glass.style.backdropFilter = glass.style.webkitBackdropFilter = st.backdrop || 'none';
    img.style.backgroundImage = st.bgImg || 'none';
    img.style.display = st.bgImg ? '' : 'none';
  }
  /* геометрия: холст = рамочная коробка панели + запас */
  function draw() {
    if (!st) return;
    const W = panel.offsetWidth, H = panel.offsetHeight;
    const cw = W + PAD * 2, ch = H + PAD * 2;
    root.style.left = root.style.top = `${-st.bw - PAD}px`;
    root.style.width = cw + 'px';
    root.style.height = ch + 'px';
    for (const svg of [shSvg, bodySvg, edgeSvg]) { svg.setAttribute('width', cw); svg.setAttribute('height', ch); svg.setAttribute('viewBox', `0 0 ${cw} ${ch}`); }
    for (const f of [shFilter, inFilter]) { f.setAttribute('x', 0); f.setAttribute('y', 0); f.setAttribute('width', cw); f.setAttribute('height', ch); }
    const bp = getBump ? getBump(W, H) : null;
    const bump = bp ? { side: bp.side, at: PAD + bp.at, d: depth } : null;
    const x0 = PAD, y0 = PAD, x1 = PAD + W, y1 = PAD + H;
    const fill = shapePath(x0, y0, x1, y1, st.r, bump);
    fillPath.setAttribute('d', fill);
    shPath.setAttribute('d', fill);
    glass.style.clipPath = `path('${fill}')`;
    /* градиент панели — в размер самой панели, как у неё */
    img.style.clipPath = `path('${fill}')`;
    img.style.backgroundSize = `${W}px ${H}px`;
    img.style.backgroundPosition = `${PAD}px ${PAD}px`;
    /* линия: рамка — по её средней линии внутри, кольцо — снаружи; выступ
       тот же, поэтому линия идёт вдоль края выпуклости */
    const k = st.lineOut ? -st.lw / 2 : st.lw / 2;
    linePath.setAttribute('d', st.lw ? shapePath(x0 + k, y0 + k, x1 - k, y1 - k, st.r.map(v => Math.max(0, v - k)), bump) : '');
  }
  let anim = 0;
  return {
    refresh() { read(); draw(); },
    draw,
    get depth() { return depth; },
    get bw() { return st ? st.bw : 0; },
    get r() { return st ? st.r : [0, 0, 0, 0]; },
    /* выступ пупырки: 0 — разглажена, BUMP_DEPTH — выпуклая */
    setDepth(to, ms = 0, delay = 0) {
      cancelAnimationFrame(anim);
      const from = depth, t0 = performance.now() + delay;
      if (!ms || matchMedia('(prefers-reduced-motion: reduce)').matches) { depth = to; draw(); return; }
      const ease = t => (to > from ? 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2) : t * t * (3 - 2 * t));
      const step = now => {
        const t = Math.min(1, Math.max(0, (now - t0) / ms));
        depth = from + (to - from) * ease(t);
        draw();
        if (t < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    },
  };
}
