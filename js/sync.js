import { API_URL, CLIENT_ID, OWNER_EMAIL } from './config.js';
import {
  state, applyMerged, getTagsDict, getTagsDeleted, saveTagsMeta,
  getTombstonesFull
} from './store.js';
import { getContactsForSync, applyContactsMerged, getContactTombstones, applyContactTombstones } from './contacts.js';
import { getNotesForSync, getNoteTombstones, applyNotesMerged } from './notes.js';
import { getFinanceForSync, applyFinanceMerged } from './finance.js';
import { getKbForSync, applyKbMerged } from './kb.js';

const TOKEN_KEY = 'rl_token';
const KEY_KEY = 'rl_device_key';
const ISSUED_KEYS_STORAGE = 'rl_issued_device_keys'; // список выданных ключей (только у владельца)

let busy = false;
let pushTimer = null;
let lastError = '';
/* Предохранитель: после нескольких неудач подряд автосинхронизация
   замолкает. Иначе каждое изменение задачи (а таймер меняет её
   постоянно) запускало новый круг из пяти запросов к мёртвому
   адресу — отсюда и «очень долгая синхронизация». */
let fails = 0;
const MAX_FAILS = 3;
export const syncPaused = () => fails >= MAX_FAILS;
export function resumeSync() { fails = 0; }

export const configured = () => API_URL.startsWith('https://') && CLIENT_ID.includes('.apps.googleusercontent.com');
export const signedIn = () => !!(localStorage.getItem(TOKEN_KEY) || localStorage.getItem(KEY_KEY));

function setStatus(s) { document.dispatchEvent(new CustomEvent('sync-status', { detail: s })); }
export function refreshStatus() {
  const s = !navigator.onLine ? 'offline' : !configured() ? 'off' : signedIn() ? 'ok' : 'auth';
  setStatus(s);
}

function jwtPayload(t) {
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); }
  catch { return null; }
}

export const userEmail = () => (jwtPayload(localStorage.getItem(TOKEN_KEY) || '') || {}).email || '';

const tokenValid = () => {
  const p = jwtPayload(localStorage.getItem(TOKEN_KEY) || '');
  return !!(p && p.exp * 1000 > Date.now() + 60000);
};

function loadGIS() {
  return new Promise((res, rej) => {
    if (window.google && window.google.accounts && window.google.accounts.id) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res;
    s.onerror = () => rej(new Error('GIS'));
    document.head.appendChild(s);
  });
}

async function ensureToken() {
  if (tokenValid()) return localStorage.getItem(TOKEN_KEY);
  if (!configured()) return '';
  try { await loadGIS(); } catch { return ''; }
  return new Promise(resolve => {
    let done = false;
    const fin = c => {
      if (done) return;
      done = true;
      if (c) localStorage.setItem(TOKEN_KEY, c);
      resolve(c || '');
    };
    google.accounts.id.initialize({
      client_id: CLIENT_ID,
      auto_select: true,
      callback: c => fin(c.credential)
    });
    google.accounts.id.prompt();
    setTimeout(() => fin(''), 7000);
  });
}

export async function apiCall(action, extra) {
  const key = localStorage.getItem(KEY_KEY) || '';
  let auth = '';
  if (!key) {
    auth = await ensureToken();
    if (!auth) {
      lastError = 'Требуется вход';
      setStatus('auth');
      const e = new Error(lastError);
      e.auth = true;
      throw e;
    }
  }
  const body = JSON.stringify(Object.assign({ auth, key, action }, extra));
  let res, netErr = null;
  /* Повтор делаем только при обрыве соединения. HTTP-ошибку (404, 403)
     повторять бессмысленно: ответ не изменится, а запросов станет вдвое
     больше — именно это и растягивало «синхронизацию» на минуты. */
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), 20000) : null;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        signal: ctl ? ctl.signal : undefined,
      });
      netErr = null;
      break;
    } catch (err) {
      netErr = err;
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    } finally {
      if (t) clearTimeout(t);
    }
  }
  if (netErr) {
    lastError = netErr.name === 'AbortError'
      ? 'Сервер не ответил за 20 секунд'
      : 'Соединение оборвалось: ' + netErr.message;
    throw new Error(lastError);
  }
  if (!res.ok) {
    /* 404 после редиректа на script.googleusercontent.com/macros/echo
       означает ровно одно: ссылка ведёт на архивное или удалённое
       развёртывание. Ошибка приходит уже с чужого домена, поэтому
       статус — единственная зацепка, и её стоит объяснить словами. */
    if (res.status === 404) {
      lastError = 'Развёртывание не найдено (404). Ссылка в config.js ведёт на архивное развёртывание — создайте новое (Deploy → New deployment → Web app, доступ «Все») и вставьте свежий /exec.';
    } else if (res.status === 401 || res.status === 403) {
      lastError = 'Нет доступа (' + res.status + '). В развёртывании должно стоять «Execute as: Me» и «Who has access: Anyone».';
    } else {
      lastError = 'HTTP ' + res.status;
    }
    const e = new Error(lastError);
    e.fatal = res.status === 404 || res.status === 401 || res.status === 403;
    throw e;
  }
  let text;
  try { text = await res.text(); }
  catch (err) {
    lastError = 'Не удалось прочитать ответ';
    throw new Error(lastError);
  }
  let out;
  try { out = JSON.parse(text); }
  catch (err) {
    lastError = 'Сервер вернул не-JSON. Переразверните Apps Script с доступом «Все».';
    console.error('[sync] Non-JSON preview:', text.slice(0, 300));
    throw new Error(lastError);
  }
  if (!out || typeof out !== 'object') {
    lastError = 'Некорректный ответ сервера';
    throw new Error(lastError);
  }
  if (!out.ok) {
    lastError = out.error || 'Ошибка сервера';
    if (/Сеанс|токен|expired/i.test(lastError)) {
      localStorage.removeItem(TOKEN_KEY);
      resetSyncWatermarks();
    }
    const e = new Error(lastError);
    if (/Сеанс|токен|expired/i.test(lastError)) e.auth = true;
    throw e;
  }
  lastError = '';
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   Инкрементальный обмен.

   Раньше каждая синхронизация гоняла ВСЁ: все задачи со всеми
   сессиями, все заметки с полным HTML, контакты, финансы, базу
   знаний — и сервер возвращал всё это обратно. С ростом базы запрос
   и ответ пухли, обмен занимал секунды, а Apps Script на больших
   телах рвал соединение.

   Теперь отправляются только записи, изменившиеся с прошлого удачного
   обмена, и сервер возвращает только такие же свежие. Полный обмен
   случается один раз — при первом входе или после сброса.
   ══════════════════════════════════════════════════════════════════ */
const SINCE_KEY = 'rl_sync_since';
const PARTS = ['tasks', 'notes', 'contacts', 'finance', 'kb'];
const SOFT_LIMIT = 3 * 1024 * 1024;   // выше этого Apps Script рвёт соединение
/* Часы на устройствах расходятся; берём запас, чтобы не пропустить
   запись, сохранённую соседним устройством «в прошлом». */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function loadSince() {
  try { return JSON.parse(localStorage.getItem(SINCE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function saveSince(map) {
  try { localStorage.setItem(SINCE_KEY, JSON.stringify(map)); } catch (e) {}
}
export function resetSyncWatermarks() {
  try { localStorage.removeItem(SINCE_KEY); } catch (e) {}
}
const newer = (list, since) => !since
  ? (list || [])
  : (list || []).filter(r => r && String(r.updatedAt || '') > since);

function partPayload(part, since) {
  if (part === 'tasks') {
    const tombstonesToSend = getTombstonesFull();
    const tombIds = new Set(tombstonesToSend.map(t => t.id));
    return {
      tasks: newer(state.tasks.filter(t => t && !tombIds.has(t.id)), since),
      tombstones: tombstonesToSend,        // могильники малы, шлём целиком
      tags: getTagsDict(),
      tagsDeleted: getTagsDeleted(),
    };
  }
  if (part === 'notes') return { notes: newer(getNotesForSync(), since), noteTombstones: getNoteTombstones() };
  if (part === 'contacts') return { contacts: newer(getContactsForSync(), since), contactTombstones: getContactTombstones() };
  if (part === 'finance') return { finance: newer(getFinanceForSync(), since) };
  if (part === 'kb') return { kb: newer(getKbForSync(), since) };
  return {};
}
async function applyPart(part, out) {
  if (part === 'tasks') {
    await applyMerged({
      tasks: Array.isArray(out.tasks) ? out.tasks : [],
      tombstones: Array.isArray(out.tombstones) ? out.tombstones : [],
    });
    if (Array.isArray(out.tags)) await saveTagsMeta(out.tags, out.tagsDeleted || []);
  } else if (part === 'notes') {
    if (Array.isArray(out.notes)) await applyNotesMerged(out.notes);
  } else if (part === 'contacts') {
    if (Array.isArray(out.contacts)) await applyContactsMerged(out.contacts);
    if (Array.isArray(out.contactTombstones)) await applyContactTombstones(out.contactTombstones);
  } else if (part === 'finance') {
    if (Array.isArray(out.finance)) await applyFinanceMerged(out.finance);
  } else if (part === 'kb') {
    if (Array.isArray(out.kb)) await applyKbMerged(out.kb);
  }
}
/* Пустой пакет отправлять незачем: если ничего не менялось и мы уже
   синхронизировались, раздел просто пропускаем. */
function isEmptyPayload(part, payload) {
  if (part === 'tasks') return !payload.tasks.length;
  if (part === 'notes') return !payload.notes.length;
  if (part === 'contacts') return !payload.contacts.length;
  if (part === 'finance') return !payload.finance.length;
  if (part === 'kb') return !payload.kb.length;
  return true;
}
const sizeOf = obj => {
  try { return new Blob([JSON.stringify(obj)]).size; }
  catch { return JSON.stringify(obj).length; }
};
const human = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.round(n / 1024) + ' КБ';

export async function syncNow(manual) {
  if (manual) fails = 0;
  if (busy || !configured()) return;
  if (!navigator.onLine) { setStatus('offline'); return; }
  if (!signedIn()) { setStatus('auth'); return; }
  busy = true;
  setStatus('syncing');
  const since = loadSince();
  const startedAt = new Date(Date.now() - CLOCK_SKEW_MS).toISOString();
  let warn = null;
  try {
    for (const part of PARTS) {
      const from = since[part] || '';
      const payload = partPayload(part, from);
      /* Даже когда локально ничего не менялось, раз в цикл спрашиваем
         сервер: на другом устройстве могло появиться новое. */
      if (from && isEmptyPayload(part, payload) && !manual) {
        const out = await apiCall('sync', { parts: [part], since: from, pull: true });
        await applyPart(part, out);
        since[part] = startedAt;
        continue;
      }
      const bytes = sizeOf(payload);
      if (bytes > SOFT_LIMIT) {
        warn = `Раздел «${part}» слишком большой (${human(bytes)}) и не отправлен. Обычно это картинки, вставленные прямо в заметку.`;
        console.warn('[sync] part too big:', part, bytes);
        continue;
      }
      const out = await apiCall('sync', Object.assign({ parts: [part], since: from }, payload));
      await applyPart(part, out);
      since[part] = startedAt;
    }
    saveSince(since);
    document.dispatchEvent(new CustomEvent('sync-done'));
    fails = 0;
    if (warn) { lastError = warn; setStatus('error'); }
    else { lastError = ''; setStatus('ok'); }
  } catch (e) {
    fails++;
    lastError = e.message || String(e);
    if (e.fatal) fails = MAX_FAILS;   // 404/403 сами не пройдут
    if (fails >= MAX_FAILS) {
      lastError += ' Автосинхронизация приостановлена — нажмите «Синхронизировать», когда исправите.';
    }
    if (e.auth) setStatus('auth');
    else setStatus(navigator.onLine ? 'error' : 'offline');
  } finally {
    busy = false;
  }
}

export function schedule() {
  if (!configured() || !signedIn()) return;
  if (syncPaused()) return;          // молчим, пока пользователь не починит
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, 2000);
}

export async function connectKey(key) {
  localStorage.setItem(KEY_KEY, key);
  resetSyncWatermarks();   // новый аккаунт — забираем всё заново
  lastError = '';
  refreshStatus();
  await syncNow(true);
}

export async function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(KEY_KEY);
  resetSyncWatermarks();
  lastError = '';
  refreshStatus();
}

/* ── Генератор ключей устройства (для владельца) ── */
function generateDeviceKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const rnd = new Uint32Array(24);
  crypto.getRandomValues(rnd);
  for (let i = 0; i < 24; i++) out += chars[rnd[i] % chars.length];
  // группами по 4 для удобства чтения: ABCD-EFGH-JKLM-NPQR-STUV-WXYZ
  return out.match(/.{1,4}/g).join('-');
}

function loadIssuedKeys() {
  try { return JSON.parse(localStorage.getItem(ISSUED_KEYS_STORAGE) || '[]'); }
  catch { return []; }
}
function saveIssuedKeys(list) {
  try { localStorage.setItem(ISSUED_KEYS_STORAGE, JSON.stringify(list)); } catch {}
}

function isOwner() {
  if (!OWNER_EMAIL) return false;
  return String(userEmail()).toLowerCase() === String(OWNER_EMAIL).toLowerCase();
}

function renderDeviceKeysPanel(el) {
  if (!el) return;
  if (!isOwner()) {
    el.innerHTML = '';
    return;
  }
  const list = loadIssuedKeys();
  el.innerHTML = `<div class="set-sub" style="margin-top:18px">Ключи устройства</div>
    <p class="hint" style="margin:0 0 10px">
      Ключ — это вход без Google. У каждого ключа своя изолированная папка в твоём Drive.
      Сгенерируй, скопируй и передай кому нужно.
    </p>
    <div class="auth-row" style="justify-content:flex-start">
      <button type="button" id="issueKeyBtn" class="btn primary">＋ Выдать ключ</button>
    </div>
    <div id="issuedKeysList" class="issued-keys-list"></div>`;

  const renderList = () => {
    const wrap = el.querySelector('#issuedKeysList');
    const current = loadIssuedKeys();
    if (!current.length) {
      wrap.innerHTML = '<p class="hint" style="margin:6px 0 0">Пока никто не получил ключ.</p>';
      return;
    }
    wrap.innerHTML = current.map((item, i) =>
      `<div class="key-line" style="margin-top:8px">
        <span class="kl" style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.label || 'Без имени'}</div>
          <div style="font-size:11px;color:var(--dim);margin-top:2px">выдан ${new Date(item.issuedAt).toLocaleString('ru-RU')}</div>
          <code style="font-size:11px;color:var(--accent);font-family:monospace;word-break:break-all;display:block;margin-top:4px">${item.key}</code>
        </span>
        <button type="button" class="btn mini" data-copy="${i}" title="Скопировать">⎘</button>
        <button type="button" class="btn mini danger" data-del="${i}" title="Отозвать (удалить из списка)">✕</button>
      </div>`
    ).join('');
    wrap.querySelectorAll('[data-copy]').forEach(b => {
      b.onclick = async () => {
        const idx = +b.dataset.copy;
        const k = loadIssuedKeys()[idx];
        if (!k) return;
        try {
          await navigator.clipboard.writeText(k.key);
          b.textContent = '✓';
          setTimeout(() => { b.textContent = '⎘'; }, 900);
        } catch {
          prompt('Скопируй ключ вручную:', k.key);
        }
      };
    });
    wrap.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = () => {
        const idx = +b.dataset.del;
        const arr = loadIssuedKeys();
        arr.splice(idx, 1);
        saveIssuedKeys(arr);
        renderList();
      };
    });
  };

  el.querySelector('#issueKeyBtn').onclick = () => {
    const label = prompt('Для кого этот ключ? (имя/почта — для себя)', '') || '';
    const key = generateDeviceKey();
    const arr = loadIssuedKeys();
    arr.unshift({ key, label: label.trim() || 'Без имени', issuedAt: Date.now() });
    saveIssuedKeys(arr);
    // Сразу копируем в буфер, чтобы не потерять
    navigator.clipboard.writeText(key).catch(() => {});
    renderList();
  };

  renderList();
}

export function renderSyncPanel(el) {
  const st = !navigator.onLine ? 'offline' : !configured() ? 'off' : signedIn() ? 'ok' : 'auth';
  const names = { ok: 'подключено', auth: 'не выполнен вход', off: 'не настроено', offline: 'нет сети' };
  let html = `<div class="sync-statusline">Статус: ${names[st]}${userEmail() ? ' · ' + userEmail() : ''}</div>`;
  if (lastError) html += `<p class="hint err">${lastError}</p>`;
  if (!configured()) {
    html += `<p class="hint">Заполните API_URL и CLIENT_ID в js/config.js.</p>`;
  } else if (!signedIn()) {
    html += `<div class="key-row"><input id="syncKey" class="key-input" placeholder="Ключ устройства"><button type="button" id="syncKeyGo" class="btn">Войти</button></div><div id="gBtnWrap" style="display:flex;justify-content:center;margin:8px 0;"></div>`;
  } else {
    html += `<div class="auth-row"><button type="button" id="syncNowBtn" class="btn primary">Синхронизировать</button><button type="button" id="syncOut" class="btn danger">Выйти</button></div>`;
  }
  html += `<div class="auth-row"><button type="button" id="syncPing" class="btn">Проверить подключение</button><button type="button" id="syncFull" class="btn">Полная пересинхронизация</button></div>
    <p class="hint sync-ping" id="syncPingOut">Адрес: ${API_URL.replace(/^https:\/\/script\.google\.com\/macros\/s\//, '…/').slice(0, 44)}…</p>`;
  html += '<div id="deviceKeysHost"></div>';
  el.innerHTML = html;

  const fullBtn = el.querySelector('#syncFull');
  if (fullBtn) fullBtn.onclick = async () => {
    fullBtn.disabled = true;
    resetSyncWatermarks();
    await syncNow(true);
    fullBtn.disabled = false;
    renderSyncPanel(el);
  };
  const pingBtn = el.querySelector('#syncPing');
  if (pingBtn) pingBtn.onclick = async () => {
    const out = el.querySelector('#syncPingOut');
    pingBtn.disabled = true;
    out.textContent = 'Проверяю…';
    const r = await pingServer();
    pingBtn.disabled = false;
    out.className = 'hint sync-ping' + (r.ok ? '' : ' err');
    out.textContent = r.ok
      ? `Скрипт отвечает, версия: ${r.version || 'неизвестна'}`
      : r.error;
  };

  const kg = el.querySelector('#syncKeyGo');
  if (kg) kg.onclick = async () => {
    const v = el.querySelector('#syncKey').value.trim();
    if (v) { await connectKey(v); renderSyncPanel(el); }
  };
  const gw = el.querySelector('#gBtnWrap');
  if (gw) {
    loadGIS().then(() => {
      google.accounts.id.initialize({
        client_id: CLIENT_ID,
        auto_select: false,
        callback: async c => {
          localStorage.setItem(TOKEN_KEY, c.credential);
          resetSyncWatermarks();   // вход — тянем всё с нуля
          lastError = '';
          refreshStatus();
          await syncNow();
          renderSyncPanel(el);
        }
      });
      google.accounts.id.renderButton(gw, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ru' });
    }).catch(() => {});
  }
  const nb = el.querySelector('#syncNowBtn');
  if (nb) nb.onclick = async () => { await syncNow(true); renderSyncPanel(el); };
  const ob = el.querySelector('#syncOut');
  if (ob) ob.onclick = async () => { await signOut(); renderSyncPanel(el); };

  // Панель генератора ключей — показывается только владельцу после входа
  renderDeviceKeysPanel(el.querySelector('#deviceKeysHost'));
}

export function syncInit() {
  document.addEventListener('user-change', schedule);
  window.addEventListener('online', () => { refreshStatus(); syncNow(); });
  window.addEventListener('offline', () => setStatus('offline'));
  refreshStatus();
  if (configured() && signedIn()) setTimeout(syncNow, 300);
}
