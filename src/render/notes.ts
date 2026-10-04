import type { NoteType } from '../chart/types';

/**
 * 太鼓風のノーツ描画（プレイ画面とエディタで共通）。
 * 公式素材は使わず、色・縁取りの比率だけを合わせたオリジナル描画。
 *   外側の黒縁 → 白い縁 → 本体（上が明るいグラデーション）
 */

export const COLOR = {
  don: '#f2442b',
  donLight: '#ff7b5c',
  ka: '#5ec4d4',
  kaLight: '#9be3ec',
  roll: '#fbbf14',
  rollLight: '#ffe27a',
  balloon: '#ff8a1c',
  balloonLight: '#ffc07a',
  outline: '#1f1613',
};

export const isBig = (t: NoteType) => t === 'bigDon' || t === 'bigKa' || t === 'bigRoll';

/** 大音符は通常の 1.45 倍 */
export const BIG_SCALE = 1.45;

function colorsOf(t: NoteType): [string, string] {
  switch (t) {
    case 'don':
    case 'bigDon':
      return [COLOR.don, COLOR.donLight];
    case 'ka':
    case 'bigKa':
      return [COLOR.ka, COLOR.kaLight];
    case 'roll':
    case 'bigRoll':
      return [COLOR.roll, COLOR.rollLight];
    case 'balloon':
      return [COLOR.balloon, COLOR.balloonLight];
  }
}

/**
 * 音符の絵は、種類と大きさごとに一度だけ描いて（スプライト）、毎フレームはそれを貼るだけにする。
 * 1 フレームに数十個の音符それぞれでグラデーションを作ると、スマホでは描画が重くなり、
 * タッチの処理や打音が遅れる原因になる。
 */
const spriteCache = new Map<string, HTMLCanvasElement>();

/** r = 黒縁を含めた外径の半径 */
export function drawNoteHead(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, type: NoteType) {
  const m = ctx.getTransform();
  const scale = Math.hypot(m.a, m.b) || 1;
  const pr = Math.max(1, Math.round(r * scale)); // 端末ピクセルでの半径
  const key = `${type}:${pr}`;
  let sp = spriteCache.get(key);
  if (!sp) {
    if (spriteCache.size > 400) spriteCache.clear();
    sp = document.createElement('canvas');
    sp.width = sp.height = pr * 2 + 4;
    const c = sp.getContext('2d')!;
    drawNoteHeadRaw(c, pr + 2, pr + 2, pr, type);
    spriteCache.set(key, sp);
  }
  const half = (pr + 2) / scale;
  ctx.drawImage(sp, x - half, y - half, half * 2, half * 2);
}

function drawNoteHeadRaw(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, type: NoteType) {
  const [body, light] = colorsOf(type);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = COLOR.outline;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  const g = ctx.createLinearGradient(x, y - r * 0.76, x, y + r * 0.76);
  g.addColorStop(0, light);
  g.addColorStop(0.45, body);
  g.addColorStop(1, body);
  ctx.beginPath();
  ctx.arc(x, y, r * 0.76, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  // つや
  ctx.beginPath();
  ctx.ellipse(x - r * 0.22, y - r * 0.36, r * 0.3, r * 0.14, -0.35, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.fill();
}

/** 連打（頭は x1、尾は x2。横向き） */
export function drawRoll(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, r: number, type: NoteType) {
  const [body, light] = colorsOf(type);
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const bar = (rr: number, fill: string | CanvasGradient) => {
    ctx.beginPath();
    ctx.arc(left, y, rr, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.lineTo(right, y - rr);
    ctx.arc(right, y, rr, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  bar(r, COLOR.outline);
  bar(r * 0.9, '#fff');
  const g = ctx.createLinearGradient(0, y - r * 0.76, 0, y + r * 0.76);
  g.addColorStop(0, light);
  g.addColorStop(0.45, body);
  g.addColorStop(1, body);
  bar(r * 0.76, g);
  drawNoteHead(ctx, x1, y, r, type);
}

/** 風船（本体＋尻尾の糸）。left = 残り打数 */
export function drawBalloon(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number, left: number | null, tailX?: number,
) {
  if (tailX !== undefined && tailX > x + r) {
    ctx.strokeStyle = COLOR.outline;
    ctx.lineWidth = Math.max(2, r * 0.18);
    ctx.beginPath();
    ctx.moveTo(x + r * 0.8, y);
    ctx.lineTo(tailX, y);
    ctx.stroke();
    ctx.strokeStyle = COLOR.balloon;
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tailX, y, r * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = COLOR.balloon;
    ctx.fill();
  }
  drawNoteHead(ctx, x, y, r, 'balloon');
  if (left !== null) {
    ctx.font = `900 ${Math.round(r * 0.9)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.strokeStyle = COLOR.outline;
    ctx.strokeText(String(left), x, y + r * 0.04);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(left), x, y + r * 0.04);
  }
}

export function drawAny(
  ctx: CanvasRenderingContext2D, type: NoteType, x: number, y: number, r: number, endX?: number, hitsLeft?: number | null,
) {
  if (type === 'roll' || type === 'bigRoll') drawRoll(ctx, x, endX ?? x, y, r, type);
  else if (type === 'balloon') drawBalloon(ctx, x, y, r, hitsLeft ?? null, endX);
  else drawNoteHead(ctx, x, y, r, type);
}

/** 六角形（Malody 風の UI 用） */
export function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** 縁取り文字 */
export function outlinedText(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string | CanvasGradient, stroke: string, width: number,
) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}
