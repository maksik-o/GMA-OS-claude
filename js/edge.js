/* ══════════════════════════════════════════════════════════════════
   ТЕСТ: блюр под статус-баром iPhone (iOS 26).

   В веб-приложении на экране «Домой» с прозрачным статус-баром
   (black-translucent) iOS 26 размывает верх страницы. По наблюдениям
   разработчиков, WebKit не размывает край, если его закрывает
   закреплённый элемент со своим фоном (от ~10 px высотой и 90 %
   ширины) — тогда берётся цвет элемента. Проверяем, сработает ли это с
   (почти) прозрачным элементом, чтобы контент по-прежнему был виден под
   Dynamic Island. Варианты переключаются в «Оформлении»; после выбора
   рабочего — оставить его, а переключатель и лишние варианты убрать.
   ══════════════════════════════════════════════════════════════════ */
const KEY = 'rl_edge';
const VARIANTS = [
  { id: 'off', label: 'Как сейчас' },
  { id: 'clear', label: 'Прозрачная' },
  { id: 'a1', label: '1 %' },
  { id: 'a5', label: '5 %' },
  { id: 'kid', label: '1 % внутри' },
];
const get = () => { try { return localStorage.getItem(KEY) || 'off'; } catch { return 'off'; } };
function apply(id) {
  const root = document.documentElement;
  if (id === 'off') delete root.dataset.edge; else root.dataset.edge = id;
  if (!document.getElementById('edgeGuard')) {
    const g = document.createElement('div');
    g.id = 'edgeGuard';
    g.setAttribute('aria-hidden', 'true');
    document.body.appendChild(g);
  }
}
function renderRow() {
  const row = document.getElementById('edgeRow');
  if (!row) return;
  const cur = get();
  row.innerHTML = VARIANTS.map(v => `<button type="button" class="font-btn${v.id === cur ? ' on' : ''}" data-edge="${v.id}">${v.label}</button>`).join('');
}
export function edgeInit() {
  apply(get());
  renderRow();
  const row = document.getElementById('edgeRow');
  if (row) row.addEventListener('click', e => {
    const b = e.target.closest('[data-edge]');
    if (!b) return;
    try { localStorage.setItem(KEY, b.dataset.edge); } catch {}
    apply(b.dataset.edge);
    renderRow();
  });
}
