import { describe, expect, it } from 'vitest';

/**
 * 時計（AudioEngine.now）のテスト。実機の AudioContext の代わりに、時刻を進められる偽物を使う。
 * スマホでは「いま聞こえている音の時刻」がブロック単位でしか進まず、ときどき外れた値も返ってくる。
 * それでも時計が数 ms 以内に収まり、音が途切れて遅れたときはすぐ追いつくことを確かめる。
 */

let T = 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => T * 1000 }, configurable: true });

interface Cond { latency: number; block: number; noise: number; glitchAt?: number; glitch?: number }

function install(c: Cond) {
  const lat = () => c.latency + (c.glitchAt !== undefined && T > c.glitchAt ? c.glitch ?? 0 : 0);
  const node = () => ({
    gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} },
    connect() { return this; },
    disconnect() {},
  });
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    sampleRate = 48000;
    destination = {};
    state = 'running';
    outputLatency = 0.03;
    baseLatency = 0.01;
    get currentTime() { return Math.floor(T / c.block) * c.block; }
    getOutputTimestamp() {
      const L = lat();
      const ctxT = Math.floor((T - L) / c.block) * c.block;
      const noise = Math.random() < 0.3 ? (Math.random() * 2 - 1) * c.noise : 0;
      return { contextTime: ctxT + noise, performanceTime: (ctxT + L) * 1000 };
    }
    createGain() { return node(); }
    async resume() {}
  };
  return lat;
}

async function simulate(c: Cond, seconds: number) {
  const lat = install(c);
  const { AudioEngine } = await import('./audio');
  const a = new AudioEngine();
  T = 10;
  await a.startAt(-2, 1);
  const startedAt = (a as unknown as { startedAt: number }).startedAt;
  const out: { t: number; err: number }[] = [];
  for (let i = 0; i < seconds * 240; i++) {
    T += 1 / 240;
    const err = (a.now() - (-2 + (T - lat() - startedAt))) * 1000;
    if (T - 10 > 3) out.push({ t: T, err });
  }
  return out;
}

describe('時計', () => {
  it('再生位置が 20ms 刻みで、ときどき ±30ms 外れても、ずれは ±8ms 以内', async () => {
    const r = await simulate({ latency: 0.12, block: 0.02, noise: 0.03 }, 40);
    expect(Math.max(...r.map((x) => Math.abs(x.err)))).toBeLessThan(8);
  });

  it('途中で音が 60ms 遅れても、2 秒以内に 10ms 以内まで追いつく', async () => {
    const r = await simulate({ latency: 0.12, block: 0.02, noise: 0.03, glitchAt: 30, glitch: 0.06 }, 40);
    const lastBad = Math.max(30, ...r.filter((x) => Math.abs(x.err) > 10).map((x) => x.t));
    expect(lastBad - 30).toBeLessThan(2);
  });
});
