import type { EChart } from '../chart/model';
import type { AudioFile } from './load';
import { dbGet, dbPut, dbDel } from './storage';

/**
 * 曲の一覧（ライブラリ）。曲ごとに譜面と音源をブラウザ内（IndexedDB）に保存し、フォルダで分ける。
 * 一覧（lib-index）には、曲選択の画面に出す情報だけを持つ（譜面・音源は曲ごとの別のキー）。
 */

export interface SongEntry {
  id: string;
  title: string;
  subtitle: string;
  bpm: number;
  /** 曲の長さ（秒。音源が無いときは 0） */
  length: number;
  /** BPM の最小・最大（途中で変わる曲） */
  bpmMin: number;
  bpmMax: number;
  courses: { name: string; level: number }[];
  /** 入っているフォルダ（'' は一番上） */
  folder: string;
  audioName: string;
  demoStart: number;
  updatedAt: number;
}

export interface SongData {
  chart: EChart;
  courseIndex: number;
}

const kIndex = 'lib-index';
const kFolders = 'lib-folders';
const kChart = (id: string) => `lib-chart-${id}`;
const kAudio = (id: string) => `lib-audio-${id}`;

export const listSongs = async () => (await dbGet<SongEntry[]>(kIndex)) ?? [];
export const listFolders = async () => (await dbGet<string[]>(kFolders)) ?? [];
export const loadSongData = (id: string) => dbGet<SongData>(kChart(id));
export const loadSongAudio = (id: string) => dbGet<AudioFile>(kAudio(id));
export const getCurrentId = () => dbGet<string>('lib-current');
export const setCurrentId = (id: string | null) => (id ? dbPut('lib-current', id) : dbDel('lib-current'));

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 譜面から一覧に出す情報を作る */
export function entryOf(id: string, chart: EChart, prev: Partial<SongEntry> = {}, length?: number): SongEntry {
  const bpms = [chart.bpm];
  for (const c of chart.courses) for (const e of c.events) if (e.kind === 'bpm' && e.value > 0) bpms.push(e.value);
  return {
    id,
    title: chart.title || '（無題）',
    subtitle: chart.subtitle.replace(/^--/, ''),
    bpm: chart.bpm,
    bpmMin: Math.min(...bpms),
    bpmMax: Math.max(...bpms),
    length: length ?? prev.length ?? 0,
    courses: chart.courses.map((c) => ({ name: c.name, level: c.level })),
    folder: prev.folder ?? '',
    audioName: chart.wave,
    demoStart: chart.demoStart,
    updatedAt: Date.now(),
  };
}

async function writeIndex(f: (list: SongEntry[]) => SongEntry[]) {
  const list = await listSongs();
  await dbPut(kIndex, f(list));
}

/** 曲を保存する（audio は undefined なら音源はそのまま、null なら消す） */
export async function saveSong(id: string, data: SongData, audio?: AudioFile | null, length?: number, folder?: string) {
  await dbPut(kChart(id), data);
  if (audio !== undefined) {
    if (audio) await dbPut(kAudio(id), audio);
    else await dbDel(kAudio(id));
  }
  await writeIndex((list) => {
    const prev = list.find((x) => x.id === id);
    const e = entryOf(id, data.chart, { ...prev, ...(folder !== undefined ? { folder } : {}) }, audio === null ? 0 : length);
    return prev ? list.map((x) => (x.id === id ? e : x)) : [...list, e];
  });
}

export async function deleteSong(id: string) {
  await dbDel(kChart(id));
  await dbDel(kAudio(id));
  await writeIndex((list) => list.filter((x) => x.id !== id));
}

export async function moveSong(id: string, folder: string) {
  await writeIndex((list) => list.map((x) => (x.id === id ? { ...x, folder } : x)));
}

export async function addFolder(name: string) {
  const fs = await listFolders();
  if (!fs.includes(name)) await dbPut(kFolders, [...fs, name]);
}

export async function renameFolder(from: string, to: string) {
  const fs = await listFolders();
  await dbPut(kFolders, fs.map((f) => (f === from ? to : f)).filter((f, i, a) => a.indexOf(f) === i));
  await writeIndex((list) => list.map((x) => (x.folder === from ? { ...x, folder: to } : x)));
}

/** フォルダを消す（中の曲は一番上に出す） */
export async function deleteFolder(name: string) {
  const fs = await listFolders();
  await dbPut(kFolders, fs.filter((f) => f !== name));
  await writeIndex((list) => list.map((x) => (x.folder === name ? { ...x, folder: '' } : x)));
}
