import { describe, expect, it } from 'vitest';
import { encodeSJIS } from './sjis';

describe('シフトJIS で書き出す', () => {
  it('日本語・半角カナ・記号をシフトJIS にして、読み戻すと同じ文字になる', () => {
    const s = 'TITLE:蠱惑 瀟洒な 極めて遺憾 妥当性\r\nSUBTITLE:--ｶﾀｶﾅ ①♪～\r\n#START';
    const b = encodeSJIS(s);
    expect(new TextDecoder('shift_jis').decode(b)).toBe(s);
    expect(Array.from(encodeSJIS('あ'))).toEqual([0x82, 0xa0]);
  });
  it('シフトJIS に無い文字は ? にする', () => {
    expect(new TextDecoder('shift_jis').decode(encodeSJIS('a😀b简'))).toBe('a?b?');
  });
});
