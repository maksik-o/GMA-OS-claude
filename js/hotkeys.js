import { dbGetKV, dbSetKV } from './db.js';

const DEFAULT = { new: 'KeyN', search: 'Slash', today: 'KeyT', weekPrev: 'ArrowLeft', weekNext: 'ArrowRight', dayPrev: 'KeyA', dayNext: 'KeyD', kanban: 'KeyK' };
const LABELS = { new: 'Новая задача', search: 'Поиск', today: 'Сегодня', weekPrev: 'Неделя −', weekNext: 'Неделя +', dayPrev: 'День −', dayNext: 'День +', kanban: 'Смена режима отображения задач' };
let keys = { ...DEFAULT };

export async function loadKeys() {
  const v = await dbGetKV('hotkeys');
  keys = Object.assign({}, DEFAULT, v || {});
}
export const keyFor = a => keys[a] || DEFAULT[a];
export function matches(e, a) {
  const k = keyFor(a);
  return !!k && e.code === k;
}
export function pretty(k) {
  if (!k) return '—';
  return k.replace('Key', '').replace('Digit', '')
    .replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓')
    .replace('Slash', '/');
}

/* Панель настройки клавиш — рисуется внутрь шторки настроек */
export function renderKeysPanel(el) {
  if (!el) return;
  el.innerHTML = '';
  for (const [a, l] of Object.entries(LABELS)) {
    const row = document.createElement('div');
    row.className = 'key-line';
    const ic = document.createElement('span');
    ic.className = 'kl';
    ic.textContent = l;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kbd';
    b.textContent = pretty(keys[a]);
    b.onclick = () => {
      b.classList.add('listen');
      b.textContent = '…';
      const h = e => {
        e.preventDefault();
        e.stopPropagation();
        keys[a] = e.code;
        dbSetKV('hotkeys', keys);
        b.classList.remove('listen');
        b.textContent = pretty(e.code);
        document.dispatchEvent(new CustomEvent('hotkeys-changed'));
        b.removeEventListener('keydown', h);
      };
      b.addEventListener('keydown', h);
    };
    row.append(ic, b);
    el.appendChild(row);
  }
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn';
  reset.textContent = 'Сбросить';
  reset.onclick = async () => {
    keys = { ...DEFAULT };
    await dbSetKV('hotkeys', keys);
    renderKeysPanel(el);
    document.dispatchEvent(new CustomEvent('hotkeys-changed'));
  };
  el.appendChild(reset);
}
