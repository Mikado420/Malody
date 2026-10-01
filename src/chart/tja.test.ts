import { describe, expect, it } from 'vitest';
import { parseTJA } from './tja';
import { writeTJA } from './tjaWrite';
import { measures, toPlayable, Timing, TPB } from './model';
import { Game } from '../engine/game';
import { readZip, writeZip } from '../io/zip';

const BASIC = `TITLE:Test
BPM:120
OFFSET:0
GENRE:テスト
COURSE:Oni
LEVEL:8
BALLOON:3
SCOREINIT:1000

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

  it('ヘッダを読む（未対応ヘッダは保持）', () => {
    expect(chart.title).toBe('Test');
    expect(chart.bpm).toBe(120);
    expect(c.name).toBe('Oni');
    expect(c.level).toBe(8);
    expect(chart.extra).toEqual([['GENRE', 'テスト']]);
    expect(c.extra).toEqual([['SCOREINIT', '1000']]);
  });

  it('ノーツを tick で持つ', () => {
    expect(c.notes.map((n) => [n.type, n.tick / TPB])).toEqual([
      ['don', 0], ['ka', 2], ['don', 4], ['roll', 8], ['balloon', 12],
    ]);
    expect(c.notes[3].endTick! / TPB).toBe(11);
    expect(c.notes[4]).toMatchObject({ hits: 3, endTick: 14 * TPB });
    expect(c.events).toEqual([{ tick: 4 * TPB, kind: 'bpm', value: 240 }]);
  });

  it('#MEASURE と空小節', () => {
    const t = parseTJA(`BPM:120\n#START\n#MEASURE 3/4\n111,\n,\n#MEASURE 4/4\n1,\n#END`);
    expect(t.courses[0].notes.map((n) => n.tick / TPB)).toEqual([0, 1, 2, 6]);
    expect(measures(t.courses[0], 6 * TPB).map((m) => m.length / TPB)).toEqual([3, 3, 4]);
  });

  it('譜面分岐は普通譜面だけ採用', () => {
    const t = parseTJA(`BPM:120\n#START\n#BRANCHSTART p,50,80\n#N\n1,\n#E\n2,\n#M\n3,\n#BRANCHEND\n#END`);
    expect(t.courses[0].notes.map((n) => n.type)).toEqual(['don']);
  });

  it('複数難易度でヘッダが混ざらない', () => {
    const t = parseTJA(`BPM:120\nCOURSE:Easy\nLEVEL:2\nBALLOON:4\n#START\n7008,\n#END\nCOURSE:Oni\nLEVEL:9\n#START\n7008,\n#END`);
    expect(t.courses.map((c) => [c.name, c.level, c.notes[0].hits])).toEqual([['Easy', 2, 4], ['Oni', 9, 5]]);
  });
});

describe('時間変換', () => {
  it('BPM 変化と OFFSET', () => {
    const chart = parseTJA(BASIC.replace('OFFSET:0', 'OFFSET:-1.5'));
    const t = new Timing(chart, chart.courses[0]);
    expect(t.tickToTime(0)).toBe(1.5);
    expect(t.tickToTime(4 * TPB)).toBeCloseTo(3.5); // 120BPM で4拍=2秒
    expect(t.tickToTime(8 * TPB)).toBeCloseTo(4.5); // 240BPM で4拍=1秒
    expect(t.timeToTick(4.5)).toBeCloseTo(8 * TPB);
  });

  it('プレイ用に変換', () => {
    const chart = parseTJA(BASIC);
    const p = toPlayable(chart, chart.courses[0]);
    expect(p.notes.map((n) => n.time)).toEqual([0, 1, 2, 3, 4]);
    expect(p.notes[3].endTime).toBeCloseTo(3.75);
    expect(p.bars.map((b) => b.time)).toEqual([0, 2, 3, 4]);
  });
});

describe('ゴーゴータイム', () => {
  it('#GOGOEND の後にノーツがなくても、その時刻で終わる', () => {
    const c = parseTJA(`BPM:120\n#START\n#GOGOSTART\n1,\n#GOGOEND\n,\n,\n1,\n#END`);
    const p = toPlayable(c, c.courses[0]);
    expect(p.gogo).toEqual([[0, 2]]);
    expect(p.notes.map((n) => n.gogo)).toEqual([true, false]);
  });

  it('#GOGOEND が無ければ最後まで', () => {
    const c = parseTJA(`BPM:120\n#START\n1,\n#GOGOSTART\n1,\n#END`);
    expect(toPlayable(c, c.courses[0]).gogo).toEqual([[2, Infinity]]);
  });
});

describe('writeTJA', () => {
  it('読み込み → 書き出し → 読み込みで同じ内容になる', () => {
    const src = `TITLE:往復
BPM:150
OFFSET:-0.25
COURSE:Oni
LEVEL:10
BALLOON:12,20

#START
1010201010102010,
#GOGOSTART
3004,
#SCROLL 1.5
11211121,
#MEASURE 3/4
#BPMCHANGE 200
500000000008,
100200100200,
#MEASURE 4/4
#GOGOEND
7008,
#DELAY 0.5
12121212121212121212121212121212,
111111111111,
7000000000000000000000000000000000000000000000000000000000000008,
#END
`;
    const a = parseTJA(src);
    const out = writeTJA(a);
    const b = parseTJA(out);
    expect(b.title).toBe(a.title);
    expect(b.offset).toBe(a.offset);
    expect(b.courses[0].notes).toEqual(a.courses[0].notes);
    expect(b.courses[0].events).toEqual(a.courses[0].events);
    // 書き出しは最小の分割になる
    expect(out).toContain('\n3004,\n');
    expect(out).toContain('BALLOON:12,20');
  });

  it('空の譜面', () => {
    const out = writeTJA(parseTJA('BPM:100\n#START\n#END'));
    expect(out).toContain('#START\n0,\n#END');
  });
});

describe('zip', () => {
  it('書き出し → 読み込み（無圧縮・deflate・日本語名）', async () => {
    const tja = new TextEncoder().encode('TITLE:テスト\n'.repeat(50));
    const bin = new Uint8Array([0, 1, 2, 3, 250, 255]);
    const blob = await writeZip([
      { name: '曲/譜面.tja', data: tja, compress: true },
      { name: '曲/song.ogg', data: bin },
    ]);
    const entries = await readZip(await blob.arrayBuffer());
    expect(entries.map((e) => e.name)).toEqual(['曲/譜面.tja', '曲/song.ogg']);
    expect(Array.from(entries[0].data)).toEqual(Array.from(tja));
    expect(Array.from(entries[1].data)).toEqual(Array.from(bin));
  });
});

describe('Game 判定', () => {
  const mk = (spec: [string, number, number?][]) =>
    spec.map(([type, time, endTime]) => ({ type, time, endTime, bpm: 120, scroll: 1, gogo: false, hits: 5 })) as never;

  const chart = parseTJA(BASIC);
  const notes = toPlayable(chart, chart.courses[0]).notes;

  it('良・可、色違いは判定しない（ノーツは残る）', () => {
    const g = new Game(notes);
    g.hit('don', 0.01);
    g.hit('ka', 1.06);
    g.hit('ka', 2.0); // ドンをカッで叩いた → 何も起きない
    expect([g.stats.good, g.stats.ok, g.stats.bad, g.stats.combo]).toEqual([1, 1, 0, 2]);
    g.hit('don', 2.01); // 同じノーツをドンで叩き直せる
    expect([g.stats.good, g.stats.combo]).toEqual([2, 3]);
  });

  it('ドンとカッが混ざっていても、叩いた色のノーツで判定される', () => {
    // ドン(1.00) カッ(1.05) が近い。カッをちょうどで叩くと、近いドンではなくカッが良になる
    const g = new Game(mk([['don', 1], ['ka', 1.05]]));
    g.hit('ka', 1.05);
    g.hit('don', 1.0);
    expect([g.stats.good, g.stats.bad]).toEqual([2, 0]);
  });

  it('判定幅は 良 25ms / 可 75ms / 不可 114ms', () => {
    const one = (delta: number) => {
      const g = new Game([{ type: 'don', time: 1, bpm: 120, scroll: 1, gogo: false }]);
      g.hit('don', 1 + delta);
      return g.stats.good ? 'good' : g.stats.ok ? 'ok' : g.stats.bad ? 'bad' : 'none';
    };
    expect([0.025, -0.025, 0.026, 0.075, -0.075, 0.076, 0.114, -0.114, 0.115, -0.115].map(one)).toEqual([
      'good', 'good', 'ok', 'ok', 'ok', 'bad', 'bad', 'bad', 'none', 'none',
    ]);
  });

  it('1つ見逃しても、次のノーツは叩いた時刻に近いほうで判定される', () => {
    // 16分（0.1秒間隔）の連打で 1 つ目を叩かず、2 つ目以降をちょうどで叩く
    const g = new Game(mk([['don', 1], ['don', 1.1], ['don', 1.2], ['don', 1.3]]));
    g.hit('don', 1.1);
    g.hit('don', 1.2);
    g.hit('don', 1.3);
    g.update(1.5);
    expect([g.stats.good, g.stats.bad]).toEqual([3, 1]);
  });

  it('大音符を両手で叩いた 2 打目は次のノーツに使われない', () => {
    const g = new Game(mk([['bigDon', 1], ['don', 1.1]]));
    g.hit('don', 1.0);
    g.hit('don', 1.02); // 両手の 2 打目
    g.hit('don', 1.1);
    expect([g.stats.good, g.stats.bad]).toEqual([2, 0]);
  });

  it('連打の最中に叩いた分は、すぐ後のノーツの判定に使われない', () => {
    const g = new Game(mk([['roll', 1, 1.5], ['don', 1.55]]));
    for (const t of [1.0, 1.1, 1.2, 1.3, 1.45, 1.5]) g.hit('don', t);
    g.hit('don', 1.55);
    expect([g.stats.rolls, g.stats.good, g.stats.bad]).toEqual([6, 1, 0]);
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
