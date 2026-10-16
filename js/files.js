// Файлы задач. При новой синхронизации — общий механизм вложений
// (устройство + выбранное хранилище, attach.js). При прежней (скрипт
// Google) — как раньше: загрузка в Drive через скрипт.
import { getTask, updateTask } from './store.js';
import { apiCall } from './sync.js';
import { dbGetFile, dbPutFile, dbDelFile } from './db.js';
import { fmtSize, storageMode, saveAttachment, loadAttachment, deleteAttachment, downloadBlob } from './attach.js';
export { fmtSize };

const TASK_MAX = 5 * 1024 * 1024;

export async function attachFile(taskId, file) {
  if (storageMode() !== 'legacy') {
    const meta = await saveAttachment(file, TASK_MAX, '5 МБ');
    const t = getTask(taskId);
    if (!t) { await deleteAttachment(meta); return; }
    await updateTask(taskId, { files: [...(t.files || []), meta] });
    return;
  }
  if (file.size > TASK_MAX) throw new Error('Файл больше 5 МБ');
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  try {
    const out = await apiCall('upload', { payload: { name: file.name, mime: file.type, data } });
    const t = getTask(taskId);
    if (!t) return;
    await updateTask(taskId, { files: [...(t.files || []), out.file] });
  } finally {
  }
}

export async function openTaskFile(meta) {
  if (meta.src) {   // вложение нового образца
    const blob = await loadAttachment(meta);
    if (!blob) throw new Error('Файл доступен только на устройстве, где его добавили');
    downloadBlob(blob, meta.name);
    return;
  }
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
  const meta = (t.files || []).find(f => f.id === fileId);
  if (meta && meta.src) {
    await deleteAttachment(meta);
    await updateTask(taskId, { files: (t.files || []).filter(f => f.id !== fileId) });
    return;
  }
  await apiCall('filedel', { payload: { fileId } }).catch(() => {});
  await dbDelFile(fileId).catch(() => {});
  await updateTask(taskId, { files: (t.files || []).filter(f => f.id !== fileId) });
}
