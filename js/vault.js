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
import { YANDEX_CLIENT_ID, YANDEX_PROXY } from './config.js';
const Y_PROXIES = [].concat(YANDEX_PROXY || []).filter(Boolean);

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
  { id: 'yandex', label: 'Яндекс Диск', icon: 'cloud', soon: () => !YANDEX_CLIENT_ID || !Y_PROXIES.length, desc: 'Папка «Приложения/GMA-OS» в вашем Яндекс Диске. Работает на телефоне и компьютере.' },
  { id: 'gdrive', label: 'Google Диск', icon: 'cloud', soon: true, desc: 'Скрытая папка приложения в вашем Google Диске.' },
  { id: 'dropbox', label: 'Dropbox', icon: 'cloud', soon: true, desc: 'Папка «Apps/GMA-OS» в вашем Dropbox.' },
  { id: 'onedrive', label: 'OneDrive', icon: 'cloud', soon: true, desc: 'Папка приложения в вашем OneDrive.' },
  { id: 'legacy', label: 'Google через скрипт', icon: 'script', legacy: true,
    desc: 'Прежняя синхронизация: данные хранятся на Google Диске владельца приложения.' },
];
const storageById = id => STORAGES.find(s => s.id === id);
const isSoon = s => (typeof s.soon === 'function' ? s.soon() : !!s.soon);

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

/* ══════════════ Хранилище «Яндекс Диск» ══════════════
   Вход — через окно Яндекса (OAuth, implicit flow): токен приходит в
   адресе страницы после возврата и хранится только в этом браузере.
   Права — только на папку приложения: «Приложения/<имя приложения>».
   Файл данных — gma-os-data.json в этой папке. */
const Y_TOKEN = 'rl_yandex_token';
const Y_STATE = 'rl_yandex_state';
const Y_PENDING = 'rl_yandex_pending';
const Y_API = 'https://cloud-api.yandex.net/v1/disk';
const Y_PATH = 'app:/gma-os-data.json';
const yRedirect = () => location.origin + location.pathname.replace(/index\.html$/, '');
const yandexStore = {
  token() {
    try {
      const t = JSON.parse(localStorage.getItem(Y_TOKEN) || 'null');
      return t && t.exp > Date.now() + 60000 ? t.t : '';
    } catch { return ''; }
  },
  login() {
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem(Y_STATE, st); localStorage.setItem(Y_PENDING, '1'); } catch {}
    location.href = 'https://oauth.yandex.ru/authorize?response_type=token'
      + '&client_id=' + encodeURIComponent(YANDEX_CLIENT_ID)
      + '&redirect_uri=' + encodeURIComponent(yRedirect())
      + '&state=' + encodeURIComponent(st);
  },
  /* После возврата из окна Яндекса токен лежит в #access_token=… */
  takeTokenFromUrl() {
    if (!/access_token=/.test(location.hash) && !/error=/.test(location.hash)) return false;
    const q = new URLSearchParams(location.hash.slice(1));
    let expected = '';
    try { expected = sessionStorage.getItem(Y_STATE) || ''; sessionStorage.removeItem(Y_STATE); } catch {}
    history.replaceState(null, '', location.pathname + location.search);   // токен не должен остаться в адресе
    if (q.get('error')) { lastError = 'Яндекс не дал доступ: ' + (q.get('error_description') || q.get('error')); return true; }
    if (!expected || q.get('state') !== expected) { lastError = 'Ответ Яндекса не прошёл проверку — попробуйте войти ещё раз'; return true; }
    const exp = Date.now() + (parseInt(q.get('expires_in'), 10) || 31536000) * 1000;
    try { localStorage.setItem(Y_TOKEN, JSON.stringify({ t: q.get('access_token'), exp })); } catch {}
    let pending = false;
    try { pending = localStorage.getItem(Y_PENDING) === '1'; localStorage.removeItem(Y_PENDING); } catch {}
    if (pending) setMode('yandex');
    return true;
  },
  disconnect() { try { localStorage.removeItem(Y_TOKEN); } catch {} },
  async ready() { return this.token() ? true : 'auth'; },
  async api(path) {
    let res;
    try { res = await fetch(Y_API + path, { headers: { Authorization: 'OAuth ' + this.token(), Accept: 'application/json' } }); }
    catch { throw new Error('Не удалось связаться с Яндекс Диском — проверьте интернет'); }
    if (res.status === 401) { this.disconnect(); const e = new Error('Вход в Яндекс истёк — войдите снова'); e.auth = true; throw e; }
    return res;
  },
  /* Версия файла: revision (если отдаётся) или md5 + время изменения */
  async meta() {
    const res = await this.api('/resources?path=' + encodeURIComponent(Y_PATH) + '&fields=md5,modified,revision');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Яндекс Диск ответил ошибкой ' + res.status);
    const m = await res.json();
    return { rev: m.revision != null ? String(m.revision) : (m.md5 || '') + '|' + (m.modified || '') };
  },
  async read() {
    const m = await this.meta();
    if (!m) return { data: null, rev: null };
    const res = await this.api('/resources/download?path=' + encodeURIComponent(Y_PATH));
    if (!res.ok) throw new Error('Не удалось получить ссылку на файл (' + res.status + ')');
    const { href } = await res.json();
    // Ссылка скачивания Яндекса не разрешает чтение из браузера (нет CORS),
    // поэтому идём через свой прокси: он только пересылает файл, ничего не хранит.
    if (!Y_PROXIES.length) throw new Error('Не настроен прокси для Яндекс Диска — сообщите разработчику');
    // Прокси пробуем по очереди: первый, что ответил, и выигрывает
    // (например, Yandex Cloud доступен везде, Cloudflare — не у всех провайдеров).
    let file = null;
    const fails = [];
    for (const px of Y_PROXIES) {
      const host = px.replace(/^https?:\/\/([^/]+).*$/, '$1');
      try {
        const r = await fetch(px + (px.includes('?') ? '&' : '?') + 'u=' + encodeURIComponent(href), { cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
        if (r.ok) { file = r; break; }
        const why = (await r.text().catch(() => '')).slice(0, 200);
        fails.push(host + ': ' + r.status + (why ? ' ' + why : ''));
      } catch (e) { fails.push(host + ': ' + (e && e.name === 'TimeoutError' ? 'нет ответа' : 'не открылся')); }
    }
    if (!file) {
      console.warn('[Яндекс Диск] прокси не сработали:\n' + fails.join('\n'));
      throw new Error('Прокси Яндекс Диска недоступен (' + fails.map(f => f.split(' ').slice(0, 2).join(' ')).join('; ') + ')');
    }
    const text = (await file.text()).trim();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { throw new Error('Файл на Яндекс Диске повреждён'); } }
    return { data, rev: m.rev };
  },
  async write(data, rev) {
    const m = await this.meta();
    if ((m ? m.rev : null) !== rev) return { conflict: true };
    const res = await this.api('/resources/upload?path=' + encodeURIComponent(Y_PATH) + '&overwrite=true');
    if (!res.ok) throw new Error('Не удалось начать загрузку (' + res.status + ')');
    const { href, method } = await res.json();
    let up;
    try { up = await fetch(href, { method: method || 'PUT', body: JSON.stringify(data) }); }
    catch { throw new Error('Яндекс Диск не принял файл от браузера — сообщите разработчику'); }
    if (!up.ok) throw new Error('Загрузка не удалась (' + up.status + ')');
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
/* Единый интерфейс хранилища для движка:
   ready(manual) → true | 'perm' | 'auth' | 'error'; read() → { data, rev };
   write(data, rev) → { conflict } — конфликт, если версия уже не та. */
const PROVIDERS = {
  file: {
    async ready(manual) {
      const h = await fileStore.handle();
      if (!h) { lastError = 'Файл не выбран'; return 'error'; }
      return (await fileStore.permitted(h, manual)) ? true : 'perm';
    },
    async read() { return fileStore.read(await fileStore.handle()); },
    async write(data, rev) { return fileStore.write(await fileStore.handle(), data, rev); },
  },
  yandex: yandexStore,
};
const syncable = m => !!PROVIDERS[m];

async function vaultSync(manual) {
  const mode = getMode();
  const pv = PROVIDERS[mode];
  if (!pv) {
    if (mode === 'device' || !mode) status('local');
    return;
  }
  if (busy) { pending = true; return; }
  busy = true;
  try {
    const ok = await pv.ready(manual);
    if (ok !== true) { status(ok); return; }
    if (!navigator.onLine && mode !== 'file') { status('offline'); return; }
    status('syncing');
    let written = false;
    for (let i = 0; i < 3 && !written; i++) {
      const { data, rev } = await pv.read();
      if (data) {
        if (!isSnapshot(data)) throw new Error('В хранилище лежат не данные GMA-OS');
        await applySnapshot(data);
      }
      const res = await pv.write(buildSnapshot(), rev);
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
    status(e && e.auth ? 'auth' : 'error');
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
  if (!syncable(m)) return;
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden && syncable(getMode())) vaultSync(false); });
  /* Вернулись из окна входа Яндекса — забираем токен из адреса */
  if (YANDEX_CLIENT_ID) yandexStore.takeTokenFromUrl();
  const m = getMode();
  if (m === 'legacy') {
    legacy.refreshStatus();
    if (legacy.configured() && legacy.signedIn()) setTimeout(() => legacy.syncNow(), 300);
  } else if (syncable(m)) {
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
  const off = isSoon(s) || (s.available && !s.available());
  const badge = isSoon(s) ? '<span class="vo-badge">скоро</span>'
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
    if (id === 'yandex' && !yandexStore.token()) { yandexStore.login(); return; }   // вернёмся уже с доступом
    setMode(id);
    if (id === 'legacy') { legacy.refreshStatus(); legacy.syncNow(); }
    else if (syncable(id)) vaultSync(true);
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
  } else if (mode === 'yandex') {
    const has = !!yandexStore.token();
    st.innerHTML = `<div class="vault-card">
      <div class="vc-row"><span>Яндекс Диск</span><b>${has ? 'подключён' : 'нужен вход'}</b></div>
      <div class="vc-row"><span>Файл</span><b>Приложения/GMA-OS/gma-os-data.json</b></div>
      <div class="vc-row"><span>Последняя синхронизация</span><b>${lastSyncText()}</b></div>
      ${lastError ? `<p class="hint err">${esc(lastError)}</p>` : ''}
      <div class="auth-row">
        ${has ? '<button type="button" class="btn primary" data-act="sync">Синхронизировать</button><button type="button" class="btn" data-act="yout">Отключить</button>'
              : '<button type="button" class="btn primary" data-act="ylogin">Войти через Яндекс</button>'}
      </div></div>`;
  } else if (mode === 'device' || !mode) {
    st.innerHTML = `<p class="hint">${mode ? 'Данные хранятся только в этом браузере. Если очистить данные сайта или сменить устройство, они пропадут — сохраняйте резервную копию.' : 'Хранилище ещё не выбрано — пока данные лежат только на этом устройстве.'}</p>`;
  } else if (mode === 'legacy') {
    st.innerHTML = '<div class="vault-legacy"></div>';
    legacy.renderSyncPanel(st.querySelector('.vault-legacy'));
  } else if (s && isSoon(s)) {
    st.innerHTML = '<p class="hint">Это хранилище появится в следующем обновлении.</p>';
  }
  bindOptions(el, () => renderSyncPanel(el));
  const act = a => el.querySelector(`[data-act="${a}"]`);
  if (act('sync')) act('sync').onclick = async () => { await vaultSync(true); renderSyncPanel(el); };
  if (act('refile')) act('refile').onclick = () => { el.querySelector('.vault-filepick').hidden = false; };
  if (act('ylogin')) act('ylogin').onclick = () => yandexStore.login();
  if (act('yout')) act('yout').onclick = () => {
    if (!confirm('Отключить Яндекс Диск на этом устройстве? Данные останутся и на устройстве, и на Диске.')) return;
    yandexStore.disconnect();
    setMode('device');
    status('local');
    renderSyncPanel(el);
  };
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
