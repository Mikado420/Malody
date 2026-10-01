import { decodeText } from '../chart/decode';
import type { EChart } from '../chart/model';
import { parseTJA } from '../chart/tja';
import { isZip, readZip } from './zip';

export interface AudioFile {
  name: string;
  data: ArrayBuffer;
}

export interface LoadResult {
  chart: EChart | null;
  audio: AudioFile | null;
  /** zip 内に .tja が複数あったときの候補（選び直し用） */
  others: string[];
  message: string;
}

const AUDIO_EXT = /\.(ogg|mp3|wav|m4a|aac|opus|flac)$/i;
const base = (p: string) => p.split('/').pop() ?? p;
const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

const toBuf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/**
 * 選ばれたファイル群（.tja / .zip / 音源）を読み込む。
 * 拡張子で判定するが、zip は中身のシグネチャでも判定する（iOS で拡張子が変わる対策）。
 */
export async function loadFiles(files: File[], pickTja?: string): Promise<LoadResult> {
  const entries: { name: string; data: ArrayBuffer }[] = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    if (isZip(buf)) {
      for (const e of await readZip(buf)) entries.push({ name: e.name, data: toBuf(e.data) });
    } else {
      entries.push({ name: f.name, data: buf });
    }
  }

  const tjas = entries.filter((e) => /\.tja$/i.test(e.name));
  const audios = entries.filter((e) => AUDIO_EXT.test(e.name));

  if (!tjas.length) {
    if (audios.length) {
      return { chart: null, audio: { name: base(audios[0].name), data: audios[0].data }, others: [], message: '音源を読み込みました' };
    }
    return { chart: null, audio: null, others: [], message: '.tja・.zip・音源ファイルが見つかりませんでした' };
  }

  const tja = tjas.find((t) => t.name === pickTja) ?? tjas[0];
  const chart = parseTJA(decodeText(tja.data));

  // WAVE: と同じ名前 → 同じフォルダの音源 → 最初の音源
  const audio =
    audios.find((a) => base(a.name) === chart.wave && dir(a.name) === dir(tja.name)) ??
    audios.find((a) => base(a.name) === chart.wave) ??
    audios.find((a) => dir(a.name) === dir(tja.name)) ??
    audios[0];

  const parts = [`「${chart.title || base(tja.name)}」を読み込みました（${chart.courses.length}難易度）`];
  if (!audio) parts.push('音源が見つかりませんでした。ファイルメニューから音源を追加できます');

  return {
    chart,
    audio: audio ? { name: base(audio.name), data: audio.data } : null,
    others: tjas.map((t) => t.name),
    message: parts.join('。'),
  };
}
