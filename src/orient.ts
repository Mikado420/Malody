/**
 * 横画面固定。
 * 端末が縦向き（または縦長のウィンドウ）のときは、CSS で #root 全体を 90° 回転させて横画面として表示する
 * （iPhone の Safari は画面の向きを固定する API に対応していないため）。
 * 回転中はタッチ座標も回転させる必要があるので、要素内の座標はこの関数で求める。
 */

const portrait = matchMedia('(orientation: portrait)');

export const isRotated = () => portrait.matches;

export function onRotateChange(fn: () => void) {
  portrait.addEventListener('change', fn);
}

/** clientX / clientY を、要素の（回転前の）左上を原点とする座標に変換 */
export function localPoint(e: { clientX: number; clientY: number }, el: Element) {
  const r = el.getBoundingClientRect();
  if (isRotated()) {
    // #root は時計回りに 90° 回っている: 要素の x 軸は画面の下向き、y 軸は画面の左向き
    return { x: e.clientY - r.top, y: r.right - e.clientX };
  }
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
