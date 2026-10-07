import { describe, expect, it } from 'vitest';
import { isOgg, oggName, pcmToOgg } from './toOgg';

describe('.ogg にする', () => {
  it('PCM を Ogg Vorbis にする', async () => {
    const sr = 44100;
    const l = new Float32Array(sr * 2);
    const r = new Float32Array(sr * 2);
    for (let i = 0; i < l.length; i++) { l[i] = Math.sin((i / sr) * 2 * Math.PI * 440) * 0.5; r[i] = l[i]; }
    const out = await pcmToOgg([l, r], sr);
    expect(isOgg(out)).toBe(true);
    expect(out.byteLength > 2000).toBe(true);
  });
  it('名前の拡張子を .ogg にする', () => {
    expect(oggName('song.mp3')).toBe('song.ogg');
    expect(oggName('a.b.wav')).toBe('a.b.ogg');
  });
});
