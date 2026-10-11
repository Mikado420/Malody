import { describe, expect, it } from 'vitest';
import { arrangeLength, bringToTop, clipAt, mapTime, refShift, renderClips, snapTo, splitClip, trimEnd, trimStart, type Clip } from './arrange';

const clip = (src: number, len: number, pos: number, fadeIn = 0, fadeOut = 0): Clip => ({ src, len, pos, fadeIn, fadeOut });

describe('音源の切り貼り', () => {
  it('分けると、前と後ろのクリップになる（フェードは外側だけ残す）', () => {
    const out = splitClip([clip(0, 10, 0, 1, 2)], 0, 4)!;
    expect(out).toEqual([clip(0, 4, 0, 1, 0), clip(4, 6, 4, 0, 2)]);
  });

  it('端に近すぎる所では分けない', () => {
    expect(splitClip([clip(0, 10, 0)], 0, 0.01)).toBeNull();
    expect(splitClip([clip(0, 10, 0)], 0, 9.99)).toBeNull();
  });

  it('左の端を詰めると、中身はその場のまま（src も同じだけ進む）', () => {
    expect(trimStart(clip(2, 6, 5), 6.5)).toEqual(clip(3.5, 4.5, 6.5));
    // 元の音源の頭より前には伸ばせない
    expect(trimStart(clip(1, 6, 5), 0)).toEqual(clip(0, 7, 4));
  });

  it('右の端は元の音源の終わりまで', () => {
    expect(trimEnd(clip(2, 3, 0), 10, 8)).toEqual(clip(2, 6, 0));
  });

  it('上のクリップが優先される', () => {
    const cs = [clip(0, 10, 0), clip(20, 2, 3)];
    expect(clipAt(cs, 4)).toBe(1);
    expect(clipAt(cs, 6)).toBe(0);
    expect(clipAt(cs, 11)).toBe(-1);
    expect(bringToTop(cs, 0).clips[1]).toEqual(clip(0, 10, 0));
  });

  it('並べた音を作る: 重なりは上の音、すき間は無音', () => {
    const sr = 10;
    const src = new Float32Array(100).map((_, i) => i);
    const [out] = renderClips([src], sr, [clip(0, 1, 0), clip(5, 0.5, 0.5), clip(2, 0.3, 2)]);
    expect(out.length).toBe(23);
    expect(Array.from(out.slice(0, 10))).toEqual([0, 1, 2, 3, 4, 50, 51, 52, 53, 54]);
    expect(Array.from(out.slice(10, 20))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(out.slice(20))).toEqual([20, 21, 22]);
  });

  it('上のクリップのフェードの間は、下の音と混ぜて入れ替わる', () => {
    const sr = 10;
    const a = new Float32Array(40).fill(1);
    a.fill(3, 20);
    const [out] = renderClips([a], sr, [clip(0, 2, 0), clip(2, 1, 1, 0.5, 0)]);
    // 1.0〜1.5 秒は 1 → 3 へ
    expect(Array.from(out.slice(10, 16)).map((v) => Math.round(v * 10) / 10)).toEqual([1, 1.4, 1.8, 2.2, 2.6, 3]);
  });

  it('譜面の頭のずれ: その音を使っているクリップから求める', () => {
    const cs = [clip(10, 5, 0), clip(30, 10, 5)];
    expect(mapTime(cs, 32)).toBe(7);
    expect(refShift(cs, 32)).toBe(-25);
    // 使っていない所: 元の位置がいちばん近いクリップ
    expect(refShift(cs, 20)).toBe(-10);
    expect(arrangeLength(cs)).toBe(15);
  });

  it('近い候補に吸い付く', () => {
    expect(snapTo(1.04, [0, 1, 2], 0.05)).toBe(1);
    expect(snapTo(1.2, [0, 1, 2], 0.05)).toBe(1.2);
  });
});
