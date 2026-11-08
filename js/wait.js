/* ══════════════════════════════════════════════════════════════════
   ЖДУ. Задачи, которым для продолжения нужно чужое действие.
   • Окно «В ожидание»: от кого (люди из «Контактов» или просто текст),
     чего жду, когда напомнить. Все поля можно пропустить.
   • Карточки ожидания — одна разметка для панели на главной, виджета в
     задачах и карточки человека в «Контактах».
   • «Пришло» — задача возвращается в Running-list на сегодня как
     «Начато» (store.returnFromWait).
   • Перетаскивание строки задачи на цель [data-wait-drop] (виджет или
     панель «Жду») открывает то же окно.
   Поручения из «Контактов» — это ожидания с выбранным человеком.
   ══════════════════════════════════════════════════════════════════ */
import {
  esc, today, addDays, getTask, createTask, sendToWait, returnFromWait, snoozeWait,
  waitingTasks, waitDays, remindDue, fmtD,
} from './store.js';
import { getPerson, getPeople } from './contacts.js';
import { growFrom, shrinkTo, BASE, EASE, EASE_IN, reduced } from './anim.js';

const changed = () => document.dispatchEvent(new CustomEvent('wait-changed'));
const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const ICO = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
};
export const wIco = (k, s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[k]}</svg>`;

/* От кого ждём: человек из контактов или текст */
export function whoOf(w) {
  if (!w) return '';
  const p = w.personId ? getPerson(w.personId) : null;
  return p && !p.deleted ? p.name : (w.who || '');
}
const daysWord = n => n % 10 === 1 && n % 100 !== 11 ? 'день' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? 'дня' : 'дней';

/* ── Карточка ожидания ── */
export function waitCardHTML(t, o = {}) {
  const w = t.wait || {};
  const n = waitDays(t);
  const who = o.noWho ? '' : whoOf(w);
  const due = remindDue(t);
  const meta = [
    who ? esc(who) : '',
    n ? `ждём ${n} ${n < 5 ? daysWord(n) : 'дн'}` : 'с сегодня',
  ].filter(Boolean).join(' · ');
  const remind = due ? '<span class="wt-due">пора напомнить</span>'
    : w.remindAt ? `<span class="wt-soft">напомню ${esc(fmtD(w.remindAt))}</span>` : '';
  return `<div class="wt-card" data-id="${esc(t.id)}" data-wait="${esc(t.id)}" style="--mc:var(--mode-${esc(t.mode)})">
    <i class="wt-bar"></i>
    <div class="wt-body">
      <button type="button" class="wt-title" data-wact="open">${esc(t.title || 'Без названия')}</button>
      ${w.what ? `<div class="wt-what">${esc(w.what)}</div>` : ''}
      <div class="wt-meta"><span>${meta}</span>${remind}</div>
    </div>
    <div class="wt-acts">
      <button type="button" class="wt-btn" data-wact="back" title="Действие пришло — вернуть задачу в список">${wIco('check')}<span>Пришло</span></button>
      ${o.compact ? '' : `<button type="button" class="wt-btn wt-sub" data-wact="remind" title="Напомнить">${wIco('bell')}<span>Напомнить</span></button>`}
    </div>
  </div>`;
}

/* Список ожиданий, сгруппированный по людям; сверху — кто дольше ждёт */
export function waitListHTML(o = {}) {
  const list = waitingTasks();
  if (!list.length) return `<div class="wt-empty" data-wait-drop>${wIco('clock', 18)}<span>${o.emptyText || 'Перетащите сюда задачу, которая ждёт чужого действия'}</span></div>`;
  const groups = new Map();
  for (const t of list) {
    const k = t.wait.personId && getPerson(t.wait.personId) ? 'p:' + t.wait.personId : (t.wait.who ? 'w:' + t.wait.who.toLowerCase() : '-');
    if (!groups.has(k)) groups.set(k, { name: whoOf(t.wait) || 'Без человека', items: [] });
    groups.get(k).items.push(t);
  }
  const gs = [...groups.values()].sort((a, b) => (b.name !== 'Без человека') - (a.name !== 'Без человека') || waitDays(b.items[0]) - waitDays(a.items[0]));
  return gs.map(g => `<div class="wt-group">
      <div class="wt-ghead"><span class="wt-av">${g.name === 'Без человека' ? '—' : esc(initials(g.name))}</span><b>${esc(g.name)}</b><span class="wt-n">${g.items.length}</span></div>
      ${g.items.map(t => waitCardHTML(t, { compact: o.compact, noWho: true })).join('')}
    </div>`).join('');
}

/* Действия карточек (делегирование: перерисовка не ломает) */
let bound = false;
export function bindWaitActions() {
  if (bound) return;
  bound = true;
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-wact]');
    if (!b) return;
    const card = b.closest('[data-wait]');
    const t = card && getTask(card.dataset.wait);
    if (!t) return;
    e.stopPropagation();
    const act = b.dataset.wact;
    if (act === 'back') comeBack(t, card);
    else if (act === 'remind') openRemindMenu(t, b);
    else if (act === 'open') import('./sheet.js').then(m => m.openSheet(t));
  });
}

/* «Пришло»: карточка улетает, задача возвращается на сегодня как «Начато» */
async function comeBack(t, card) {
  if (card && !reduced() && card.animate) {
    await card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-24px) scale(.97)' }],
      { duration: BASE, easing: EASE_IN, fill: 'forwards' }).finished.catch(() => {});
  }
  await returnFromWait(t.id);
  changed();
  toast(`«${t.title}» вернулась в список на сегодня`, async () => {
    const cur = getTask(t.id);
    if (!cur) return;
    const log = (cur.waitLog || []).slice();
    const last = log.pop();
    const days = { ...(cur.days || {}) };
    if (days[today()] === 'started') delete days[today()];
    const { updateTask } = await import('./store.js');
    await updateTask(cur.id, { wait: { since: last ? last.from : today(), personId: last ? last.personId : '', who: last ? last.who : '', what: last ? last.what : '', remindAt: '' }, waitLog: log, days });
    changed();
  });
}

/* Короткое уведомление с «Отменить» */
function toast(text, undo) {
  let el = document.getElementById('waitToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'waitToast';
    el.className = 'wt-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.innerHTML = `${wIco('check', 16)}<span>${esc(text)}</span>${undo ? '<button type="button">Отменить</button>' : ''}`;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 4200);
  const b = el.querySelector('button');
  if (b) b.onclick = () => { el.classList.remove('show'); undo(); };
}

/* ── Меню «Напомнить»: позвонить/написать человеку или отложить ── */
function openRemindMenu(t, anchor) {
  closeMenus();
  const p = t.wait && t.wait.personId ? getPerson(t.wait.personId) : null;
  const m = document.createElement('div');
  m.className = 'cmenu wt-menu';
  const items = [];
  if (p && p.phone) items.push(`<a href="tel:${esc(p.phone.replace(/[^+\d]/g, ''))}">${wIco('phone', 16)}<span>Позвонить · ${esc(p.phone)}</span></a>`);
  if (p && p.email) items.push(`<a href="mailto:${esc(p.email)}?subject=${encodeURIComponent(t.title)}">${wIco('mail', 16)}<span>Написать</span></a>`);
  items.push(`<button type="button" data-n="1">${wIco('bell', 16)}<span>Напомнить завтра</span></button>`);
  items.push(`<button type="button" data-n="3">${wIco('bell', 16)}<span>Через 3 дня</span></button>`);
  items.push(`<button type="button" data-n="7">${wIco('bell', 16)}<span>Через неделю</span></button>`);
  m.innerHTML = items.join('');
  document.body.appendChild(m);
  placeMenu(m, anchor);
  m.querySelectorAll('[data-n]').forEach(b => b.onclick = async () => { closeMenus(); await snoozeWait(t.id, +b.dataset.n); changed(); });
  m.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setTimeout(closeMenus, 50)));
}
function placeMenu(m, anchor) {
  const r = anchor.getBoundingClientRect();
  m.style.width = '232px';
  const mw = 232, mh = m.offsetHeight || 200;
  const x = Math.min(Math.max(8, r.right - mw), innerWidth - mw - 8);
  let y = r.bottom + 6;
  if (y + mh > innerHeight - 8) y = r.top - mh - 6;
  m.style.left = x + 'px';
  m.style.top = Math.max(8, y) + 'px';
  requestAnimationFrame(() => m.classList.add('open'));
  setTimeout(() => {
    const close = e => { if (!m.contains(e.target)) { closeMenus(); document.removeEventListener('pointerdown', close, true); } };
    document.addEventListener('pointerdown', close, true);
  }, 0);
}
export function closeMenus() {
  document.querySelectorAll('.wt-menu').forEach(m => {
    m.classList.remove('open');
    setTimeout(() => m.remove(), 240);
  });
}

/* ══ Окно «В ожидание» ══
   taskId — отправить существующую задачу; без него (o.create) — новая
   задача сразу в ожидание (из карточки человека: «Поручить…»). */
let dlgOpen = false;
export function openWaitDialog(taskId, o = {}) {
  if (dlgOpen) return;
  const t = taskId ? getTask(taskId) : null;
  if (taskId && !t) return;
  dlgOpen = true;
  const w = (t && t.wait) || {};
  let personId = o.personId || w.personId || '';
  let remind = 3;
  const people = getPeople('all');
  const ov = document.createElement('div');
  ov.className = 'wd-overlay';
  ov.innerHTML = `<div class="wd glass" role="dialog" aria-modal="true" aria-labelledby="wdTitle">
    <div class="wd-cap" id="wdTitle">${t ? 'в ожидание' : 'поручить'}</div>
    ${t ? `<div class="wd-task" style="--mc:var(--mode-${esc(t.mode)})"><i></i><b>${esc(t.title)}</b></div>`
      : `<input class="wd-in wd-title" maxlength="200" placeholder="Что нужно сделать…" aria-label="Задача">`}
    <div class="wd-cap">от кого</div>
    <div class="wd-people">
      ${people.map(p => `<button type="button" class="wd-pick${p.id === personId ? ' on' : ''}" data-pid="${esc(p.id)}" aria-pressed="${p.id === personId}"><span class="wd-av">${esc(initials(p.name))}</span>${esc(p.name)}</button>`).join('')}
      <input class="wd-in wd-who" maxlength="60" placeholder="${people.length ? 'или кто-то другой…' : 'Кто: «бухгалтерия», «банк»…'}" aria-label="От кого" value="${esc(!w.personId ? (w.who || '') : '')}">
    </div>
    <label class="wd-cap" for="wdWhat">чего жду</label>
    <input id="wdWhat" class="wd-in wd-what" maxlength="200" placeholder="Например: пришлёт подписанный договор" value="${esc(w.what || '')}">
    <div class="wd-cap">напомнить</div>
    <div class="wd-seg" role="group" aria-label="Напомнить">
      ${[[1, 'Завтра'], [3, 'Через 3 дня'], [7, 'Через неделю'], [0, 'Не надо']].map(([n, l]) => `<button type="button" data-rem="${n}" aria-pressed="${n === remind}">${l}</button>`).join('')}
    </div>
    <div class="wd-foot"><span class="wd-hint">Поля можно пропустить</span>
      <button type="button" class="wd-cancel">Отмена</button>
      <button type="button" class="wd-ok">В «Жду»</button></div>
  </div>`;
  document.body.appendChild(ov);
  const pane = ov.querySelector('.wd');
  const src = o.from && o.from.isConnected ? o.from : null;
  if (!growFrom(pane, src, () => {})) pane.classList.add('wd-in-anim');
  if (!reduced()) ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: BASE, easing: EASE });

  const whoIn = ov.querySelector('.wd-who');
  const setPick = id => {
    personId = id;
    ov.querySelectorAll('.wd-pick').forEach(b => { const on = b.dataset.pid === id; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  };
  ov.querySelectorAll('.wd-pick').forEach(b => b.onclick = () => { setPick(personId === b.dataset.pid ? '' : b.dataset.pid); if (personId) whoIn.value = ''; });
  whoIn.oninput = () => { if (whoIn.value.trim()) setPick(''); };
  ov.querySelectorAll('[data-rem]').forEach(b => b.onclick = () => {
    remind = +b.dataset.rem;
    ov.querySelectorAll('[data-rem]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });

  const close = () => {
    dlgOpen = false;
    ov.style.pointerEvents = 'none';
    if (!reduced()) ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: BASE, easing: EASE_IN, fill: 'forwards' });
    const back = src && src.isConnected ? src : null;
    if (!shrinkTo(pane, back, () => ov.remove())) {
      if (!reduced()) pane.animate([{ transform: 'none' }, { transform: 'translateY(14px) scale(.97)' }], { duration: BASE, easing: EASE_IN, fill: 'forwards' });
      setTimeout(() => ov.remove(), BASE);
    }
  };
  const ok = async () => {
    const data = {
      personId, who: personId ? '' : whoIn.value, what: ov.querySelector('.wd-what').value,
      remindAt: remind ? addDays(today(), remind) : '',
    };
    let id = taskId;
    if (!id) {
      const ti = ov.querySelector('.wd-title');
      const title = ti.value.trim();
      if (!title) { ti.focus(); return; }
      const p = personId ? getPerson(personId) : null;
      const nt = await createTask({ title, mode: p && p.mode && p.mode !== 'all' ? p.mode : undefined, days: {} });
      id = nt.id;
    }
    await sendToWait(id, data);
    close();
    changed();
    if (o.onDone) o.onDone(id);
  };
  ov.querySelector('.wd-ok').onclick = ok;
  ov.querySelector('.wd-cancel').onclick = close;
  ov.addEventListener('pointerdown', e => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); ok(); }
  });
  setTimeout(() => { const f = ov.querySelector('.wd-title') || ov.querySelector('.wd-what'); if (f) f.focus({ preventScroll: true }); }, 60);
}

/* ══ Перетаскивание строки задачи на «Жду» (мышь) ══
   Строка приподнимается копией и едет за курсором; цели [data-wait-drop]
   подсвечиваются. Отпустили над целью — открывается окно «В ожидание». */
export const hasDropTarget = () => [...document.querySelectorAll('[data-wait-drop]')].some(el => el.getClientRects().length);
export function startLift(row, taskId, e0) {
  const r = row.getBoundingClientRect();
  const gx = e0.clientX - r.left, gy = e0.clientY - r.top;
  const ghost = row.cloneNode(true);
  ghost.classList.add('wt-lift');
  Object.assign(ghost.style, { position: 'fixed', left: '0', top: '0', width: r.width + 'px', height: r.height + 'px', margin: '0', zIndex: 80, pointerEvents: 'none' });
  (row.parentElement || document.body).appendChild(ghost);
  const o = ghost.getBoundingClientRect();
  const ox = o.left, oy = o.top;
  const place = (x, y) => { ghost.style.transform = `translate(${x - gx - ox}px, ${y - gy - oy}px) rotate(-1.5deg) scale(1.02)`; };
  place(e0.clientX, e0.clientY);
  row.classList.add('wt-lifted');
  document.body.classList.add('wt-dragging');
  let over = null;
  const targetAt = (x, y) => {
    ghost.style.visibility = 'hidden';
    const el = document.elementFromPoint(x, y);
    ghost.style.visibility = '';
    return el ? el.closest('[data-wait-drop]') : null;
  };
  const move = e => {
    place(e.clientX, e.clientY);
    const t = targetAt(e.clientX, e.clientY);
    if (t !== over) { if (over) over.classList.remove('wt-over'); over = t; if (over) over.classList.add('wt-over'); }
  };
  const up = e => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    document.body.classList.remove('wt-dragging');
    const target = e.type === 'pointerup' ? targetAt(e.clientX, e.clientY) : null;
    if (over) over.classList.remove('wt-over');
    row.classList.remove('wt-lifted');
    if (target) {
      ghost.remove();
      openWaitDialog(taskId, { from: target });
    } else if (!reduced() && ghost.animate) {
      ghost.animate([{ transform: ghost.style.transform, opacity: 1 }, { transform: `translate(${r.left - ox}px, ${r.top - oy}px)`, opacity: .4 }],
        { duration: BASE, easing: EASE, fill: 'forwards' }).finished.then(() => ghost.remove(), () => ghost.remove());
    } else ghost.remove();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

export const waitCount = () => waitingTasks().length;
export const waitDueCount = () => waitingTasks().filter(remindDue).length;
