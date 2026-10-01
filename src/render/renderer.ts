import type { Course, Note } from '../chart/types';
import { CLEAR_LINE, type Game, type HitKind, type Judge, type JudgeEvent, type NoteState } from '../engine/game';
import { BIG_SCALE, drawAny, drawBalloon, drawNoteHead, isBig, outlinedText } from './notes';

/**
 * テストプレイ画面。太鼓の達人のプレイ画面（2000×1125 のスクリーンショット）から
 * 位置・大きさを測った「基準座標」で描き、画面サイズに合わせて拡大縮小する。
 * 公式の画像・キャラクターは使わず、配置と演出の動きだけを再現している。
 */

// ---------- 基準座標（2000×1125） ----------
const REF_W = 2000;
const REF_H = 1125;
const LANE_X = 515; // レーン左端（左パネルの右端）
const LANE_TOP = 298;
const LANE_BOTTOM = 508;
const TEXT_BOTTOM = 548; // 音符文字の帯の下端
const JX = 660; // 判定枠の中心
const JY = 403;
const NR = 47; // 通常ノーツの半径
const MEASURE_PX = 1470; // ハイスピード 1.0 で 1 小節が流れる距離
const GAUGE = { x1: 768, x2: 1812, y1: 258, y2: 291, segs: 50 };
const FLOWER = { x: 1912, y: 258, r: 96 };
const DRUM = { x: 418, y: 426, r: 84 }; // 左パネルのコンボ太鼓
const FONT = "'M PLUS Rounded 1c', 'Hiragino Maru Gothic ProN', 'Arial Rounded MT Bold', system-ui, sans-serif";

const JUDGE_TEXT: Record<Judge, string> = { good: '良', ok: '可', bad: '不可' };
const COURSE_LABEL: Record<string, [string, string]> = {
  Easy: ['かんたん', '#f08a24'],
  Normal: ['ふつう', '#5cae3a'],
  Hard: ['むずかしい', '#7c8aa6'],
  Oni: ['おに', '#7b3fd1'],
  Edit: ['おに', '#4a2a96'],
};

interface Fx { t: number }
interface Burst extends Fx { judge: Judge; big: boolean }
interface Flyer extends Fx { note: Note }
interface Flash extends Fx { kind: HitKind; side: 'L' | 'R' }

export interface Layout {
  w: number;
  h: number;
  laneY: number;
  laneH: number;
  judgeX: number;
  drumX: number;
  drumY: number;
  /** 面（ドン）の楕円の半径（画面 px） */
  drumRx: number;
  drumRy: number;
}

const ease = (x: number) => 1 - (1 - x) * (1 - x);

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  layout!: Layout;
  speed = 1;
  /** タッチ操作用の太鼓を画面下に描くか */
  touch = matchMedia('(pointer: coarse)').matches;

  private dpr = 1;
  private s = 1;
  private ox = 0;
  private oy = 0;
  private vis = { x0: 0, y0: 0, x1: REF_W, y1: REF_H };
  /** 画面下の太鼓（画面 px） */
  private pad = { x: 0, y: 0, faceRx: 1, faceRy: 1, rimRx: 1, rimRy: 1 };

  private bursts: Burst[] = [];
  private flyers: Flyer[] = [];
  private flashes: Flash[] = [];
  private touches: { kind: HitKind; x: number; y: number; t: number }[] = [];
  private judgeFx: { judge: Judge; t: number } | null = null;
  private comboPop = 0;
  private lastCombo = 0;
  private banner: { combo: number; t: number } | null = null;
  private flowerPop = 0;
  private rollFx: { count: number; t: number; balloon: boolean } | null = null;
  private labels = new WeakMap<Game, Map<Note, string>>();
  private topPattern: CanvasPattern | null = null;
  private topTile: HTMLCanvasElement | null = null;
  private bandTile: HTMLCanvasElement | null = null;
  /** 動かない背景（上の模様・下の背景・帯）を前もって描いておいたもの */
  private bg: HTMLCanvasElement | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.makePatterns();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // ---------- レイアウト ----------

  resize() {
    // 高解像度の端末でも描く量を抑える（3倍だと1フレームの塗りが多すぎて、叩いた処理が遅れることがある）
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);

    // 太鼓の達人の画面（16:9）の比率を固定して中央に置き、余った部分は黒帯
    this.s = Math.min(w / REF_W, h / REF_H);
    this.ox = (w - REF_W * this.s) / 2;
    this.oy = (h - REF_H * this.s) / 2;
    const s = this.s;
    this.vis = { x0: 0, y0: 0, x1: REF_W, y1: REF_H };

    // タッチ用の太鼓（画面 px）。斜めから見た太鼓のような横長の楕円で、16:9 の外の黒帯まで含めた
    // 画面の横幅いっぱいに置く。横持ちで両手の親指が自然に置かれる左右の下側も面（ドン）に入る。
    {
      const laneBottom = this.sy(TEXT_BOTTOM);
      const cy = h + (h - laneBottom) * 0.12;
      const rimRy = cy - laneBottom - 8 * (h / 400);
      this.pad = {
        x: w / 2,
        y: cy,
        rimRx: w * 0.5,
        rimRy,
        faceRx: w * 0.44,
        faceRy: rimRy * 0.82,
      };
    }

    this.layout = {
      w, h,
      laneY: this.sy(LANE_TOP),
      laneH: (TEXT_BOTTOM - LANE_TOP) * s,
      judgeX: this.sx(JX),
      drumX: this.pad.x,
      drumY: this.pad.y,
      drumRx: this.pad.faceRx,
      drumRy: this.pad.faceRy,
    };
    this.buildBackground();
  }

  /** 動かない背景を一度だけ描いておく（毎フレームはこれをコピーするだけ） */
  private buildBackground() {
    const bg = this.bg ?? document.createElement('canvas');
    bg.width = this.canvas.width;
    bg.height = this.canvas.height;
    const c = bg.getContext('2d')!;
    c.fillStyle = '#000';
    c.fillRect(0, 0, bg.width, bg.height);
    c.setTransform(this.dpr * this.s, 0, 0, this.dpr * this.s, this.dpr * this.ox, this.dpr * this.oy);
    c.beginPath();
    c.rect(0, 0, REF_W, REF_H);
    c.clip();
    const V = this.vis;
    // 上の模様
    c.fillStyle = (this.topTile && c.createPattern(this.topTile, 'repeat')) || '#e43b55';
    c.fillRect(V.x0, V.y0, V.x1 - V.x0, LANE_TOP - V.y0);
    // 下の背景
    const top = TEXT_BOTTOM;
    const g = c.createLinearGradient(0, top, 0, V.y1);
    g.addColorStop(0, '#2b2148');
    g.addColorStop(1, '#5b3360');
    c.fillStyle = g;
    c.fillRect(V.x0, top, V.x1 - V.x0, V.y1 - top);
    if (!this.touch) {
      // 提灯の列
      c.strokeStyle = 'rgba(0,0,0,0.5)';
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(V.x0, top + 60);
      for (let x = V.x0; x <= V.x1 + 200; x += 200) c.quadraticCurveTo(x + 100, top + 100, x + 200, top + 60);
      c.stroke();
      for (let x = Math.floor(V.x0 / 200) * 200 + 100; x < V.x1; x += 200) {
        const y = top + 120;
        c.fillStyle = '#d8392a';
        c.beginPath();
        c.ellipse(x, y, 34, 44, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#1b1210';
        c.fillRect(x - 18, y - 50, 36, 10);
        c.fillRect(x - 18, y + 40, 36, 10);
        c.fillStyle = 'rgba(255,230,160,0.35)';
        c.beginPath();
        c.ellipse(x, y, 18, 36, 0, 0, Math.PI * 2);
        c.fill();
      }
    }
    // 一番下の帯
    c.save();
    c.translate(0, V.y1 - 66);
    c.fillStyle = (this.bandTile && c.createPattern(this.bandTile, 'repeat')) || '#d6402c';
    c.fillRect(V.x0, 0, V.x1 - V.x0, 66);
    c.restore();
    c.fillStyle = '#120c0a';
    c.fillRect(V.x0, V.y1 - 70, V.x1 - V.x0, 4);
    this.bg = bg;
  }

  private sx(x: number) { return x * this.s + this.ox; }
  private sy(y: number) { return y * this.s + this.oy; }

  private makePatterns() {
    // 上部: 青海波（せいがいは）模様
    const t = document.createElement('canvas');
    t.width = 120;
    t.height = 60;
    const c = t.getContext('2d')!;
    c.fillStyle = '#e43b55';
    c.fillRect(0, 0, 120, 60);
    const wave = (x: number, y: number) => {
      for (let i = 4; i >= 1; i--) {
        c.beginPath();
        c.arc(x, y, i * 14, Math.PI, 0);
        c.fillStyle = i % 2 ? '#ef6b80' : '#e43b55';
        c.fill();
      }
    };
    for (const [x, y] of [[0, 30], [120, 30], [60, 60], [0, 90], [120, 90], [60, 0], [-60, 60], [180, 60]]) wave(x, y);
    this.topTile = t;
    this.topPattern = this.ctx.createPattern(t, 'repeat');

    // 下の帯: 色違いの市松
    const b = document.createElement('canvas');
    b.width = 400;
    b.height = 66;
    const d = b.getContext('2d')!;
    const cols = ['#d6402c', '#f0b431', '#1d4d55'];
    for (let i = 0; i < 3; i++) {
      d.fillStyle = cols[i];
      d.fillRect(i * 133.4, 0, 134, 66);
      d.strokeStyle = 'rgba(255,255,255,0.18)';
      d.lineWidth = 3;
      for (let k = 0; k < 4; k++) {
        d.beginPath();
        d.arc(i * 133.4 + 66, 66, 18 + k * 14, Math.PI, 0);
        d.stroke();
      }
    }
    this.bandTile = b;
  }

  // ---------- 演出の受け口 ----------

  pushJudge(e: JudgeEvent) {
    const now = performance.now();
    this.judgeFx = { judge: e.judge, t: now };
    if (e.judge !== 'bad') {
      this.bursts.push({ t: now, judge: e.judge, big: isBig(e.note.type) });
      this.flyers.push({ t: now, note: e.note });
      if (this.bursts.length > 6) this.bursts.shift();
      if (this.flyers.length > 24) this.flyers.shift();
    }
  }

  pushRoll(s: NoteState) {
    this.rollFx = { count: s.count, t: performance.now(), balloon: s.note.type === 'balloon' };
    if (s.note.type !== 'balloon') this.flyers.push({ t: performance.now(), note: { ...s.note, type: s.note.type === 'bigRoll' ? 'bigDon' : 'don' } });
  }

  pushHit(kind: HitKind, side: 'L' | 'R') {
    this.flashes.push({ kind, side, t: performance.now() });
    if (this.flashes.length > 8) this.flashes.shift();
  }

  reset() {
    this.bursts = [];
    this.flyers = [];
    this.flashes = [];
    this.judgeFx = null;
    this.banner = null;
    this.rollFx = null;
    this.lastCombo = 0;
  }

  // ---------- 描画 ----------

  private velocity(n: { bpm: number; scroll: number }) {
    return (MEASURE_PX * n.bpm * n.scroll * this.speed) / 240;
  }

  draw(game: Game, course: Course, now: number, info: { title: string; course: string; level: number }) {
    const bars = course.bars;
    const ctx = this.ctx;
    const wall = performance.now();
    const st = game.stats;

    if (st.combo > this.lastCombo) {
      this.comboPop = wall;
      if (st.combo % 100 === 0) this.banner = { combo: st.combo, t: wall };
    }
    this.lastCombo = st.combo;

    const gogo = course.gogo.some(([a, b]) => now >= a && now < b);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.bg && this.bg.width === this.canvas.width && this.bg.height === this.canvas.height) {
      ctx.drawImage(this.bg, 0, 0);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.setTransform(this.dpr * this.s, 0, 0, this.dpr * this.s, this.dpr * this.ox, this.dpr * this.oy);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, REF_W, REF_H);
    ctx.clip();
    const V = this.vis;

    this.drawTop(V, gogo, wall);
    ctx.font = `900 58px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    outlinedText(ctx, info.title, V.x1 - 46, 78, '#fff', '#111', 11);
    this.drawBottom(V, wall);
    this.drawLane(V, game, bars, now, gogo, wall);
    this.drawBursts(wall);
    this.drawPanel(st.score, st.combo, info, wall);
    this.drawGauge(st.gauge, wall);
    this.drawRollBubble(wall);
    this.drawJudgeText(wall);
    this.drawFlyers(wall);
    this.drawBanner(wall);
    ctx.restore();
    if (this.touch) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawPad(wall);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawTop(V: Rect, gogo: boolean, wall: number) {
    const ctx = this.ctx;
    if (!this.bg) {
      ctx.fillStyle = this.topPattern ?? '#e43b55';
      ctx.fillRect(V.x0, V.y0, V.x1 - V.x0, LANE_TOP - V.y0);
    }
    if (gogo) {
      ctx.fillStyle = `rgba(255,190,60,${0.16 + 0.08 * Math.sin(wall / 120)})`;
      ctx.fillRect(V.x0, V.y0, V.x1 - V.x0, LANE_TOP - V.y0);
    }
  }

  /** 下の背景は前もって描いてあるので、ここでは舞う花びら（パソコンのみ）だけ描く */
  private drawBottom(V: Rect, wall: number) {
    if (this.touch) return;
    const ctx = this.ctx;
    const top = TEXT_BOTTOM;
    ctx.fillStyle = 'rgba(255,190,215,0.8)';
    for (let i = 0; i < 26; i++) {
      const sp = 40 + (i * 37) % 60;
      const x = V.x0 + (((i * 173 + wall / 1000 * sp * 2) % (V.x1 - V.x0 + 100)) - 50);
      const y = top + 30 + (((i * 97 + wall / 1000 * sp) % (V.y1 - top - 90)));
      ctx.beginPath();
      ctx.ellipse(x, y, 9, 5, (wall / 600 + i) % Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }


  private drawLane(V: Rect, game: Game, bars: Course['bars'], now: number, gogo: boolean, wall: number) {
    const ctx = this.ctx;
    const right = V.x1;

    // 枠
    ctx.fillStyle = '#121010';
    ctx.fillRect(LANE_X, LANE_TOP - 6, right - LANE_X, TEXT_BOTTOM - LANE_TOP + 12);

    // レーン本体
    if (gogo) {
      const g = ctx.createLinearGradient(0, LANE_TOP, 0, LANE_BOTTOM);
      g.addColorStop(0, '#7a2238');
      g.addColorStop(1, '#4a1424');
      ctx.fillStyle = g;
    } else {
      const g = ctx.createLinearGradient(0, LANE_TOP, 0, LANE_BOTTOM);
      g.addColorStop(0, '#3a332f');
      g.addColorStop(1, '#2a2421');
      ctx.fillStyle = g;
    }
    ctx.fillRect(LANE_X, LANE_TOP, right - LANE_X, LANE_BOTTOM - LANE_TOP);

    // 叩いたときのレーンの光
    for (const f of this.flashes) {
      const a = 1 - (wall - f.t) / 130;
      if (a <= 0) continue;
      const g = ctx.createLinearGradient(LANE_X, 0, LANE_X + 620, 0);
      const col = f.kind === 'don' ? '255,70,40' : '70,190,230';
      g.addColorStop(0, `rgba(${col},${0.55 * a})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(LANE_X, LANE_TOP, 620, LANE_BOTTOM - LANE_TOP);
    }

    // 判定枠
    if (gogo) {
      const pulse = 1 + 0.06 * Math.sin(wall / 90);
      const g = ctx.createRadialGradient(JX, JY, 30, JX, JY, 120 * pulse);
      g.addColorStop(0, 'rgba(255,200,80,0.55)');
      g.addColorStop(1, 'rgba(255,90,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(JX, JY, 120 * pulse, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(JX, JY, NR - 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(170,165,160,0.9)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(JX, JY, NR * BIG_SCALE - 2, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(140,135,130,0.7)';
    ctx.stroke();

    // 小節線
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (const b of bars) {
      const x = JX + (b.time - now) * this.velocity(b);
      if (x < LANE_X || x > right) continue;
      ctx.fillRect(x - 1.5, LANE_TOP, 3, LANE_BOTTOM - LANE_TOP);
    }

    // 音符文字の帯
    ctx.fillStyle = '#5e5a57';
    ctx.fillRect(LANE_X, LANE_BOTTOM, right - LANE_X, TEXT_BOTTOM - LANE_BOTTOM);
    ctx.fillStyle = '#2c2826';
    ctx.fillRect(LANE_X, LANE_BOTTOM, right - LANE_X, 3);

    // ノーツ
    const labels = this.labelsFor(game);
    ctx.save();
    ctx.beginPath();
    ctx.rect(LANE_X, LANE_TOP - 80, right - LANE_X + 200, TEXT_BOTTOM - LANE_TOP + 80);
    ctx.clip();
    ctx.font = `800 31px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const states = game.states;
    for (let i = states.length - 1; i >= 0; i--) {
      const s = states[i];
      const n = s.note;
      if (s.done && !s.missed && n.type !== 'roll' && n.type !== 'bigRoll') continue;
      const v = this.velocity(n);
      let x = JX + (n.time - now) * v;
      const endX = n.endTime !== undefined ? JX + (n.endTime - now) * v : x;
      if (endX < LANE_X - 120 || x > right + 120) continue;
      const r = isBig(n.type) ? NR * BIG_SCALE : NR;

      if (n.type === 'balloon') {
        if (s.done && s.count >= (n.hits ?? 5)) continue; // 割れた
        const active = now >= n.time && now <= (n.endTime ?? n.time);
        if (active) x = JX;
        if (now > (n.endTime ?? n.time)) continue;
        drawBalloon(ctx, x, JY, r, active ? Math.max(0, (n.hits ?? 5) - s.count) : null, active ? undefined : endX);
      } else if (n.type === 'roll' || n.type === 'bigRoll') {
        drawAny(ctx, n.type, x, JY, r, endX);
      } else {
        drawNoteHead(ctx, x, JY, r, n.type);
      }

      const label = labels.get(n);
      if (label && x > LANE_X - 40) {
        outlinedText(ctx, label, x, (LANE_BOTTOM + TEXT_BOTTOM) / 2 + 1, '#fff', '#1d1715', 7);
      }
    }
    ctx.restore();
  }

  /** 音符の下の文字（ドン / ド / コ / カッ / カ / 連打 / ふうせん） */
  private labelsFor(game: Game): Map<Note, string> {
    const cached = this.labels.get(game);
    if (cached) return cached;
    const map = new Map<Note, string>();
    const notes = game.states.map((s) => s.note);
    let prevShort = false;
    let prevLabel = '';
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const beat = 60 / n.bpm;
      if (n.type === 'roll' || n.type === 'bigRoll') { map.set(n, '連打ーっ!!'); prevShort = false; continue; }
      if (n.type === 'balloon') { map.set(n, 'ふうせん'); prevShort = false; continue; }
      const next = notes[i + 1];
      const gap = next ? next.time - n.time : Infinity;
      const short = gap < beat / 2 - 1e-3;
      const isDon = n.type === 'don' || n.type === 'bigDon';
      let label: string;
      if (isDon) {
        if (!short) label = 'ドン';
        else if (prevShort && prevLabel === 'ド' && gap <= beat / 4 + 1e-3) label = 'コ';
        else label = 'ド';
      } else {
        label = short ? 'カ' : 'カッ';
      }
      map.set(n, label);
      prevShort = short;
      prevLabel = label;
    }
    this.labels.set(game, map);
    return map;
  }

  private drawBursts(wall: number) {
    const ctx = this.ctx;
    for (const b of this.bursts) {
      const p = (wall - b.t) / 260;
      if (p < 0 || p > 1) continue;
      const k = b.big ? 1.35 : 1;
      const a = 1 - p;
      const col = b.judge === 'good' ? '255,226,70' : '255,255,255';
      // 光
      const g = ctx.createRadialGradient(JX, JY, 10, JX, JY, (70 + 50 * ease(p)) * k);
      g.addColorStop(0, `rgba(${col},${0.85 * a})`);
      g.addColorStop(0.6, `rgba(${col},${0.35 * a})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(JX, JY, (70 + 50 * ease(p)) * k, 0, Math.PI * 2);
      ctx.fill();
      // 粒の輪（2重）
      ctx.fillStyle = `rgba(${col},${a})`;
      for (let ring = 0; ring < 2; ring++) {
        const count = 22 + ring * 6;
        const rad = (58 + ring * 22 + 70 * ease(p)) * k;
        const dot = (8 - ring * 2) * (1 - p * 0.6) * k;
        for (let i = 0; i < count; i++) {
          const ang = (Math.PI * 2 * (i + ring * 0.5)) / count;
          ctx.beginPath();
          ctx.arc(JX + Math.cos(ang) * rad, JY + Math.sin(ang) * rad, dot, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    this.bursts = this.bursts.filter((b) => wall - b.t < 300);
  }

  private drawPanel(score: number, combo: number, info: { course: string; level: number }, wall: number) {
    const ctx = this.ctx;
    const x0 = Math.min(0, this.vis.x0);
    // 赤いパネル
    const g = ctx.createLinearGradient(0, LANE_TOP - 6, 0, TEXT_BOTTOM);
    g.addColorStop(0, '#e9452f');
    g.addColorStop(1, '#c9301f');
    ctx.fillStyle = g;
    ctx.fillRect(x0, LANE_TOP - 6, LANE_X - x0, TEXT_BOTTOM - LANE_TOP + 12);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let x = 30; x < LANE_X; x += 70) {
      for (let y = LANE_TOP + 30; y < TEXT_BOTTOM; y += 70) {
        ctx.beginPath();
        ctx.arc(x + ((y / 70) % 2) * 35, y, 18, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // スコア欄
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x0, LANE_TOP - 6, 320 - x0, 62);
    ctx.font = `800 48px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    outlinedText(ctx, String(score), 288, LANE_TOP + 26, '#fff', '#000', 8);

    // 難易度
    const [label, col] = COURSE_LABEL[info.course] ?? [info.course, '#7b3fd1'];
    ctx.beginPath();
    ctx.arc(100, 412, 44, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = `900 ${label.length > 3 ? 19 : 27}px ${FONT}`;
    outlinedText(ctx, label, 100, 414, '#fff', '#2a1640', 5);
    ctx.font = `800 26px ${FONT}`;
    outlinedText(ctx, `★${info.level}`, 100, 482, '#ffe25a', '#3a1a00', 6);

    // コンボ太鼓
    this.drawComboDrum(combo, wall);
  }

  private drawComboDrum(combo: number, wall: number) {
    const ctx = this.ctx;
    const { x, y, r } = DRUM;
    // 胴
    ctx.fillStyle = '#5a1d10';
    ctx.beginPath();
    ctx.ellipse(x, y + 26, r, r * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#a3381f';
    ctx.beginPath();
    ctx.ellipse(x, y + 18, r * 0.98, r * 0.88, 0, 0, Math.PI * 2);
    ctx.fill();
    // 面
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#3a1810';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.93, 0, Math.PI * 2);
    ctx.fillStyle = '#f3e3c6';
    ctx.fill();

    // 叩いた場所が光る（面＝ドン、縁＝カッ）
    for (const f of this.flashes) {
      const a = 1 - (wall - f.t) / 160;
      if (a <= 0) continue;
      const start = f.side === 'L' ? Math.PI / 2 : -Math.PI / 2;
      ctx.beginPath();
      if (f.kind === 'don') {
        ctx.moveTo(x, y);
        ctx.arc(x, y, r * 0.93, start, start + Math.PI);
        ctx.fillStyle = `rgba(255,80,40,${0.75 * a})`;
        ctx.fill();
      } else {
        ctx.arc(x, y, r * 0.97, start, start + Math.PI);
        ctx.lineWidth = 12;
        ctx.strokeStyle = `rgba(70,200,240,${a})`;
        ctx.stroke();
      }
    }

    if (combo < 10) return;
    const p = Math.min(1, (wall - this.comboPop) / 90);
    const scale = 1 + 0.22 * (1 - p);
    const digits = String(combo);
    const size = digits.length >= 4 ? 54 : digits.length === 3 ? 68 : 80;
    ctx.save();
    ctx.translate(x, y - 8);
    ctx.scale(1, scale);
    ctx.font = `900 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let fill: string | CanvasGradient = '#fff';
    if (combo >= 100) {
      const g = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
      g.addColorStop(0, '#fff7c2');
      g.addColorStop(0.5, '#ffd23a');
      g.addColorStop(1, '#ff9a12');
      fill = g;
    }
    outlinedText(ctx, digits, 0, 0, fill, '#2a1208', 11);
    ctx.restore();
    ctx.font = `900 26px ${FONT}`;
    ctx.textAlign = 'center';
    outlinedText(ctx, 'コンボ', x, y + 46, '#fff', '#2a1208', 6);
  }

  private drawGauge(gauge: number, wall: number) {
    const ctx = this.ctx;
    const G = GAUGE;
    // 枠
    ctx.fillStyle = '#1a0d09';
    roundRect(ctx, G.x1 - 8, G.y1 - 7, G.x2 - G.x1 + 16, G.y2 - G.y1 + 14, 10);
    ctx.fill();
    // クリア欄
    const clearX = G.x1 + ((G.x2 - G.x1) * CLEAR_LINE) / 100;
    ctx.fillStyle = '#4a3a12';
    roundRect(ctx, clearX - 4, G.y1 - 40, G.x2 - clearX + 12, 38, 8);
    ctx.fill();
    ctx.font = `800 26px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    outlinedText(ctx, 'クリア', clearX + 10, G.y1 - 21, gauge >= CLEAR_LINE ? '#ffe25a' : '#b9a46a', '#1a0d09', 5);

    // 目盛り
    const segW = (G.x2 - G.x1) / G.segs;
    const filled = Math.floor((gauge / 100) * G.segs + 1e-6);
    const full = gauge >= 100;
    for (let i = 0; i < G.segs; i++) {
      const x = G.x1 + i * segW;
      const clear = i >= (G.segs * CLEAR_LINE) / 100;
      let col: string;
      if (i < filled) {
        if (full) col = `hsl(${(i * 9 + wall / 4) % 360},90%,58%)`;
        else col = clear ? '#ffd21f' : '#ff3d1c';
      } else col = clear ? '#5a4a1a' : '#5a2418';
      ctx.fillStyle = col;
      ctx.fillRect(x + 1, G.y1, segW - 2, G.y2 - G.y1);
      if (i < filled) {
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillRect(x + 1, G.y1, segW - 2, 7);
      }
    }

    // 魂の花
    const pop = Math.max(0, 1 - (wall - this.flowerPop) / 160);
    const fr = FLOWER.r * (1 + 0.1 * pop);
    const bright = gauge >= CLEAR_LINE;
    for (let i = 0; i < 12; i++) {
      const a = (Math.PI * 2 * i) / 12 + wall / 4000;
      ctx.beginPath();
      ctx.arc(FLOWER.x + Math.cos(a) * fr * 0.7, FLOWER.y + Math.sin(a) * fr * 0.7, fr * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? (bright ? '#ffb31a' : '#a4752a') : bright ? '#ff7a1a' : '#8a5022';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(FLOWER.x, FLOWER.y, fr * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    drawNoteHead(ctx, FLOWER.x, FLOWER.y, fr * 0.52, 'don');
  }

  private drawRollBubble(wall: number) {
    const r = this.rollFx;
    if (!r || r.balloon) return;
    const age = wall - r.t;
    if (age > 600) return;
    const ctx = this.ctx;
    const a = age < 450 ? 1 : 1 - (age - 450) / 150;
    ctx.globalAlpha = a;
    ctx.fillStyle = '#fff4d6';
    roundRect(ctx, JX - 10, LANE_TOP - 120, 210, 74, 18);
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#e46a12';
    ctx.stroke();
    ctx.font = `900 50px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    outlinedText(ctx, String(r.count), JX + 125, LANE_TOP - 82, '#ff8a1c', '#3a1500', 7);
    ctx.font = `900 28px ${FONT}`;
    ctx.textAlign = 'left';
    outlinedText(ctx, '打', JX + 132, LANE_TOP - 78, '#fff', '#3a1500', 5);
    ctx.globalAlpha = 1;
  }

  private drawJudgeText(wall: number) {
    const j = this.judgeFx;
    if (!j) return;
    const age = wall - j.t;
    if (age > 400) return;
    const ctx = this.ctx;
    const rise = ease(Math.min(1, age / 60));
    const y = LANE_TOP - 6 - 30 * rise;
    const a = age < 300 ? 1 : 1 - (age - 300) / 100;
    ctx.globalAlpha = a;
    ctx.font = `900 ${j.judge === 'bad' ? 56 : 68}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let fill: string | CanvasGradient;
    if (j.judge === 'good') {
      const g = ctx.createLinearGradient(0, y - 34, 0, y + 34);
      g.addColorStop(0, '#fff6b0');
      g.addColorStop(0.5, '#ffc21a');
      g.addColorStop(1, '#ff8a00');
      fill = g;
    } else if (j.judge === 'ok') fill = '#ffffff';
    else fill = '#7f9cff';
    outlinedText(ctx, JUDGE_TEXT[j.judge], JX, y, fill, '#3a1300', 10);
    ctx.globalAlpha = 1;
  }

  /** 叩いたノーツが弧を描いて魂ゲージへ飛んでいく */
  private drawFlyers(wall: number) {
    const ctx = this.ctx;
    const DUR = 420;
    const keep: Flyer[] = [];
    for (const f of this.flyers) {
      const p = (wall - f.t) / DUR;
      if (p >= 1) {
        this.flowerPop = wall;
        continue;
      }
      keep.push(f);
      const t = p * p * (3 - 2 * p) * 0.35 + p * 0.65;
      // 3次ベジェ: 判定枠 → 上へ → 右へ → 花
      const P0 = [JX, JY], P1 = [JX + 60, JY - 420], P2 = [FLOWER.x - 420, FLOWER.y - 330], P3 = [FLOWER.x, FLOWER.y];
      const u = 1 - t;
      const x = u * u * u * P0[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t * t * t * P3[0];
      const y = u * u * u * P0[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t * t * t * P3[1];
      const r = (isBig(f.note.type) ? NR * BIG_SCALE : NR) * (1 - 0.25 * t);
      drawNoteHead(ctx, x, y, r, f.note.type === 'balloon' ? 'balloon' : f.note.type);
    }
    this.flyers = keep;
  }

  /** 100 コンボごとの巻物 */
  private drawBanner(wall: number) {
    const b = this.banner;
    if (!b) return;
    const age = wall - b.t;
    if (age > 2100) { this.banner = null; return; }
    const ctx = this.ctx;
    const a = age < 150 ? age / 150 : age > 1800 ? 1 - (age - 1800) / 300 : 1;
    const sc = age < 150 ? 0.85 + 0.15 * (age / 150) : 1;
    const cx = 700;
    const cy = 115;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx, cy);
    ctx.scale(sc, sc);
    // 巻物
    ctx.fillStyle = '#c0331f';
    roundRect(ctx, -222, -86, 22, 172, 8);
    ctx.fill();
    roundRect(ctx, 200, -86, 22, 172, 8);
    ctx.fill();
    ctx.fillStyle = '#fbf2dc';
    ctx.fillRect(-202, -74, 404, 148);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#d9542b';
    ctx.strokeRect(-190, -62, 380, 124);
    const g = ctx.createLinearGradient(0, -50, 0, 50);
    g.addColorStop(0, '#fff3a0');
    g.addColorStop(0.5, '#ffb11a');
    g.addColorStop(1, '#f06a00');
    ctx.font = `900 96px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    outlinedText(ctx, String(b.combo), 70, 2, g, '#3a1300', 12);
    ctx.font = `900 40px ${FONT}`;
    ctx.textAlign = 'left';
    outlinedText(ctx, 'コンボ!', 78, 26, '#ff7a1a', '#3a1300', 7);
    ctx.restore();
  }

  /** 画面下の太鼓（タッチ用）。後ろの背景が見えるように半透明 */
  private drawPad(wall: number) {
    const ctx = this.ctx;
    const P = this.pad;
    const ell = (rx: number, ry: number) => {
      ctx.beginPath();
      ctx.ellipse(P.x, P.y, rx, ry, 0, 0, Math.PI * 2);
    };
    ctx.save();
    ctx.globalAlpha = 0.5;
    ell(P.rimRx, P.rimRy); // 縁（カッ）
    ctx.fillStyle = '#8a2f1a';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#1f0c06';
    ctx.stroke();
    ell(P.faceRx, P.faceRy); // 面（ドン）
    ctx.fillStyle = '#f4e6c8';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(P.x - 2, P.y - P.faceRy, 4, P.faceRy * 2);
    ctx.restore();

    // 叩いた側の面・縁が光る
    for (const f of this.flashes) {
      const a = 1 - (wall - f.t) / 150;
      if (a <= 0) continue;
      const start = f.side === 'L' ? Math.PI / 2 : -Math.PI / 2;
      ctx.save();
      ctx.beginPath();
      if (f.kind === 'don') {
        ctx.moveTo(P.x, P.y);
        ctx.ellipse(P.x, P.y, P.faceRx, P.faceRy, 0, start, start + Math.PI);
        ctx.fillStyle = `rgba(255,80,40,${0.45 * a})`;
        ctx.fill();
      } else {
        ctx.ellipse(P.x, P.y, P.rimRx, P.rimRy, 0, start, start + Math.PI);
        ctx.ellipse(P.x, P.y, P.faceRx, P.faceRy, 0, start + Math.PI, start, true);
        ctx.fillStyle = `rgba(70,200,240,${0.6 * a})`;
        ctx.fill();
      }
      ctx.restore();
    }

    // 指が触れた場所の波紋（ドン＝赤、カッ＝青）。どちらと判定されたかが分かるように
    for (const t of this.touches) {
      const p = (wall - t.t) / 260;
      if (p < 0 || p > 1) continue;
      ctx.beginPath();
      ctx.arc(t.x, t.y, (30 + 70 * ease(p)) * this.s, 0, Math.PI * 2);
      ctx.lineWidth = (10 * (1 - p) + 2) * this.s;
      ctx.strokeStyle = t.kind === 'don' ? `rgba(255,70,40,${1 - p})` : `rgba(60,190,240,${1 - p})`;
      ctx.stroke();
    }

    ctx.font = `700 ${Math.round(26 * this.s)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('面＝ドン　それ以外（画面のどこでも）＝カッ', P.x, P.y - P.faceRy + 40 * this.s);
  }

  /** 指が触れた場所（画面 px）を記録して波紋を出す */
  pushTouch(kind: HitKind, sx: number, sy: number) {
    this.touches.push({ kind, x: sx, y: sy, t: performance.now() });
    if (this.touches.length > 10) this.touches.shift();
  }
}

interface Rect { x0: number; y0: number; x1: number; y1: number }

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

