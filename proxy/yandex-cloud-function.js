/* Прокси скачивания для Яндекс Диска — Yandex Cloud Functions.

   То же, что proxy/yandex-worker.js, но в Yandex Cloud: доступен
   в России без VPN. Скачивает файл по подписанной ссылке Яндекс
   Диска и отдаёт его с заголовком CORS. Ничего не хранит и не
   логирует, токенов не видит.

   Пускает только страницы приложения (ALLOWED_ORIGINS) и только
   к серверам скачивания Диска — открытым прокси он не станет.

   Среда выполнения: Node.js 18 или новее, точка входа index.handler. */

const ALLOWED_ORIGINS = [
  'https://maksik-o.github.io',
];
const ALLOWED_HOST = /(^|\.)disk\.yandex\.(ru|net|com)$/;

module.exports.handler = async function (event) {
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;
  const origin = headers.origin || '';
  if (!ALLOWED_ORIGINS.includes(origin)) return { statusCode: 403, body: 'Forbidden' };

  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  const method = event.httpMethod || 'GET';
  if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (method !== 'GET') return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  let target;
  try { target = new URL((event.queryStringParameters || {}).u || ''); }
  catch { return { statusCode: 400, headers: cors, body: 'Bad url' }; }
  if (target.protocol !== 'https:' || !ALLOWED_HOST.test(target.hostname)) {
    return { statusCode: 400, headers: cors, body: 'Host not allowed' };
  }

  let upstream;
  try { upstream = await fetch(target.toString(), { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (GMA-OS proxy)', 'Accept': '*/*' } }); }
  catch (e) { return { statusCode: 502, headers: cors, body: 'Upstream failed: ' + (e && e.message) }; }
  if (!upstream.ok) return { statusCode: 502, headers: cors, body: await describe(upstream) };
  return {
    statusCode: upstream.status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: await upstream.text(),
    isBase64Encoded: false,
  };
};

// Что именно ответил Яндекс — для диагностики (без содержимого файла).
async function describe(r) {
  let host = '';
  try { host = new URL(r.url).hostname; } catch {}
  const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
  return 'Yandex answered ' + r.status + (r.redirected ? ' after redirect to ' + host : ' from ' + host) + (body ? ' | ' + body : '');
}
