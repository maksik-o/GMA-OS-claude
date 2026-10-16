/* Прокси скачивания для Яндекс Диска (Cloudflare Worker).

   Яндекс отдаёт файл по одноразовой ссылке downloader.disk.yandex.ru,
   но без заголовка CORS — браузер не даёт приложению его прочитать.
   Этот воркер скачивает файл по такой ссылке и возвращает его
   с нужным заголовком. Он ничего не хранит и не логирует, токенов
   не видит: ссылка уже подписана Яндексом и живёт несколько часов.

   Пускает только запросы со страниц приложения (ALLOWED_ORIGINS)
   и только к серверам скачивания Яндекс Диска — открытым прокси
   для всего интернета он не станет. */

const ALLOWED_ORIGINS = [
  'https://maksik-o.github.io',
];
const ALLOWED_HOST = /(^|\.)disk\.yandex\.(ru|net|com)$/;

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response('Forbidden', { status: 403 });
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    let target;
    try { target = new URL(new URL(request.url).searchParams.get('u') || ''); }
    catch { return new Response('Bad url', { status: 400, headers: cors }); }
    if (target.protocol !== 'https:' || !ALLOWED_HOST.test(target.hostname)) {
      return new Response('Host not allowed', { status: 400, headers: cors });
    }

    let upstream;
    try { upstream = await fetch(target.toString(), { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (GMA-OS proxy)', 'Accept': '*/*' } }); }
    catch (e) { return new Response('Upstream failed: ' + (e && e.message), { status: 502, headers: cors }); }
    if (!upstream.ok) return new Response(await describe(upstream), { status: 502, headers: cors });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  },
};

// Что именно ответил Яндекс — для диагностики (без содержимого файла).
async function describe(r) {
  let host = '';
  try { host = new URL(r.url).hostname; } catch {}
  const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
  return 'Yandex answered ' + r.status + (r.redirected ? ' after redirect to ' + host : ' from ' + host) + (body ? ' | ' + body : '');
}
