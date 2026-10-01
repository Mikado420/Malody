/**
 * Web Audio まわり。ゲーム内の時刻は「曲の再生位置（秒）」で統一し、
 * AudioContext.currentTime から計算するので映像と音がずれにくい。
 */
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
    this.clockOffset = null;
    this.startedAt = this.ctx.currentTime + 0.03;
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

  stop() {
    this.playing = false;
    if (this.source) {
      try { this.source.stop(); } catch { /* 既に停止済み */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  /** 現在の曲の再生位置（秒）。出力遅延を補正 */
  now(perfMs = performance.now()): number {
    return this.songStart + (this.contextTimeAt(perfMs) - this.startedAt) * this.rate;
  }

  /** ctx の時刻と performance.now() の差（なめらかにしたもの） */
  private clockOffset: number | null = null;

  /**
   * perfMs（performance.now() 基準。イベントの timeStamp も同じ基準）の時点で、
   * スピーカーから実際に聞こえている音の ctx 時刻。
   * - getOutputTimestamp() は「いま出力されている音の ctx 時刻」と「その時刻」の組を返すので、出力の遅れが含まれる
   * - currentTime は端末によって 10〜20ms 刻みでしか進まないので、performance.now() に結び付けてなめらかにする
   */
  private contextTimeAt(perfMs: number): number {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime && ts.performanceTime > 0 && ts.contextTime !== undefined) {
      const off = ts.contextTime - ts.performanceTime / 1000;
      if (this.clockOffset === null || Math.abs(off - this.clockOffset) > 0.03) this.clockOffset = off;
      else this.clockOffset += (off - this.clockOffset) * 0.02;
      return perfMs / 1000 + this.clockOffset;
    }
    // 未対応のブラウザ: 報告されている出力遅延を引く
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return this.ctx.currentTime - latency - (performance.now() - perfMs) / 1000;
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

  /** 叩いた音（簡易シンセ。素材差し替え時はここを AudioBuffer 再生に） */
  playHit(kind: 'don' | 'ka') {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    if (kind === 'don') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(160, t);
      osc.frequency.exponentialRampToValueAtTime(60, t + 0.12);
      g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    } else {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200, t);
      osc.frequency.exponentialRampToValueAtTime(700, t + 0.05);
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    }
    osc.connect(g).connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}
