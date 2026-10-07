/**
 * 音源を .ogg（Ogg Vorbis）にする。.mp3・.wav・.m4a・.mp4 などはブラウザで PCM にしてから、
 * WebAssembly の Vorbis エンコーダ（wasm-media-encoders。使うときだけ読み込む）で .ogg にする。
 */
import type { AudioFile } from '../io/load';

export const isOgg = (data: ArrayBuffer) => {
  const b = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  return String.fromCharCode(...b) === 'OggS';
};

export const oggName = (name: string) => `${name.replace(/\.[^./]+$/, '') || 'audio'}.ogg`;

interface OggEncoder {
  configure(o: { channels: number; sampleRate: number; vbrQuality?: number }): void;
  encode(samples: Float32Array[]): Uint8Array;
  finalize(): Uint8Array;
}

/** PCM（チャンネルごと）→ .ogg のバイト列 */
export async function pcmToOgg(channels: Float32Array[], sampleRate: number, progress?: (p: number) => void): Promise<ArrayBuffer> {
  // @ts-ignore 型は依存パッケージ側にある（入れていない環境でも型チェックが通るように）
  const mod = (await import('wasm-media-encoders')) as { createOggEncoder: () => Promise<OggEncoder> };
  const enc = await mod.createOggEncoder();
  const chs = channels.slice(0, 2);
  enc.configure({ channels: chs.length, sampleRate, vbrQuality: 5 });
  const parts: Uint8Array[] = [];
  const len = chs[0].length;
  const step = sampleRate; // 1 秒ずつ
  for (let i = 0; i < len; i += step) {
    const e = Math.min(len, i + step);
    parts.push(enc.encode(chs.map((c) => c.subarray(i, e))).slice());
    progress?.(e / len);
    // 画面が止まらないように、ときどき他の処理に譲る
    if ((i / step) % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  parts.push(enc.finalize().slice());
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

/** AudioBuffer → チャンネルごとの PCM */
export const bufferChannels = (b: AudioBuffer) => Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, i) => b.getChannelData(i));

/** 音源を .ogg にする（もう .ogg ならそのまま） */
export async function toOgg(file: AudioFile, ctx: BaseAudioContext, progress?: (p: number) => void): Promise<AudioFile> {
  if (isOgg(file.data)) return { name: oggName(file.name), data: file.data };
  const buf = await ctx.decodeAudioData(file.data.slice(0));
  return { name: oggName(file.name), data: await pcmToOgg(bufferChannels(buf), buf.sampleRate, progress) };
}
