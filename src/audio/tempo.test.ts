import { describe, expect, it } from 'vitest';
import { analyzeTempo, tempoPlan } from './tempo';

const TPB = 6720;

/** 毎回同じ結果になる乱数 */
let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

/** テスト用の曲: 区間ごとの BPM で、1 拍目にキック、2・4 拍目にスネア、8 分でハイハット */
function song(sr: number, first: number, parts: { bpm: number; beats: number }[], tail = 2) {
  let t = first;
  const hits: { t: number; kind: 'kick' | 'snare' | 'hat' }[] = [];
  for (const p of parts) {
    const P = 60 / p.bpm;
    for (let k = 0; k < p.beats; k++) {
      const bt = t + k * P;
      hits.push({ t: bt, kind: k % 4 === 0 ? 'kick' : k % 2 === 1 ? 'snare' : 'hat' });
      hits.push({ t: bt + P / 2, kind: 'hat' });
    }
    t += p.beats * P;
  }
  const len = Math.ceil((t + tail) * sr);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = (rand() * 2 - 1) * 0.01; // 小さな雑音
  for (const h of hits) {
    const i0 = Math.round(h.t * sr);
    const n = Math.round(sr * 0.12);
    for (let i = 0; i < n && i0 + i < len; i++) {
      const tt = i / sr;
      let v = 0;
      if (h.kind === 'kick') v = Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-tt / 0.02)) * tt) * Math.exp(-tt / 0.08) * 0.9;
      else if (h.kind === 'snare') v = (rand() * 2 - 1) * Math.exp(-tt / 0.05) * 0.5 + Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt / 0.04) * 0.3;
      else v = (rand() * 2 - 1) * Math.exp(-tt / 0.015) * 0.25;
      x[i0 + i] += v;
    }
  }
  return x;
}

describe('BPM・OFFSET の自動測定', () => {
  it('一定の BPM と OFFSET', () => {
    const sr = 22050;
    const x = song(sr, 0.734, [{ bpm: 150, beats: 96 }]);
    const r = analyzeTempo(x, sr);
    const plan = tempoPlan(r, TPB)!;
    expect(r.segments.length).toBe(1);
    expect(plan.bpm).toBe(150);
    expect(Math.abs(plan.offset - -0.734)).toBeLessThan(0.006);
    expect(plan.changes.length).toBe(0);
  });

  it('途中で BPM が変わる（150 → 180）。変わり目の位置も合う', () => {
    const sr = 22050;
    const x = song(sr, 0.5, [{ bpm: 150, beats: 64 }, { bpm: 180, beats: 72 }]);
    const r = analyzeTempo(x, sr);
    const plan = tempoPlan(r, TPB)!;
    expect(plan.bpm).toBe(150);
    expect(plan.changes.length).toBe(1);
    expect(plan.changes[0].bpm).toBe(180);
    expect(plan.changes[0].tick).toBe(64 * TPB);
    expect(Math.abs(plan.offset - -0.5)).toBeLessThan(0.006);
  });

  it('小数の BPM（173.5）も区間全体で合わせる', () => {
    const sr = 22050;
    const x = song(sr, 1.1, [{ bpm: 173.5, beats: 120 }]);
    const r = analyzeTempo(x, sr);
    const plan = tempoPlan(r, TPB)!;
    expect(plan.bpm).toBe(173.5);
    // 1.1 秒は 1 小節（4 拍 = 1.383 秒）より短いので、そのまま 1 拍目
    expect(Math.abs(plan.offset - -1.1)).toBeLessThan(0.006);
  });

  it('短い区間だけ BPM が変わる（200 → 130 → 200）。変わり目は前後の拍の合い方を曲全体で比べて決める', () => {
    const sr = 22050;
    const x = song(sr, 1.37, [{ bpm: 200, beats: 64 }, { bpm: 130, beats: 32 }, { bpm: 200, beats: 64 }]);
    const r = analyzeTempo(x, sr);
    const plan = tempoPlan(r, TPB)!;
    // 1 小節 = 1.2 秒なので、最初の 1 拍目は 0.17 秒（音が鳴り始める 1.37 秒の 4 拍前）
    expect(Math.abs(plan.offset - -0.17)).toBeLessThan(0.006);
    expect(plan.changes.map((c) => [c.tick / TPB, c.bpm])).toEqual([[68, 130], [100, 200]]);
  });
});
