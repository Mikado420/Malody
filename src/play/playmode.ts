import type { AudioEngine } from '../audio/audio';
import type { Course } from '../chart/types';
import { Game } from '../engine/game';
import { bindInput } from '../input';
import { Renderer } from '../render/renderer';

export interface PlaySettings {
  speed: number;
  /** 判定オフセット（ms）。＋で判定を遅らせる */
  offset: number;
  /** オート（譜面確認用に自動で叩く） */
  auto?: boolean;
}

/**
 * テストプレイ画面。エディタの上に重ねて表示する。
 */
export class PlayMode {
  private readonly renderer: Renderer;
  private game: Game | null = null;
  private raf = 0;
  private active = false;
  onExit: () => void = () => {};

  constructor(
    private readonly root: HTMLElement,
    canvas: HTMLCanvasElement,
    private readonly result: HTMLElement,
    private readonly audio: AudioEngine,
    private readonly settings: PlaySettings,
  ) {
    this.renderer = new Renderer(canvas);
    bindInput(
      canvas,
      () => {
        const L = this.renderer.layout;
        return { x: L.drumX, y: L.drumY, r: L.drumR, top: L.laneY + L.laneH };
      },
      (kind, side) => {
        if (!this.active || !this.game) return;
        this.audio.playHit(kind);
        this.renderer.pushHit(kind, side);
        this.game.hit(kind, this.time());
      },
    );
    window.addEventListener('keydown', (e) => {
      if (this.active && e.code === 'Escape') this.finish();
    });
  }

  get isActive() {
    return this.active;
  }

  private time() {
    return this.audio.now() - this.settings.offset / 1000;
  }

  /** fromTime 秒の位置から（2秒前から助走して）開始 */
  async start(course: Course, fromTime: number, info: { title: string; course: string; level: number }) {
    const from = Math.max(fromTime, (course.notes[0]?.time ?? 0) - 1);
    const notes = course.notes.filter((n) => (n.endTime ?? n.time) >= from - 0.05);
    const game = new Game(notes);
    game.onJudge = (e) => this.renderer.pushJudge(e);
    game.onRoll = (st) => this.renderer.pushRoll(st);
    this.renderer.reset();
    this.game = game;

    this.root.classList.remove('hidden');
    this.result.classList.add('hidden');
    this.renderer.resize();
    this.renderer.speed = this.settings.speed;
    this.active = true;
    await this.audio.startAt(from - 2, 1);

    const lastTime = Math.max(from, ...notes.map((n) => n.endTime ?? n.time));
    const endAt = Math.max(lastTime + 2, Math.min(this.audio.musicDuration, lastTime + 4));

    this.autoIdx = 0;
    this.autoRoll = -1;
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.active) return;
      const now = this.time();
      if (this.settings.auto) this.autoPlay(game, now);
      game.update(now);
      this.renderer.draw(game, course, now, info);
      if (now > endAt || (game.finished && now > lastTime + 1.5)) {
        this.finish();
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private autoIdx = 0;
  private autoRoll = -1;
  private autoSide: 'L' | 'R' = 'L';

  private autoHit(game: Game, kind: 'don' | 'ka', at: number) {
    this.autoSide = this.autoSide === 'L' ? 'R' : 'L';
    this.audio.playHit(kind);
    this.renderer.pushHit(kind, this.autoSide);
    game.hit(kind, at);
  }

  private autoPlay(game: Game, now: number) {
    const st = game.states;
    while (this.autoIdx < st.length && st[this.autoIdx].note.time <= now) {
      const s = st[this.autoIdx++];
      const t = s.note.type;
      if (s.done) continue;
      if (t === 'don' || t === 'bigDon') this.autoHit(game, 'don', s.note.time);
      else if (t === 'ka' || t === 'bigKa') this.autoHit(game, 'ka', s.note.time);
    }
    // 連打・風船は 1 秒に 15 回
    for (const s of st) {
      const n = s.note;
      if (n.time > now) break;
      if (s.done || n.endTime === undefined || now > n.endTime) continue;
      if (now - this.autoRoll >= 1 / 15) {
        this.autoRoll = now;
        this.autoHit(game, 'don', now);
      }
      break;
    }
  }

  finish() {
    if (!this.active) return;
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.audio.stop();
    const g = this.game;
    if (!g) return;
    const s = g.stats;
    const total = g.totalHitNotes || 1;
    const acc = ((s.good + s.ok * 0.5) / total) * 100;
    const rows: [string, string][] = [
      ['スコア', String(s.score)],
      ['良', String(s.good)],
      ['可', String(s.ok)],
      ['不可', String(s.bad)],
      ['最大コンボ', String(s.maxCombo)],
      ['連打', String(s.rolls)],
      ['精度', `${acc.toFixed(2)}%`],
    ];
    this.result.querySelector('dl')!.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    this.result.classList.remove('hidden');
  }

  close() {
    this.finish();
    this.root.classList.add('hidden');
    this.result.classList.add('hidden');
    this.onExit();
  }
}
