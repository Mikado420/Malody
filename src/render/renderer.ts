import type { BarLine, Note } from '../chart/types';
import type { Game, Judge, HitKind } from '../engine/game';

const COLORS = {
  bg: '#14121a',
  lane: '#2a2633',
  laneGogo: '#4a2a1a',
  laneEdge: '#3d3848',
  judgeRing: '#e9e4f2',
  don: '#f2493a',
  ka: '#3fb5e0',
  roll: '#f7c531',
  balloon: '#ff8a3d',
  bar: 'rgba(255,255,255,0.35)',
  text: '#f4f1fa',
  sub: '#a49fb2',
  good: '#ffcf3f',
  ok: '#e9e4f2',
  bad: '#7a7f99',
  drumFace: '#efe3cf',
  drumRim: '#7b3a2a',
};

const JUDGE_TEXT: Record<Judge, string> = { good: '良', ok: '可', bad: '不可' };

interface Popup { text: string; color: string; t: number }
interface Flash { kind: HitKind; side: 'L' | 'R'; t: number }

export interface Layout {
  w: number;
  h: number;
  laneY: number;
  laneH: number;
  judgeX: number;
  drumX: number;
  drumY: number;
  drumR: number;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private popups: Popup[] = [];
  private flashes: Flash[] = [];
  layout!: Layout;
  /** ハイスピード倍率 */
  speed = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const laneH = Math.max(64, Math.min(130, h * 0.16, w * 0.22));
    const laneY = Math.max(70, h * 0.14);
    const judgeX = Math.max(70, Math.min(160, w * 0.16));
    const below = laneY + laneH;
    const drumR = Math.max(60, Math.min((h - below) * 0.38, w * 0.4));
    this.layout = { w, h, laneY, laneH, judgeX, drumX: w / 2, drumY: below + (h - below) / 2, drumR };
  }

  pushJudge(j: Judge) {
    this.popups.push({ text: JUDGE_TEXT[j], color: COLORS[j], t: performance.now() });
    if (this.popups.length > 4) this.popups.shift();
  }

  pushHit(kind: HitKind, side: 'L' | 'R') {
    this.flashes.push({ kind, side, t: performance.now() });
    if (this.flashes.length > 8) this.flashes.shift();
  }

  /** 1 小節ぶんが画面上で何 px か（狭い画面でも16分が潰れないよう下限あり） */
  private measurePx() {
    const L = this.layout;
    return Math.max((L.w - L.judgeX) * 0.75, L.laneH * 4.8) * this.speed;
  }

  private xOf(time: number, bpm: number, scroll: number, now: number) {
    return this.layout.judgeX + (time - now) * (bpm / 240) * scroll * this.measurePx();
  }

  draw(game: Game, bars: BarLine[], now: number, info: { title: string; course: string }) {
    const { ctx } = this;
    const L = this.layout;
    const wallNow = performance.now();

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, L.w, L.h);

    // ゴーゴータイム判定（直近の過ぎたノーツの gogo を見る）
    let gogo = false;
    for (const s of game.states) {
      if (s.note.time > now) break;
      gogo = s.note.gogo;
    }

    // レーン
    ctx.fillStyle = gogo ? COLORS.laneGogo : COLORS.lane;
    ctx.fillRect(0, L.laneY, L.w, L.laneH);
    ctx.fillStyle = COLORS.laneEdge;
    ctx.fillRect(0, L.laneY - 3, L.w, 3);
    ctx.fillRect(0, L.laneY + L.laneH, L.w, 3);

    const cy = L.laneY + L.laneH / 2;
    const r = L.laneH * 0.27;

    // 叩いたときのレーン発光
    for (const f of this.flashes) {
      const a = 1 - (wallNow - f.t) / 120;
      if (a <= 0) continue;
      ctx.fillStyle = f.kind === 'don' ? `rgba(242,73,58,${0.25 * a})` : `rgba(63,181,224,${0.25 * a})`;
      ctx.fillRect(0, L.laneY, L.judgeX + r * 2, L.laneH);
    }

    // 判定枠
    ctx.strokeStyle = COLORS.judgeRing;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(L.judgeX, cy, r * 1.05, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.arc(L.judgeX, cy, r * 1.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 小節線
    ctx.strokeStyle = COLORS.bar;
    ctx.lineWidth = 2;
    for (const b of bars) {
      const x = this.xOf(b.time, b.bpm, b.scroll, now);
      if (x < L.judgeX - 4 || x > L.w + 4) continue;
      ctx.beginPath();
      ctx.moveTo(x, L.laneY);
      ctx.lineTo(x, L.laneY + L.laneH);
      ctx.stroke();
    }

    // ノーツ（奥＝後のノーツから描く）
    for (let i = game.states.length - 1; i >= 0; i--) {
      const s = game.states[i];
      if (s.done) continue;
      this.drawNote(s.note, now, cy, r, s.count);
    }

    // 判定文字（最新のものだけ）
    const p = this.popups[this.popups.length - 1];
    const age = p ? (wallNow - p.t) / 1000 : Infinity;
    if (p && age <= 0.4) {
      ctx.globalAlpha = 1 - age / 0.4;
      ctx.fillStyle = p.color;
      ctx.font = `bold ${Math.round(L.laneH * 0.24)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(p.text, L.judgeX, L.laneY - 10 - age * 30);
      ctx.globalAlpha = 1;
    }

    this.drawHud(game, info);
    this.drawDrum();
  }

  private drawNote(n: Note, now: number, cy: number, r: number, count: number) {
    const { ctx } = this;
    const L = this.layout;
    const big = n.type === 'bigDon' || n.type === 'bigKa' || n.type === 'bigRoll';
    const rr = big ? r * 1.45 : r;
    let x = this.xOf(n.time, n.bpm, n.scroll, now);

    if (n.type === 'roll' || n.type === 'bigRoll') {
      const x2 = this.xOf(n.endTime ?? n.time, n.bpm, n.scroll, now);
      if (x2 < -rr || x > L.w + rr) return;
      const hx = Math.max(x, L.judgeX);
      ctx.fillStyle = COLORS.roll;
      ctx.fillRect(hx, cy - rr, Math.max(0, x2 - hx), rr * 2);
      this.circle(x2, cy, rr, COLORS.roll);
      this.circle(hx, cy, rr, COLORS.roll);
      return;
    }

    if (n.type === 'balloon') {
      const active = now >= n.time;
      if (active) x = L.judgeX;
      if (x > L.w + rr * 2) return;
      this.circle(x, cy, rr, COLORS.balloon);
      if (active) {
        const left = Math.max(0, (n.hits ?? 5) - count);
        ctx.fillStyle = COLORS.text;
        ctx.font = `bold ${Math.round(rr)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(left), x, cy);
        ctx.textBaseline = 'alphabetic';
      }
      return;
    }

    if (x < -rr || x > L.w + rr) return;
    const color = n.type === 'don' || n.type === 'bigDon' ? COLORS.don : COLORS.ka;
    this.circle(x, cy, rr, color);
  }

  private circle(x: number, y: number, r: number, fill: string) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.84, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  private drawHud(game: Game, info: { title: string; course: string }) {
    const { ctx } = this;
    const L = this.layout;
    const st = game.stats;
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText(info.title, 16, 30);
    ctx.fillStyle = COLORS.sub;
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(info.course, 16, 50);

    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 22px ui-monospace, monospace';
    ctx.fillText(String(st.score).padStart(7, '0'), L.w - 16, 32);
    ctx.fillStyle = COLORS.sub;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`良 ${st.good}  可 ${st.ok}  不可 ${st.bad}  連打 ${st.rolls}`, L.w - 16, 52);

    if (st.combo >= 10) {
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.text;
      ctx.font = `bold ${Math.round(L.laneH * 0.22)}px system-ui, sans-serif`;
      ctx.fillText(String(st.combo), L.judgeX, L.laneY + L.laneH + 30);
    }
  }

  private drawDrum() {
    const { ctx } = this;
    const L = this.layout;
    const now = performance.now();
    const { drumX: x, drumY: y, drumR: r } = L;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.drumRim;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.drumFace;
    ctx.fill();

    for (const f of this.flashes) {
      const a = 1 - (now - f.t) / 150;
      if (a <= 0) continue;
      const start = f.side === 'L' ? Math.PI / 2 : -Math.PI / 2;
      ctx.beginPath();
      if (f.kind === 'don') {
        ctx.moveTo(x, y);
        ctx.arc(x, y, r * 0.72, start, start + Math.PI);
        ctx.fillStyle = `rgba(242,73,58,${0.6 * a})`;
        ctx.fill();
      } else {
        ctx.arc(x, y, r * 0.86, start, start + Math.PI);
        ctx.lineWidth = r * 0.26;
        ctx.strokeStyle = `rgba(63,181,224,${0.7 * a})`;
        ctx.stroke();
      }
    }

    ctx.fillStyle = COLORS.sub;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('内側タップ＝ドン / 外側＝カッ　キー: F J＝ドン D K＝カッ', x, Math.min(L.h - 10, y + r + 22));
  }
}
