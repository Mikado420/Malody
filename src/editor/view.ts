import { TPB, type EEvent } from '../chart/model';
import type { NoteType } from '../chart/types';
import type { Editor } from './editor';

/**
 * Malody 風の縦スクロール作譜画面。
 * 時間は下から上へ流れ、判定線（再生位置）は画面下寄りに固定。
 * ドラッグ＝スクロール、タップ＝配置、2本指ピンチ＝拡大縮小。
 */

const C = {
  bg: '#121019',
  lane: '#1d1a26',
  laneEdge: '#3a3547',
  gogo: 'rgba(255,120,40,0.13)',
  measure: 'rgba(255,255,255,0.75)',
  beat: 'rgba(255,255,255,0.32)',
  text: '#f4f1fa',
  sub: '#8f89a0',
  playhead: '#ffd23f',
  don: '#f2493a',
  ka: '#3fb5e0',
  roll: '#f7c531',
  balloon: '#ff8a3d',
  event: '#b78cff',
};

/** 拍の中の位置の細かさ別の線の色（Malody の配色に近い） */
const SUB_COLORS: Record<number, string> = {
  2: 'rgba(240,80,80,0.55)',
  3: 'rgba(190,110,255,0.55)',
  4: 'rgba(80,150,255,0.5)',
  6: 'rgba(255,120,200,0.45)',
  8: 'rgba(255,220,80,0.45)',
  12: 'rgba(120,220,160,0.4)',
  16: 'rgba(160,160,170,0.35)',
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const NOTE_COLOR: Record<NoteType, string> = {
  don: C.don, ka: C.ka, bigDon: C.don, bigKa: C.ka, roll: C.roll, bigRoll: C.roll, balloon: C.balloon,
};

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

export class EditorView {
  private readonly ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  /** 判定線の位置（tick、小数可） */
  pos = 0;
  /** 1拍あたりの px */
  zoom = 120;

  onTap: (tick: number) => void = () => {};
  onUserScroll: () => void = () => {};

  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { startY: number; lastY: number; moved: boolean } | null = null;
  private pinch: { d0: number; z0: number } | null = null;
  private hoverY: number | null = null;
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

  get playY() {
    return this.h - Math.max(70, this.h * 0.2);
  }

  private get layout() {
    const left = 46; // 小節番号
    const right = Math.min(120, this.w * 0.3); // イベント表示
    const laneW = Math.min(200, this.w - left - right - 8);
    const laneX = left + (this.w - left - right - laneW) / 2;
    return { left, right, laneX, laneW, cx: laneX + laneW / 2 };
  }

  yOf(tick: number) {
    return this.playY - ((tick - this.pos) / TPB) * this.zoom;
  }

  tickOf(y: number) {
    return this.pos + ((this.playY - y) / this.zoom) * TPB;
  }

  scrollBy(ticks: number) {
    this.pos = Math.max(-TPB, this.pos + ticks);
    this.invalidate();
  }

  setZoom(z: number) {
    this.zoom = Math.min(1200, Math.max(24, z));
    this.invalidate();
  }

  // ---------- 入力 ----------

  private bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: this.zoom };
        this.drag = null;
      } else if (this.pointers.size === 1) {
        this.drag = { startY: e.offsetY, lastY: e.offsetY, moved: false };
      }
    });

    c.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') {
        this.hoverY = e.offsetY;
        this.invalidate();
      }
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch.d0 > 10) this.setZoom((this.pinch.z0 * d) / this.pinch.d0);
        return;
      }
      if (!this.drag) return;
      const dy = e.offsetY - this.drag.lastY;
      if (!this.drag.moved && Math.abs(e.offsetY - this.drag.startY) > 8) {
        this.drag.moved = true;
        this.onUserScroll();
      }
      if (this.drag.moved) {
        this.scrollBy((dy / this.zoom) * TPB);
      }
      this.drag.lastY = e.offsetY;
    });

    const end = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size === 0) this.pinch = null;
        return;
      }
      if (e.type === 'pointerup' && this.drag && !this.drag.moved) {
        this.onTap(this.tickOf(e.offsetY));
      }
      this.drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.hoverY = null;
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
          this.scrollBy((-e.deltaY / this.zoom) * TPB);
        }
      },
      { passive: false },
    );
  }

  // ---------- 描画 ----------

  /** 必要なときだけ描き直す（再生中は毎フレーム invalidate される） */
  frame() {
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  private draw() {
    const { ctx, ed } = this;
    const L = this.layout;
    const course = ed.course;
    const bottomTick = this.tickOf(this.h + 40);
    const topTick = this.tickOf(-40);

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    // レーン
    ctx.fillStyle = C.lane;
    ctx.fillRect(L.laneX, 0, L.laneW, this.h);

    // ゴーゴー区間
    let gogoFrom: number | null = null;
    const gogoRanges: [number, number][] = [];
    for (const e of course.events) {
      if (e.kind !== 'gogo') continue;
      if (e.on && gogoFrom === null) gogoFrom = e.tick;
      if (!e.on && gogoFrom !== null) { gogoRanges.push([gogoFrom, e.tick]); gogoFrom = null; }
    }
    if (gogoFrom !== null) gogoRanges.push([gogoFrom, Infinity]);
    ctx.fillStyle = C.gogo;
    for (const [a, b] of gogoRanges) {
      const y1 = Math.min(this.h, this.yOf(a));
      const y2 = Math.max(0, b === Infinity ? 0 : this.yOf(b));
      if (y1 > y2) ctx.fillRect(L.laneX, y2, L.laneW, y1 - y2);
    }

    ctx.fillStyle = C.laneEdge;
    ctx.fillRect(L.laneX - 1, 0, 1, this.h);
    ctx.fillRect(L.laneX + L.laneW, 0, 1, this.h);

    // グリッド
    const ms = ed.measuresUntil(Math.max(0, topTick));
    const step = ed.step;
    const stepPx = (step / TPB) * this.zoom;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const m of ms) {
      if (m.start + m.length < bottomTick) continue;
      if (m.start > topTick) break;
      const count = Math.round(m.length / step);
      for (let k = 0; k < count; k++) {
        const rel = k * step;
        const y = this.yOf(m.start + rel);
        if (y < -2 || y > this.h + 2) continue;
        const inBeat = rel % TPB;
        let color: string;
        if (k === 0) continue;
        if (inBeat === 0) color = C.beat;
        else {
          if (stepPx < 5) continue;
          const d = TPB / gcd(TPB, inBeat);
          color = SUB_COLORS[d] ?? 'rgba(150,150,160,0.3)';
        }
        ctx.fillStyle = color;
        ctx.fillRect(L.laneX, Math.round(y), L.laneW, 1);
      }
      const y = this.yOf(m.start);
      if (y >= -2 && y <= this.h + 2) {
        ctx.fillStyle = C.measure;
        ctx.fillRect(L.laneX, Math.round(y) - 1, L.laneW, 2);
        ctx.fillStyle = C.sub;
        ctx.fillText(String(m.index + 1), L.left - 6, y);
      }
    }

    // イベント（右側）
    ctx.textAlign = 'left';
    ctx.font = '11px system-ui, sans-serif';
    let lastTick = NaN;
    let stack = 0;
    for (const e of course.events) {
      if (e.tick < bottomTick || e.tick > topTick) continue;
      stack = e.tick === lastTick ? stack + 1 : 0;
      lastTick = e.tick;
      const y = this.yOf(e.tick);
      const x = L.laneX + L.laneW + 6;
      ctx.fillStyle = C.event;
      ctx.fillRect(L.laneX + L.laneW - 6, Math.round(y) - 1, 10, 2);
      ctx.fillText(eventText(e), x + 6, y - 7 - stack * 13);
    }

    // ノーツ（後ろのノーツから描くと手前が上になる）
    const r = Math.min(16, L.laneW * 0.11);
    const notes = course.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const endT = n.endTick ?? n.tick;
      if (endT < bottomTick || n.tick > topTick) continue;
      const big = n.type === 'bigDon' || n.type === 'bigKa' || n.type === 'bigRoll';
      const rr = big ? r * 1.4 : r;
      const y = this.yOf(n.tick);
      if (n.endTick !== undefined) {
        const y2 = this.yOf(n.endTick);
        ctx.fillStyle = NOTE_COLOR[n.type];
        ctx.globalAlpha = n.type === 'balloon' ? 0.35 : 0.85;
        ctx.fillRect(L.cx - rr * 0.8, y2, rr * 1.6, y - y2);
        ctx.globalAlpha = 1;
        ctx.fillRect(L.cx - rr, Math.round(y2) - 2, rr * 2, 4);
      }
      this.circle(L.cx, y, rr, NOTE_COLOR[n.type]);
      if (n.type === 'balloon') {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.round(rr)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(String(n.hits ?? 5), L.cx, y + 1);
      }
    }

    // 連打の始点（終点待ち）
    if (ed.pendingLong !== null) {
      const y = this.yOf(ed.pendingLong);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = C.roll;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(L.cx, y, r * 1.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // マウス位置のプレビュー
    if (this.hoverY !== null && !this.drag) {
      const t = ed.snap(this.tickOf(this.hoverY));
      const y = this.yOf(t);
      ctx.globalAlpha = 0.35;
      if (ed.tool === 'erase') {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(L.cx, y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const big = ed.tool === 'bigDon' || ed.tool === 'bigKa' || ed.tool === 'bigRoll';
        this.circle(L.cx, y, big ? r * 1.4 : r, NOTE_COLOR[ed.tool]);
      }
      ctx.globalAlpha = 1;
    }

    // 判定線
    ctx.fillStyle = C.playhead;
    ctx.fillRect(L.laneX - 8, this.playY - 1.5, L.laneW + 16, 3);
    ctx.textAlign = 'right';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(ed.label(Math.max(0, ed.snap(this.pos))), L.laneX + L.laneW + 4, this.playY + 6);
    ctx.textBaseline = 'alphabetic';
  }

  private circle(x: number, y: number, r: number, fill: string) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }
}
