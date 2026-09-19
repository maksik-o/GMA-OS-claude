// Файлы задач: загрузка в Drive, открытие с офлайн-кэшем, удаление
import { getTask, updateTask } from './store.js';
import { apiCall } from './sync.js';
import { dbGetFile, dbPutFile, dbDelFile } from './db.js';

export const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ';

/* Колбэк прогресса: вызывается из sheet.js */
let onUploadProgress = null;
export function setUploadProgressCb(fn){ onUploadProgress = fn; }

export async function attachFile(taskId, file) {
  if (file.size > 5 * 1024 * 1024) throw new Error('Файл больше 5 МБ');
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  if (onUploadProgress) onUploadProgress(true);
  try {
    const out = await apiCall('upload', { payload: { name: file.name, mime: file.type, data } });
    const t = getTask(taskId);
    if (!t) return;
    await updateTask(taskId, { files: [...(t.files || []), out.file] });
  } finally {
    if (onUploadProgress) onUploadProgress(false);
  }
}

export async function openTaskFile(meta) {
  let cached = await dbGetFile(meta.id);
  if (!cached) {
    const out = await apiCall('file', { payload: { fileId: meta.id } });
    const bin = Uint8Array.from(atob(out.file.data), c => c.charCodeAt(0));
    cached = { id: meta.id, name: out.file.name, mime: out.file.mime, blob: new Blob([bin], { type: out.file.mime }) };
    await dbPutFile(cached);
  }
  const url = URL.createObjectURL(cached.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = cached.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function removeTaskFile(taskId, fileId) {
  const t = getTask(taskId);
  if (!t) return;
  await apiCall('filedel', { payload: { fileId } }).catch(() => {});
  await dbDelFile(fileId).catch(() => {});
  await updateTask(taskId, { files: (t.files || []).filter(f => f.id !== fileId) });
}
