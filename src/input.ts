import type { HitKind } from './engine/game';

export type HitHandler = (kind: HitKind, side: 'L' | 'R') => void;

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
    onHit(k.kind, k.side);
  };

  const onPointer = (e: PointerEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const d = getDrum();
    if (py < d.top) return; // レーンより上は無視
    const dist = Math.hypot(px - d.x, py - d.y);
    const side = px < d.x ? 'L' : 'R';
    onHit(dist <= d.r * 0.72 ? 'don' : 'ka', side);
  };

  window.addEventListener('keydown', onKey);
  canvas.addEventListener('pointerdown', onPointer);
  return () => {
    window.removeEventListener('keydown', onKey);
    canvas.removeEventListener('pointerdown', onPointer);
  };
}
