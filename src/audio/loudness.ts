/**
 * 書き出す音源の音量を上げる（音割れしないように、ピークの所だけ自然に抑えるリミッター付き）。
 *
 * gain 倍にしたとき ceiling を超える所だけ、そこに向けて少し前から（約 3ms）なめらかに音量を下げ、
 * 過ぎたら約 80ms かけて戻す。超えない所は、ちょうど gain 倍（音は変わらず大きくなるだけ）。
 * 全チャンネルに同じ音量を掛けるので、左右の定位は変わらない。
 */
export function boostWithLimiter(chs: Float32Array[], sr: number, gain: number, ceiling = 0.95): Float32Array[] {
  const n = chs[0]?.length ?? 0;
  // その所で必要な音量（1 = 下げなくてよい）
  const need = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of chs) { const v = Math.abs(c[i]); if (v > p) p = v; }
    const q = p * gain;
    if (q > ceiling) { need[i] = ceiling / q; any = true; } else need[i] = 1;
  }
  const g = need;
  if (any) {
    // 後ろから: ピークの少し前から下げ始める（ピークで急に下がらないように）
    const atk = 1 - Math.exp(-1 / (0.003 * sr));
    for (let i = n - 2; i >= 0; i--) {
      let back = g[i + 1] + (1 - g[i + 1]) * atk;
      if (back > 0.999999) back = 1; // 戻りきったら、ちょうど 1（下げていない所は正確に gain 倍）
      if (back < g[i]) g[i] = back;
    }
    // 前から: 下げたあと、ゆっくり戻す
    const rel = 1 - Math.exp(-1 / (0.08 * sr));
    for (let i = 1; i < n; i++) {
      let fwd = g[i - 1] + (1 - g[i - 1]) * rel;
      if (fwd > 0.999999) fwd = 1;
      if (fwd < g[i]) g[i] = fwd;
    }
  }
  return chs.map((c) => {
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = c[i] * gain * g[i];
    return o;
  });
}

/** .ogg（Vorbis）の最初のヘッダーから、サンプリング周波数を読む（読めなければ 0） */
export function oggSampleRate(data: ArrayBuffer): number {
  const b = new Uint8Array(data, 0, Math.min(data.byteLength, 4096));
  for (let i = 0; i + 16 < b.length; i++) {
    // 0x01 "vorbis" の後ろ: バージョン（4）・チャンネル数（1）・サンプリング周波数（4、リトルエンディアン）
    if (b[i] === 1 && b[i + 1] === 0x76 && b[i + 2] === 0x6f && b[i + 3] === 0x72 && b[i + 4] === 0x62 && b[i + 5] === 0x69 && b[i + 6] === 0x73) {
      const o = i + 7 + 4 + 1;
      return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    }
  }
  return 0;
}
