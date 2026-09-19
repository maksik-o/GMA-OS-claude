/* ══════════════════════════════════════════════════════════════════
   Импорт и экспорт финансовых операций.

   Поддержаны CSV/TSV (в том числе банковские выписки без заголовка)
   и .xlsx. Xlsx читаем сами: это ZIP, а в браузере есть
   DecompressionStream('deflate-raw') — распаковываем поток и
   разбираем sharedStrings.xml + первый лист. Никаких библиотек,
   всё работает офлайн в PWA.
   ══════════════════════════════════════════════════════════════════ */

/* ── CSV ── */
export function parseDelimited(text, delim) {
  const d = delim || guessDelim(text);
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}
function guessDelim(text) {
  const head = text.slice(0, 4000);
  const counts = [[';', 0], ['\t', 0], [',', 0]];
  let q = false;
  for (const ch of head) {
    if (ch === '"') q = !q;
    else if (!q) for (const c of counts) if (ch === c[0]) c[1]++;
  }
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] ? counts[0][0] : ';';
}

/* ── XLSX ── */
const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('no-ds');
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
/* Разбор ZIP по центральному каталогу — надёжнее, чем идти по локальным
   заголовкам: там размеры могут лежать в data descriptor после данных. */
async function unzip(buf) {
  const b = new Uint8Array(buf), v = dv(b);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 66000; i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not-zip');
  const n = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const cmtLen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = v.getUint16(lho + 26, true);
    const lExtraLen = v.getUint16(lho + 28, true);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = b.subarray(start, start + csize);
    out.set(name, method === 0 ? Promise.resolve(raw) : inflateRaw(raw));
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}
const xmlText = u8 => new TextDecoder().decode(u8);
const unent = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
                    .replace(/&amp;/g, '&');
const colNum = ref => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64); else break;
  }
  return n - 1;
};
/* Excel хранит даты числом дней от 1899-12-30 */
const excelDate = n => {
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
export async function parseXlsx(buf) {
  const files = await unzip(buf);
  let shared = [];
  const ssKey = [...files.keys()].find(k => /sharedStrings\.xml$/i.test(k));
  if (ssKey) {
    const xml = xmlText(await files.get(ssKey));
    shared = [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
      unent([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  }
  const sheetKey = [...files.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k)).sort()[0];
  if (!sheetKey) throw new Error('no-sheet');
  const xml = xmlText(await files.get(sheetKey));
  /* какие стили — даты: иначе дата приедет числом 45900 */
  const dateStyles = new Set();
  const stKey = [...files.keys()].find(k => /styles\.xml$/i.test(k));
  if (stKey) {
    const st = xmlText(await files.get(stKey));
    const xf = st.split('<cellXfs')[1] || '';
    [...xf.matchAll(/<xf[^>]*numFmtId="(\d+)"[^>]*\/?>/g)].forEach((m, i) => {
      const id = +m[1];
      if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || id >= 164) dateStyles.add(i);
    });
  }
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g)) {
      const attrs = cm[1] || cm[3] || '';
      const inner = cm[2] || '';
      const ref = (attrs.match(/r="([A-Z]+)/) || [])[1] || '';
      const t = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
      const sIdx = +((attrs.match(/s="(\d+)"/) || [])[1] || -1);
      let val = '';
      if (t === 'inlineStr') val = unent([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
      else {
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        const raw = vm ? unent(vm[1]) : '';
        if (t === 's') val = shared[+raw] || '';
        else if (t === 'b') val = raw === '1' ? 'ИСТИНА' : 'ЛОЖЬ';
        else if (raw !== '' && dateStyles.has(sIdx) && !isNaN(+raw)) val = excelDate(+raw);
        else val = raw;
      }
      const idx = ref ? colNum(ref) : cells.length;
      while (cells.length < idx) cells.push('');
      cells[idx] = val;
    }
    rows.push(cells);
  }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}

/* ── Распознавание колонок ── */
const RX_DATE = [
  /^(\d{2})[.\/-](\d{2})[.\/-](\d{4})/,     // 10.09.2026
  /^(\d{4})-(\d{2})-(\d{2})/,               // 2026-09-10
];
export function toISODate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(RX_DATE[1]);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(RX_DATE[0]);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return '';
}
export function toAmount(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  s = s.replace(/[\s\u00a0₽$€]/g, '');
  /* 1 234,56 и 1,234.56 — решаем по последнему разделителю */
  const lastC = s.lastIndexOf(','), lastD = s.lastIndexOf('.');
  if (lastC > lastD) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}
const HEAD_MAP = [
  ['date',   /^(дата|date|дата операции|дата платежа)/i],
  ['amount', /^(сумма|amount|сумма операции|сумма в валюте)/i],
  ['type',   /^(тип|type|направление|операция)/i],
  ['cat',    /^(категория|category|назначение)/i],
  ['acc',    /^(счёт|счет|account|карта)/i],
  ['note',   /^(заметка|описание|note|комментарий|назначение платежа|детали)/i],
];
/* Ищем колонки по содержимому: для банковских выписок без заголовка
   это единственный рабочий способ. */
export function detectColumns(rows) {
  const sample = rows.slice(0, 40);
  const width = Math.max(...sample.map(r => r.length));
  const map = { date: -1, amount: -1, type: -1, cat: -1, acc: -1, note: -1 };
  let hasHeader = false;

  const head = rows[0] || [];
  const headHits = head.filter(h => HEAD_MAP.some(([, rx]) => rx.test(String(h).trim()))).length;
  if (headHits >= 2) {
    hasHeader = true;
    head.forEach((h, i) => {
      for (const [key, rx] of HEAD_MAP) if (map[key] < 0 && rx.test(String(h).trim())) map[key] = i;
    });
  }
  const body = hasHeader ? sample.slice(1) : sample;
  const score = i => body.reduce((a, r) => a + (r[i] != null ? 1 : 0), 0);
  for (let i = 0; i < width; i++) {
    const vals = body.map(r => String(r[i] == null ? '' : r[i]).trim()).filter(Boolean);
    if (!vals.length) continue;
    const dates = vals.filter(v => toISODate(v)).length / vals.length;
    const nums = vals.filter(v => !isNaN(toAmount(v)) && /\d/.test(v)).length / vals.length;
    const avgLen = vals.reduce((a, v) => a + v.length, 0) / vals.length;
    if (map.date < 0 && dates > 0.7) { map.date = i; continue; }
    if (map.amount < 0 && nums > 0.85 && dates < 0.3 && avgLen < 18) { map.amount = i; continue; }
    if (map.note < 0 && avgLen > 24) map.note = i;
  }
  /* «Зачисление/Списание» — колонка направления */
  if (map.type < 0) {
    for (let i = 0; i < width; i++) {
      const vals = body.map(r => String(r[i] == null ? '' : r[i]).trim()).filter(Boolean);
      if (vals.length && vals.every(v => /^(зачисление|списание|приход|расход|income|expense|débit|credit|дебет|кредит)$/i.test(v))) {
        map.type = i;
        break;
      }
    }
  }
  /* Короткая повторяющаяся колонка справа от суммы — обычно категория */
  if (map.cat < 0) {
    for (let i = width - 1; i >= 0; i--) {
      if (i === map.date || i === map.amount || i === map.note || i === map.type) continue;
      const vals = body.map(r => String(r[i] == null ? '' : r[i]).trim()).filter(Boolean);
      if (vals.length < body.length * 0.5) continue;
      const uniq = new Set(vals).size;
      const avgLen = vals.reduce((a, v) => a + v.length, 0) / vals.length;
      if (uniq > 1 && uniq <= Math.max(3, vals.length * 0.7) && avgLen >= 4 && avgLen <= 34 && !/^\d+$/.test(vals[0])) {
        map.cat = i;
        break;
      }
    }
  }
  if (map.acc < 0) {
    for (let i = 0; i < width; i++) {
      if (i === map.date || i === map.amount || i === map.note || i === map.type || i === map.cat) continue;
      const vals = body.map(r => String(r[i] == null ? '' : r[i]).trim()).filter(Boolean);
      if (vals.length >= body.length * 0.8 && new Set(vals).size <= 3) { map.acc = i; break; }
    }
  }
  return { map, hasHeader, score };
}

const IS_INCOME = /^(зачисление|приход|income|credit|кредит|пополнение)$/i;
const IS_EXPENSE = /^(списание|расход|expense|debit|дебет|оплата|покупка)$/i;

/* Отпечаток операции — по нему отсекаем повторный импорт того же файла.
   Берём дату, сумму, направление и первые 60 символов описания:
   выписка за пересекающийся период даст те же значения. */
export function fingerprint(t) {
  const note = String(t.note || '').replace(/\s+/g, ' ').trim().slice(0, 60).toLowerCase();
  return [t.date, (Math.round((Number(t.amount) || 0) * 100)), t.type, note].join('|');
}

export function rowsToTx(rows, opts) {
  const o = opts || {};
  const { map, hasHeader } = o.columns || detectColumns(rows);
  if (map.date < 0 || map.amount < 0) return { list: [], map, error: 'Не нашёл колонки с датой и суммой' };
  const body = hasHeader ? rows.slice(1) : rows;
  const list = [];
  for (const r of body) {
    const date = toISODate(r[map.date]);
    let amount = toAmount(r[map.amount]);
    if (!date || isNaN(amount) || amount === 0) continue;
    let type;
    const rawType = map.type >= 0 ? String(r[map.type] || '').trim() : '';
    if (IS_INCOME.test(rawType)) type = 'income';
    else if (IS_EXPENSE.test(rawType)) type = 'expense';
    else type = amount < 0 ? 'expense' : 'income';
    amount = Math.abs(amount);
    const note = map.note >= 0 ? String(r[map.note] || '').trim() : '';
    const catName = map.cat >= 0 ? String(r[map.cat] || '').trim() : '';
    const accName = map.acc >= 0 ? String(r[map.acc] || '').trim() : '';
    list.push({ date, amount, type, note, catName, accName });
  }
  return { list, map };
}

/* ── Чтение файла ── */
export async function readFinanceFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    return parseXlsx(await file.arrayBuffer());
  }
  if (name.endsWith('.xls')) throw new Error('old-xls');
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  /* Выписки часто отдают в windows-1251: если много «замены» — перечитываем */
  if ((text.match(/\uFFFD/g) || []).length > text.length * 0.01) {
    try { text = new TextDecoder('windows-1251').decode(buf); } catch {}
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return parseDelimited(text);
}

/* ── Экспорт ── */
export function toCSV(rows) {
  const esc = v => {
    const s = String(v == null ? '' : v);
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '\uFEFF' + rows.map(r => r.map(esc).join(';')).join('\r\n');
}
export function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
