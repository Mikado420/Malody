import { describe, expect, it } from 'vitest';
import { parseTJA } from '../chart/tja';
import { writeTJA } from '../chart/tjaWrite';
import { TPB } from '../chart/model';
import { Editor } from './editor';

const M = TPB * 4;
const TJA = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1111,\n0,\n00001210,\n5008,\n0,\n#END\n';

describe('グラデ', () => {
  it('1111, に 1→2 の等差: 音符ごとに 1, 1.25, 1.5, 1.75、終点で 2', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.setGrad({ start: 0, end: M, from: 1, to: 2, mode: 'linear', digits: 3 });
    const s = ed.course.events.filter((e) => e.kind === 'scroll').map((e) => [e.tick, (e as { value: number }).value]);
    expect(s).toEqual([[0, 1], [M / 4, 1.25], [M / 2, 1.5], [(M * 3) / 4, 1.75], [M, 2]]);
  });

  it('小節線と 5〜7 の始まりは対象、8 は対象外。等比で 1→1.5', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.setGrad({ start: M, end: M * 4, from: 1, to: 1.5, mode: 'geometric', digits: 3 });
    const s = ed.course.events.filter((e) => e.kind === 'scroll').map((e) => (e as { value: number }).value);
    // 0, の小節線 / 00001210, の小節線と 1・2・1 / 5008, の 5（8 は対象外） = 6 か所 + 終点
    expect(s.length).toBe(7);
    expect(s[0]).toBe(1);
    expect(s[6]).toBe(1.5);
  });

  it('TJA のテキストを書き換えても、#SCROLL がそのままならグラデを引き継ぐ', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.setGrad({ start: 0, end: M, from: 1, to: 2, mode: 'linear', digits: 3 });
    const text = writeTJA(ed.chart);
    ed.replaceChart(parseTJA(text));
    expect(ed.course.grads?.length).toBe(1);
    ed.replaceChart(parseTJA(text.replace('#SCROLL 1.25', '#SCROLL 1.3')));
    expect(ed.course.grads?.length ?? 0).toBe(0);
  });
});
