import { describe, expect, it } from 'vitest';
import { parseTJA } from '../chart/tja';
import { writeTJA } from '../chart/tjaWrite';
import { TPB } from '../chart/model';
import { Editor } from './editor';

const M = TPB * 4;
const TJA = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n0,\n0,\n#END\n';

describe('自由グリッド（割り切れない分割）', () => {
  it('13 分割で置いた音符は、13 文字の小節で書き出され、読み直すと同じ位置', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.divisor = 13;
    ed.tool = 'don';
    for (const k of [0, 1, 5, 12]) ed.tap(ed.snap((k * M) / 13));
    const ticks = ed.course.notes.map((n) => n.tick).sort((a, b) => a - b);
    expect(ticks.every(Number.isInteger)).toBe(true);
    const text = writeTJA(ed.chart);
    expect(text).toContain('1100010000001,');
    const back = parseTJA(text).courses[0].notes.map((n) => n.tick).sort((a, b) => a - b);
    expect(back).toEqual(ticks);
  });

  it('いろいろな分割（7, 11, 17, 100, 1000）でも書き出して読み直すと同じ位置', () => {
    for (const div of [7, 11, 17, 100, 1000]) {
      const ed = new Editor(parseTJA(TJA));
      ed.divisor = div;
      ed.tool = 'ka';
      for (const k of [1, 2, div - 1]) ed.tap(ed.snap((k * M) / div));
      const ticks = ed.course.notes.map((n) => n.tick).sort((a, b) => a - b);
      const back = parseTJA(writeTJA(ed.chart)).courses[0].notes.map((n) => n.tick).sort((a, b) => a - b);
      expect(back).toEqual(ticks);
    }
  });

  it('グリッドに寄せた位置は小節の終わりを越えない（3/4 に 13 分割）', () => {
    const t = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n#MEASURE 3/4\n0,\n0,\n#END\n';
    const ed = new Editor(parseTJA(t));
    ed.divisor = 13;
    const len = (M * 3) / 4;
    expect(ed.snap(len - 1)).toBe(len);
  });
});
