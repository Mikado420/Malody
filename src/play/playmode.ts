import type { AudioEngine } from '../audio/audio';
import type { Course } from '../chart/types';
import { Game } from '../engine/game';
import { bindInput, touchStats } from '../input';
import { Renderer } from '../render/renderer';
import { BUILD_ID } from '../update';
import { suggestDonWidth, zoneSamples } from './zone';

export interface PlaySettings {
  speed: number;
  /** 判定オフセット（ms）。＋で判定を遅らせる */
  offset: number;
  /** オート（譜面確認用に自動で叩く） */
  auto?: boolean;
  /** タッチ用: 中央のドンの帯の幅（画面の幅に対する割合） */
  donWidth?: number;
  /** 叩くたびにずれ（ms）を表示する */
  showTiming?: boolean;
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
      root,
      canvas,
      () => {
        const L = this.renderer.layout;
        return { x: L.drumX, half: L.drumHalf };
      },
      (kind, side, at, pt) => {
        if (!this.active || !this.game) return;
        this.audio.playHit(kind);
        this.renderer.pushHit(kind, side);
        if (pt) this.renderer.pushTouch(kind, pt.x, pt.y);
        // 叩いた瞬間の時刻で判定（処理が遅れてもずれない）
        const r = this.game.hit(kind, this.time(at), pt?.ring);
        if (this.settings.showTiming) {
          const ms = (d: number) => `${d > 0 ? '+' : ''}${Math.round(d * 1000)}ms`;
          if (r.type === 'judged') this.renderer.pushTiming(ms(r.delta), r.delta > 0 ? '#ffb070' : '#8fd0ff');
          else if (r.type === 'big') this.renderer.pushTiming('大音符の2打目', '#ffe25a');
          else if (r.type === 'roll') this.renderer.pushTiming('連打', '#ffe25a');
          else if (r.type === 'none') {
            if (r.wrongColor && r.nearest === null) this.renderer.pushTiming('色違い', '#c0c0c0');
            else if (r.nearest !== null) this.renderer.pushTiming(`判定なし ${ms(r.nearest)}`, '#ff6b6b');
            else this.renderer.pushTiming('近くに音符なし', '#c0c0c0');
          }
        }
      },
    );
    window.addEventListener('keydown', (e) => {
      if (this.active && e.code === 'Escape') this.finish();
    });
  }

  get isActive() {
    return this.active;
  }

  private time(perfMs = performance.now()) {
    return this.audio.now(perfMs) - this.settings.offset / 1000;
  }

  /** タイミング調整の測定中か */
  private calibrating = false;

  /**
   * タイミング調整: 0.6 秒おきのドンに合わせてクリック音を鳴らし、叩いたずれを測る。
   * 音符の間隔が広いので、端末の音の遅れが ±300ms あっても別の音符と取り違えずに測れる。
   */
  async startCalibration() {
    const N = 24;
    const notes = Array.from({ length: N }, (_, i) => ({
      type: 'don' as const, time: 1 + i * 0.6, bpm: 100, scroll: 1, gogo: false,
    }));
    const bars = Array.from({ length: Math.ceil(N / 4) + 1 }, (_, i) => ({ time: 1 + i * 2.4, bpm: 100, scroll: 1 }));
    this.calibrating = true;
    await this.start(
      { name: 'Oni', level: 0, notes, bars, gogo: [] },
      1,
      { title: 'タイミング調整（クリック音に合わせて叩いてください）', course: 'Oni', level: 0 },
      notes.map((n) => n.time),
    );
  }

  /** fromTime 秒の位置から（2秒前から助走して）開始。clicks を渡すとその時刻にクリック音を鳴らす */
  async start(course: Course, fromTime: number, info: { title: string; course: string; level: number }, clicks?: number[]) {
    if (!clicks) this.calibrating = false;
    const from = Math.max(fromTime, (course.notes[0]?.time ?? 0) - 1);
    const notes = course.notes.filter((n) => (n.endTime ?? n.time) >= from - 0.05);
    const game = new Game(notes);
    game.onJudge = (e) => this.renderer.pushJudge(e);
    game.onRoll = (st) => this.renderer.pushRoll(st);
    this.renderer.reset();
    this.renderer.donWidth = this.settings.donWidth ?? 0.6;
    touchStats.starts = 0;
    touchStats.recovered = 0;
    this.game = game;

    this.root.classList.remove('hidden');
    this.result.classList.add('hidden');
    this.renderer.resize();
    this.renderer.speed = this.settings.speed;
    this.active = true;
    await this.audio.startAt(from - 2, 1);
    for (const t of clicks ?? []) this.audio.scheduleTick(t);

    const lastTime = Math.max(from, ...notes.map((n) => n.endTime ?? n.time));
    const endAt = Math.max(lastTime + 2, Math.min(this.audio.musicDuration, lastTime + 4));

    this.autoIdx = 0;
    this.autoRoll = -1;
    cancelAnimationFrame(this.raf);
    this.perf = { frames: 0, work: 0, workMax: 0, gapMax: 0, slow: 0, last: 0 };
    const loop = () => {
      if (!this.active) return;
      const t0 = performance.now();
      const P = this.perf;
      if (P.last) {
        const gap = t0 - P.last;
        if (gap > P.gapMax) P.gapMax = gap;
        if (gap > 34) P.slow++;
      }
      P.last = t0;
      const now = this.time();
      if (this.settings.auto && !this.calibrating) this.autoPlay(game, now);
      game.update(now);
      this.renderer.draw(game, course, now, info);
      const w = performance.now() - t0;
      P.frames++;
      P.work += w;
      if (w > P.workMax) P.workMax = w;
      if (now > endAt || (game.finished && now > lastTime + 1.5)) {
        this.finish();
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** 描画の重さの記録（結果画面の診断用） */
  perf = { frames: 0, work: 0, workMax: 0, gapMax: 0, slow: 0, last: 0 };

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
    if (this.calibrating) {
      this.showCalibration(g);
      return;
    }
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
    // 叩いたタイミングのずれ（オートのときは出さない）。
    // 判定幅の外だった打撃も含めて中央値を取るので、端末の音の遅れが 114ms より大きくても調整できる
    const calib = this.result.querySelector<HTMLElement>('.calib')!;
    calib.classList.add('hidden');
    if (!this.settings.auto) {
      const T = g.taps;
      const all = [...g.deltas, ...g.outside].sort((a, b) => a - b);
      rows.push(['叩いた回数', `${T.total}（判定 ${T.judged}・連打 ${T.roll + T.big}）`]);
      if (T.none > 0) {
        const out = g.outside;
        const outMean = out.length ? Math.round((out.reduce((a, b) => a + b, 0) / out.length) * 1000) : 0;
        const parts = [];
        if (out.length) parts.push(`判定幅の外 ${out.length}（平均 ${outMean > 0 ? '+' : ''}${outMean}ms）`);
        if (T.wrongColor) parts.push(`色違い ${T.wrongColor}`);
        const rest = T.none - out.length - T.wrongColor;
        if (rest > 0) parts.push(`近くに音符なし ${rest}`);
        rows.push(['判定されなかった', `${T.none}：${parts.join('・')}`]);
      }
      if (all.length >= 8) {
        const med = all[Math.floor(all.length / 2)];
        const mean = g.deltas.length ? g.deltas.reduce((a, b) => a + b, 0) / g.deltas.length : med;
        const sd = g.deltas.length
          ? Math.sqrt(g.deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / g.deltas.length)
          : 0;
        const ms = Math.round(med * 1000);
        rows.push(['ずれ（中央値）', `${ms > 0 ? '+' : ''}${ms}ms（${Math.abs(ms) <= 5 ? 'ちょうど' : ms > 0 ? '遅め' : '早め'}）`]);
        if (g.deltas.length) rows.push(['ばらつき', `±${Math.round(sd * 1000)}ms`]);
        this.suggested = Math.round(this.settings.offset + med * 1000);
        if (Math.abs(ms) > 5) {
          calib.classList.remove('hidden');
          calib.querySelector('button')!.textContent = `判定調整を ${this.suggested}ms にする（今は ${this.settings.offset}ms）`;
        }
      }
    }
    // 見逃しの内訳（その音符の前後 114ms に何が起きていたか）
    if (!this.settings.auto) {
      const taps = g.log.filter((x) => x.e === 'tap') as Extract<typeof g.log[number], { e: 'tap' }>[];
      const misses = g.log.filter((x) => x.e === 'miss') as Extract<typeof g.log[number], { e: 'miss' }>[];
      if (misses.length) {
        let wrong = 0;
        let stolen = 0;
        let none = 0;
        const rings: number[] = [];
        for (const m of misses) {
          const isDonNote = m.type === 'don' || m.type === 'bigDon';
          const near = taps.filter((t) => Math.abs(t.t - m.t) <= 0.114);
          const other = near.find((t) => (t.kind === 'don') !== isDonNote);
          const same = near.find((t) => (t.kind === 'don') === isDonNote);
          if (other) {
            wrong++;
            if (other.ring !== undefined) rings.push(other.ring);
          } else if (same) stolen++;
          else none++;
        }
        const parts = [];
        if (wrong) {
          const avg = rings.length ? `、ドンの帯の端からの位置 平均 ${(rings.reduce((a, b) => a + b, 0) / rings.length).toFixed(2)}` : '';
          parts.push(`色違いで叩いた ${wrong}${avg}`);
        }
        if (stolen) parts.push(`同じ色で叩いたが別の音符に使われた ${stolen}`);
        if (none) parts.push(`近くで叩いていない ${none}`);
        rows.push(['見逃し', `${misses.length}：${parts.join('・')}`]);
      }
    }
    // 不具合を調べるための情報
    const c = this.audio.clockInfo();
    rows.push([
      '音の遅れ（推定）',
      `${c.latencyMs}ms（${c.mode === 'outputTimestamp' ? '再生位置から' : '端末の申告値'}、申告 ${c.outputLatencyMs}/${c.baseLatencyMs}ms）`,
    ]);
    if (touchStats.starts + touchStats.recovered > 0) {
      rows.push(['タッチ', `${touchStats.starts}（取りこぼしを補った ${touchStats.recovered}）`]);
    }
    const P = this.perf;
    if (P.frames) {
      rows.push([
        '描画',
        `1コマ平均 ${(P.work / P.frames).toFixed(1)}ms・最大 ${P.workMax.toFixed(0)}ms／コマ落ち ${P.slow}回（最長 ${P.gapMax.toFixed(0)}ms）`,
      ]);
    }
    rows.push(['判定調整', `${this.settings.offset}ms`]);
    rows.push(['バージョン', BUILD_ID.slice(0, 7)]);
    this.lastLog = this.logText(g);
    // 叩いた位置から、ドンの帯のちょうどいい幅を提案する
    const cur = this.settings.donWidth ?? 0.6;
    const sug = this.settings.auto ? null : suggestDonWidth(zoneSamples(g.log, cur), cur);
    this.suggestedDonWidth = sug ? sug.width : null;
    const hint = this.result.querySelector<HTMLElement>('.edgehint');
    if (hint) {
      hint.classList.toggle('hidden', !sug);
      if (sug) {
        hint.querySelector('p')!.textContent = `叩いた位置を見ると、ドンの帯（中央）の幅を変えると色の取り違えが ${sug.before} 回 → ${sug.after} 回に減ります。`;
        hint.querySelector('button')!.textContent = `ドンの幅を ${Math.round(sug.width * 100)}% にする（今 ${Math.round(cur * 100)}%）`;
      }
    }
    this.result.querySelector('h2')!.textContent = '結果';
    this.result.querySelector('dl')!.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    this.result.classList.remove('hidden');
  }

  /** 結果画面で提案する判定調整の値（ms） */
  suggested = 0;

  /** 結果画面で提案するドンの帯の幅（提案がなければ null） */
  suggestedDonWidth: number | null = null;

  /** 直前のプレイの記録（「ログをコピー」で使う） */
  lastLog = '';

  private logText(g: Game): string {
    const f = (t: number) => t.toFixed(3);
    const lines = [`version ${BUILD_ID.slice(0, 7)} offset ${this.settings.offset}ms ua ${navigator.userAgent}`];
    for (const x of g.log) {
      if (x.e === 'miss') lines.push(`${f(x.t)} MISS ${x.type}`);
      else {
        const j = x.res === 'judged' ? ` ${x.judge} note=${f(x.note!)} (${Math.round((x.t - x.note!) * 1000)}ms)` : ` ${x.res}`;
        lines.push(`${f(x.t)} tap ${x.kind}${j}${x.ring !== undefined ? ` ring=${x.ring.toFixed(2)}` : ''}`);
      }
    }
    return lines.join('\n');
  }

  private showCalibration(g: Game) {
    const all = [...g.deltas, ...g.outside].filter((d) => Math.abs(d) < 0.3).sort((a, b) => a - b);
    const calib = this.result.querySelector<HTMLElement>('.calib')!;
    const rows: [string, string][] = [['叩いた回数', `${g.taps.total}（測れた ${all.length}）`]];
    if (all.length >= 8) {
      // 外れ値に強いよう、中央付近の半分の平均を使う
      const q = all.slice(Math.floor(all.length / 4), Math.ceil((all.length * 3) / 4));
      const mid = q.reduce((a, b) => a + b, 0) / q.length;
      const sd = Math.sqrt(all.reduce((a, b) => a + (b - mid) ** 2, 0) / all.length);
      const ms = Math.round(mid * 1000);
      rows.push(['ずれ', `${ms > 0 ? '+' : ''}${ms}ms（${Math.abs(ms) <= 5 ? 'ちょうど' : ms > 0 ? '遅め' : '早め'}）`]);
      rows.push(['ばらつき', `±${Math.round(sd * 1000)}ms`]);
      this.suggested = Math.round(this.settings.offset + mid * 1000);
      calib.classList.remove('hidden');
      calib.querySelector('button')!.textContent = `判定調整を ${this.suggested}ms にする（今は ${this.settings.offset}ms）`;
    } else {
      rows.push(['結果', '測れた打撃が少ないので、もう一度試してください']);
      calib.classList.add('hidden');
    }
    const c = this.audio.clockInfo();
    rows.push(['音の遅れ（推定）', `${c.latencyMs}ms（${c.mode === 'outputTimestamp' ? '再生位置から' : '端末の申告値'}）`]);
    rows.push(['バージョン', BUILD_ID.slice(0, 7)]);
    this.result.querySelector('h2')!.textContent = 'タイミング調整の結果';
    this.result.querySelector('dl')!.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    this.result.classList.remove('hidden');
  }

  /** 「もう一度」で同じモードをやり直す */
  get lastWasCalibration() {
    return this.calibrating;
  }

  close() {
    this.finish();
    this.root.classList.add('hidden');
    this.result.classList.add('hidden');
    this.onExit();
  }
}
