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

  // ---------- 打音 ----------
  // 叩くたびに音を合成すると、速く叩いたときに端末の負荷で音が途切れることがあるので、
  // 打音は最初に一度だけ AudioBuffer にしておき、叩くたびにそれを鳴らすだけにする。

  private hitBuffers: Record<'don' | 'ka', AudioBuffer | null> = { don: null, ka: null };
  private customHit: Record<'don' | 'ka', AudioBuffer | null> = { don: null, ka: null };
  private voices: Record<'don' | 'ka', { src: AudioBufferSourceNode; g: GainNode }[]> = { don: [], ka: [] };

  /** 自分で用意した打音（ogg / mp3 / wav など）。null で内蔵の音に戻す */
  async setCustomHit(kind: 'don' | 'ka', data: ArrayBuffer | null) {
    this.customHit[kind] = data ? await this.ctx.decodeAudioData(data.slice(0)) : null;
  }

  hasCustomHit(kind: 'don' | 'ka') {
    return this.customHit[kind] !== null;
  }

  /** 内蔵の打音（オリジナルの合成音）を AudioBuffer として作る */
  private builtinHit(kind: 'don' | 'ka'): AudioBuffer {
    const cached = this.hitBuffers[kind];
    if (cached) return cached;
    const sr = this.ctx.sampleRate;
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
