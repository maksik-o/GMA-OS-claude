// Настройки синхронизации. Заполняются один раз после развертывания Apps Script.
export const API_URL = 'https://script.google.com/macros/s/AKfycbzbUqRnmptDWQs2zWzwQHCt26ZHzirvQ5Sbye3KNBK0UHhunJTKtefxXNgDHsLq1gCfhQ/exec';                            // заканчивается на /exec
export const CLIENT_ID = '40124617550-80jhol56dkg6jq84l14k96d57kvrhret.apps.googleusercontent.com'; // из console.cloud.google.com

// Email владельца приложения — ТОЛЬКО этому пользователю видна панель генерации ключей устройства.
// Заполни своим Google-email, чтобы раздавать ключи друзьям из приложения.
// Оставь пустым, чтобы панель не показывалась никому.
export const OWNER_EMAIL = 'maksimgomzyakov1@gmail.com';

// ── Хранилища пользователя (данные лежат у него, не у нас) ──
// ClientID приложения на oauth.yandex.ru. Это публичный идентификатор,
// он не даёт доступа ни к чьим данным. Client secret сюда НЕ вписывать.
// Пусто — вариант «Яндекс Диск» в приложении помечен «скоро».
export const YANDEX_CLIENT_ID = '08e532e75ecb430baf6f86bf1e7aaeac';

// Прокси для скачивания с Яндекс Диска — Яндекс не даёт браузеру
// скачать файл напрямую. Прокси только пересылает файл, не хранит.
// Можно несколько: пробуются по очереди. Yandex Cloud Functions
// (proxy/yandex-cloud-function.js) работает в России без VPN,
// Cloudflare Worker (proxy/yandex-worker.js) — запасной.
// Пусто — вариант «Яндекс Диск» помечен «скоро».
export const YANDEX_PROXY = [
  'https://gma-os-yandex.maksimgomzyakov1.workers.dev/',
];
