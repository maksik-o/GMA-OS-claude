import { dbAll, dbPut, dbBulk } from './db.js';
import { morph, fadeRemove, growFrom, shrinkTo, BASE, EASE, EASE_IN } from './anim.js';
import { uid, esc, MODES, getTask, createTask, today, state as tstate, isDone, fmtD } from './store.js';
import { waitCardHTML, openWaitDialog } from './wait.js';

const STORE = 'contacts';
const state = { people: [] };
const listeners = [];

export const contactsSubscribe = fn => listeners.push(fn);
let pending = false;
const notify = () => {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    listeners.forEach(fn => fn());
  }, 100);
};
const userChange = () => document.dispatchEvent(new CustomEvent('user-change'));

export async function init() {
  state.people = (await dbAll(STORE)).map(m => {
    if (m.kind !== 'group' && !Array.isArray(m.assignments)) m.assignments = [];
    if (!m.mode) m.mode = 'all';
    return m;
  });
  await ensureGroups();
}

export const getPeople = mode => {
  const list = state.people.filter(p => !p.deleted && p.kind !== 'group'
    && (!mode || mode === 'all' || p.mode === 'all' || p.mode === mode));
  return list.sort((a, b) => a.name.localeCompare(b.name));
};
/* ── Группы контактов ──
   Живут в том же сторе, что и люди, с пометкой kind: 'group'.
   Так они автоматически попадают в существующую синхронизацию
   и не требуют новой версии базы. */
export const DEFAULT_GROUPS = [
  { id: 'g-home',  name: 'Дом',    mode: 'home'  },
  { id: 'g-work',  name: 'Работа', mode: 'work'  },
  { id: 'g-study', name: 'Учёба',  mode: 'study' },
];
export const getGroups = () => state.people
  .filter(g => g.kind === 'group' && !g.deleted)
  .sort((a, b) => (a.order || 0) - (b.order || 0));
export const getGroup = id => state.people.find(g => g.id === id && g.kind === 'group');
async function ensureGroups() {
  let changed = false;
  for (let i = 0; i < DEFAULT_GROUPS.length; i++) {
    const d = DEFAULT_GROUPS[i];
    if (getGroup(d.id)) continue;
    const g = { id: d.id, kind: 'group', name: d.name, mode: d.mode, order: i,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.people.push(g);
    await dbPut(STORE, g);
    changed = true;
  }
  /* Миграция: у кого нет группы — раскладываем по прежнему режиму */
  for (const p of state.people) {
    if (p.kind === 'group' || p.groupId) continue;
    p.groupId = ({ home: 'g-home', work: 'g-work', study: 'g-study' })[p.mode] || '';
    p.updatedAt = new Date().toISOString();
    await dbPut(STORE, p);
    changed = true;
  }
  if (changed) notify();
}
export async function addGroup(name) {
  const g = { id: uid(), kind: 'group', name: (name || 'Новая группа').trim().slice(0, 40),
              mode: 'all', order: getGroups().length,
              createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.people.push(g);
  await dbPut(STORE, g);
  notify();
  userChange();
  return g;
}
export async function renameGroup(id, name) {
  const g = getGroup(id);
  if (!g) return;
  g.name = (name || g.name).trim().slice(0, 40) || g.name;
  g.renamed = true;
  g.updatedAt = new Date().toISOString();
  await dbPut(STORE, g);
  notify();
  userChange();
}
export async function removeGroup(id) {
  const g = getGroup(id);
  if (!g) return;
  for (const p of state.people) {
    if (p.kind !== 'group' && p.groupId === id) {
      p.groupId = '';
      p.updatedAt = new Date().toISOString();
      await dbPut(STORE, p);
    }
  }
  g.deleted = true;
  g.updatedAt = new Date().toISOString();
  addContactTombstone(id);
  await dbPut(STORE, g);
  notify();
  userChange();
}
export async function setPersonGroup(personId, groupId) {
  const g = getGroup(groupId);
  await updatePerson(personId, { groupId, mode: g && g.mode !== 'all' ? g.mode : 'all' });
}
export const getPerson = id => state.people.find(p => p.id === id);

/* ── Поручения → «Жду» (один раз) ──
   Незакрытое поручение становится задачей в ожидании от этого человека.
   Id задачи выводится из id поручения: на двух устройствах миграция
   даст одну и ту же задачу, а синхронизация их сольёт. Закрытые
   поручения остаются историей («Готово» в карточке). */
export async function migrateAssignments(isTombstoned) {
  let n = 0;
  for (const p of state.people) {
    if (p.kind === 'group' || p.deleted || !Array.isArray(p.assignments)) continue;
    let touched = false;
    for (const a of p.assignments) {
      if (a.wTask || a.status === 'done' || a.status === 'skipped') continue;
      const id = 'asg-' + a.id;
      if (!getTask(id) && !(isTombstoned && isTombstoned(id))) {
        await createTask({
          id, title: a.title || 'Поручение', mode: p.mode && p.mode !== 'all' ? p.mode : 'work', days: {},
          wait: { since: String(a.createdAt || '').slice(0, 10) || today(), personId: p.id, who: '', what: a.note || '', remindAt: '' },
        });
        n++;
      }
      a.wTask = id;
      touched = true;
    }
    if (touched) { p.updatedAt = new Date().toISOString(); await dbPut(STORE, p); }
  }
  if (n) notify();
  return n;
}

export async function addPerson(data) {
  const p = {
    id: uid(), name: (data.name || '').trim(), note: data.note || '', mode: data.mode || 'all',
    phone: data.phone || '', email: data.email || '', birthday: data.birthday || '',
    assignments: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  state.people.push(p);
  await dbPut(STORE, p);
  notify();
  userChange();
  return p;
}

export async function updatePerson(id, patch) {
  const p = getPerson(id);
  if (!p) return;
  Object.assign(p, patch);
  p.updatedAt = new Date().toISOString();
  await dbPut(STORE, p);
  notify();
  userChange();
}

export async function removePerson(id) {
  const p = getPerson(id);
  if (!p) return;
  addContactTombstone(id);
  p.deleted = true;
  await dbPut(STORE, p);
  notify();
  userChange();
}

export async function addAssignment(personId, data) {
  const p = getPerson(personId);
  if (!p) return;
  const a = {
    id: uid(), title: (data.title || '').trim(), note: data.note || '',
    status: data.status || 'todo', createdAt: new Date().toISOString(), doneAt: null
  };
  p.assignments.push(a);
  p.updatedAt = new Date().toISOString();
  await dbPut(STORE, p);
  notify();
  userChange();
  return a;
}

export async function updateAssignment(personId, aid, patch) {
  const p = getPerson(personId);
  if (!p) return;
  const a = p.assignments.find(x => x.id === aid);
  if (!a) return;
  Object.assign(a, patch);
  if (patch.status === 'done' && !a.doneAt) a.doneAt = new Date().toISOString();
  if (patch.status !== 'done') a.doneAt = null;
  p.updatedAt = new Date().toISOString();
  await dbPut(STORE, p);
  notify();
  userChange();
}

export async function removeAssignment(personId, aid) {
  const p = getPerson(personId);
  if (!p) return;
  p.assignments = p.assignments.filter(a => a.id !== aid);
  p.updatedAt = new Date().toISOString();
  await dbPut(STORE, p);
  notify();
  userChange();
}

/* Подписи и цвета режимов меняются в «Настройках режимов», поэтому
   берём их из MODES и CSS-переменных, а не из строк в коде. */
const modeLabel = m => (MODES.find(x => x.id === m) || {}).label || m;
const DEFAULT_GROUP_MODE = { 'g-home': 'home', 'g-work': 'work', 'g-study': 'study' };
/* Имя стандартной группы следует за названием режима, пока пользователь
   не переименовал саму группу. */
const groupName = g => {
  if (!g) return 'Без группы';
  const m = DEFAULT_GROUP_MODE[g.id];
  if (m && !g.renamed) return modeLabel(m);
  return g.name;
};
function modeColor(m) {
  const cs = getComputedStyle(document.documentElement);
  return ({
    work: cs.getPropertyValue('--mode-work'),
    home: cs.getPropertyValue('--mode-home'),
    study: cs.getPropertyValue('--mode-study'),
    all: cs.getPropertyValue('--mode-all')
  }[m] || '#888').trim();
}

/* ── Представление: панели-группы ──
   Панель на каждую группу; внутри — карточки людей. Режим приложения
   больше не фильтрует список: распределение идёт по группам, а три
   стандартные группы соответствуют прежним режимам. */
const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
/* Карточка человека (по макету): шапка с аватаром и связью, «Жду от…» —
   ожидания с этим человеком (это и есть поручения), «+ Поручить…» и
   короткая история «Готово». */
const ICON = {
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16z"/>',
  del: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  cake: '<path d="M4 21h16M5 21v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7M12 12V8M12 5.5v.5"/>',
};
const ic = (k, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const waitsOf = pid => tstate.tasks.filter(t => !t.deleted && t.wait && t.wait.personId === pid)
  .sort((a, b) => String(a.wait.since).localeCompare(String(b.wait.since)));
function doneOf(p) {
  const old = (p.assignments || []).filter(a => a.status === 'done' || a.status === 'skipped')
    .map(a => ({ title: a.title, at: String(a.doneAt || a.createdAt || '').slice(0, 10) }));
  const back = tstate.tasks.filter(t => !t.deleted && !t.wait && isDone(t) && (t.waitLog || []).some(w => w.personId === p.id))
    .map(t => ({ title: t.title, at: String(t.doneAt || t.updatedAt || '').slice(0, 10), id: t.id }));
  return [...old, ...back].sort((a, b) => b.at.localeCompare(a.at));
}
const personCardHTML = (p, g) => {
  const waits = waitsOf(p.id);
  const done = doneOf(p);
  const sub = [groupName(g), p.phone, p.birthday ? fmtD(p.birthday) : ''].filter(Boolean).map(esc).join(' · ');
  return `<article class="contact-card" data-id="${p.id}" draggable="true" style="--pc:${modeColor(p.mode)}">
    <div class="cc-grip" title="Перетащите в другую группу" aria-hidden="true">⠿</div>
    <header class="cc-head">
      <div class="cc-av" title="Перетащите в другую группу">${esc(initials(p.name))}</div>
      <div class="cc-id">
        <h4 class="cc-name">${esc(p.name)}</h4>
        ${sub ? `<div class="cc-sub">${sub}</div>` : ''}
      </div>
      <div class="cc-acts">
        ${p.phone ? `<a class="cc-ib" href="tel:${esc(p.phone.replace(/[^+\d]/g, ''))}" title="Позвонить" aria-label="Позвонить">${ic('phone')}</a>` : ''}
        ${p.email ? `<a class="cc-ib" href="mailto:${esc(p.email)}" title="Написать" aria-label="Написать">${ic('mail')}</a>` : ''}
        <button type="button" class="cc-ib contact-edit" title="Редактировать" aria-label="Редактировать">${ic('edit')}</button>
        <button type="button" class="cc-ib cc-del contact-del" title="Удалить" aria-label="Удалить">${ic('del')}</button>
      </div>
    </header>
    ${p.note ? `<p class="cc-note">${esc(p.note)}</p>` : ''}
    <div class="cc-sec"><span class="cc-cap">жду</span>${waits.length ? `<span class="cc-n">${waits.length}</span>` : ''}</div>
    ${waits.map(t => waitCardHTML(t, { noWho: true })).join('')}
    <button type="button" class="cc-assign" data-assign="${p.id}">+ Поручить…</button>
    ${done.length ? `<div class="cc-sec"><span class="cc-cap">готово</span></div>
      <div class="cc-done">${done.slice(0, 3).map(d => `<div class="cc-done-row"><span>${esc(d.title)}</span><small>${d.at ? esc(fmtD(d.at)) : ''}</small></div>`).join('')}
      ${done.length > 3 ? `<small class="cc-more">и ещё ${done.length - 3}</small>` : ''}</div>` : ''}
  </article>`;
};

/* ── Перенос контакта между группами ──
   Pointer-события вместо HTML5 drag-and-drop: на iOS нативный DnD в
   вебе не работает, а здесь один код и для мыши, и для пальца.
   Карточка едет за курсором копией, а группа под ней подсвечивается. */
function bindDrag(container, mode) {
  let ghost = null, srcCard = null, overEl = null, started = false, sx = 0, sy = 0, gx = 0, gy = 0;
  const groupAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('.cgroup') : null;
  };
  const clearOver = () => {
    if (overEl) overEl.classList.remove('drop-over');
    overEl = null;
  };
  const finish = async (x, y) => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    document.removeEventListener('touchmove', block);
    document.body.classList.remove('cc-dragging');
    if (ghost) { ghost.remove(); ghost = null; }
    if (srcCard) srcCard.classList.remove('dragging');
    const target = started ? groupAt(x, y) : null;
    const gid = target ? target.dataset.gid : null;
    clearOver();
    const card = srcCard;
    srcCard = null;
    started = false;
    if (card && gid != null && gid !== '' ) {
      const p = getPerson(card.dataset.id);
      if (p && p.groupId !== gid) {
        await setPersonGroup(card.dataset.id, gid);
        renderContactsView(container, mode);
      }
    }
  };
  const block = e => { if (started && e.cancelable) e.preventDefault(); };
  const move = e => {
    if (!srcCard) return;
    if (!started) {
      if (Math.abs(e.clientX - sx) < 7 && Math.abs(e.clientY - sy) < 7) return;
      started = true;
      const r = srcCard.getBoundingClientRect();
      gx = sx - r.left;
      gy = sy - r.top;
      ghost = srcCard.cloneNode(true);
      ghost.classList.add('cc-ghost');
      ghost.style.width = r.width + 'px';
      document.body.appendChild(ghost);
      srcCard.classList.add('dragging');
      document.body.classList.add('cc-dragging');
      try { navigator.vibrate(8); } catch {}
    }
    ghost.style.transform = `translate(${e.clientX - gx}px, ${e.clientY - gy}px)`;
    const g = groupAt(e.clientX, e.clientY);
    if (g !== overEl) {
      clearOver();
      if (g && g.dataset.gid) { overEl = g; g.classList.add('drop-over'); }
    }
  };
  const up = e => finish(e.clientX, e.clientY);
  container.querySelectorAll('.contact-card').forEach(card => {
    card.addEventListener('dragstart', e => e.preventDefault());
    card.addEventListener('pointerdown', e => {
      if (!e.target.closest('.cc-grip') && !e.target.closest('.cc-av')) return;
      e.preventDefault();
      srcCard = card;
      sx = e.clientX;
      sy = e.clientY;
      started = false;
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
      document.addEventListener('touchmove', block, { passive: false });
    });
  });
}

/* Перерисовка «на месте» с движением (anim.morph); сама отрисовка — ниже */
export function renderContactsView(container, mode) { morph(container, () => renderContactsViewNow(container, mode)); }
function renderContactsViewNow(container, mode) {
  if (!container) return;
  const groups = getGroups();
  const people = getPeople('all');
  const byGroup = new Map(groups.map(g => [g.id, []]));
  const loose = [];
  for (const p of people) {
    if (p.groupId && byGroup.has(p.groupId)) byGroup.get(p.groupId).push(p);
    else loose.push(p);
  }
  const isDefault = id => DEFAULT_GROUPS.some(d => d.id === id);
  const panel = (g, list) => `<section class="cgroup" data-gid="${g ? g.id : ''}" style="--gc:${g ? modeColor(g.mode) : 'var(--dim)'}">
      <header class="cgroup-head">
        <span class="cgroup-dot"></span>
        <h3 class="cgroup-name">${esc(groupName(g))}</h3>
        <span class="cgroup-count">${list.length}</span>
        ${g ? `<button type="button" class="icon-btn cg-rename" title="Переименовать">✎</button>` : ''}
        ${g && !isDefault(g.id) ? `<button type="button" class="icon-btn cg-del" title="Удалить группу">✕</button>` : ''}
        ${g ? `<button type="button" class="icon-btn cg-add" title="Добавить человека">＋</button>` : ''}
      </header>
      <div class="cgroup-body">${list.length ? list.map(p => personCardHTML(p, g)).join('')
        : '<p class="cgroup-empty">Пусто — нажмите «＋», чтобы добавить человека</p>'}</div>
    </section>`;

  container.innerHTML =
    `<div class="cgroups">${groups.map(g => panel(g, byGroup.get(g.id) || [])).join('')}`
    + (loose.length ? panel(null, loose) : '')
    + `<button type="button" class="cgroup-new">＋ Новая группа</button></div>`;

  container.querySelector('.cgroup-new').onclick = async () => {
    const name = prompt('Название группы:', '');
    if (name === null) return;
    const g = await addGroup(name);
    renderContactsView(container, mode);
    const el = container.querySelector(`.cgroup[data-gid="${g.id}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  container.querySelectorAll('.cgroup').forEach(sec => {
    const gid = sec.dataset.gid;
    const rn = sec.querySelector('.cg-rename');
    if (rn) rn.onclick = async () => {
      const g = getGroup(gid);
      const name = prompt('Название группы:', g ? g.name : '');
      if (name === null || !name.trim()) return;
      await renameGroup(gid, name);
      renderContactsView(container, mode);
    };
    const dl = sec.querySelector('.cg-del');
    if (dl) dl.onclick = async () => {
      if (!confirm('Удалить группу? Люди из неё останутся, но без группы.')) return;
      await removeGroup(gid);
      renderContactsView(container, mode);
    };
    const ad = sec.querySelector('.cg-add');
    if (ad) ad.onclick = () => openNewPersonSheet(gid);
  });

  bindDrag(container, mode);
  container.querySelectorAll('.contact-card').forEach(card => {
    const pid = card.dataset.id;
    card.querySelector('.contact-edit').onclick = () => openPersonEditor(pid, mode);
    card.querySelector('.contact-del').onclick = async () => {
      if (confirm('Удалить человека и все его поручения?')) {
        await removePerson(pid);
        renderContactsView(container, mode);
      }
    };
    const as = card.querySelector('[data-assign]');
    if (as) as.onclick = () => openWaitDialog(null, { personId: pid, from: as });
  });
}

/* Кнопка «+» приложения в режиме контактов заводит человека, а не задачу */
export function openNewPersonSheet(groupId) {
  const groups = getGroups();
  const gid = groupId || (groups[0] || {}).id || '';
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay';
  ov.innerHTML = `<div class="notes-list-modal glass fin-modal">
    <header class="notes-list-head"><h3>Новый человек</h3>
      <button type="button" class="notes-list-close">✕</button></header>
    <div class="fin-form">
      <label class="fin-field"><span>Имя</span><input class="fin-in np-name" type="text" maxlength="100" placeholder="Имя человека"></label>
      <label class="fin-field"><span>Группа</span><select class="fin-in np-group">${groups
        .map(g => `<option value="${g.id}"${g.id === gid ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    </div>
    <div class="ne-actions"><span class="spacer"></span>
      <button type="button" class="btn primary np-save">Добавить</button></div></div>`;
  document.body.appendChild(ov);
  const close = () => fadeRemove(ov);
  ov.querySelector('.notes-list-close').onclick = close;
  ov.onclick = e => { if (e.target === ov) close(); };
  const name = ov.querySelector('.np-name');
  const save = async () => {
    const v = name.value.trim();
    if (!v) { name.focus(); return; }
    const g = getGroup(ov.querySelector('.np-group').value);
    await addPerson({ name: v, mode: g && g.mode !== 'all' ? g.mode : 'all' });
    const added = getPeople('all').find(p => p.name === v);
    if (added && g) await setPersonGroup(added.id, g.id);
    close();
    const cv = document.getElementById('contactsView');
    if (cv && !cv.hidden) renderContactsView(cv, 'all');
  };
  ov.querySelector('.np-save').onclick = save;
  name.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  setTimeout(() => name.focus(), 50);
}

let editorOpen = false;
export function openPersonEditor(personId, mode) {
  if (editorOpen) return;
  const p = getPerson(personId);
  if (!p) return;
  editorOpen = true;
  const overlay = document.createElement('div');
  overlay.className = 'person-editor-backdrop';
  overlay.innerHTML = '<div class="person-editor glass"><header class="ed-head"><span class="ed-title">Человек</span><span class="spacer"></span><button type="button" class="icon-btn pe-cancel" title="Закрыть">✕</button></header><div class="ed-scroll"><textarea name="peName" class="f-title pe-name" rows="1" maxlength="100" placeholder="Имя">' + esc(p.name) + '</textarea><section class="ed-card"><h4>Группа</h4><div class="chip-row pe-group">' + getGroups().map(g => '<button type="button" class="chip' + (p.groupId === g.id ? ' on' : '') + '" data-gid="' + g.id + '">' + esc(g.name) + '</button>').join('') + '</div></section><section class="ed-card"><h4>Контакты</h4><input name="pePhone" class="f-title pe-phone" placeholder="Телефон" value="' + esc(p.phone || '') + '"><input name="peEmail" class="f-title pe-email" placeholder="Email" value="' + esc(p.email || '') + '"><input name="peBirthday" class="f-title pe-birthday" type="date" value="' + (p.birthday || '') + '"></section><section class="ed-card"><h4>Заметка</h4><textarea name="peNote" class="f-title pe-note" rows="2" placeholder="Заметка о человеке...">' + esc(p.note || '') + '</textarea></section></div><div class="ed-actions"><button type="button" class="btn danger pe-delete">Удалить</button><span class="spacer"></span><button type="button" class="btn pe-cancel2">✕</button><button type="button" class="btn primary pe-save">✓</button></div></div>';
  document.body.appendChild(overlay);
  /* Окно вырастает из карточки человека и сжимается обратно в неё */
  const pane = overlay.querySelector('.person-editor');
  const cardOf = () => [...document.querySelectorAll(`.contact-card[data-id="${CSS.escape(personId)}"]`)].find(c => c.getClientRects().length) || null;
  if (growFrom(pane, cardOf(), () => {})) {
    pane.style.animation = 'none';
    overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: BASE, easing: EASE });
  }
  const nameEl = overlay.querySelector('.pe-name');
  nameEl.style.height = 'auto';
  nameEl.style.height = nameEl.scrollHeight + 'px';
  nameEl.addEventListener('input', () => {
    nameEl.style.height = 'auto';
    nameEl.style.height = nameEl.scrollHeight + 'px';
  });
  overlay.querySelectorAll('.pe-group .chip').forEach(b => {
    b.onclick = () => {
      overlay.querySelectorAll('.pe-group .chip').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    };
  });
  const close = () => {
    editorOpen = false;
    if (overlay.dataset.closing) return;
    const card = cardOf();
    if (!card) { fadeRemove(overlay); return; }
    overlay.dataset.closing = '1';
    overlay.style.pointerEvents = 'none';
    overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: BASE, easing: EASE_IN, fill: 'forwards' });
    shrinkTo(pane, card, () => overlay.remove());
  };
  overlay.querySelectorAll('.pe-cancel, .pe-cancel2').forEach(b => { b.onclick = close; });
  overlay.querySelector('.pe-save').onclick = async () => {
    const gsel = overlay.querySelector('.pe-group .chip.on');
    const grp = gsel ? getGroup(gsel.dataset.gid) : null;
    await updatePerson(personId, {
      name: nameEl.value.trim() || p.name,
      groupId: grp ? grp.id : (p.groupId || ''),
      mode: grp && grp.mode !== 'all' ? grp.mode : 'all',
      phone: overlay.querySelector('.pe-phone').value.trim(),
      email: overlay.querySelector('.pe-email').value.trim(),
      birthday: overlay.querySelector('.pe-birthday').value,
      note: overlay.querySelector('.pe-note').value
    });
    close();
    const cv = document.getElementById('contactsView');
    if (cv && !cv.hidden) renderContactsView(cv, mode);
  };
  overlay.querySelector('.pe-delete').onclick = async () => {
    if (confirm('Удалить человека и все его поручения?')) {
      await removePerson(personId);
      close();
      const cv = document.getElementById('contactsView');
      if (cv && !cv.hidden) renderContactsView(cv, mode);
    }
  };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

export const getContactsForSync = () => state.people;

// ── Tombstones для контактов ──
const CONTACT_TOMBSTONES_KEY = 'rl_contact_tombstones';
let contactTombstones = [];
function loadContactTombstones() {
  try {
    const raw = localStorage.getItem(CONTACT_TOMBSTONES_KEY);
    contactTombstones = raw ? JSON.parse(raw) : [];
  } catch { contactTombstones = []; }
}
function saveContactTombstones() {
  try { localStorage.setItem(CONTACT_TOMBSTONES_KEY, JSON.stringify(contactTombstones)); } catch {}
}
export function getContactTombstones() {
  return contactTombstones.slice();
}
export function addContactTombstone(id) {
  if (!id || contactTombstones.some(t => t.id === id)) return;
  contactTombstones.push({ id, deletedAt: Date.now() });
  saveContactTombstones();
}
export async function applyContactTombstones(server) {
  const arr = Array.isArray(server) ? server : [];
  const map = new Map();
  for (const t of contactTombstones) if (t && t.id) map.set(t.id, t);
  for (const t of arr) {
    if (!t || !t.id) continue;
    const existing = map.get(t.id);
    if (!existing || (t.deletedAt || 0) > (existing.deletedAt || 0)) map.set(t.id, t);
  }
  contactTombstones = [...map.values()];
  // Применяем tombstones к локальным контактам
  const tombSet = new Set(contactTombstones.map(t => t.id));
  state.people = state.people.filter(p => !tombSet.has(p.id));
  try { await dbBulk(STORE, state.people); } catch {}
  saveContactTombstones();
  notify();
}
loadContactTombstones();

export async function applyContactsMerged(people) {
  const remote = Array.isArray(people) ? people : [];
  const tombSet = new Set(contactTombstones.map(t => t.id));
  const byId = new Map();
  for (const p of state.people) {
    if (p && p.id && !tombSet.has(p.id)) byId.set(p.id, p);
  }
  for (const rp of remote) {
    if (!rp || !rp.id || tombSet.has(rp.id)) continue;
    if (!Array.isArray(rp.assignments)) rp.assignments = [];
    if (!rp.mode) rp.mode = 'all';
    const local = byId.get(rp.id);
    if (!local) {
      byId.set(rp.id, rp);
    } else if (String(rp.updatedAt || '') >= String(local.updatedAt || '')) {
      byId.set(rp.id, rp);
    }
  }
  state.people = [...byId.values()];
  try {
    await dbBulk(STORE, state.people);
  } catch (err) {
    console.error('[contacts] dbBulk failed:', err);
  }
  notify();
}
