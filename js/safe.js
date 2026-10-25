/* Отступы безопасной зоны (вырез, статус-бар, полоска «домой») в пикселях.
   env() в JS напрямую не прочитать — меряем скрытым элементом. */
let probe = null;
export function safeInsets() {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  return { t: parseFloat(cs.paddingTop) || 0, b: parseFloat(cs.paddingBottom) || 0 };
}
/* Высота, которую сверху занимает мини-полоса меню (rail.js), пока открыто
   окно режимов панели ввода: окно до неё не доходит */
export const RAIL_MINI_H = 58;
