/**
 * 横画面固定。
 * 端末が縦向き（または縦長のウィンドウ）のときは、CSS で #root 全体を 90° 回転させて横画面として表示する
 * （iPhone の Safari は画面の向きを固定する API に対応していないため）。
 * 回転中はタッチ座標も回転させる必要があるので、要素内の座標はこの関数で求める。
 */

const portrait = matchMedia('(orientation: portrait)');

/** TJA の画面を開いている間は、縦向きでも回さない（キーボードが占める割合が小さく、多くの行が見える） */
export const isRotated = () => portrait.matches && !document.body.classList.contains('tja-open');

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

/**
 * #root の大きさを実際の画面サイズ（innerWidth / innerHeight）に合わせる。
 * CSS の 100vh / 100dvh は端末やブラウザによって実際の表示領域とずれることがあるため。
 */
/** 文字を入れる欄（キーボードが出るもの）にフォーカスがあるか */
export function typing() {
  const a = document.activeElement;
  if (a instanceof HTMLTextAreaElement) return true;
  if (a instanceof HTMLInputElement) return !['checkbox', 'radio', 'range', 'button', 'file', 'color'].includes(a.type);
  return a instanceof HTMLElement && a.isContentEditable;
}

export function fitRoot() {
  const apply = () => {
    // キーボードが出ている間は大きさを変えない（変えると画面全体が縮んだりずれたりする）
    if (typing() && !document.body.classList.contains('tja-open')) return;
    const st = document.documentElement.style;
    st.setProperty('--vw', `${window.innerWidth}px`);
    st.setProperty('--vh', `${window.innerHeight}px`);
    // TJA の画面（縦向き）の高さ。ホーム画面から開いたとき（standalone）は innerHeight が上の帯のぶん短いことがあるので、
    // 画面そのものの高さを使う（iPhone の screen.height は向きに関係なく長い辺）
    const standalone = (navigator as Navigator & { standalone?: boolean }).standalone || matchMedia('(display-mode: standalone)').matches;
    const full = Math.max(screen.width, screen.height);
    st.setProperty('--tja-h', `${standalone && portrait.matches ? Math.max(full, window.innerHeight) : window.innerHeight}px`);
  };
  apply();
  const later = () => {
    apply();
    // アドレスバーの出入りや回転のアニメーション後にもう一度
    setTimeout(apply, 350);
  };
  window.addEventListener('resize', later);
  window.addEventListener('orientationchange', later);
  window.visualViewport?.addEventListener('resize', later);
  portrait.addEventListener('change', later);
  document.addEventListener('focusout', () => setTimeout(() => { if (!typing()) apply(); }, 120));
  keyboardGuard();
}

/**
 * 文字を入れるときに画面が上へずれる（iPhone の Safari が入力欄を見せようとページごと動かす）のを止める。
 * ページは動かさずに、キーボードのぶんだけ設定画面（シート）を縮めて、入力欄をシートの中でスクロールして見せる。
 * TJA の画面は別のしくみで合わせているので触らない
 */
function keyboardGuard() {
  const vv = window.visualViewport;
  const body = document.body;
  const st = document.documentElement.style;
  const reset = () => { if (window.scrollX || window.scrollY) window.scrollTo(0, 0); };
  const clear = () => {
    body.classList.remove('kb', 'kb-rot');
    st.removeProperty('--kb');
  };
  /** 入力欄を、その入っているスクロールできる箱（.sheet-body など）の中で見える位置へ */
  const reveal = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return;
    let box = el.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (!box) return;
    // 回転していても使えるよう、画面上の位置ではなくレイアウト上の位置（offsetTop）で比べる
    let top = 0;
    for (let e: HTMLElement | null = el; e && e !== box && e !== document.body; e = e.offsetParent as HTMLElement | null) top += e.offsetTop;
    let btop = 0;
    for (let e: HTMLElement | null = box; e && e !== document.body; e = e.offsetParent as HTMLElement | null) btop += e.offsetTop;
    const y = top - (box.offsetParent === el.offsetParent ? btop : 0);
    const pad = 12;
    if (y - pad < box.scrollTop) box.scrollTop = Math.max(0, y - pad);
    else if (y + el.offsetHeight + pad > box.scrollTop + box.clientHeight) box.scrollTop = y + el.offsetHeight + pad - box.clientHeight;
  };
  const update = () => {
    if (body.classList.contains('tja-open')) { clear(); return; }
    reset();
    if (!typing() || !vv) { clear(); return; }
    // キーボードの高さ（見えている範囲が画面よりどれだけ短いか）
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height));
    if (kb < 60) { clear(); return; }
    st.setProperty('--kb', `${kb}px`);
    body.classList.add('kb');
    body.classList.toggle('kb-rot', isRotated());
    requestAnimationFrame(() => { reveal(); reset(); });
  };
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', reset);
  window.addEventListener('scroll', () => { if (!body.classList.contains('tja-open')) reset(); });
  document.addEventListener('focusin', () => { update(); setTimeout(update, 120); setTimeout(update, 400); });
  document.addEventListener('focusout', () => setTimeout(update, 60));
}
