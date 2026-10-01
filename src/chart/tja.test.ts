import { describe, expect, it } from 'vitest';
import { parseTJA } from './tja';
import { Game } from '../engine/game';

const BASIC = `TITLE:Test
BPM:120
OFFSET:0
COURSE:Oni
LEVEL:8
BALLOON:3

#START
1020,
#BPMCHANGE 240
1000,
5008,
70008000,
#END
`;

describe('parseTJA', () => {
  const chart = parseTJA(BASIC);
  const c = chart.courses[0];

  it('ヘッダを読む', () => {
    expect(chart.title).toBe('Test');
    expect(chart.bpm).toBe(120);
    expect(c.name).toBe('Oni');
    expect(c.level).toBe(8);
  });

  it('ノーツの時刻を計算する', () => {
    // BPM120: 1小節 = 2秒、4分割 = 0.5秒
    expect(c.notes[0]).toMatchObject({ type: 'don', time: 0 });
    expect(c.notes[1]).toMatchObject({ type: 'ka', time: 1 });
    // 2小節目から BPM240: 1小節 = 1秒
    expect(c.notes[2]).toMatchObject({ type: 'don', time: 2, bpm: 240 });
  });

  it('連打と風船の終点・打数', () => {
    const roll = c.notes[3];
    expect(roll.type).toBe('roll');
    expect(roll.time).toBeCloseTo(3);
    expect(roll.endTime).toBeCloseTo(3.75);
    const balloon = c.notes[4];
    expect(balloon.type).toBe('balloon');
    expect(balloon.hits).toBe(3);
    expect(balloon.endTime).toBeCloseTo(4.5);
  });

  it('小節線を出力する', () => {
    expect(c.bars.map((b) => b.time)).toEqual([0, 2, 3, 4]);
  });

  it('OFFSET は開始時刻をずらす', () => {
    const shifted = parseTJA(BASIC.replace('OFFSET:0', 'OFFSET:-1.5'));
    expect(shifted.courses[0].notes[0].time).toBeCloseTo(1.5);
  });

  it('#MEASURE と空小節', () => {
    const t = parseTJA(`BPM:120\n#START\n#MEASURE 3/4\n111,\n,\n#MEASURE 4/4\n1,\n#END`);
    const times = t.courses[0].notes.map((n) => n.time);
    // 3/4 小節 = 1.5秒、3分割で 0.5秒ずつ。次の空小節も 1.5秒
    expect(times).toEqual([0, 0.5, 1, 3]);
  });

  it('譜面分岐は普通譜面だけ採用', () => {
    const t = parseTJA(`BPM:120\n#START\n#BRANCHSTART p,50,80\n#N\n1,\n#E\n2,\n#M\n3,\n#BRANCHEND\n#END`);
    expect(t.courses[0].notes.map((n) => n.type)).toEqual(['don']);
  });
});

describe('Game 判定', () => {
  const chart = parseTJA(BASIC);
  const notes = chart.courses[0].notes;

  it('良・可・色違い', () => {
    const g = new Game(notes);
    g.hit('don', 0.01); // 良
    g.hit('ka', 1.06); // 可
    g.hit('ka', 2.0); // 色違い → 不可
    expect(g.stats.good).toBe(1);
    expect(g.stats.ok).toBe(1);
    expect(g.stats.bad).toBe(1);
    expect(g.stats.combo).toBe(0);
    expect(g.stats.maxCombo).toBe(2);
  });

  it('見逃しは不可', () => {
    const g = new Game(notes);
    g.update(1.5);
    expect(g.stats.bad).toBe(2);
  });

  it('連打と風船', () => {
    const g = new Game(notes);
    g.update(3.1);
    g.hit('don', 3.2);
    g.hit('ka', 3.3);
    expect(g.stats.rolls).toBe(2);
    g.update(4.1);
    g.hit('don', 4.1);
    g.hit('don', 4.2);
    g.hit('don', 4.3);
    expect(g.states.find((s) => s.note.type === 'balloon')!.done).toBe(true);
  });
});
