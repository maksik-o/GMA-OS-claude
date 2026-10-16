/* ══════════════════════════════════════════════════════════════════
   Вложения (файлы задач и заметок базы знаний).

   Файл сохраняется на устройстве и, если выбранное хранилище умеет
   хранить файлы (сейчас — Яндекс Диск), копируется туда отдельным
   файлом. В данные (и в файл синхронизации) попадает только запись
   о вложении: id, имя, размер, тип и где лежит копия (src). Поэтому
   файл данных не раздувается от вложений.

   Облако подключает vault.js через setupAttachments() — так этот
   модуль не зависит от движка синхронизации.
   ══════════════════════════════════════════════════════════════════ */
import { dbGetFile, dbPutFile, dbDelFile } from './db.js';
import { uid } from './store.js';

const QUEUE_KEY = 'rl_att_queue';   // ещё не отправленные в облако операции

let getMode = () => '';
let cloud = () => null;   // → { id, limit, limitText, put(id, blob), get(id), del(id) } или null
export function setupAttachments(opts) {
  if (opts.getMode) getMode = opts.getMode;
  if (opts.cloud) cloud = opts.cloud;
}
export const storageMode = () => getMode();

export const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ';

/* Ограничение хранилища: у Яндекс Диска файл скачивается через прокси,
   а тот отдаёт ограниченный объём. У остальных — только свои лимиты
   раздела (5 МБ у задач, 8 МБ у базы знаний). */
export function attachLimit() {
  const c = cloud();
  return c && c.limit ? { bytes: c.limit, text: c.limitText } : null;
}
export function limitNote() {
  const l = attachLimit();
  return l ? l.text : '';
}

/* ── Очередь операций с облаком (переживает перезагрузку) ── */
function queue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {}
}
let flushing = null;
export function flushAttachments() {
  if (flushing) return flushing;
  flushing = (async () => {
    await null;   // чтобы flushing успел присвоиться до завершения
    try {
      let q = queue();
      for (const op of [...q]) {
        const c = cloud();
        if (!c || !navigator.onLine) break;
        if (c.id !== op.src) continue;   // операция для другого хранилища — ждёт его
        try {
          if (op.op === 'put') {
            const rec = await dbGetFile(op.id);
            if (rec && rec.blob) await c.put(op.id, rec.blob);
          } else if (op.op === 'del') {
            await c.del(op.id);
          }
        } catch (e) {
          console.warn('[вложения] не отправлено, повторим позже:', (e && e.message) || e);
          break;
        }
        q = queue().filter(x => !(x.op === op.op && x.id === op.id));
        saveQueue(q);
      }
    } finally { flushing = null; }
  })();
  return flushing;
}
function enqueue(op) {
  let q = queue().filter(x => !(x.id === op.id && x.op === op.op));
  // удаление отменяет ещё не отправленную загрузку того же файла
  if (op.op === 'del') q = q.filter(x => x.id !== op.id);
  saveQueue(q.concat(op));
}

/* Прикрепить файл: проверка размера → копия на устройстве → в облако.
   maxBytes — свой лимит раздела. Возвращает запись о вложении. */
export async function saveAttachment(file, maxBytes, maxText) {
  const lim = attachLimit();
  if (lim && file.size > lim.bytes) {
    throw new Error(`«${file.name}» — ${fmtSize(file.size)}. ${lim.text}.`);
  }
  if (maxBytes && file.size > maxBytes) throw new Error(`Файл больше ${maxText}`);
  const id = uid();
  await dbPutFile({ id, name: file.name, mime: file.type, blob: file });
  const c = cloud();
  const meta = { id, name: file.name, size: file.size, mime: file.type || '', src: c ? c.id : 'local' };
  if (c) { enqueue({ op: 'put', id, src: c.id }); flushAttachments(); }
  return meta;
}

/* Получить содержимое: с устройства, иначе из облака (и запомнить) */
export async function loadAttachment(meta) {
  const rec = await dbGetFile(meta.id).catch(() => null);
  if (rec && rec.blob) return rec.blob;
  const c = cloud();
  if (meta.src && meta.src !== 'local' && c && c.id === meta.src) {
    const blob = await c.get(meta.id);
    await dbPutFile({ id: meta.id, name: meta.name, mime: meta.mime, blob }).catch(() => {});
    return blob;
  }
  if (meta.src === 'yandex') throw new Error('Файл лежит на Яндекс Диске — подключите его в настройках синхронизации.');
  return null;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* Удалить: с устройства сразу, из облака — когда получится */
export async function deleteAttachment(meta) {
  await dbDelFile(meta.id).catch(() => {});
  if (meta.src && meta.src !== 'local') { enqueue({ op: 'del', id: meta.id, src: meta.src }); flushAttachments(); }
}
