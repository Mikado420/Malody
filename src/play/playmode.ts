import type { AudioEngine } from '../audio/audio';
import type { Course } from '../chart/types';
import { Game } from '../engine/game';
import { bindInput } from '../input';
import { Renderer } from '../render/renderer';

export interface PlaySettings {
  speed: number;
  /** 判定オフセット（ms）。＋で判定を遅らせる */
  offset: number;
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
  async start(course: Course, fromTime: number, info: { title: string; course: string }) {
    const from = Math.max(fromTime, (course.notes[0]?.time ?? 0) - 1);
    const notes = course.notes.filter((n) => (n.endTime ?? n.time) >= from - 0.05);
    const game = new Game(notes);
    game.onJudge = (e) => this.renderer.pushJudge(e.judge);
    this.game = game;

    this.root.classList.remove('hidden');
    this.result.classList.add('hidden');
    this.renderer.resize();
    this.renderer.speed = this.settings.speed;
    this.active = true;
    await this.audio.startAt(from - 2, 1);

    const lastTime = Math.max(from, ...notes.map((n) => n.endTime ?? n.time));
    const endAt = Math.max(lastTime + 2, Math.min(this.audio.musicDuration, lastTime + 4));

    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.active) return;
      const now = this.time();
      game.update(now);
      this.renderer.draw(game, course.bars, now, info);
      if (now > endAt || (game.finished && now > lastTime + 1.5)) {
        this.finish();
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
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
