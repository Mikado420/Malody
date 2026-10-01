import type { HitKind } from './engine/game';
import { localPoint } from './orient';

/** タッチ用の太鼓で、面（ドン）の半径が太鼓全体の何割か */
export const FACE_RATIO = 0.8;

/** at = 叩いた瞬間（performance.now() 基準の ms） */
export type HitHandler = (kind: HitKind, side: 'L' | 'R', at: number) => void;

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

/**
 * キーボードとタッチ（ポインタ）入力。
 * タッチは太鼓の中心からの距離で ドン/カッ を判定する。
 */
export function bindInput(
  canvas: HTMLCanvasElement,
  getDrum: () => { x: number; y: number; r: number; top: number },
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
    if (py < d.top) return; // レーンより上は無視
    const dist = Math.hypot(px - d.x, py - d.y);
    const side = px < d.x ? 'L' : 'R';
    onHit(dist <= d.r * FACE_RATIO ? 'don' : 'ka', side, at);
  };

  // タッチは touchstart で直接受ける。
  // pointer イベントだと端末によってはダブルタップ・長押しの判定で連続タップが間引かれるため。
  // 1回の touchstart に複数の指が入っていることもあるので changedTouches を全部処理する。
  const onTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    const at = eventTime(e.timeStamp);
    for (const t of Array.from(e.changedTouches)) hitAt(t.clientX, t.clientY, at);
  };
  const block = (e: Event) => e.preventDefault();

  const onPointer = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return; // タッチは touchstart 側で処理
    e.preventDefault();
    hitAt(e.clientX, e.clientY, eventTime(e.timeStamp));
  };

  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', block, { passive: false });
  canvas.addEventListener('touchend', block, { passive: false });
  canvas.addEventListener('contextmenu', block);
  canvas.addEventListener('dblclick', block);
  window.addEventListener('keydown', onKey);
  canvas.addEventListener('pointerdown', onPointer);
  return () => {
    window.removeEventListener('keydown', onKey);
    canvas.removeEventListener('pointerdown', onPointer);
    canvas.removeEventListener('touchstart', onTouchStart);
    canvas.removeEventListener('touchmove', block);
    canvas.removeEventListener('touchend', block);
    canvas.removeEventListener('contextmenu', block);
    canvas.removeEventListener('dblclick', block);
  };
}
