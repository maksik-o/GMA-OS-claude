import { dbAll, dbPut, dbBulk } from './db.js';
import { uid, esc } from './store.js';

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

const modeLabel = m => ({ work: 'Работа', home: 'Дом', study: 'Учёба', all: 'Все' }[m] || m);
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
const personCardHTML = p => {
  const act = p.assignments.filter(a => a.status !== 'done');
  const done = p.assignments.filter(a => a.status === 'done').length;
  const contacts = [];
  if (p.phone) contacts.push(`<a class="cc-link" href="tel:${esc(p.phone.replace(/[^+\d]/g, ''))}" title="Позвонить">📞 ${esc(p.phone)}</a>`);
  if (p.email) contacts.push(`<a class="cc-link" href="mailto:${esc(p.email)}" title="Написать">✉ ${esc(p.email)}</a>`);
  if (p.birthday) contacts.push(`<span class="cc-link">🎂 ${esc(p.birthday)}</span>`);
  return `<article class="contact-card" data-id="${p.id}" draggable="true">
    <div class="cc-grip" title="Перетащите в другую группу">⠿</div>
    <header class="cc-head">
      <div class="cc-av" style="background:${modeColor(p.mode)}">${esc(initials(p.name))}</div>
      <div class="cc-id">
        <h4 class="cc-name">${esc(p.name)}</h4>
        <div class="cc-stat">
          <span class="cc-pill${act.length ? ' hot' : ''}">${act.length} активно</span>
          <span class="cc-pill dim">${done} выполнено</span>
        </div>
      </div>
      <div class="cc-acts">
        <button type="button" class="icon-btn contact-edit" title="Редактировать">✎</button>
        <button type="button" class="icon-btn contact-del" title="Удалить">✕</button>
      </div>
    </header>
    ${contacts.length ? `<div class="cc-links">${contacts.join('')}</div>` : ''}
    ${p.note ? `<p class="cc-note">${esc(p.note)}</p>` : ''}
    <div class="cc-tasks">
      ${p.assignments.length ? p.assignments.map(a => `<div class="assignment-row${a.status === 'done' ? ' a-done' : ''}" data-aid="${a.id}">
        <button type="button" class="a-status a-${a.status}" title="Статус"></button>
        <div class="a-body"><div class="a-title${a.status === 'done' ? ' a-done' : ''}">${esc(a.title)}</div>
        ${a.note ? `<div class="a-note">${esc(a.note)}</div>` : ''}</div>
        <button type="button" class="a-edit" title="Редактировать">✎</button>
        <button type="button" class="a-del" title="Удалить">✕</button>
      </div>`).join('') : '<p class="cc-empty">Поручений нет</p>'}
    </div>
    <div class="assignment-add">
      <input name="newAssTitle" class="f-title new-ass-title" placeholder="＋ новое поручение" maxlength="200">
      <button type="button" class="btn primary new-ass-btn">＋</button>
    </div>
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

export function renderContactsView(container, mode) {
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
        <h3 class="cgroup-name">${esc(g ? g.name : 'Без группы')}</h3>
        <span class="cgroup-count">${list.length}</span>
        ${g ? `<button type="button" class="icon-btn cg-rename" title="Переименовать">✎</button>` : ''}
        ${g && !isDefault(g.id) ? `<button type="button" class="icon-btn cg-del" title="Удалить группу">✕</button>` : ''}
        ${g ? `<button type="button" class="icon-btn cg-add" title="Добавить человека">＋</button>` : ''}
      </header>
      <div class="cgroup-body">${list.length ? list.map(personCardHTML).join('')
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
    const addTitle = card.querySelector('.new-ass-title'), addAssBtn = card.querySelector('.new-ass-btn');
    const doAddAss = async () => {
      const v = addTitle.value.trim();
      if (!v) return;
      await addAssignment(pid, { title: v });
      renderContactsView(container, mode);
    };
    addAssBtn.onclick = doAddAss;
    addTitle.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); doAddAss(); } };
    card.querySelectorAll('.assignment-row').forEach(row => {
      const aid = row.dataset.aid;
      row.querySelector('.a-status').onclick = async () => {
        const a = getPerson(pid).assignments.find(x => x.id === aid);
        const order = ['todo', 'started', 'done', 'skipped'];
        await updateAssignment(pid, aid, { status: order[(order.indexOf(a.status) + 1) % order.length] });
        renderContactsView(container, mode);
      };
      row.querySelector('.a-edit').onclick = async () => {
        const a = getPerson(pid).assignments.find(x => x.id === aid);
        const nt = prompt('Текст поручения:', a.title);
        if (nt === null) return;
        const nn = prompt('Заметка:', a.note || '');
        if (nn === null) return;
        await updateAssignment(pid, aid, { title: nt.trim() || a.title, note: nn });
        renderContactsView(container, mode);
      };
      row.querySelector('.a-del').onclick = async () => {
        if (confirm('Удалить поручение?')) {
          await removeAssignment(pid, aid);
          renderContactsView(container, mode);
        }
      };
    });
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
  const close = () => ov.remove();
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
    overlay.remove();
    editorOpen = false;
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
