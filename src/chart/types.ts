// 譜面の共通フォーマット。TJA / Malody(.mc) などはすべてこの形に変換してからゲームに渡す。

export type NoteType =
  | 'don'
  | 'ka'
  | 'bigDon'
  | 'bigKa'
  | 'roll' // 連打
  | 'bigRoll' // 大連打
  | 'balloon'; // 風船（くす玉も現状は風船扱い）

export interface Note {
  type: NoteType;
  /** 判定時刻（秒、曲の再生開始からの時間） */
  time: number;
  /** 連打・風船の終了時刻（秒） */
  endTime?: number;
  /** 風船の必要打数 */
  hits?: number;
  /** そのノーツ時点の BPM（スクロール速度計算用） */
  bpm: number;
  /** #SCROLL の値 */
  scroll: number;
  gogo: boolean;
}

export interface BarLine {
  time: number;
  bpm: number;
  scroll: number;
}

export interface Course {
  /** Easy / Normal / Hard / Oni / Edit など */
  name: string;
  level: number;
  notes: Note[];
  bars: BarLine[];
}

export interface Chart {
  title: string;
  subtitle: string;
  /** 音源ファイル名（WAVE:） */
  wave: string;
  bpm: number;
  /** 曲データの開始位置からの譜面のずれ（秒）。TJA の OFFSET をそのまま保持 */
  offset: number;
  demoStart: number;
  courses: Course[];
}

export const isHitNote = (t: NoteType) =>
  t === 'don' || t === 'ka' || t === 'bigDon' || t === 'bigKa';

export const isDon = (t: NoteType) => t === 'don' || t === 'bigDon';
