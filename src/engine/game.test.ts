import { describe, expect, it } from 'vitest';
import type { Note } from '../chart/types';
import { buildAutoEvents } from '../play/auto';
import { CLEAR_LINE, Game, scoreBase } from './game';

const note = (type: Note['type'], time: number, extra: Partial<Note> = {}): Note =>
  ({ type, time, bpm: 120, scroll: 1, gogo: false, ...extra });

/** オートで最後まで叩く（split より前は、途中から始めたときと同じく先に済ませる） */
function play(notes: Note[], split = -Infinity) {
  const g = new Game(notes);
  const ev = buildAutoEvents(notes);
  for (const e of ev) {
    if (e.t >= split) break;
    g.update(e.t);
    g.hit(e.kind, e.t);
  }
  g.update(split);
  for (const e of ev) {
    if (e.t < split) continue;
    g.update(e.t);
    g.hit(e.kind, e.t);
  }
  g.update(1e9);
  return g;
}

describe('点数とゲージ', () => {
  it('初項 = (100 万 − 風船の総打数 × 100) ÷ 最大コンボ数 を 10 の位で切り上げ', () => {
    expect(scoreBase(3, 0)).toBe(333340);
    // (1,000,000 − 2,000) ÷ 800 = 1247.5 → 1250
    expect(scoreBase(800, 20)).toBe(1250);
  });

  it('全部「良」で 最大コンボ × 初項 ＋ 風船の打数 × 100', () => {
    const notes = [note('don', 1), note('ka', 1.5), note('balloon', 2, { endTime: 3, hits: 10 }), note('don', 4)];
    const g = play(notes);
    expect(g.stats.maxCombo).toBe(3);
    expect(g.stats.score).toBe(3 * g.base + 10 * 100);
  });

  it('全部「良」なら 6 割でクリア、7.5 割で満タン', () => {
    const notes = Array.from({ length: 100 }, (_, i) => note('don', 1 + i * 0.25));
    const g = new Game(notes);
    for (let i = 0; i < 100; i++) {
      g.hit('don', notes[i].time);
      if (i === 59) expect(g.stats.gauge).toBeCloseTo(CLEAR_LINE, 6);
      if (i === 74) expect(g.stats.gauge).toBe(100);
    }
  });

  it('途中から始めても、最後のコンボ・点数・ゲージは最初からと同じ', () => {
    const notes = [note('don', 1), note('roll', 1.5, { endTime: 2.5 }), note('ka', 3), note('balloon', 3.5, { endTime: 4.5, hits: 8 }), note('don', 5)];
    const a = play(notes);
    const b = play(notes, 3.95);
    expect(b.stats.maxCombo).toBe(a.stats.maxCombo);
    expect(b.stats.score).toBe(a.stats.score);
    expect(b.stats.gauge).toBe(a.stats.gauge);
  });
});
