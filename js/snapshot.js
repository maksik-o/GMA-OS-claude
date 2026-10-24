/* ══════════════════════════════════════════════════════════════════
   Снимок данных приложения.

   Как собрать данные раздела для отправки и как влить пришедшие.
   Общее для всех способов синхронизации: старого (скрипт Google) и
   нового (свой файл пользователя — локальный или в его облаке).
   Влияние везде одно и то же: запись побеждает, если она новее
   (updatedAt), удалённое помечается «могильником» и не воскресает.
   ══════════════════════════════════════════════════════════════════ */
import {
  state, applyMerged, getTagsDict, getTagsDeleted, getTagsAt, mergeTagsMeta,
  getTombstonesFull
} from './store.js';
import { getContactsForSync, applyContactsMerged, getContactTombstones, applyContactTombstones } from './contacts.js';
import { getNotesForSync, getNoteTombstones, applyNotesMerged } from './notes.js';
import { getFinanceForSync, applyFinanceMerged } from './finance.js';
import { getKbForSync, applyKbMerged } from './kb.js';

export const PARTS = ['tasks', 'notes', 'contacts', 'finance', 'kb'];

export const newer = (list, since) => !since
  ? (list || [])
  : (list || []).filter(r => r && String(r.updatedAt || '') > since);

export function partPayload(part, since) {
  if (part === 'tasks') {
    const tombstonesToSend = getTombstonesFull();
    const tombIds = new Set(tombstonesToSend.map(t => t.id));
    return {
      tasks: newer(state.tasks.filter(t => t && !tombIds.has(t.id)), since),
      tombstones: tombstonesToSend,        // могильники малы, шлём целиком
      tags: getTagsDict(),
      tagsDeleted: getTagsDeleted(),
      tagsAt: getTagsAt(),
    };
  }
  if (part === 'notes') return { notes: newer(getNotesForSync(), since), noteTombstones: getNoteTombstones() };
  if (part === 'contacts') return { contacts: newer(getContactsForSync(), since), contactTombstones: getContactTombstones() };
  if (part === 'finance') return { finance: newer(getFinanceForSync(), since) };
  if (part === 'kb') return { kb: newer(getKbForSync(), since) };
  return {};
}
export async function applyPart(part, out) {
  if (part === 'tasks') {
    await applyMerged({
      tasks: Array.isArray(out.tasks) ? out.tasks : [],
      tombstones: Array.isArray(out.tombstones) ? out.tombstones : [],
    });
    if (Array.isArray(out.tags)) await mergeTagsMeta(out.tags, out.tagsDeleted || [], out.tagsAt);
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

/* ── Весь набор данных одним объектом ── */
export const SNAPSHOT_FORMAT = 1;
export function buildSnapshot() {
  const parts = {};
  for (const p of PARTS) parts[p] = partPayload(p, '');
  /* app: 'GMA-OS' — внутренняя метка формата (прежнее название). Не
     меняем: иначе файлы, сохранённые раньше, и устройства со старой
     версией перестанут узнавать данные друг друга. */
  return { app: 'GMA-OS', format: SNAPSHOT_FORMAT, savedAt: new Date().toISOString(), parts };
}
export const isSnapshot = x => !!x && typeof x === 'object' && x.app === 'GMA-OS' && x.parts && typeof x.parts === 'object';
/* Влить снимок в данные устройства (слиянием, а не заменой) */
export async function applySnapshot(snap) {
  if (!isSnapshot(snap)) throw new Error('Это не файл данных Essential OS');
  if ((snap.format || 1) > SNAPSHOT_FORMAT) throw new Error('Файл создан более новой версией приложения — обновите страницу');
  for (const p of PARTS) if (snap.parts[p]) await applyPart(p, snap.parts[p]);
}
