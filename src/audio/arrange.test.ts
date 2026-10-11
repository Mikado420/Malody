import { describe, expect, it } from 'vitest';
import { addFadeIn, addFadeOut, arrangeLength, arrangeStart, bringToTop, clipAt, envAt, mapTime, refShift, renderClips, snapTo, splitClip, trimEnd, trimStart, type Clip, type EnvPoint } from './arrange';

const clip = (src: number, len: number, pos: number, env: EnvPoint[] = [], track = 0, srcId = 0): Clip => ({ src, len, pos, env, track, srcId });

describe('音源の切り貼り', () => {
  it('分けると、前と後ろのクリップになる（オートメーションは元の音源の時刻のまま両方へ）', () => {
    const env = [{ s: 0, v: 0 }, { s: 1, v: 1 }, { s: 9, v: 1 }, { s: 10, v: 0 }];
    const out = splitClip([clip(0, 10, 0, env)], 0, 4)!;
    expect(out).toEqual([clip(0, 4, 0, env), clip(4, 6, 4, env)]);
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
    const [out] = renderClips([[src]], sr, [clip(0, 1, 0), clip(5, 0.5, 0.5), clip(2, 0.3, 2)]);
    expect(out.length).toBe(23);
    expect(Array.from(out.slice(0, 10))).toEqual([0, 1, 2, 3, 4, 50, 51, 52, 53, 54]);
    expect(Array.from(out.slice(10, 20))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(out.slice(20))).toEqual([20, 21, 22]);
  });

  it('上のクリップの音量が下がっている間は、下の音と混ぜて入れ替わる（クロスフェード）', () => {
    const sr = 10;
    const a = new Float32Array(40).fill(1);
    a.fill(3, 20);
    const [out] = renderClips([[a]], sr, [clip(0, 2, 0), addFadeIn(clip(2, 1, 1), 0.5)]);
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

  it('オートメーション: 点のあいだは直線、外はいちばん近い点の音量', () => {
    const env = [{ s: 1, v: 0 }, { s: 3, v: 1 }];
    expect(envAt([], 5)).toBe(1);
    expect(envAt(env, 0)).toBe(0);
    expect(envAt(env, 2)).toBe(0.5);
    expect(envAt(env, 9)).toBe(1);
  });

  it('フェードイン・フェードアウトは点を 2 つ置く（その間の点は置き換える）', () => {
    const c = addFadeOut(addFadeIn(clip(10, 8, 0, [{ s: 11, v: 0.5 }]), 2), 3);
    expect(c.env).toEqual([{ s: 10, v: 0 }, { s: 12, v: 0.5 }, { s: 15, v: 0.5 }, { s: 18, v: 0 }]);
  });

  it('オートメーションの音量が掛かる', () => {
    const [out] = renderClips([[new Float32Array(20).fill(1)]], 10, [clip(0, 2, 0, [{ s: 0, v: 0 }, { s: 1, v: 1 }])]);
    expect(Array.from(out.slice(0, 6)).map((v) => Math.round(v * 10) / 10)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it('トラックどうしは足し合わせる。別の音源も使える（モノラルはステレオの両方へ）', () => {
    const main = [new Float32Array(10).fill(1), new Float32Array(10).fill(2)];
    const other = [new Float32Array(10).fill(10)];
    const out = renderClips([main, other], 10, [clip(0, 1, 0), clip(0, 0.5, 0.5, [], 1, 1)]);
    expect(Array.from(out[0])).toEqual([1, 1, 1, 1, 1, 11, 11, 11, 11, 11]);
    expect(Array.from(out[1])).toEqual([2, 2, 2, 2, 2, 12, 12, 12, 12, 12]);
  });

  it('トラックを指定して上のクリップを探す。譜面の頭のずれは譜面の音源のクリップだけで決める', () => {
    const cs = [clip(0, 10, 0), clip(0, 10, 2, [], 1, 1)];
    expect(clipAt(cs, 5, 0)).toBe(0);
    expect(clipAt(cs, 5, 1)).toBe(1);
    expect(clipAt(cs, 5)).toBe(1);
    expect(refShift(cs, 3)).toBe(0);
  });

  it('0 より前に置くと、新しい音源はそこから始まる', () => {
    const src = new Float32Array(30).map((_, i) => i);
    const cs = [clip(0, 1, 0), clip(2, 0.5, -0.5)];
    expect(arrangeStart(cs)).toBe(-0.5);
    const [out] = renderClips([[src]], 10, cs);
    expect(Array.from(out)).toEqual([20, 21, 22, 23, 24, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
