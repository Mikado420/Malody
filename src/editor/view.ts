import { TPB, type EEvent } from '../chart/model';
import { BIG_SCALE, drawAny, hexPath, isBig } from '../render/notes';
import type { Editor } from './editor';

/**
 * Malody 風の横スクロール作譜画面。
 *  左端の列 … 拡大縮小（六角形）、再生ボタン（六角形）、現在時刻
 *  上段    … 音源の波形（レーンと同じ時間軸）
 *  中段    … ノーツのレーン。中心線上の点が拍の分割
 *  下段    … イベント（BPM 変更など）
 * 横ドラッグ＝スクロール、タップ＝配置、2本指ピンチ＝拡大縮小、波形をタップ＝その位置へ移動。
 */

const C = {
  bg: '#000000',
  col: '#0b0b0d',
  colEdge: '#4a4a4f',
  lane: '#1a1a1a',
  laneEdge: '#d0d0d0',
  gogo: 'rgba(255,110,40,0.16)',
  measure: 'rgba(255,255,255,0.85)',
  text: '#f4f4f4',
  sub: '#9a9aa2',
  playhead: '#ffffff',
  hex: '#9c9ca4',
  wave: '#e8605e',
  event: '#c27dff',
};

/** 拍の中の位置の細かさ別の点の色（Malody 風） */
const DOT_COLORS: Record<number, string> = {
  1: '#e0e0e0',
  2: '#c04fd8',
  3: '#e0457b',
  4: '#3fa6c9',
  6: '#e8a33c',
  8: '#d8d050',
  12: '#55c08a',
  16: '#8c8c96',
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export function eventText(e: EEvent): string {
  switch (e.kind) {
    case 'bpm': return `BPM ${Number(e.value.toFixed(3))}`;
    case 'scroll': return `SCROLL ${Number(e.value.toFixed(3))}`;
    case 'measure': return `拍子 ${e.num}/${e.den}`;
    case 'gogo': return e.on ? 'GOGO 開始' : 'GOGO 終了';
    case 'barline': return e.on ? '小節線 ON' : '小節線 OFF';
    case 'delay': return `DELAY ${e.value}s`;
  }
}

const fmtTime = (t: number) => {
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${sign}${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
};

interface Box { x: number; y: number; r: number }
type Lay = EditorView['L'];

export class EditorView {
  private readonly ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  /** 判定線（再生位置）の tick */
  pos = 0;
  /** 1拍あたりの px */
  zoom = 220;
  playing = false;
  /** 波形（1 秒あたり rate 個の最大振幅） */
  private wave: { peaks: Float32Array; rate: number } | null = null;

  onTap: (tick: number) => void = () => {};
  onUserScroll: () => void = () => {};
  onPlayToggle: () => void = () => {};
  onZoomChange: (z: number) => void = () => {};

  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { startX: number; startY: number; lastX: number; moved: boolean } | null = null;
  private pinch: { d0: number; z0: number } | null = null;
  private hoverX: number | null = null;
  private dirty = true;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly ed: Editor) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.bind();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
  }

  setWave(peaks: Float32Array | null, rate = 0) {
    this.wave = peaks ? { peaks, rate } : null;
    this.invalidate();
  }

  // ---------- レイアウト ----------

  get L() {
    const colW = 56;
    const laneH = Math.round(Math.min(170, Math.max(70, this.h * 0.32)));
    const waveH = Math.round(Math.min(150, Math.max(36, this.h * 0.24)));
    const infoH = 20;
    const evH = 26;
    const total = infoH + waveH + 4 + laneH + evH;
    const top = Math.max(4, Math.floor((this.h - total) / 2));
    const waveY = top + infoH;
    const laneY = waveY + waveH + 4;
    const evY = laneY + laneH;
    const playX = colW + Math.min(110, (this.w - colW) * 0.14);
    return {
      colW, laneH, waveH, top, waveY, laneY, evY, evH, playX,
      cy: laneY + laneH / 2,
      r: laneH * 0.21,
      zoomOut: { x: colW / 2, y: top + 26, r: 22 } as Box,
      zoomIn: { x: colW / 2, y: top + 76, r: 22 } as Box,
      play: { x: colW / 2, y: laneY + laneH / 2, r: 25 } as Box,
    };
  }

  xOf(tick: number) {
    return this.L.playX + ((tick - this.pos) / TPB) * this.zoom;
  }

  tickOf(x: number) {
    return this.pos + ((x - this.L.playX) / this.zoom) * TPB;
  }

  scrollBy(ticks: number) {
    this.pos = Math.max(-TPB * 2, this.pos + ticks);
    this.invalidate();
  }

  setZoom(z: number) {
    this.zoom = Math.min(1600, Math.max(20, z));
    this.onZoomChange(this.zoom);
    this.invalidate();
  }

  // ---------- 入力 ----------

  private inBox(b: Box, x: number, y: number) {
    return Math.hypot(x - b.x, y - b.y) <= b.r + 6;
  }

  private bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d0: Math.abs(a.x - b.x) || 1, z0: this.zoom };
        this.drag = null;
      } else if (this.pointers.size === 1) {
        this.drag = { startX: e.offsetX, startY: e.offsetY, lastX: e.offsetX, moved: false };
      }
    });

    c.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') {
        this.hoverX = e.offsetY >= this.L.laneY - 10 && e.offsetY <= this.L.evY + 10 && e.offsetX > this.L.colW ? e.offsetX : null;
        this.invalidate();
      }
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.abs(a.x - b.x);
        if (this.pinch.d0 > 20 && d > 20) this.setZoom((this.pinch.z0 * d) / this.pinch.d0);
        return;
      }
      if (!this.drag) return;
      const dx = e.offsetX - this.drag.lastX;
      if (!this.drag.moved && Math.abs(e.offsetX - this.drag.startX) > 8) {
        if (this.drag.startX > this.L.colW) {
          this.drag.moved = true;
          this.onUserScroll();
        }
      }
      if (this.drag.moved) this.scrollBy((-dx / this.zoom) * TPB);
      this.drag.lastX = e.offsetX;
    });

    const end = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size === 0) this.pinch = null;
        return;
      }
      if (e.type === 'pointerup' && this.drag && !this.drag.moved) this.tap(e.offsetX, e.offsetY);
      this.drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.invalidate();
    });

    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.002));
        } else {
          this.onUserScroll();
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          this.scrollBy((d / this.zoom) * TPB);
        }
      },
      { passive: false },
    );
  }

  private tap(x: number, y: number) {
    const L = this.L;
    if (this.inBox(L.zoomIn, x, y)) return this.setZoom(this.zoom * 1.25);
    if (this.inBox(L.zoomOut, x, y)) return this.setZoom(this.zoom / 1.25);
    if (this.inBox(L.play, x, y)) return this.onPlayToggle();
    if (x <= L.colW) return;
    if (y >= L.waveY && y < L.laneY - 2) {
      // 波形をタップ → その位置へ移動
      this.onUserScroll();
      this.pos = Math.max(0, this.ed.snap(this.tickOf(x)));
      this.invalidate();
      return;
    }
    if (y >= L.laneY - 12 && y <= L.evY + L.evH) this.onTap(this.tickOf(x));
  }

  // ---------- 描画 ----------

  frame() {
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  private draw() {
    const { ctx, ed } = this;
    const L = this.L;
    const course = ed.course;
    const leftTick = this.tickOf(L.colW - 80);
    const rightTick = this.tickOf(this.w + 80);

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    // 上の情報
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.sub;
    const info = `${ed.chart.title || '(無題)'}  ·  ${course.name} ★${course.level}  ·  ${course.notes.length}ノーツ${ed.audio ? '' : '  ·  音源なし'}`;
    ctx.fillText(info, L.colW + 10, L.top + 9, Math.max(40, this.w - L.colW - 230));

    // 波形
    ctx.fillStyle = '#0d0d0f';
    ctx.fillRect(L.colW, L.waveY, this.w - L.colW, L.waveH);
    this.drawWave(L);

    // レーン
    ctx.fillStyle = C.lane;
    ctx.fillRect(L.colW, L.laneY, this.w - L.colW, L.laneH);

    // ゴーゴー区間
    let gogoFrom: number | null = null;
    const ranges: [number, number][] = [];
    for (const e of course.events) {
      if (e.kind !== 'gogo') continue;
      if (e.on && gogoFrom === null) gogoFrom = e.tick;
      if (!e.on && gogoFrom !== null) { ranges.push([gogoFrom, e.tick]); gogoFrom = null; }
    }
    if (gogoFrom !== null) ranges.push([gogoFrom, Infinity]);
    ctx.fillStyle = C.gogo;
    for (const [a, b] of ranges) {
      const x1 = Math.max(L.colW, this.xOf(a));
      const x2 = Math.min(this.w, b === Infinity ? this.w : this.xOf(b));
      if (x2 > x1) ctx.fillRect(x1, L.laneY, x2 - x1, L.laneH);
    }

    ctx.fillStyle = C.laneEdge;
    ctx.fillRect(L.colW, L.laneY, this.w - L.colW, 1.5);
    ctx.fillRect(L.colW, L.laneY + L.laneH - 1.5, this.w - L.colW, 1.5);

    // グリッド（小節線＋分割の点）
    const ms = ed.measuresUntil(Math.max(0, rightTick));
    const step = ed.step;
    const stepPx = (step / TPB) * this.zoom;
    for (const m of ms) {
      if (m.start + m.length < leftTick) continue;
      if (m.start > rightTick) break;
      const count = Math.round(m.length / step);
      for (let k = 1; k < count; k++) {
        if (stepPx < 7 && ((k * step) % TPB) !== 0) continue;
        const rel = k * step;
        const x = this.xOf(m.start + rel);
        if (x < L.colW || x > this.w) continue;
        const inBeat = rel % TPB;
        const d = inBeat === 0 ? 1 : TPB / gcd(TPB, inBeat);
        ctx.fillStyle = DOT_COLORS[d] ?? '#6c6c74';
        hexPath(ctx, x, L.cy, inBeat === 0 ? 6 : 4.5);
        ctx.fill();
        if (inBeat === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(x - 0.5, L.laneY, 1, 7);
          ctx.fillRect(x - 0.5, L.laneY + L.laneH - 7, 1, 7);
        }
      }
      const x = this.xOf(m.start);
      if (x >= L.colW - 1 && x <= this.w + 1) {
        ctx.fillStyle = C.measure;
        ctx.fillRect(Math.round(x) - 1, L.waveY, 2, L.evY - L.waveY);
        ctx.font = '600 13px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = C.text;
        ctx.fillText(String(m.index + 1), x + 4, L.waveY + 3);
      }
    }

    // イベント
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let lastTick = NaN;
    let stack = 0;
    for (const e of course.events) {
      if (e.tick < leftTick || e.tick > rightTick) continue;
      stack = e.tick === lastTick ? stack + 1 : 0;
      lastTick = e.tick;
      const x = this.xOf(e.tick);
      if (x < L.colW) continue;
      ctx.fillStyle = C.event;
      ctx.beginPath();
      ctx.moveTo(x, L.evY + 2);
      ctx.lineTo(x - 5, L.evY + 9);
      ctx.lineTo(x + 5, L.evY + 9);
      ctx.closePath();
      ctx.fill();
      const t = eventText(e);
      const tw = ctx.measureText(t).width;
      const ex = x + 4 + stack * (tw + 14);
      ctx.fillStyle = 'rgba(194,125,255,0.18)';
      ctx.fillRect(ex, L.evY + 10, tw + 10, 15);
      ctx.fillStyle = '#e6cfff';
      ctx.fillText(t, ex + 5, L.evY + 18);
    }

    // ノーツ（後ろから描く）
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.colW, L.laneY - L.r, this.w - L.colW, L.laneH + L.r * 2);
    ctx.clip();
    const notes = course.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const endT = n.endTick ?? n.tick;
      if (endT < leftTick || n.tick > rightTick) continue;
      const r = isBig(n.type) ? L.r * BIG_SCALE : L.r;
      const x = this.xOf(n.tick);
      const ex = n.endTick !== undefined ? this.xOf(n.endTick) : undefined;
      drawAny(ctx, n.type, x, L.cy, r, ex, n.type === 'balloon' ? n.hits ?? 5 : null);
    }

    // 連打の始点（終点待ち）
    if (ed.pendingLong !== null) {
      const x = this.xOf(ed.pendingLong);
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = '#fbbf14';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, L.cy, L.r * 1.1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // マウス位置のプレビュー
    if (this.hoverX !== null && !this.drag) {
      const t = ed.snap(this.tickOf(this.hoverX));
      const x = this.xOf(t);
      ctx.globalAlpha = 0.4;
      if (ed.tool === 'erase') {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, L.cy, L.r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        drawAny(ctx, ed.tool, x, L.cy, isBig(ed.tool) ? L.r * BIG_SCALE : L.r, x + this.zoom);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // 判定線より左（過去）は暗く
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(L.colW, L.waveY, L.playX - L.colW, L.evY + L.evH - L.waveY);

    // 判定線
    ctx.fillStyle = C.playhead;
    ctx.fillRect(L.playX - 1, L.waveY, 2, L.evY - L.waveY);
    ctx.fillRect(L.play.x, L.cy - 1, L.playX - L.play.x, 2);
    ctx.fillStyle = '#ffb02e';
    ctx.beginPath();
    ctx.moveTo(L.playX, L.laneY - 2);
    ctx.lineTo(L.playX - 6, L.laneY - 10);
    ctx.lineTo(L.playX + 6, L.laneY - 10);
    ctx.closePath();
    ctx.fill();

    this.drawColumn(L);
  }

  private drawWave(L: Lay) {
    const wv = this.wave;
    const ctx = this.ctx;
    const mid = L.waveY + L.waveH / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(L.colW, mid, this.w - L.colW, 1);
    if (!wv) {
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#55555c';
      ctx.fillText('音源なし（ファイル → 音源を差し替え）', (L.colW + this.w) / 2, mid);
      return;
    }
    const t = this.ed.timing;
    const step = 2;
    let prevT = t.tickToTime(this.tickOf(L.colW));
    ctx.fillStyle = C.wave;
    for (let x = L.colW; x < this.w; x += step) {
      const nextT = t.tickToTime(this.tickOf(x + step));
      let i0 = Math.floor(Math.min(prevT, nextT) * wv.rate);
      let i1 = Math.ceil(Math.max(prevT, nextT) * wv.rate);
      prevT = nextT;
      if (i1 < 0 || i0 >= wv.peaks.length) continue;
      i0 = Math.max(0, i0);
      i1 = Math.min(wv.peaks.length - 1, Math.max(i1, i0));
      let peak = 0;
      for (let i = i0; i <= i1; i++) if (wv.peaks[i] > peak) peak = wv.peaks[i];
      const hh = Math.max(0.5, peak * (L.waveH / 2 - 3));
      ctx.fillRect(x, mid - hh, step - 0.5, hh * 2);
    }
  }

  private drawColumn(L: Lay) {
    const ctx = this.ctx;
    ctx.fillStyle = C.col;
    ctx.fillRect(0, 0, L.colW, this.h);
    ctx.fillStyle = C.colEdge;
    ctx.fillRect(L.colW - 1, 0, 1, this.h);

    const hex = (b: Box, label: 'plus' | 'minus' | 'play' | 'pause') => {
      ctx.save();
      ctx.translate(b.x, b.y);
      hexPath(ctx, 0, 0, b.r);
      ctx.fillStyle = label === 'play' || label === 'pause' ? '#7d7d86' : C.hex;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#d9d9de';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      if (label === 'plus' || label === 'minus') {
        ctx.fillRect(-b.r * 0.42, -2, b.r * 0.84, 4);
        if (label === 'plus') ctx.fillRect(-2, -b.r * 0.42, 4, b.r * 0.84);
      } else if (label === 'play') {
        ctx.beginPath();
        ctx.moveTo(-b.r * 0.28, -b.r * 0.4);
        ctx.lineTo(b.r * 0.45, 0);
        ctx.lineTo(-b.r * 0.28, b.r * 0.4);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(-b.r * 0.32, -b.r * 0.36, b.r * 0.22, b.r * 0.72);
        ctx.fillRect(b.r * 0.1, -b.r * 0.36, b.r * 0.22, b.r * 0.72);
      }
      ctx.restore();
    };
    hex(L.zoomOut, 'minus');
    hex(L.zoomIn, 'plus');
    hex(L.play, this.playing ? 'pause' : 'play');

    // 現在時刻と位置（上の情報行の右端）
    const time = this.ed.timing.tickToTime(Math.max(0, this.pos));
    ctx.font = '600 13px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(`${this.ed.label(Math.max(0, this.ed.snap(this.pos)))}  ${fmtTime(time)}`, this.w - 10, L.top + 9);
  }
}
