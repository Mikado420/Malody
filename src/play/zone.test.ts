import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../engine/game';
import { suggestDonWidth, zoneSamples } from './zone';

describe('ドンの帯の幅の提案', () => {
  it('カッのつもりの打撃が帯の内側に入っていたら狭める', () => {
    const s = [
      ...Array.from({ length: 10 }, (_, i) => ({ pos: 0.05 * i * 0.4, don: true })), // 0〜0.18
      ...Array.from({ length: 10 }, (_, i) => ({ pos: 0.4 + i * 0.05, don: false })), // 0.4〜0.85
    ];
    const r = suggestDonWidth(s, 0.6)!;
    expect(r.before).toBeGreaterThan(r.after);
    expect(r.after).toBe(0);
    expect(r.width).toBeGreaterThan(0.18);
    expect(r.width).toBeLessThan(0.4);
  });
  it('今の幅で合っていれば提案しない', () => {
    const s = [{ pos: 0.1, don: true }, { pos: 0.2, don: true }, { pos: 0.7, don: false }, { pos: 0.8, don: false }];
    expect(suggestDonWidth(s, 0.6)).toBeNull();
  });
  it('色違いの見逃しは音符の色を狙っていたとみなす', () => {
    const log: LogEntry[] = [
      { e: 'tap', t: 1, kind: 'ka', res: 'none', ring: 0.9 },
      { e: 'miss', t: 1.01, type: 'don' },
      { e: 'tap', t: 2, kind: 'ka', res: 'judged', ring: 1.5 },
    ];
    const s = zoneSamples(log, 0.6);
    expect(s).toHaveLength(2);
    expect(s[0].don).toBe(true);
    expect(s[0].pos).toBeCloseTo(0.54);
    expect(s[1].don).toBe(false);
  });
});
