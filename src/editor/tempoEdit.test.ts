import { describe, expect, it } from 'vitest';
import { planTimeAt, type TempoPlan } from '../audio/tempo';
import { moveBoundary, removeSection, sections, setBpm, setEnd, setMeter, setStart, shiftDownbeat, splitAt } from './tempoEdit';

const TPB = 48;
const base = (): TempoPlan => ({ bpm: 120, offset: -1, changes: [{ tick: 16 * TPB, bpm: 150 }, { tick: 32 * TPB, bpm: 180 }], measures: [] });
const T = (p: TempoPlan, tick: number) => planTimeAt(p, TPB, tick);

describe('測ったテンポの手直し', () => {
  it('BPM を変えても、後ろの区間の時刻は変わらない', () => {
    const p = base();
    const t2 = T(p, p.changes[1].tick);
    const q = setBpm(p, TPB, 1, 151);
    expect(q.changes[0].bpm).toBe(151);
    expect(Math.abs(T(q, q.changes[1].tick) - t2)).toBeLessThan((60 / 151) * 0.13);
    // 倍にすると拍数も倍
    const d = setBpm(p, TPB, 1, 300);
    expect((d.changes[1].tick - d.changes[0].tick) / TPB).toBe(32);
    expect(T(d, d.changes[1].tick)).toBeCloseTo(t2, 6);
  });
  it('境目を動かすと、前の区間の拍に合い、次の区間の終わりの時刻は変わらない', () => {
    const p = base();
    const t2 = T(p, p.changes[1].tick);
    const q = moveBoundary(p, TPB, 1, 18.3 * TPB);
    expect(q.changes[0].tick).toBe(18 * TPB);
    expect(Math.abs(T(q, q.changes[1].tick) - t2)).toBeLessThan((60 / 150) * 0.13);
    // 後ろへ動かしすぎても、次の区間が 1 拍は残る
    const z = moveBoundary(p, TPB, 1, 100 * TPB);
    expect(sections(z).length).toBe(3);
    expect(z.changes[1].tick - z.changes[0].tick).toBeGreaterThanOrEqual(TPB / 4);
  });
  it('分けて BPM を変える・消すと前の区間が伸びる', () => {
    const p = base();
    const s = splitAt(p, TPB, T(p, 8 * TPB) + 0.05)!;
    expect(s.index).toBe(1);
    expect(s.plan.changes[0]).toEqual({ tick: 8 * TPB, bpm: 120 });
    const r = removeSection(p, TPB, 1)!;
    expect(r.changes.length).toBe(1);
    expect(r.changes[0].bpm).toBe(180);
    // 120 の拍に合わせ直すので、ずれは 1/8 拍以内
    expect(Math.abs(T(r, r.changes[0].tick) - T(p, 32 * TPB))).toBeLessThan((60 / 120) / 8 + 1e-9);
    const f = removeSection(p, TPB, 0)!;
    expect(f.bpm).toBe(150);
    expect(T(f, f.changes[0].tick)).toBeCloseTo(T(p, 32 * TPB), 6);
  });
  it('1 拍目を動かしても、拍の時刻は変わらない', () => {
    const p = base();
    const q = shiftDownbeat(p, TPB, 2);
    expect(q.offset).toBeCloseTo(-2, 6);
    expect(T(q, q.changes[0].tick)).toBeCloseTo(T(p, p.changes[0].tick), 6);
  });
  it('区間の拍子を変えると、区間の後ろは前の拍子に戻る', () => {
    const q = setMeter(base(), 1, { num: 3, den: 4 });
    expect(q.measures).toEqual([{ tick: 16 * TPB, num: 3, den: 4 }, { tick: 32 * TPB, num: 4, den: 4 }]);
  });
});

describe('区間の始まり・終わりを決める', () => {
  it('終わりを後ろの区間の先まで動かすと、またいだ区間は消えて伸びる', () => {
    const p = base();
    const q = setEnd(p, TPB, 0, 20 * TPB);
    expect(q.changes[0].tick).toBe(20 * TPB);
    expect(q.changes.length).toBe(2);
    const r = setEnd(p, TPB, 0, 36 * TPB);
    expect(r.changes.length).toBe(1);
    expect(r.changes[0]).toEqual({ tick: 36 * TPB, bpm: 180 });
  });
  it('始まりを前の区間の先まで動かすと、またいだ区間は消えて前に伸びる', () => {
    const p = base();
    const q = setStart(p, TPB, 2, 8 * TPB);
    expect(q.changes.length).toBe(1);
    expect(q.changes[0]).toEqual({ tick: 8 * TPB, bpm: 180 });
  });
});
