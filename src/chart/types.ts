// プレイ用（秒ベース）の譜面フォーマット。編集用モデル（model.ts）から toPlayable() で作る。

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
  /** 流れ方が #HBSCROLL / #BMSCROLL のときの位置（拍の数。#BMSCROLL は #SCROLL を掛けて足したもの） */
  beat?: number;
  /** 連打・風船の終点の beat */
  endBeat?: number;
}

export interface BarLine {
  time: number;
  bpm: number;
  scroll: number;
  beat?: number;
}

/** 時刻 → 拍の位置（#HBSCROLL / #BMSCROLL 用）。time 以降は 1 秒に rate 拍ずつ進む（#DELAY の間は 0） */
export interface BeatPoint {
  time: number;
  beat: number;
  rate: number;
}

/** #JPOSSCROLL: start 秒から time 秒かけて、判定枠を dx（基準の px、＋で右）動かす */
export interface JposMove {
  start: number;
  time: number;
  dx: number;
}

export interface Course {
  /** Easy / Normal / Hard / Oni / Edit など */
  name: string;
  level: number;
  notes: Note[];
  bars: BarLine[];
  /** ゴーゴータイムの区間 [開始, 終了]（秒）。終了がない場合は Infinity */
  gogo: [number, number][];
  /** 流れ方（#HBSCROLL / #BMSCROLL）。無ければふつう（音符ごとの BPM と SCROLL の速さで流れる） */
  scrollMode?: 'hb' | 'bm';
  /** scrollMode があるときの、時刻 → 拍の位置 */
  beatPoints?: BeatPoint[];
  /** 判定枠の移動（#JPOSSCROLL） */
  jpos?: JposMove[];
}

/** 時刻 now の拍の位置（beatPoints から） */
export function beatAt(points: BeatPoint[], now: number): number {
  let lo = 0;
  let hi = points.length - 1;
  if (now <= points[0].time) return points[0].beat + (now - points[0].time) * points[0].rate;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].time <= now) lo = mid;
    else hi = mid - 1;
  }
  const p = points[lo];
  return p.beat + (now - p.time) * p.rate;
}

/** 時刻 now の判定枠のずれ（基準の px、＋で右） */
export function jposAt(moves: JposMove[] | undefined, now: number): number {
  if (!moves) return 0;
  let x = 0;
  for (const m of moves) {
    if (now <= m.start) break;
    x += m.time > 0 ? m.dx * Math.min(1, (now - m.start) / m.time) : m.dx;
  }
  return x;
}

export const isHitNote = (t: NoteType) =>
  t === 'don' || t === 'ka' || t === 'bigDon' || t === 'bigKa';

export const isDon = (t: NoteType) => t === 'don' || t === 'bigDon';
