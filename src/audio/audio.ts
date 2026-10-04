/**
 * Web Audio まわり。ゲーム内の時刻は「曲の再生位置（秒）」で統一し、
 * AudioContext.currentTime から計算するので映像と音がずれにくい。
 */
/** 打音の種類（balloon = 風船が割れた音） */
export type HitSound = 'don' | 'ka' | 'balloon';

export class AudioEngine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private music: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0; // 再生を開始した ctx 時刻
  private readonly musicGain = this.ctx.createGain();
  private readonly sfxGain = this.ctx.createGain();

  constructor() {
    this.musicGain.connect(this.ctx.destination);
    this.sfxGain.connect(this.ctx.destination);
    this.musicGain.gain.value = 0.8;
    this.sfxGain.gain.value = 0.9;
  }

  async loadMusic(buf: ArrayBuffer | null) {
    this.music = buf ? await this.ctx.decodeAudioData(buf) : null;
  }

  get buffer() {
    return this.music;
  }

  get hasMusic() {
    return this.music !== null;
  }

  get musicDuration() {
    return this.music?.duration ?? 0;
  }

  /** leadIn 秒後に曲の 0 秒が来るように再生開始 */
  async start(leadIn: number) {
    await this.startAt(-leadIn, 1);
  }

  /**
   * 曲の songTime 秒の位置から rate 倍速で再生（songTime が負なら、その分待ってから曲が始まる）
   */
  async startAt(songTime: number, rate = 1) {
    await this.ctx.resume();
    this.stop();
    this.rate = rate;
    this.songStart = songTime;
    this.startedAt = this.ctx.currentTime + 0.03;
    this.samples = [];
    this.sampleCount = 0;
    this.bigDiffCount = 0;
    this.lastSample = -Infinity;
    this.perfZero = this.perfZeroCandidate() ?? performance.now() + 30;
    this.playing = true;
    if (this.music && songTime < this.music.duration) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.music;
      src.playbackRate.value = rate;
      src.connect(this.musicGain);
      src.start(this.startedAt + Math.max(0, -songTime) / rate, Math.max(0, songTime));
      this.source = src;
    }
  }

  /** 曲の songTime 秒の位置で鳴るように、クリック音を予約する（タイミング調整用） */
  scheduleTick(songTime: number) {
    const when = this.startedAt + (songTime - this.songStart) / this.rate;
    if (when < this.ctx.currentTime) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = 1500;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.35, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.06);
    osc.connect(g).connect(this.sfxGain);
    osc.start(when);
    osc.stop(when + 0.07);
    this.scheduled.push(osc);
  }

  private scheduled: AudioScheduledSourceNode[] = [];

  stop() {
    this.playing = false;
    for (const n of this.scheduled) {
      try { n.stop(); } catch { /* 停止済み */ }
    }
    this.scheduled = [];
    if (this.source) {
      try { this.source.stop(); } catch { /* 既に停止済み */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  /**
   * 現在の曲の再生位置（秒）。perfMs は performance.now() 基準の時刻（イベントの timeStamp も同じ基準）。
   *
   * 時計は「端末の高精度タイマー（performance.now）」で進め、音の再生位置はそのずれを少しずつ直すのにだけ使う。
   * 音の再生位置（AudioContext の currentTime / getOutputTimestamp）は端末によって 10〜40ms 刻みでしか進まなかったり、
   * 値が行ったり来たりするので、そのまま使うと判定が数十 ms 単位でぶれて、正確に叩いても可・不可になることがある。
   */
  now(perfMs = performance.now()): number {
    this.refineClock();
    return this.songStart + ((perfMs - this.perfZero) / 1000) * this.rate;
  }

  /** ctx の startedAt の音が実際に聞こえる performance.now() の時刻（ms） */
  private perfZero = 0;
  private samples: number[] = [];
  private lastSample = -Infinity;

  /** いまの音の再生位置から求めた perfZero の候補。使える値がないときは null */
  private perfZeroCandidate(): number | null {
    const perf = performance.now();
    const heard = this.heardContextTime(perf);
    if (heard === null) return null;
    return perf + (this.startedAt - heard) * 1000;
  }

  /** 再生開始から何回照らし合わせたか（最初のうちはすぐ合わせる） */
  private sampleCount = 0;
  private bigDiffCount = 0;

  /**
   * 0.1 秒ごとに音の再生位置と照らし合わせて、時計のずれを直す。
   * - 直近 11 回（約 1 秒）の、外れ値を除いた平均を使うので、たまに外れた値が来ても影響しない
   * - 再生開始から 2 秒間はすぐ合わせる
   * - それ以降、15ms 未満のずれは 0.1 秒あたり 1ms ずつ寄せる（判定や見た目が細かく揺れない）
   * - 15ms 以上のずれ（音が一瞬止まって曲が遅れた等）は 0.1 秒ごとに 25% ずつ素早く寄せる
   * - 0.1 秒以上のずれが続いたとき（アプリに戻ってきた等）は一気に合わせる
   */
  private refineClock() {
    if (!this.playing) return;
    const perf = performance.now();
    if (perf - this.lastSample < 100) return;
    this.lastSample = perf;
    const c = this.perfZeroCandidate();
    if (c === null) return;
    this.samples.push(c);
    if (this.samples.length > 11) this.samples.shift();
    this.sampleCount++;
    // 外れ値に強い平均: 大きい側・小さい側の 1/4 ずつを捨てて、真ん中の値を平均する
    const sorted = [...this.samples].sort((a, b) => a - b);
    const cut = Math.floor(sorted.length / 4);
    const mid = sorted.slice(cut, sorted.length - cut);
    const med = mid.reduce((a, b) => a + b, 0) / mid.length;
    const diff = med - this.perfZero;
    if (this.sampleCount <= 20) {
      this.perfZero = med;
      return;
    }
    this.bigDiffCount = Math.abs(diff) > 100 ? this.bigDiffCount + 1 : 0;
    if (this.bigDiffCount >= 3) {
      this.perfZero = med;
      this.bigDiffCount = 0;
    } else if (Math.abs(diff) >= 15) {
      this.perfZero += diff * 0.25;
    } else {
      this.perfZero += Math.max(-1, Math.min(1, diff));
    }
  }

  /** 一度でも getOutputTimestamp の正しい値が取れたら、以後はそれだけを使う（方式を混ぜると値が跳ぶ） */
  private tsReliable = false;

  /**
   * perfMs の時点でスピーカーから聞こえている音の ctx 時刻（の推定）。使える値がないときは null。
   * - getOutputTimestamp() があれば「いま出力されている音の ctx 時刻」と「その時刻」の組から求める（出力の遅れを含む）
   * - なければ currentTime から端末が申告している出力の遅れを引く
   */
  private heardContextTime(perfMs: number): number | null {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime && ts.performanceTime > 0 && ts.contextTime) {
      const off = ts.contextTime - ts.performanceTime / 1000;
      // 明らかにおかしい値（出力の遅れがマイナス、または 0.5 秒以上）は使わない
      const lat = this.ctx.currentTime - (performance.now() / 1000 + off);
      if (lat > -0.05 && lat < 0.5) {
        if (!this.tsReliable) {
          // ここから getOutputTimestamp の値だけを使う。それまでの別方式の値は捨てる
          this.tsReliable = true;
          this.samples = [];
          this.sampleCount = 0;
        }
        this.clockMode = 'outputTimestamp';
        return perfMs / 1000 + off;
      }
    }
    if (this.tsReliable) return null;
    this.clockMode = 'outputLatency';
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return this.ctx.currentTime - latency - (performance.now() - perfMs) / 1000;
  }

  private clockMode: 'outputTimestamp' | 'outputLatency' = 'outputLatency';

  /** 診断用: 時計の方式と、推定している出力の遅れ（ms） */
  clockInfo() {
    const lat = this.ctx.currentTime - (this.startedAt + (performance.now() - this.perfZero) / 1000);
    return {
      mode: this.clockMode,
      latencyMs: Math.round(lat * 1000),
      outputLatencyMs: Math.round((this.ctx.outputLatency || 0) * 1000),
      baseLatencyMs: Math.round((this.ctx.baseLatency || 0) * 1000),
    };
  }

  playing = false;
  private rate = 1;
  private songStart = 0;

  /** 曲が無いとき用のメトロノーム音 */
  playTick(strong: boolean) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = strong ? 1600 : 1000;
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    osc.connect(g).connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  // ---------- 打音 ----------
  // 叩くたびに音を合成すると、速く叩いたときに端末の負荷で音が途切れることがあるので、
  // 打音は最初に一度だけ AudioBuffer にしておき、叩くたびにそれを鳴らすだけにする。

  private hitBuffers: Record<HitSound, AudioBuffer | null> = { don: null, ka: null, balloon: null };
  private customHit: Record<HitSound, AudioBuffer | null> = { don: null, ka: null, balloon: null };
  private voices: Record<'don' | 'ka', { src: AudioBufferSourceNode; g: GainNode }[]> = { don: [], ka: [] };

  /** 自分で用意した打音（ogg / mp3 / wav など）。null で内蔵の音に戻す */
  async setCustomHit(kind: HitSound, data: ArrayBuffer | null) {
    this.customHit[kind] = data ? await this.ctx.decodeAudioData(data.slice(0)) : null;
  }

  hasCustomHit(kind: HitSound) {
    return this.customHit[kind] !== null;
  }

  /** 内蔵の打音（オリジナルの合成音）を AudioBuffer として作る */
  private builtinHit(kind: HitSound): AudioBuffer {
    const cached = this.hitBuffers[kind];
    if (cached) return cached;
    const sr = this.ctx.sampleRate;
    if (kind === 'balloon') {
      // 風船が割れる音（短い雑音）
      const len = Math.round(sr * 0.18);
      const buf = this.ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / sr / 0.03) * 0.9;
      this.hitBuffers.balloon = buf;
      return buf;
    }
    const len = Math.round(sr * (kind === 'don' ? 0.22 : 0.1));
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      if (kind === 'don') {
        const f = 60 + 100 * Math.exp(-t / 0.035); // 160Hz → 60Hz
        phase += (2 * Math.PI * f) / sr;
        d[i] = Math.sin(phase) * Math.exp(-t / 0.05) * 0.95;
      } else {
        const f = 700 + 500 * Math.exp(-t / 0.012);
        phase += (2 * Math.PI * f) / sr;
        const tri = (2 / Math.PI) * Math.asin(Math.sin(phase));
        d[i] = (tri * 0.45 + (Math.random() * 2 - 1) * 0.15) * Math.exp(-t / 0.022);
      }
    }
    this.hitBuffers[kind] = buf;
    return buf;
  }

  private lastScheduled: Partial<Record<HitSound, { g: GainNode; end: number }>> = {};

  /**
   * 曲の時刻 songTime ちょうどに打音を鳴らす予約（オートで音符の位置に正確に鳴らす）。
   * 同じ種類の前の音がまだ鳴っていれば、新しい音の瞬間に素早く消す（連打で音が重なりすぎないように）
   */
  scheduleHit(kind: HitSound, songTime: number) {
    const ctx = this.ctx;
    const when = this.startedAt + (songTime - this.songStart) / this.rate;
    if (when < ctx.currentTime - 0.005) return;
    const at = Math.max(when, ctx.currentTime);
    const prev = this.lastScheduled[kind];
    if (prev && prev.end > at) prev.g.gain.setTargetAtTime(0, at, 0.006);
    const src = ctx.createBufferSource();
    src.buffer = this.customHit[kind] ?? this.builtinHit(kind);
    const g = ctx.createGain();
    src.connect(g).connect(this.sfxGain);
    src.start(at);
    this.lastScheduled[kind] = { g, end: at + src.buffer.duration };
    this.scheduled.push(src);
    src.onended = () => {
      const i = this.scheduled.indexOf(src);
      if (i >= 0) this.scheduled.splice(i, 1);
      src.disconnect();
      g.disconnect();
    };
  }

  /** 叩いた音。同じ種類の音は同時に 4 つまで（古いものから素早く消す） */
  playHit(kind: 'don' | 'ka') {
    const ctx = this.ctx;
    if (ctx.state !== 'running') void ctx.resume();
    const t = ctx.currentTime;
    const list = this.voices[kind];
    while (list.length >= 4) {
      const old = list.shift()!;
      old.g.gain.setTargetAtTime(0, t, 0.005);
      try { old.src.stop(t + 0.03); } catch { /* 停止済み */ }
    }
    const src = ctx.createBufferSource();
    src.buffer = this.customHit[kind] ?? this.builtinHit(kind);
    const g = ctx.createGain();
    src.connect(g).connect(this.sfxGain);
    src.start(t);
    const v = { src, g };
    list.push(v);
    src.onended = () => {
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1);
      src.disconnect();
      g.disconnect();
    };
  }
}
