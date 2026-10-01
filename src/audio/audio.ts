/**
 * Web Audio まわり。ゲーム内の時刻は「曲の再生位置（秒）」で統一し、
 * AudioContext.currentTime から計算するので映像と音がずれにくい。
 */
export class AudioEngine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private music: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0; // ctx 時刻で「曲の 0 秒」にあたる時刻
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

  get hasMusic() {
    return this.music !== null;
  }

  get musicDuration() {
    return this.music?.duration ?? 0;
  }

  /** leadIn 秒後に曲の 0 秒が来るように再生開始 */
  async start(leadIn: number) {
    await this.ctx.resume();
    this.stop();
    this.startedAt = this.ctx.currentTime + leadIn;
    if (this.music) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.music;
      src.connect(this.musicGain);
      src.start(this.startedAt);
      this.source = src;
    }
  }

  stop() {
    if (this.source) {
      try { this.source.stop(); } catch { /* 既に停止済み */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  /** 現在の曲の再生位置（秒）。出力遅延を補正 */
  now(): number {
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return this.ctx.currentTime - this.startedAt - latency;
  }

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
