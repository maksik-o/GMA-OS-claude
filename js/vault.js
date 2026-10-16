/* ══════════════════════════════════════════════════════════════════
   Хранилище данных пользователя.

   Пользователь сам выбирает, где лежат его данные: только на этом
   устройстве, в локальном файле или (дальше) в своём облаке —
   Яндекс Диск, Google Диск, Dropbox, OneDrive. Сервер разработчика
   данных не видит и не хранит: обмен идёт напрямую между браузером
   и выбранным местом.

   Как устроена синхронизация с файлом:
   1) читаем файл (снимок всех разделов);
   2) вливаем его в данные устройства — «новее побеждает», удалённое
      помечено и не воскресает (snapshot.js);
   3) записываем объединённый результат обратно. Если файл успели
      изменить между чтением и записью (другое устройство через папку
      облака), повторяем круг.

   Прежняя синхронизация через скрипт Google остаётся вариантом
   «legacy» — для тех, кто уже ею пользуется.
   ══════════════════════════════════════════════════════════════════ */
import { buildSnapshot, applySnapshot, isSnapshot } from './snapshot.js';
import { dbGetKV, dbSetKV } from './db.js';
import { esc } from './store.js';
import * as legacy from './sync.js';

const MODE_KEY = 'rl_storage';
const LAST_KEY = 'rl_vault_last';
const FILE_KV = 'vaultFileHandle';

const ICONS = {
  device: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M17.5 19H8a6 6 0 1 1 5.7-8h1.8a4 4 0 0 1 0 8z"/></svg>',
  script: '<svg viewBox="0 0 24 24"><path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12"/></svg>',
};

const hasFileApi = () => typeof window.showSaveFilePicker === 'function' && typeof window.showOpenFilePicker === 'function';

export const STORAGES = [
  { id: 'device', label: 'Только на этом устройстве', icon: 'device',
    desc: 'Данные не покидают это устройство. Синхронизации нет — время от времени сохраняйте резервную копию.' },
  { id: 'file', label: 'Локальный файл', icon: 'file',
    desc: 'JSON-файл на компьютере. Положите его в папку Яндекс Диска, Dropbox или OneDrive — их программа разнесёт файл по вашим компьютерам.',
    note: 'Chrome и Edge на компьютере', available: hasFileApi },
  { id: 'yandex', label: 'Яндекс Диск', icon: 'cloud', soon: true, desc: 'Папка «Приложения/GMA-OS» в вашем Яндекс Диске.' },
  { id: 'gdrive', label: 'Google Диск', icon: 'cloud', soon: true, desc: 'Скрытая папка приложения в вашем Google Диске.' },
  { id: 'dropbox', label: 'Dropbox', icon: 'cloud', soon: true, desc: 'Папка «Apps/GMA-OS» в вашем Dropbox.' },
  { id: 'onedrive', label: 'OneDrive', icon: 'cloud', soon: true, desc: 'Папка приложения в вашем OneDrive.' },
  { id: 'legacy', label: 'Google через скрипт', icon: 'script', legacy: true,
    desc: 'Прежняя синхронизация: данные хранятся на Google Диске владельца приложения.' },
];
const storageById = id => STORAGES.find(s => s.id === id);

/* ── Выбранное хранилище ──
   Тем, кто уже вошёл в прежнюю синхронизацию, ничего не ломаем:
   для них по умолчанию «legacy». Остальным предложим выбрать. */
export function getMode() {
  let m = '';
  try { m = localStorage.getItem(MODE_KEY) || ''; } catch {}
  if (!m && legacy.configured() && legacy.signedIn()) m = 'legacy';
  return m;
}
function setMode(m) {
  try { localStorage.setItem(MODE_KEY, m); } catch {}
}

/* ── Статус для облачка в шапке и плашки ── */
let lastError = '';
let busy = false, pending = false, timer = null;
const status = s => document.dispatchEvent(new CustomEvent('sync-status', { detail: s }));
const lastSyncText = () => {
  let t = 0;
  try { t = +localStorage.getItem(LAST_KEY) || 0; } catch {}
  return t ? new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : 'ещё не было';
};

/* ══════════════ Хранилище «локальный файл» ══════════════
   Путь к файлу браузер вводить не даёт — файл выбирается в окне, а
   приложение запоминает его (handle хранится в IndexedDB). После
   перезапуска браузера доступ нужно один раз подтвердить кнопкой. */
const fileStore = {
  handle: () => dbGetKV(FILE_KV),
  async permitted(h, ask) {
    const opts = { mode: 'readwrite' };
    if (await h.queryPermission(opts) === 'granted') return true;
    if (!ask) return false;
    return (await h.requestPermission(opts)) === 'granted';
  },
  async read(h) {
    const f = await h.getFile();
    const text = (await f.text()).trim();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { throw new Error('Файл повреждён или это не JSON'); }
    }
    return { data, rev: f.lastModified };
  },
  async write(h, data, rev) {
    const f = await h.getFile();
    if (rev != null && f.lastModified !== rev) return { conflict: true };
    const w = await h.createWritable();
    await w.write(JSON.stringify(data));
    await w.close();
    return { ok: true };
  },
};
const PICK_TYPES = [{ description: 'Данные GMA-OS', accept: { 'application/json': ['.json'] } }];
async function pickFile(create) {
  try {
    if (create) return await window.showSaveFilePicker({ suggestedName: 'gma-os-data.json', types: PICK_TYPES });
    const [h] = await window.showOpenFilePicker({ types: PICK_TYPES, multiple: false });
    return h;
  } catch (e) {
    if (e && e.name === 'AbortError') return null;   // окно просто закрыли
    throw e;
  }
}

/* ── Синхронизация с выбранным хранилищем ── */
async function vaultSync(manual) {
  const mode = getMode();
  if (mode !== 'file') {
    if (mode === 'device' || !mode) status('local');
    return;
  }
  if (busy) { pending = true; return; }
  busy = true;
  try {
    const h = await fileStore.handle();
    if (!h) { lastError = 'Файл не выбран'; status('error'); return; }
    if (!(await fileStore.permitted(h, manual))) { status('perm'); return; }
    status('syncing');
    let written = false;
    for (let i = 0; i < 3 && !written; i++) {
      const { data, rev } = await fileStore.read(h);
      if (data) {
        if (!isSnapshot(data)) throw new Error('В выбранном файле не данные GMA-OS — выберите другой файл');
        await applySnapshot(data);
      }
      const res = await fileStore.write(h, buildSnapshot(), rev);
      written = !res.conflict;   // файл изменили между чтением и записью — повторяем
    }
    if (!written) throw new Error('Файл постоянно меняется другим устройством — попробуйте ещё раз');
    try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch {}
    lastError = '';
    status('ok');
    document.dispatchEvent(new CustomEvent('sync-done'));
  } catch (e) {
    lastError = (e && e.message) || String(e);
    if (e && e.name === 'NotFoundError') lastError = 'Файл не найден — его переместили или удалили. Выберите файл заново.';
    status('error');
  } finally {
    busy = false;
    if (pending) { pending = false; schedule(); }
  }
}

/* ══════════════ Общий вход для приложения ══════════════ */
export function syncNow(manual) {
  const m = getMode();
  if (m === 'legacy') return legacy.syncNow(manual);
  return vaultSync(manual);
}
export function schedule() {
  const m = getMode();
  if (m === 'legacy') { legacy.schedule(); return; }
  if (m !== 'file') return;
  clearTimeout(timer);
  timer = setTimeout(() => vaultSync(false), 2000);
}
export function syncInit() {
  document.addEventListener('user-change', schedule);
  window.addEventListener('online', () => {
    if (getMode() === 'legacy') legacy.refreshStatus();
    syncNow();
  });
  window.addEventListener('offline', () => { if (getMode() === 'legacy') status('offline'); });
  /* Файл мог изменить другой компьютер через папку облака — подтягиваем,
     когда приложение снова на экране */
  document.addEventListener('visibilitychange', () => { if (!document.hidden && getMode() === 'file') vaultSync(false); });
  const m = getMode();
  if (m === 'legacy') {
    legacy.refreshStatus();
    if (legacy.configured() && legacy.signedIn()) setTimeout(() => legacy.syncNow(), 300);
  } else if (m === 'file') {
    setTimeout(() => vaultSync(false), 300);
  } else {
    status('local');
    if (!m) setTimeout(openStorageChooser, 900);
  }
}

/* ══════════════ Резервная копия: экспорт и импорт ══════════════ */
export async function exportBackup() {
  const name = `gma-os-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(buildSnapshot())], { type: 'application/json' });
  /* На телефоне — через «Поделиться»: так файл можно сохранить в
     «Файлы», облако или отправить себе. На компьютере — загрузкой. */
  const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
  if (file && matchMedia('(hover: none)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Резервная копия GMA-OS' }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export function importBackup(onDone) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!isSnapshot(data)) throw new Error('Это не файл данных GMA-OS');
      if (!confirm('Данные из файла объединятся с текущими: более новые записи заменят старые, ничего не удалится. Продолжить?')) return;
      await applySnapshot(data);
      document.dispatchEvent(new CustomEvent('sync-done'));
      schedule();   // и сразу разнести по выбранному хранилищу
      if (onDone) onDone('Импортировано');
    } catch (e) {
      alert('Не удалось импортировать: ' + ((e && e.message) || e));
    }
  };
  inp.click();
}

/* ══════════════ Интерфейс ══════════════ */
function optionHTML(s, current) {
  const off = s.soon || (s.available && !s.available());
  const badge = s.soon ? '<span class="vo-badge">скоро</span>'
    : s.id === current ? '<span class="vo-badge on">выбрано</span>'
    : (s.available && !s.available()) ? `<span class="vo-badge">${esc(s.note || 'недоступно')}</span>` : '';
  return `<button type="button" class="vault-opt${s.id === current ? ' on' : ''}" data-st="${s.id}"${off ? ' disabled' : ''}>
    <span class="vo-ico">${ICONS[s.icon]}</span>
    <span class="vo-body"><b>${esc(s.label)}</b><span>${esc(s.desc)}</span></span>${badge}</button>`;
}
const visibleStorages = forChooser => STORAGES.filter(s => !s.legacy || (!forChooser && legacy.configured()));

/* Подключение локального файла: создать новый или открыть имеющийся */
async function connectFile(create) {
  const h = await pickFile(create);
  if (!h) return false;
  await dbSetKV(FILE_KV, h);
  setMode('file');
  await vaultSync(true);
  return true;
}

function bindOptions(root, onChange) {
  root.querySelectorAll('.vault-opt').forEach(b => b.onclick = () => {
    const id = b.dataset.st;
    if (id === 'file') {
      /* Сначала спрашиваем, какой файл: новый или существующий */
      const box = root.querySelector('.vault-filepick');
      if (box) { box.hidden = false; box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      return;
    }
    setMode(id);
    if (id === 'legacy') { legacy.refreshStatus(); legacy.syncNow(); }
    else status('local');
    onChange(id);
  });
  root.querySelectorAll('[data-file]').forEach(b => b.onclick = async () => {
    try { if (await connectFile(b.dataset.file === 'new')) onChange('file'); }
    catch (e) { alert('Не удалось открыть файл: ' + ((e && e.message) || e)); }
  });
}
const filePickHTML = `<div class="vault-filepick" hidden>
    <p>Где будет храниться файл? Удобно выбрать папку Яндекс Диска, Dropbox или OneDrive на компьютере.</p>
    <div class="auth-row">
      <button type="button" class="btn primary" data-file="new">Создать новый файл</button>
      <button type="button" class="btn" data-file="open">Открыть существующий</button>
    </div></div>`;

/* Панель «Синхронизация» в настройках */
export function renderSyncPanel(el) {
  if (!el) return;
  const mode = getMode();
  const s = storageById(mode);
  el.innerHTML = `
    <div class="vault">
      <p class="vault-lead">Ваши данные хранятся только там, где вы выберете. Сервер разработчика их не получает.</p>
      <div class="set-sub">Где хранятся данные</div>
      <div class="vault-opts">${visibleStorages(false).map(x => optionHTML(x, mode)).join('')}</div>
      ${filePickHTML}
      <div class="vault-state"></div>
      <div class="set-sub">Резервная копия</div>
      <div class="auth-row vault-backup">
        <button type="button" class="btn" data-act="export">Сохранить в файл</button>
        <button type="button" class="btn" data-act="import">Загрузить из файла</button>
      </div>
      <p class="hint vault-note">Все разделы одним JSON-файлом. Загрузка объединяет файл с текущими данными: новее побеждает, ничего не удаляется.</p>
    </div>`;
  const st = el.querySelector('.vault-state');
  if (mode === 'file') {
    st.innerHTML = `<div class="vault-card">
      <div class="vc-row"><span>Файл</span><b class="vc-file">…</b></div>
      <div class="vc-row"><span>Последняя синхронизация</span><b>${lastSyncText()}</b></div>
      ${lastError ? `<p class="hint err">${esc(lastError)}</p>` : ''}
      <div class="auth-row">
        <button type="button" class="btn primary" data-act="sync">Синхронизировать</button>
        <button type="button" class="btn" data-act="refile">Другой файл</button>
      </div></div>`;
    fileStore.handle().then(async h => {
      const n = st.querySelector('.vc-file');
      if (n) n.textContent = h ? h.name : 'не выбран';
      if (h && !(await fileStore.permitted(h, false))) {
        const row = st.querySelector('.auth-row');
        if (row) row.insertAdjacentHTML('beforebegin', '<p class="hint">Браузер просит заново разрешить доступ к файлу — нажмите «Синхронизировать».</p>');
      }
    });
  } else if (mode === 'device' || !mode) {
    st.innerHTML = `<p class="hint">${mode ? 'Данные хранятся только в этом браузере. Если очистить данные сайта или сменить устройство, они пропадут — сохраняйте резервную копию.' : 'Хранилище ещё не выбрано — пока данные лежат только на этом устройстве.'}</p>`;
  } else if (mode === 'legacy') {
    st.innerHTML = '<div class="vault-legacy"></div>';
    legacy.renderSyncPanel(st.querySelector('.vault-legacy'));
  } else if (s && s.soon) {
    st.innerHTML = '<p class="hint">Это хранилище появится в следующем обновлении.</p>';
  }
  bindOptions(el, () => renderSyncPanel(el));
  const act = a => el.querySelector(`[data-act="${a}"]`);
  if (act('sync')) act('sync').onclick = async () => { await vaultSync(true); renderSyncPanel(el); };
  if (act('refile')) act('refile').onclick = () => { el.querySelector('.vault-filepick').hidden = false; };
  act('export').onclick = () => exportBackup();
  act('import').onclick = () => importBackup(() => renderSyncPanel(el));
}

/* Экран первого запуска: «Где хранить ваши данные?» */
export function openStorageChooser() {
  if (document.querySelector('.vault-chooser')) return;
  const ov = document.createElement('div');
  ov.className = 'notes-list-overlay vault-chooser';
  ov.innerHTML = `<div class="notes-list-modal glass vault-modal">
    <header class="notes-list-head"><h3>Где хранить ваши данные?</h3></header>
    <p class="vault-lead">Задачи, заметки, финансы и база знаний будут лежать только там, где вы выберете. Сервер разработчика их не получает. Выбор можно изменить в «Настройки → Синхронизация».</p>
    <div class="vault-opts">${visibleStorages(true).map(x => optionHTML(x, '')).join('')}</div>
    ${filePickHTML}
  </div>`;
  document.body.appendChild(ov);
  bindOptions(ov, () => ov.remove());
}
