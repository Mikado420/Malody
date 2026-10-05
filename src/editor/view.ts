import { TPB, type EEvent } from '../chart/model';
import { drawAny, drawRoll, hexPath } from '../render/notes';
import { localPoint } from '../orient';
import type { Editor } from './editor';

/**
 * Malody 風の横スクロール作譜画面。
 * Malody の太鼓エディタのスクリーンショット（2000×924）から測った座標を「基準座標」とし、
 * 画面の高さに合わせて拡大縮小する（横幅は画面に合わせて伸びる）。
 *   左の列 (x 0〜235)     … 拡大縮小・再生の六角形、再生位置の線、x 160〜235 は密度推移（上下にドラッグで移動）
 *   判定枠 (x 410)        … 再生位置。Malody と同じ金色の二重の輪
 *   x 262 付近            … 曲の長さ（上）と現在時刻（下）を縦書きで
 *   レーン (y 352〜570)   … ノーツ（半径 54、大音符 83）と拍の点
 *   レーンの上 (y 120〜340) … 音源の波形
 * 横ドラッグ＝スクロール、タップ＝配置、2本指ピンチ＝拡大縮小、波形をタップ＝その位置へ移動。
 */

export const REF_H = 924;
const R = {
  colLine1: 72, // 密度推移の左端（拡大縮小の六角形のすぐ右）
  densW: 75, // 密度推移の幅（Malody と同じ）
  laneX: 147, // レーンの左端（密度推移のすぐ右）
  laneTop: 352,
  laneBottom: 570,
  laneCY: 461,
  noteR: 54,
  bigR: 83,
  play: { x: 230, y: 461, r: 55 },
  judgeX: 410, // 判定枠（再生位置）
  judgeR: 72,
  judgeR2: 49,
  zoomOut: { x: 24, y: 82, r: 36 },
  zoomIn: { x: 24, y: 160, r: 36 },
  timeX: 176,
  waveX: 205,
  waveTop: 40, // 曲名の表示をなくした分、波形を上へ広げる
  waveBottom: 336,
  evTop: 576,
  evBottom: 616,
  posLabel: { x: 205, y: 650 },
  beatPx: 400, // 初期の拡大率（1拍あたり）
};

const C = {
  bg: '#000000',
  col: '#000000',
  colLine: '#6a6a70',
  lane: '#1b1b1b',
  laneEdge: '#c8c8c8',
  gogo: 'rgba(255,110,40,0.16)',
  measure: 'rgba(255,255,255,0.8)',
  text: '#f4f4f4',
  sub: '#9a9aa2',
  hex: '#9a9aa0',
  hexEdge: '#e8e8ec',
  wave: '#e8605e',
  event: '#c27dff',
};

/** 拍の中の位置の細かさ別の点の色（Malody 風） */
const DOT_COLORS: Record<number, string> = {
  1: '#d8d8dc',
  2: '#b23fcf',
  3: '#e0457b',
  4: '#3a9fc6',
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

export class EditorView {
  private readonly ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  /** 基準座標 → 画面 px の倍率（画面の高さ / 924） */
  s = 1;
  /** 判定線（再生位置）の tick */
  pos = 0;
  /** 1拍あたりの px */
  zoom = 180;
  playing = false;
  /** 曲の長さ（秒）。左上に縦書きで表示 */
  duration = 0;
  private wave: { peaks: Float32Array; rate: number } | null = null;

  onTap: (tick: number) => void = () => {};
  onUserScroll: () => void = () => {};
  onPlayToggle: () => void = () => {};
  onZoomChange: (z: number) => void = () => {};
  onResize: () => void = () => {};

  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { startX: number; startY: number; lastX: number; moved: boolean; scrub?: boolean } | null = null;
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
    this.s = Math.max(0.2, this.h / REF_H);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.invalidate();
    this.onResize();
  }

  invalidate() {
    this.dirty = true;
  }

  setWave(peaks: Float32Array | null, rate = 0) {
    this.wave = peaks ? { peaks, rate } : null;
    this.invalidate();
  }

  // ---------- レイアウト（基準座標 × 倍率） ----------

  get L() {
    const s = this.s;
    const box = (b: { x: number; y: number; r: number }): Box => ({ x: b.x * s, y: b.y * s, r: b.r * s });
    const laneY = R.laneTop * s;
    const laneH = (R.laneBottom - R.laneTop) * s;
    return {
      s,
      colW: R.laneX * s,
      colLine1: R.colLine1 * s,
      laneY,
      laneH,
      evY: R.laneBottom * s,
      evH: (R.evBottom - R.evTop) * s,
      evTop: R.evTop * s,
      cy: R.laneCY * s,
      playX: R.judgeX * s,
      r: R.noteR * s,
      bigR: R.bigR * s,
      waveX: R.waveX * s,
      waveY: R.waveTop * s,
      waveH: (R.waveBottom - R.waveTop) * s,
      zoomOut: box(R.zoomOut),
      zoomIn: box(R.zoomIn),
      play: box(R.play),
    };
  }

  /** 初期の拡大率（Malody と同じ間隔） */
  get defaultZoom() {
    return R.beatPx * this.s;
  }

  xOf(tick: number) {
    return this.L.playX + ((tick - this.pos) / TPB) * this.zoom;
  }

  tickOf(x: number) {
    return this.pos + ((x - this.L.playX) / this.zoom) * TPB;
  }

  /** 密度推移の縦の範囲（下が曲の始め、上が終わり） */
  private get graph() {
    const s = this.L.s;
    return { top: 18 * s, bottom: this.h - 18 * s };
  }

  /** 曲の長さ（秒）。音源がなければ最後のノーツ＋2 秒 */
  private songLength() {
    const notes = this.ed.course.notes;
    let last = 0;
    for (const n of notes) last = Math.max(last, n.endTick ?? n.tick);
    const lastT = notes.length ? this.ed.timing.tickToTime(last) + 2 : 0;
    return Math.max(this.duration, lastT, 1);
  }

  private scrubTo(y: number) {
    const g = this.graph;
    const p = Math.min(1, Math.max(0, (g.bottom - y) / (g.bottom - g.top)));
    const tick = this.ed.timing.timeToTick(p * this.songLength());
    this.pos = Math.max(0, this.ed.snap(tick));
    this.invalidate();
  }

  /**
   * 判定枠（再生位置）は自由に動かせるが、手を離したら一番近いグリッドへ寄せる（短くなめらかに動かす）
   */
  private settleAnim = 0;
  private settleTimer = 0;

  settle() {
    cancelAnimationFrame(this.settleAnim);
    if (this.playing) return;
    const from = this.pos;
    const to = this.ed.snap(Math.max(0, from));
    if (Math.abs(to - from) < 1) {
      this.pos = to;
      this.invalidate();
      return;
    }
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 120);
      const k = 1 - (1 - p) * (1 - p);
      this.pos = from + (to - from) * k;
      this.invalidate();
      if (p < 1) this.settleAnim = requestAnimationFrame(step);
    };
    this.settleAnim = requestAnimationFrame(step);
  }

  private stopSettle() {
    cancelAnimationFrame(this.settleAnim);
    clearTimeout(this.settleTimer);
  }

  scrollBy(ticks: number) {
    this.pos = Math.max(-TPB * 2, this.pos + ticks);
    this.invalidate();
  }

  setZoom(z: number) {
    this.zoom = Math.min(2400, Math.max(20, z));
    this.onZoomChange(this.zoom);
    this.invalidate();
  }

  // ---------- 入力 ----------

  /** 小さい画面でも押しやすいよう、当たり判定は見た目より少し大きく */
  private inBox(b: Box, x: number, y: number) {
    return Math.hypot(x - b.x, y - b.y) <= Math.max(b.r + 6, 22);
  }

  private bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.stopSettle();
      c.setPointerCapture(e.pointerId);
      const pt = localPoint(e, c);
      this.pointers.set(e.pointerId, pt);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d0: Math.abs(a.x - b.x) || 1, z0: this.zoom };
        this.drag = null;
      } else if (this.pointers.size === 1) {
        this.drag = { startX: pt.x, startY: pt.y, lastX: pt.x, moved: false };
        // 密度推移の列を押したら、上下に動かしてその位置へ移動する
        const L = this.L;
        if (pt.x >= L.colLine1 && pt.x <= L.colW && !this.inBox(L.play, pt.x, pt.y)) {
          this.drag.scrub = true;
          this.drag.moved = true;
          this.onUserScroll();
          this.scrubTo(pt.y);
        }
      }
    });

    c.addEventListener('pointermove', (e) => {
      const pt = localPoint(e, c);
      const L = this.L;
      if (e.pointerType === 'mouse') {
        this.hoverX = pt.y >= L.laneY - 10 && pt.y <= L.evTop + L.evH && pt.x > L.colW ? pt.x : null;
        this.invalidate();
      }
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, pt);
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.abs(a.x - b.x);
        if (this.pinch.d0 > 20 && d > 20) this.setZoom((this.pinch.z0 * d) / this.pinch.d0);
        return;
      }
      if (!this.drag) return;
      if (this.drag.scrub) {
        this.scrubTo(pt.y);
        return;
      }
      const dx = pt.x - this.drag.lastX;
      if (!this.drag.moved && Math.abs(pt.x - this.drag.startX) > 8 && this.drag.startX > L.colW) {
        this.drag.moved = true;
        this.onUserScroll();
      }
      if (this.drag.moved) this.scrollBy((-dx / this.zoom) * TPB);
      this.drag.lastX = pt.x;
    });

    const end = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size === 0) this.pinch = null;
        return;
      }
      if (e.type === 'pointerup' && this.drag && !this.drag.moved) {
        const pt = localPoint(e, c);
        this.tap(pt.x, pt.y);
      }
      // 横にスクロールして離したら、一番近いグリッドへ寄せる
      if (this.drag?.moved && !this.drag.scrub) this.settle();
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
          this.stopSettle();
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          this.scrollBy((d / this.zoom) * TPB);
          // ホイールが止まったらグリッドへ寄せる
          this.settleTimer = window.setTimeout(() => this.settle(), 160);
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
    if (y >= L.waveY && y <= L.waveY + L.waveH) {
      // 波形をタップ → その位置へ移動
      this.onUserScroll();
      this.pos = Math.max(0, this.ed.snap(this.tickOf(x)));
      this.invalidate();
      return;
    }
    if (y >= L.laneY - L.r * 0.5 && y <= L.evTop + L.evH) this.onTap(this.tickOf(x));
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
    const s = L.s;
    const course = ed.course;
    const leftTick = this.tickOf(L.colW - L.bigR * 2);
    const rightTick = this.tickOf(this.w + L.bigR * 2);

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    // 波形
    ctx.fillStyle = '#0c0c0e';
    ctx.fillRect(L.waveX, L.waveY, this.w - L.waveX, L.waveH);
    this.drawWave(L);

    // レーン
    ctx.fillStyle = C.lane;
    ctx.fillRect(L.colW, L.laneY, this.w - L.colW, L.laneH);

    // ゴーゴー区間
    const ranges = this.ed.gogoRanges();
    ctx.fillStyle = C.gogo;
    for (const [a, b] of ranges) {
      const x1 = Math.max(L.colW, this.xOf(a));
      const x2 = Math.min(this.w, b === Infinity ? this.w : this.xOf(b));
      if (x2 > x1) ctx.fillRect(x1, L.laneY, x2 - x1, L.laneH);
    }

    // グラデの範囲（レーンの下の端に紫の帯。右へ行くほど濃く）
    for (const g of course.grads ?? []) {
      const x1 = Math.max(L.colW, this.xOf(g.start));
      const x2 = Math.min(this.w, this.xOf(g.end));
      if (x2 <= x1) continue;
      const bh = Math.max(4, 10 * s);
      const grd = ctx.createLinearGradient(this.xOf(g.start), 0, this.xOf(g.end), 0);
      grd.addColorStop(0, 'rgba(199,146,234,0.25)');
      grd.addColorStop(1, 'rgba(199,146,234,0.9)');
      ctx.fillStyle = grd;
      ctx.fillRect(x1, L.laneY + L.laneH - bh, x2 - x1, bh);
    }

    ctx.fillStyle = C.laneEdge;
    const edge = Math.max(1, 2 * s);
    ctx.fillRect(L.colW, L.laneY - edge / 2, this.w - L.colW, edge);
    ctx.fillRect(L.colW, L.laneY + L.laneH - edge / 2, this.w - L.colW, edge);

    // グリッド（小節線＋分割の点）
    const ms = ed.measuresUntil(Math.max(0, rightTick));
    const step = ed.step;
    const stepPx = (step / TPB) * this.zoom;
    for (const m of ms) {
      if (m.start + m.length < leftTick) continue;
      if (m.start > rightTick) break;
      const count = Math.round(m.length / step);
      // 波形の上の目安の線: 拍ごとに薄い線、グリッドごとにさらに薄い線（小節線だけはレーンまで通す）
      const lw1 = Math.max(1, s);
      const beatPx = this.zoom;
      if (beatPx >= 6) {
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        for (let rel = TPB; rel < m.length; rel += TPB) {
          const x = this.xOf(m.start + rel);
          if (x >= L.colW && x <= this.w) ctx.fillRect(x - lw1 / 2, L.waveY, lw1, L.waveH);
        }
      }
      if (stepPx >= 7) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        for (let k = 1; k < count; k++) {
          const rel = k * step;
          if (rel % TPB === 0) continue;
          const x = this.xOf(m.start + rel);
          if (x >= L.colW && x <= this.w) ctx.fillRect(x - lw1 / 2, L.waveY, lw1, L.waveH);
        }
      }
      for (let k = 1; k < count; k++) {
        const rel = k * step;
        const inBeat = rel % TPB;
        if (stepPx < 7 && inBeat !== 0) continue;
        const x = this.xOf(m.start + rel);
        if (x < L.colW || x > this.w) continue;
        const d = inBeat === 0 ? 1 : TPB / gcd(TPB, inBeat);
        ctx.fillStyle = DOT_COLORS[d] ?? '#6c6c74';
        hexPath(ctx, x, L.cy, (inBeat === 0 ? 13 : 9) * s);
        ctx.fill();
      }
      const x = this.xOf(m.start);
      if (x >= L.colW - 1 && x <= this.w + 1) {
        ctx.fillStyle = C.measure;
        const lw = Math.max(1, 2 * s);
        ctx.fillRect(x - lw / 2, L.waveY, lw, L.evY - L.waveY);
        ctx.font = `600 ${Math.round(28 * s)}px ui-monospace, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = C.text;
        ctx.fillText(String(m.index + 1), x + 6 * s, L.waveY + 6 * s);
      }
    }

    // イベント（レーンの下）
    ctx.font = `600 ${Math.round(22 * s)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let lastTick = NaN;
    let stack = 0;
    const grads = course.grads ?? [];
    for (const e of course.events) {
      if (e.tick < leftTick || e.tick > rightTick) continue;
      stack = e.tick === lastTick ? stack + 1 : 0;
      lastTick = e.tick;
      const x = this.xOf(e.tick);
      if (x < L.colW) continue;
      ctx.fillStyle = C.event;
      ctx.beginPath();
      ctx.moveTo(x, L.evY + 2);
      ctx.lineTo(x - 10 * s, L.evTop + 4 * s);
      ctx.lineTo(x + 10 * s, L.evTop + 4 * s);
      ctx.closePath();
      ctx.fill();
      // グラデの中の #SCROLL は三角の印だけ。始点には「グラデ 開始値→終了値」を出す
      const g = e.kind === 'scroll' ? grads.find((x) => e.tick >= x.start && e.tick < x.end) : undefined;
      if (g && e.tick !== g.start) { lastTick = NaN; continue; }
      const t = g ? `グラデ ${g.from}→${g.to} ${g.mode === 'linear' ? '等差' : '等比'}` : eventText(e);
      const tw = ctx.measureText(t).width;
      const ex = x + 6 * s + stack * (tw + 26 * s);
      ctx.fillStyle = 'rgba(194,125,255,0.2)';
      ctx.fillRect(ex, L.evTop + 8 * s, tw + 16 * s, 30 * s);
      ctx.fillStyle = '#e6cfff';
      ctx.fillText(t, ex + 8 * s, L.evTop + 23 * s);
    }

    // 判定枠（Malody と同じ金色の二重の輪。ここが再生位置）
    ctx.lineWidth = Math.max(1.5, 4 * s);
    ctx.strokeStyle = '#e0a400';
    ctx.beginPath();
    ctx.arc(L.playX, L.cy, R.judgeR * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, 3 * s);
    ctx.strokeStyle = '#8a6a10';
    ctx.beginPath();
    ctx.arc(L.playX, L.cy, R.judgeR2 * s, 0, Math.PI * 2);
    ctx.stroke();

    // ノーツ（後ろから描く）
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.colW, L.laneY - L.bigR, this.w - L.colW, L.laneH + L.bigR * 2);
    ctx.clip();
    const notes = course.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const endT = n.endTick ?? n.tick;
      if (endT < leftTick || n.tick > rightTick) continue;
      const big = n.type === 'bigDon' || n.type === 'bigKa' || n.type === 'bigRoll';
      const x = this.xOf(n.tick);
      const ex = n.endTick !== undefined ? this.xOf(n.endTick) : undefined;
      if (n.type === 'balloon' && ex !== undefined) {
        // 風船は、受け付けている範囲を半透明のオレンジの連打で示す
        ctx.globalAlpha = 0.45;
        drawRoll(ctx, x, ex, L.cy, L.r, 'balloon');
        ctx.globalAlpha = 1;
        drawAny(ctx, n.type, x, L.cy, L.r, undefined, n.hits ?? 5);
      } else {
        drawAny(ctx, n.type, x, L.cy, big ? L.bigR : L.r, ex, n.type === 'balloon' ? n.hits ?? 5 : null);
      }
    }

    // 連打の始点（終点待ち）
    if (ed.pendingLong !== null) {
      const x = this.xOf(ed.pendingLong);
      ctx.setLineDash([8 * s, 8 * s]);
      ctx.strokeStyle = ed.tool === 'gogo' ? '#ff6e28' : ed.tool === 'grad' ? '#c792ea' : '#fbbf14';
      ctx.lineWidth = Math.max(2, 5 * s);
      ctx.beginPath();
      if (ed.tool === 'gogo' || ed.tool === 'grad') {
        // ゴーゴー・グラデの始点は縦の点線
        ctx.moveTo(x, L.laneY);
        ctx.lineTo(x, L.laneY + L.laneH);
      } else {
        ctx.arc(x, L.cy, L.r * 1.15, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // マウス位置のプレビュー
    if (this.hoverX !== null && !this.drag) {
      const t = ed.snap(this.tickOf(this.hoverX));
      const x = this.xOf(t);
      ctx.globalAlpha = 0.4;
      if (ed.tool === 'gogo' || ed.tool === 'grad') {
        ctx.fillStyle = ed.tool === 'gogo' ? '#ff6e28' : '#c792ea';
        ctx.fillRect(x - Math.max(1, 2 * s), L.laneY, Math.max(2, 4 * s), L.laneH);
      } else if (ed.tool === 'erase') {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, L.cy, L.r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const big = ed.tool === 'bigDon' || ed.tool === 'bigKa' || ed.tool === 'bigRoll';
        drawAny(ctx, ed.tool, x, L.cy, big ? L.bigR : L.r, x + this.zoom);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // 下: 現在の小節・拍、BPM、拍子
    const at = Math.max(0, ed.snap(this.pos));
    const m = ed.measureOf(at);
    const bpm = Number(ed.timing.bpmAt(at).toFixed(3));
    ctx.font = `700 ${Math.round(30 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // 数値の桁が変わっても位置がずれないよう、項目ごとに位置を固定する
    const items: [string, string, number][] = [
      ['小節', String(m.index + 1), 0],
      ['BPM', String(bpm), 220],
      ['拍子', `${m.num}/${m.den}`, 520],
    ];
    for (const [k, v, dx] of items) {
      const x = (R.posLabel.x + dx) * s;
      ctx.fillStyle = C.sub;
      ctx.fillText(k, x, R.posLabel.y * s);
      ctx.fillStyle = C.text;
      ctx.fillText(v, x + (k === 'BPM' ? 92 : 72) * s, R.posLabel.y * s);
    }

    this.drawColumn(L);
  }

  private drawWave(L: Lay) {
    const wv = this.wave;
    const ctx = this.ctx;
    const mid = L.waveY + L.waveH / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(L.waveX, mid, this.w - L.waveX, 1);
    if (!wv) {
      ctx.font = `${Math.round(24 * L.s)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#55555c';
      ctx.fillText('音源なし（ファイル → 音源を差し替え）', (L.waveX + this.w) / 2, mid);
      return;
    }
    const t = this.ed.timing;
    const step = 2;
    let prevT = t.tickToTime(this.tickOf(L.waveX));
    ctx.fillStyle = C.wave;
    for (let x = L.waveX; x < this.w; x += step) {
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

  /**
   * 密度推移（Malody の左の列と同じ縦向き。下が曲の始め、上が終わり）。
   * 曲を短い区間に分け、1 秒あたりのノーツ数を右端から左へ伸びる棒で描く。今の位置に横線
   */
  private drawDensity(L: Lay) {
    const ctx = this.ctx;
    const s = L.s;
    const g = this.graph;
    const x1 = L.colLine1 + R.densW * s;
    const maxW = (R.densW - 6) * s;
    const len = this.songLength();
    const step = Math.max(3, 7 * s);
    const n = Math.max(8, Math.floor((g.bottom - g.top) / step));
    // ドン（赤）とカッ（水色）を分けて数え、右端からドン → カッの順に積む（連打・風船はドンに数える）
    const dons = new Float32Array(n);
    const kas = new Float32Array(n);
    const timing = this.ed.timing;
    for (const note of this.ed.course.notes) {
      const t = timing.tickToTime(note.tick);
      const i = Math.floor((t / len) * n);
      if (i < 0 || i >= n) continue;
      // ドンは 1・3、カッは 2・4 だけ数える（連打・風船は数えない）
      if (note.type === 'ka' || note.type === 'bigKa') kas[i] += 1;
      else if (note.type === 'don' || note.type === 'bigDon') dons[i] += 1;
    }
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, dons[i] + kas[i]);
    const bh = ((g.bottom - g.top) / n) * 0.8;
    for (let i = 0; i < n; i++) {
      const total = dons[i] + kas[i];
      if (!total || !max) continue;
      const w = Math.max(1, (total / max) * maxW);
      const wd = (dons[i] / total) * w;
      const y = g.bottom - ((i + 1) * (g.bottom - g.top)) / n;
      ctx.fillStyle = '#f2442b';
      ctx.fillRect(x1 - wd, y, wd, bh);
      ctx.fillStyle = '#5ec4d4';
      ctx.fillRect(x1 - w, y, w - wd, bh);
    }
    // 今の位置
    const now = timing.tickToTime(Math.max(0, this.pos));
    const y = g.bottom - (Math.min(1, now / len)) * (g.bottom - g.top);
    ctx.fillStyle = '#ffb02e';
    ctx.fillRect(L.colLine1, y - Math.max(1, 1.5 * s), R.densW * s, Math.max(2, 3 * s));
  }

  /** 左の列（Malody と同じ配置） */
  private drawColumn(L: Lay) {
    const ctx = this.ctx;
    const s = L.s;
    ctx.fillStyle = C.col;
    ctx.fillRect(0, 0, L.colW, this.h);
    ctx.fillStyle = C.colLine;
    const lw = Math.max(1, 2 * s);
    ctx.fillRect(L.colLine1, 0, lw, this.h);
    ctx.fillRect(L.colW - lw, 0, lw, L.laneY);
    ctx.fillRect(L.colW - lw, L.evY, lw, this.h - L.evY);

    this.drawDensity(L);

    // 再生位置の線（左端から再生ボタンまで）
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, L.cy - lw / 2, L.play.x, lw);
    ctx.fillStyle = '#ffb02e';
    hexPath(ctx, 6 * s, L.cy, 9 * s);
    ctx.fill();

    const hex = (b: Box, label: 'plus' | 'minus' | 'play' | 'pause') => {
      ctx.save();
      ctx.translate(b.x, b.y);
      hexPath(ctx, 0, 0, b.r);
      ctx.fillStyle = C.hex;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, 4 * s);
      ctx.strokeStyle = C.hexEdge;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      const k = b.r;
      if (label === 'plus' || label === 'minus') {
        const t = Math.max(2, k * 0.12);
        ctx.fillRect(-k * 0.42, -t / 2, k * 0.84, t);
        if (label === 'plus') ctx.fillRect(-t / 2, -k * 0.42, t, k * 0.84);
      } else if (label === 'play') {
        ctx.beginPath();
        ctx.moveTo(-k * 0.28, -k * 0.36);
        ctx.lineTo(k * 0.42, 0);
        ctx.lineTo(-k * 0.28, k * 0.36);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(-k * 0.3, -k * 0.34, k * 0.2, k * 0.68);
        ctx.fillRect(k * 0.1, -k * 0.34, k * 0.2, k * 0.68);
      }
      ctx.restore();
    };
    hex(L.zoomOut, 'minus');
    hex(L.zoomIn, 'plus');
    hex(L.play, this.playing ? 'pause' : 'play');

    // 曲の長さ（上）と現在時刻（下）を縦書きで（Malody と同じ位置）
    const time = this.ed.timing.tickToTime(Math.max(0, this.pos));
    ctx.font = `700 ${Math.round(34 * s)}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    const vtext = (text: string, x: number, y: number, align: CanvasTextAlign) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = align;
      ctx.shadowColor = 'rgba(255,255,255,0.35)';
      ctx.shadowBlur = 6 * s;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    if (this.duration > 0) vtext(fmtTime(this.duration), R.timeX * s, 24 * s, 'right');
    vtext(fmtTime(time), R.timeX * s, this.h - 24 * s, 'left');
  }
}

type Lay = EditorView['L'];
