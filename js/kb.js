/* ══════════════════════════════════════════════════════════════════
   Режим «База знаний».

   Заметки, разложенные по группам, со связями между собой и
   вложенными файлами. Всё в одном сторе IndexedDB ('kb'), тип записи
   в поле kind — так же, как сделаны финансы: не нужно поднимать
   версию базы под каждую новую сущность.

   Файлы лежат отдельно, в сторе 'kbfiles' (base64). В синхронизацию
   уходят только метаданные — сами файлы остаются на устройстве,
   иначе один вложенный PDF раздул бы полезную нагрузку sync.
   ══════════════════════════════════════════════════════════════════ */
import { dbAll, dbPut, dbBulk, dbGet, dbDel } from './db.js';
import { uid, esc, today, MODES } from './store.js';
import { getAllNotes, updateNoteById, deleteNote, notesSubscribe } from './notes.js';

const STORE = 'kb';
const FILES = 'kbfiles';
const state = { items: [] };
const listeners = [];
export const kbSubscribe = fn => listeners.push(fn);
let pending = false;
const notify = () => {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; listeners.forEach(fn => fn()); }, 50);
};
const userChange = () => document.dispatchEvent(new CustomEvent('user-change'));

const DEFAULT_GROUPS = [
  { id: 'kb-work', name: 'Работа', color: '#dc2626' },
  { id: 'kb-home', name: 'Дом', color: '#16a34a' },
  { id: 'kb-study', name: 'Учёба', color: '#2563eb' },
];
const PALETTE = ['#ef4444', '#f59e0b', '#10b981', '#2563eb', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

const all = kind => state.items.filter(i => i.kind === kind && !i.deleted);
export const kbGroups = () => all('group').sort((a, b) => (a.order || 0) - (b.order || 0));
export const kbNotes = () => [...all('note'), ...dailyNotes()]
  .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
export const kbItem = id => isDaily(id)
  ? dailyNotes().find(n => n.id === id) || null
  : state.items.find(i => i.id === id);

export async function init() {
  state.items = await dbAll(STORE);
  if (!all('group').length) {
    for (let i = 0; i < DEFAULT_GROUPS.length; i++) {
      const g = {
        ...DEFAULT_GROUPS[i], kind: 'group', order: i,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      state.items.push(g);
      await dbPut(STORE, g);
    }
  }
}
async function put(it) {
  it.updatedAt = new Date().toISOString();
  await dbPut(STORE, it);
  notify();
  userChange();
}
export async function kbSave(kind, data, id) {
  if (isDaily(id)) {
    const patch = {};
    if ('title' in data) patch.title = data.title;
    if ('html' in data) patch.html = data.html;
    if ('groupId' in data) {
      const m = groupMode(data.groupId);
      if (m) patch.mode = m;
    }
    if ('files' in data) patch.files = data.files;
    if ('links' in data) patch.links = data.links;
    await updateNoteById(dailyRealId(id), patch);
    notify();
    return kbItem(id);
  }
  let it = id ? kbItem(id) : null;
  if (!it) {
    it = { id: uid(), kind, createdAt: new Date().toISOString() };
    state.items.push(it);
  }
  Object.assign(it, data);
  await put(it);
  return it;
}
export async function kbRemove(id) {
  if (isDaily(id)) {
    const it = kbItem(id);
    for (const f of (it && it.files) || []) await dbDel(FILES, f.id).catch(() => {});
    await deleteNote(dailyRealId(id));
    notify();
    return;
  }
  const it = kbItem(id);
  if (!it) return;
  if (it.kind === 'note') for (const f of it.files || []) await dbDel(FILES, f.id).catch(() => {});
  if (it.kind === 'group') {
    for (const n of all('note')) {
      if (n.groupId === id) { n.groupId = ''; await dbPut(STORE, n); }
    }
  }
  it.deleted = true;
  await put(it);
}

/* ── Синхронизация ── */
export const getKbForSync = () => state.items.map(i =>
  i.kind === 'note' ? { ...i, files: (i.files || []).map(f => ({ id: f.id, name: f.name, size: f.size, mime: f.mime })) } : i);
export async function applyKbMerged(list) {
  const remote = Array.isArray(list) ? list : [];
  const byId = new Map();
  for (const i of state.items) if (i && i.id) byId.set(i.id, i);
  for (const r of remote) {
    if (!r || !r.id) continue;
    const local = byId.get(r.id);
    if (!local || String(r.updatedAt || '') >= String(local.updatedAt || '')) byId.set(r.id, r);
  }
  state.items = [...byId.values()];
  try { await dbBulk(STORE, state.items); } catch (e) { console.error('[kb] dbBulk:', e); }
  notify();
}

/* ── Файлы ── */
const MAX_FILE = 8 * 1024 * 1024;
export const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ';
async function attach(noteId, file) {
  if (file.size > MAX_FILE) throw new Error('Файл больше 8 МБ');
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const rec = { id: uid(), data };
  await dbPut(FILES, rec);
  const n = kbItem(noteId);
  if (!n) return;
  const files = [...(n.files || []), { id: rec.id, name: file.name, size: file.size, mime: file.type }];
  if (isDaily(noteId)) { await kbSave('note', { files }, noteId); return; }
  n.files = files;
  await put(n);
}
async function openAttachment(fid, name) {
  const rec = await dbGet(FILES, fid).catch(() => null);
  if (!rec || !rec.data) { alert('Файл доступен только на устройстве, где его добавили.'); return; }
  const a = document.createElement('a');
  a.href = rec.data;
  a.download = name || 'file';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ══════════════ ПРЕДСТАВЛЕНИЕ ══════════════ */
let curGroup = '';     // '' — все
const openGroups = new Set();
let curNote = null;
let query = '';
let _host = null;

const plain = html => String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const titleOf = n => (n.title || '').trim() || plain(n.html).slice(0, 40) || 'Без названия';

/* ── Ежедневные заметки из панели-виджета ──
   Они живут в своём сторе ('notes') и раньше в базу знаний не
   попадали. Показываем их здесь как обычные заметки с префиксом id;
   правки уходят обратно в тот же стор, так что панель и база всегда
   показывают одно и то же. Группа выводится из режима заметки:
   перенос в другую группу меняет режим — и точку в панели. */
const DAILY = 'daily:';
const isDaily = id => typeof id === 'string' && id.startsWith(DAILY);
const dailyRealId = id => String(id).slice(DAILY.length);
const modeGroup = m => 'kb-' + (m || 'work');
const groupMode = gid => (MODES.find(m => 'kb-' + m.id === gid) || {}).id || '';
function dailyNotes() {
  return getAllNotes().filter(n => plain(n.html) || (n.title || '').trim()).map(n => ({
    id: DAILY + n.id,
    kind: 'note',
    title: (n.title || '').trim() || `Заметка ${n.day || ''}`.trim(),
    html: n.html || '',
    groupId: modeGroup(n.mode),
    files: n.files || [], links: n.links || [], daily: true, day: n.day,
    createdAt: n.createdAt, updatedAt: n.updatedAt,
  }));
}

export function renderKbView(el) {
  if (!el) return;
  _host = el;
  const groups = kbGroups();
  const q = query.trim().toLowerCase();
  let notes = kbNotes();
  if (curGroup) notes = notes.filter(n => n.groupId === curGroup);
  if (q) notes = notes.filter(n => (titleOf(n) + ' ' + plain(n.html)).toLowerCase().includes(q));
  if (curNote && !kbItem(curNote)) curNote = null;
  const note = curNote ? kbItem(curNote) : null;
  const countIn = gid => kbNotes().filter(n => n.groupId === gid).length;

  el.innerHTML = `
    <aside class="kb-side">
      <div class="kb-search"><input class="kb-q" type="search" placeholder="Поиск по базе" value="${esc(query)}"></div>
      <div class="kb-groups">
        <button type="button" class="kb-g${curGroup === '' ? ' on' : ''}" data-g="" style="--gc:var(--dim)">
          <span class="kb-g-dot"></span><span class="kb-g-name">Все заметки</span><span class="kb-g-n">${kbNotes().length}</span></button>
        ${groups.map(g => {
          const inside = kbNotes().filter(n => n.groupId === g.id);
          const open = openGroups.has(g.id);
          return `<div class="kb-gwrap${open ? ' open' : ''}" data-drop="${g.id}">
            <button type="button" class="kb-g${curGroup === g.id ? ' on' : ''}" data-g="${g.id}" style="--gc:${g.color || '#94a3b8'}">
              <span class="kb-g-caret">${open ? '▾' : '▸'}</span>
              <span class="kb-g-dot"></span><span class="kb-g-name">${esc(g.name)}</span>
              <span class="kb-g-n">${countIn(g.id)}</span>
              <span class="kb-g-edit" title="Переименовать">✎</span></button>
            ${open ? `<div class="kb-sub">${inside.length
              ? inside.map(n => `<button type="button" class="kb-subitem${curNote === n.id ? ' on' : ''}" data-id="${n.id}" data-drag="1">${esc(titleOf(n))}</button>`).join('')
              : '<span class="kb-sub-empty">Пусто</span>'}</div>` : ''}
          </div>`;
        }).join('')}
        <button type="button" class="kb-g-new">＋ Группа</button>
      </div>
      <div class="kb-list">
        ${notes.length ? notes.map(n => {
          const g = kbItem(n.groupId);
          return `<button type="button" class="kb-item${curNote === n.id ? ' on' : ''}" data-id="${n.id}">
            <span class="kb-item-bar" style="background:${g ? g.color : 'var(--dim)'}"></span>
            <span class="kb-item-body">
              <b>${esc(titleOf(n))}</b>
              <i>${esc(plain(n.html).slice(0, 70) || 'Пусто')}</i>
              <em>${esc(String(n.updatedAt || '').slice(0, 10))}${(n.files || []).length ? ` · 📎${n.files.length}` : ''}${(n.links || []).length ? ` · 🔗${n.links.length}` : ''}</em>
            </span></button>`;
        }).join('') : '<p class="empty">Ничего не найдено</p>'}
      </div>
    </aside>
    <main class="kb-main">${note ? noteHTML(note, groups) : `<div class="kb-blank">
      <b>База знаний</b>
      <span>Выберите заметку слева или создайте новую. Заметки можно раскладывать по группам, связывать между собой и прикреплять к ним файлы.</span>
    </div>`}</main>`;

  const qi = el.querySelector('.kb-q');
  qi.oninput = () => { query = qi.value; renderKbView(el); el.querySelector('.kb-q').focus(); };
  el.querySelectorAll('.kb-subitem').forEach(b => b.onclick = () => { curNote = b.dataset.id; renderKbView(el); });
  el.querySelectorAll('.kb-g[data-g]').forEach(b => {
    b.onclick = e => {
      if (e.target.classList.contains('kb-g-caret')) {
        const gid = b.dataset.g;
        if (openGroups.has(gid)) openGroups.delete(gid);
        else openGroups.add(gid);
        renderKbView(el);
        return;
      }
      if (e.target.classList.contains('kb-g-edit')) {
        const g = kbItem(b.dataset.g);
        const name = prompt('Название группы:', g ? g.name : '');
        if (name === null || !name.trim()) return;
        kbSave('group', { name: name.trim().slice(0, 40) }, b.dataset.g).then(() => renderKbView(el));
        return;
      }
      curGroup = b.dataset.g;
      renderKbView(el);
    };
  });
  el.querySelector('.kb-g-new').onclick = async () => {
    const name = prompt('Название группы:', '');
    if (name === null || !name.trim()) return;
    const g = await kbSave('group', {
      name: name.trim().slice(0, 40),
      color: PALETTE[kbGroups().length % PALETTE.length],
      order: kbGroups().length,
    });
    curGroup = g.id;
    renderKbView(el);
  };

  el.querySelectorAll('.kb-item').forEach(b => b.onclick = () => { curNote = b.dataset.id; renderKbView(el); });
  if (note) bindNote(el, note);
  bindNoteDrag(el);
}

/* ── Перенос заметки в группу ──
   Pointer-события, а не нативный drag-and-drop: на iOS он в вебе не
   работает. Тянем карточку из списка, группа под курсором
   подсвечивается, отпустили — заметка сменила группу. */
function bindNoteDrag(el) {
  let src = null, ghost = null, over = null, started = false, sx = 0, sy = 0, gx = 0, gy = 0;
  const dropAt = (x, y) => {
    const n = document.elementFromPoint(x, y);
    return n ? n.closest('[data-drop]') : null;
  };
  const clearOver = () => { if (over) over.classList.remove('kb-drop-over'); over = null; };
  const move = e => {
    if (!src) return;
    if (!started) {
      if (Math.abs(e.clientX - sx) < 7 && Math.abs(e.clientY - sy) < 7) return;
      started = true;
      const r = src.getBoundingClientRect();
      gx = sx - r.left;
      gy = sy - r.top;
      ghost = document.createElement('div');
      ghost.className = 'kb-note-ghost';
      ghost.textContent = src.textContent;
      ghost.style.width = r.width + 'px';
      document.body.appendChild(ghost);
      src.classList.add('dragging');
      document.body.classList.add('kb-dragging');
      try { navigator.vibrate(8); } catch {}
    }
    ghost.style.transform = `translate(${e.clientX - gx}px, ${e.clientY - gy}px)`;
    const d = dropAt(e.clientX, e.clientY);
    if (d !== over) { clearOver(); if (d) { over = d; d.classList.add('kb-drop-over'); } }
  };
  const up = async e => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    document.removeEventListener('touchmove', block);
    document.body.classList.remove('kb-dragging');
    if (ghost) { ghost.remove(); ghost = null; }
    if (src) src.classList.remove('dragging');
    const target = started ? dropAt(e.clientX, e.clientY) : null;
    const gid = target ? target.dataset.drop : null;
    const node = src;
    clearOver();
    src = null;
    started = false;
    if (node && gid) {
      const n = kbItem(node.dataset.id);
      if (n && n.groupId !== gid) {
        await kbSave('note', { groupId: gid }, node.dataset.id);
        renderKbView(el);
      }
    }
  };
  const block = e => { if (started && e.cancelable) e.preventDefault(); };
  el.querySelectorAll('[data-drag], .kb-item').forEach(node => {
    node.addEventListener('pointerdown', e => {
      src = node;
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
export const refreshKbView = () => { if (_host && !_host.hidden) renderKbView(_host); };
/* Кнопка «+» приложения в этом режиме заводит заметку */
export async function newKbNote() {
  const n = await kbSave('note', {
    title: '', html: '', groupId: curGroup || (kbGroups()[0] || {}).id || '',
    files: [], links: [], tags: [],
  });
  curNote = n.id;
  if (_host) {
    renderKbView(_host);
    const t = _host.querySelector('.kb-title');
    if (t) t.focus();
  }
}

function noteHTML(n, groups) {
  const links = (n.links || []).map(id => kbItem(id)).filter(Boolean);
  return `
    <header class="kb-nhead">
      <input class="kb-title" type="text" maxlength="120" placeholder="Название заметки" value="${esc(n.title || '')}">
      <button type="button" class="icon-btn kb-del" title="Удалить заметку">✕</button>
    </header>
    <div class="kb-meta">
      <select class="kb-group-sel">
        <option value="">Без группы</option>
        ${groups.map(g => `<option value="${g.id}"${n.groupId === g.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}
      </select>
      ${n.daily ? '<span class="kb-daily-tag">Заметка дня</span>' : ''}
      <label class="kb-attach">📎 Файл<input type="file" class="kb-file" hidden multiple></label>
      <button type="button" class="btn mini kb-link">🔗 Связать</button>
    </div>
    <div class="kb-edit-wrap">
      <div class="kb-editor" contenteditable="true">${n.html || ''}</div>
    </div>
    ${(n.files || []).length ? `<div class="kb-files">${n.files.map(f => `<div class="kb-file-row" data-fid="${f.id}">
      <span class="kbf-name">${esc(f.name)}</span><span class="kbf-size">${fmtSize(f.size)}</span>
      <button type="button" class="kbf-del" title="Открепить">✕</button></div>`).join('')}</div>` : ''}
    ${links.length ? `<div class="kb-links"><span class="kb-links-cap">Связанные</span>
      ${links.map(l => `<button type="button" class="kb-linkchip" data-id="${l.id}">${esc(titleOf(l))}<i class="kbl-x" title="Убрать">✕</i></button>`).join('')}</div>` : ''}`;
}

function bindNote(el, n) {
  const title = el.querySelector('.kb-title');
  const ed = el.querySelector('.kb-editor');
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      kbSave('note', { title: title.value, html: ed.innerHTML }, n.id);
    }, 500);
  };
  title.oninput = save;
  ed.oninput = save;
  const flush = () => { clearTimeout(timer); kbSave('note', { title: title.value, html: ed.innerHTML }, n.id); };
  title.onblur = flush;
  ed.onblur = flush;

  el.querySelector('.kb-group-sel').onchange = async e => {
    await kbSave('note', { title: title.value, html: ed.innerHTML, groupId: e.target.value }, n.id);
    renderKbView(el);
  };
  const delBtn = el.querySelector('.kb-del');
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm(n.daily
      ? 'Удалить заметку дня вместе с вложениями? Она пропадёт и из панели заметок.'
      : 'Удалить заметку вместе с вложениями?')) return;
    await kbRemove(n.id);
    curNote = null;
    renderKbView(el);
  };
  const file = el.querySelector('.kb-file');
  if (file) file.onchange = async () => {
    flush();
    for (const f of file.files) {
      try { await attach(n.id, f); }
      catch (err) { alert(err.message || 'Не удалось прикрепить файл'); }
    }
    renderKbView(el);
  };
  el.querySelectorAll('.kb-file-row').forEach(r => {
    r.onclick = e => {
      const f = (kbItem(n.id).files || []).find(x => x.id === r.dataset.fid);
      if (e.target.classList.contains('kbf-del')) {
        const note = kbItem(n.id);
        const files = (note.files || []).filter(x => x.id !== r.dataset.fid);
        dbDel(FILES, r.dataset.fid).catch(() => {});
        kbSave('note', { files }, n.id).then(() => renderKbView(el));
        return;
      }
      openAttachment(r.dataset.fid, f ? f.name : '');
    };
  });
  const link = el.querySelector('.kb-link');
  if (link) link.onclick = () => {
    const others = kbNotes().filter(x => x.id !== n.id && !(n.links || []).includes(x.id));
    if (!others.length) { alert('Нет других заметок для связи'); return; }
    openPicker(others, async id => {
      flush();
      const note = kbItem(n.id);
      const target = kbItem(id);
      await kbSave('note', { links: [...(note.links || []), id] }, n.id);
      /* Связь двусторонняя: иначе из второй заметки первую не найти */
      if (target && !(target.links || []).includes(n.id)) {
        await kbSave('note', { links: [...(target.links || []), n.id] }, id);
      }
      renderKbView(el);
    });
  };
  el.querySelectorAll('.kb-linkchip').forEach(c => c.onclick = async e => {
    if (e.target.classList.contains('kbl-x')) {
      flush();
      const note = kbItem(n.id);
      const other = kbItem(c.dataset.id);
      await kbSave('note', { links: (note.links || []).filter(x => x !== c.dataset.id) }, n.id);
      if (other) await kbSave('note', { links: (other.links || []).filter(x => x !== n.id) }, c.dataset.id);
      renderKbView(el);
      return;
    }
    curNote = c.dataset.id;
    renderKbView(el);
  });
}

function openPicker(notes, onPick) {
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay';
  ov.innerHTML = `<div class="notes-list-modal glass">
    <header class="notes-list-head"><h3>С чем связать</h3><button type="button" class="notes-list-close">✕</button></header>
    <div class="notes-list-content">${notes.map(n => `<button type="button" class="kb-pick" data-id="${n.id}">${esc(titleOf(n))}</button>`).join('')}</div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.notes-list-close').onclick = close;
  ov.onclick = e => { if (e.target === ov) close(); };
  ov.querySelectorAll('.kb-pick').forEach(b => b.onclick = () => { close(); onPick(b.dataset.id); });
}
