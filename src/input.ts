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
export const touchStats = {
  starts: 0,
  recovered: 0,
  /** iPhone がタッチを途中で取り消した回数（ジェスチャーとして横取りされた） */
  cancels: 0,
  /** ポインターイベント（指）で届いた数 */
  pointers: 0,
  /** ポインターイベントの取り消し */
  pointerCancels: 0,
  /** 同時に触れていた指の最大数 */
  maxFingers: 0,
};

export function resetTouchStats() {
  for (const k of Object.keys(touchStats) as (keyof typeof touchStats)[]) touchStats[k] = 0;
}

/**
 * キーボードとタッチ（ポインタ）入力。
 * タッチは画面の横の位置で ドン（中央の帯）/ カッ（左右の端）を判定する。
 *
 * iPhone の Safari では、片方の指がまだ画面に触れている間に別の指で叩くと、
 * その指の touchstart が届かないことがある（2 本指のジェスチャーとして扱われる・他のイベントにまとめられる）。
 * そこで、どのタッチイベントでも「まだ見ていない指」が含まれていたら、その指が叩いたものとして扱う。
 */
export function bindInput(
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  getDrum: () => { x: number; half: number },
  onHit: HitHandler,
  /** true のときは指のタッチをポインターイベントで受け取る（タッチイベントは止めるだけ） */
  usePointer: () => boolean = () => false,
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
    // 画面のどこを叩いても反応する。横の位置だけで決める: 中央の帯＝ドン、左右の端＝カッ
    // ring = 中心からの距離をドンの帯の半分の幅で割ったもの（1 がドンとカッの境目）
    const side = px < d.x ? 'L' : 'R';
    const ring = Math.abs(px - d.x) / Math.max(1, d.half);
    onHit(ring <= 1 ? 'don' : 'ka', side, at, { x: px, y: py, ring });
  };

  /** いま画面に触れている（叩いたとして処理済みの）指 */
  let seen = new Set<number>();

  const onTouch = (e: TouchEvent) => {
    // 終了ボタンなどのボタンはふつうに押せるようにする
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.preventDefault();
    if (e.type === 'touchcancel') touchStats.cancels++;
    touchStats.maxFingers = Math.max(touchStats.maxFingers, e.touches.length);
    if (usePointer()) {
      seen = new Set(Array.from(e.touches).map((t) => t.identifier));
      return;
    }
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
    if (e.target instanceof Element && e.target.closest('button')) return;
    if (e.pointerType === 'touch') {
      touchStats.pointers++;
      if (!usePointer()) return; // タッチは touch イベント側で処理
    }
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
  root.addEventListener('pointerdown', onPointer, opts);
  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerType === 'touch') touchStats.pointerCancels++;
  };
  root.addEventListener('pointercancel', onPointerCancel, opts);
  return () => {
    root.removeEventListener('pointercancel', onPointerCancel, opts);
    window.removeEventListener('keydown', onKey);
    root.removeEventListener('pointerdown', onPointer, opts);
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
      root.removeEventListener(type, onTouch, opts);
    }
    root.removeEventListener('contextmenu', block);
    root.removeEventListener('dblclick', block);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) root.removeEventListener(type, block, opts);
  };
}
