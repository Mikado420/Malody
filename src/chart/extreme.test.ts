import { describe, expect, it } from 'vitest';
import { parseTJA } from './tja';
import { toPlayable } from './model';

const tja = (body: string) => `TITLE:t\nBPM:120\nOFFSET:0\n\nCOURSE:Oni\nLEVEL:8\n#START\n${body}\n#END\n`;
const times = (body: string) => {
  const c = parseTJA(tja(body));
  return toPlayable(c, c.courses[0]).notes.map((n) => n.time);
};

describe('極端に遅い・速い BPM と、とても短い・長い小節', () => {
  it('#BPMCHANGE 0.02 と #MEASURE 1/40000 の小節は、#BPMCHANGE 200 と #MEASURE 1/4 の小節と同じ長さ（0.3 秒）', () => {
    // 1 小節目（2 秒）のあとに、その小節、そのあとの音符の時刻をくらべる
    const a = times('1,\n#BPMCHANGE 0.02\n#MEASURE 1/40000\n0,\n#BPMCHANGE 120\n#MEASURE 4/4\n1,');
    const b = times('1,\n#BPMCHANGE 200\n#MEASURE 1/4\n0,\n#BPMCHANGE 120\n#MEASURE 4/4\n1,');
    expect(b[1]).toBeCloseTo(2.3, 9);
    expect(a[1]).toBeCloseTo(b[1], 9);
  });

  it('とても短い小節がたくさん続いても、ずれがたまらない', () => {
    const many = Array.from({ length: 1000 }, () => '0,').join('\n');
    const t = times(`1,\n#BPMCHANGE 0.02\n#MEASURE 1/40000\n${many}\n#BPMCHANGE 120\n#MEASURE 4/4\n1,`);
    // 0.3 秒 × 1000 小節 = 300 秒
    expect(t[1]).toBeCloseTo(2 + 300, 6);
  });

  it('極端に速い BPM と長い小節', () => {
    const a = times('1,\n#BPMCHANGE 60000\n#MEASURE 1000/4\n0,\n#BPMCHANGE 120\n#MEASURE 4/4\n1,');
    // 1000 拍 × 60 / 60000 = 1 秒
    expect(a[1]).toBeCloseTo(3, 9);
  });
});
