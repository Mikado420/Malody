import { describe, expect, it } from 'vitest';
import { TJA_COLOR, tjaLinesHtml, tjaMarks } from './tjaHighlight';

const tja = `TITLE:x
#START
1203,
5000
008,
70,
5,
#BPMCHANGE 150
#END`;

describe('TJA の色分け', () => {
  const m = tjaMarks(tja);
  it('#START より前は外、#START〜#END は中', () => {
    expect(Array.from(m.inside)).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
  it('5 から 8 までを（行をまたいでも）つなぐ。8 がない 7・5 はつながない', () => {
    expect(m.ranges.length).toBe(1);
    expect(m.ranges[0][2]).toBe(TJA_COLOR.roll);
  });
  it('音符の色と命令の色', () => {
    const h = tjaLinesHtml(tja, m, 0, 9);
    expect(h).toContain(`<span style="color:${TJA_COLOR.header}">TITLE:x</span>`);
    expect(h).toContain(`<span style="color:${TJA_COLOR.don}">1</span><span style="color:${TJA_COLOR.ka}">2</span><span style="color:${TJA_COLOR.zero}">0</span>`);
    // 5000 / 008 はすべて連打の色
    expect(h).toContain(`<span style="color:${TJA_COLOR.roll}">5000</span>`);
    expect(h).toContain(`<span style="color:${TJA_COLOR.roll}">008</span>`);
    // 8 のない 7 の後ろの 0 は灰色
    expect(h).toContain(`<span style="color:${TJA_COLOR.balloon}">7</span><span style="color:${TJA_COLOR.zero}">0</span>`);
    expect(h).toContain(`<span style="color:${TJA_COLOR.command}">#BPMCHANGE</span>`);
  });
});
