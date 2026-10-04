import type { HitKind } from './engine/game';
import { localPoint } from './orient';

/** at = 叩いた瞬間（performance.now() 基準の ms）、pt = タッチした場所（キーボードのときはなし） */
export type HitHandler = (kind: HitKind, side: 'L' | 'R', at: number, pt?: { x: number; y: number; ring: number }) => void;

/** イベントの timeStamp を performance.now() 基準の時刻として使う（古いブラウザの別基準の値は捨てる） */
function eventTime(ts: number): number {
  const now = performance.now();
  return ts > 0 && ts <= now + 5 && now - ts < 1000 ? ts : now;
}

/** キー割り当て（KeyboardEvent.code） */
export const DEFAULT_KEYS: Record<string, { kind: HitKind; side: 'L' | 'R' }> = {
  KeyD: { kind: 'ka', side: 'L' },
  KeyF: { kind: 'don', side: 'L' },
  KeyJ: { kind: 'don', side: 'R' },
  KeyK: { kind: 'ka', side: 'R' },
};

/** タッチ入力の集計（結果画面の診断用） */
export const touchStats = { starts: 0, recovered: 0 };

/**
 * キーボードとタッチ（ポインタ）入力。
 * タッチは太鼓の面の楕円の中か外かで ドン/カッ を判定する。
 *
 * iPhone の Safari では、片方の指がまだ画面に触れている間に別の指で叩くと、
 * その指の touchstart が届かないことがある（2 本指のジェスチャーとして扱われる・他のイベントにまとめられる）。
 * そこで、どのタッチイベントでも「まだ見ていない指」が含まれていたら、その指が叩いたものとして扱う。
 */
export function bindInput(
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  getDrum: () => { x: number; y: number; rx: number; ry: number },
  onHit: HitHandler,
): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    const k = DEFAULT_KEYS[e.code];
    if (!k) return;
    e.preventDefault();
    onHit(k.kind, k.side, eventTime(e.timeStamp));
  };

  const hitAt = (clientX: number, clientY: number, at: number) => {
    const { x: px, y: py } = localPoint({ clientX, clientY }, canvas);
    const d = getDrum();
    // 画面のどこを叩いても反応する（太鼓の面の楕円の中＝ドン、それ以外はすべてカッ）
    const nx = (px - d.x) / d.rx;
    const ny = (py - d.y) / d.ry;
    const side = px < d.x ? 'L' : 'R';
    const ring = Math.sqrt(nx * nx + ny * ny);
    onHit(ring <= 1 ? 'don' : 'ka', side, at, { x: px, y: py, ring });
  };

  /** いま画面に触れている（叩いたとして処理済みの）指 */
  let seen = new Set<number>();

  const onTouch = (e: TouchEvent) => {
    // 終了ボタンなどのボタンはふつうに押せるようにする
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.preventDefault();
    const at = eventTime(e.timeStamp);
    const fresh: Touch[] = [];
    if (e.type === 'touchstart') {
      for (const t of Array.from(e.changedTouches)) fresh.push(t);
      touchStats.starts += fresh.length;
    } else if (e.type === 'touchmove') {
      // touchstart が届かなかった指が、ほかの指の touchmove に混ざって現れることがある
      for (const t of Array.from(e.touches)) if (!seen.has(t.identifier)) fresh.push(t);
      touchStats.recovered += fresh.length;
    } else {
      // touchstart も touchmove も届かずに離れた指
      for (const t of Array.from(e.changedTouches)) if (!seen.has(t.identifier)) fresh.push(t);
      touchStats.recovered += fresh.length;
    }
    for (const t of fresh) hitAt(t.clientX, t.clientY, at);
    // いま触れている指の一覧に合わせる（離れた指・取りこぼした touchend の指を忘れる）
    seen = new Set(Array.from(e.touches).map((t) => t.identifier));
  };

  const block = (e: Event) => {
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.preventDefault();
  };

  const onPointer = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return; // タッチは touch イベント側で処理
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.preventDefault();
    hitAt(e.clientX, e.clientY, eventTime(e.timeStamp));
  };

  const opts = { passive: false, capture: true } as const;
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
    root.addEventListener(type, onTouch, opts);
  }
  root.addEventListener('contextmenu', block);
  root.addEventListener('dblclick', block);
  // iPhone の Safari: 2 本指のピンチ・回転ジェスチャーを止める（指を素早く交互に置いたときに横取りされないように）
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) root.addEventListener(type, block, opts);
  window.addEventListener('keydown', onKey);
  root.addEventListener('pointerdown', onPointer);
  return () => {
    window.removeEventListener('keydown', onKey);
    root.removeEventListener('pointerdown', onPointer);
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
      root.removeEventListener(type, onTouch, opts);
    }
    root.removeEventListener('contextmenu', block);
    root.removeEventListener('dblclick', block);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) root.removeEventListener(type, block, opts);
  };
}
