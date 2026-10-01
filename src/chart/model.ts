import type { BarLine, Course, Note, NoteType } from './types';

/**
 * 編集用の譜面モデル。
 * 時刻（秒）ではなく「tick（拍の分割）」で位置を持つので、BPM を変えてもノーツが拍からずれない。
 * TPB = 1拍（4分音符）あたりの tick 数。1〜8, 12, 16, 24, 32, 48, 64 分割や 5・7 連符も整数で表せる値。
 */
export const TPB = 6720;

export interface ENote {
  tick: number;
  type: NoteType;
  /** 連打・風船の終点 */
  endTick?: number;
  /** 風船の打数 */
  hits?: number;
}

export type EEvent =
  | { tick: number; kind: 'bpm'; value: number }
  | { tick: number; kind: 'scroll'; value: number }
  | { tick: number; kind: 'measure'; num: number; den: number }
  | { tick: number; kind: 'gogo'; on: boolean }
  | { tick: number; kind: 'barline'; on: boolean }
  | { tick: number; kind: 'delay'; value: number };

export type EventKind = EEvent['kind'];

export interface ECourse {
  name: string;
  level: number;
  notes: ENote[];
  events: EEvent[];
  /** LEVEL / BALLOON 以外の難易度ごとのヘッダ（SCOREINIT など）をそのまま保持 */
  extra: [string, string][];
}

export interface EChart {
  title: string;
  subtitle: string;
  wave: string;
  bpm: number;
  offset: number;
  demoStart: number;
  /** 未対応のヘッダ（GENRE, SONGVOL など）をそのまま保持して書き出す */
  extra: [string, string][];
  courses: ECourse[];
}

export const COURSE_NAMES = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'] as const;

export function newCourse(name = 'Oni', level = 1): ECourse {
  return { name, level, notes: [], events: [], extra: [] };
}

export function newChart(title = '新しい譜面', bpm = 120): EChart {
  return {
    title,
    subtitle: '',
    wave: '',
    bpm,
    offset: 0,
    demoStart: 0,
    extra: [],
    courses: [newCourse('Oni', 1)],
  };
}

export const isLong = (t: NoteType) => t === 'roll' || t === 'bigRoll' || t === 'balloon';

const EVENT_ORDER: EventKind[] = ['measure', 'bpm', 'scroll', 'gogo', 'barline', 'delay'];

export function sortCourse(c: ECourse) {
  c.notes.sort((a, b) => a.tick - b.tick);
  c.events.sort((a, b) => a.tick - b.tick || EVENT_ORDER.indexOf(a.kind) - EVENT_ORDER.indexOf(b.kind));
}

// ---------- 小節 ----------

export interface Measure {
  index: number;
  start: number;
  length: number; // tick
  num: number;
  den: number;
}

/** untilTick を含むところまでの小節一覧 */
export function measures(c: ECourse, untilTick: number): Measure[] {
  const ms = c.events.filter((e) => e.kind === 'measure') as Extract<EEvent, { kind: 'measure' }>[];
  const out: Measure[] = [];
  let num = 4;
  let den = 4;
  let start = 0;
  let mi = 0;
  for (let index = 0; ; index++) {
    while (mi < ms.length && ms[mi].tick <= start) {
      num = ms[mi].num;
      den = ms[mi].den;
      mi++;
    }
    const length = Math.max(1, Math.round((TPB * 4 * num) / den));
    out.push({ index, start, length, num, den });
    start += length;
    if (start > untilTick) break;
    if (index > 100000) break; // 念のため
  }
  return out;
}

export function measureAt(list: Measure[], tick: number): Measure {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].start <= tick) lo = mid;
    else hi = mid - 1;
  }
  return list[lo];
}

/** 曲の内容（ノーツ・イベント）の最後の tick */
export function contentEnd(c: ECourse): number {
  let end = 0;
  for (const n of c.notes) end = Math.max(end, n.endTick ?? n.tick);
  for (const e of c.events) end = Math.max(end, e.tick);
  return end;
}

// ---------- 時間変換 ----------

interface Point {
  tick: number;
  time: number;
  bpm: number;
}

export class Timing {
  private readonly points: Point[] = [];

  constructor(chart: EChart, private readonly course: ECourse) {
    let time = 0 - chart.offset; // -chart.offset だと 0 のとき -0 になる
    let tick = 0;
    let bpm = chart.bpm > 0 ? chart.bpm : 120;
    this.points.push({ tick: 0, time, bpm });
    for (const e of course.events) {
      if (e.kind !== 'bpm' && e.kind !== 'delay') continue;
      time += ((e.tick - tick) / TPB) * (60 / bpm);
      tick = e.tick;
      if (e.kind === 'bpm' && e.value > 0) bpm = e.value;
      if (e.kind === 'delay') time += e.value;
      this.points.push({ tick, time, bpm });
    }
  }

  private pointAtTick(tick: number): Point {
    const p = this.points;
    let lo = 0;
    let hi = p.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (p[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return p[lo];
  }

  tickToTime(tick: number): number {
    const p = this.pointAtTick(tick);
    return p.time + ((tick - p.tick) / TPB) * (60 / p.bpm);
  }

  timeToTick(time: number): number {
    const p = this.points;
    let idx = 0;
    for (let i = 0; i < p.length; i++) if (p[i].time <= time) idx = i;
    const pt = p[idx];
    return pt.tick + ((time - pt.time) * pt.bpm * TPB) / 60;
  }

  bpmAt(tick: number): number {
    return this.pointAtTick(tick).bpm;
  }

  private lastValue<K extends 'scroll' | 'gogo' | 'barline'>(kind: K, tick: number) {
    let v: EEvent | undefined;
    for (const e of this.course.events) {
      if (e.tick > tick) break;
      if (e.kind === kind) v = e;
    }
    return v as Extract<EEvent, { kind: K }> | undefined;
  }

  scrollAt(tick: number) {
    return this.lastValue('scroll', tick)?.value ?? 1;
  }
  gogoAt(tick: number) {
    return this.lastValue('gogo', tick)?.on ?? false;
  }
  barlineAt(tick: number) {
    return this.lastValue('barline', tick)?.on ?? true;
  }
}

/** 編集用モデル → プレイ用（秒ベース）に変換 */
export function toPlayable(chart: EChart, course: ECourse): Course {
  sortCourse(course);
  const t = new Timing(chart, course);
  const notes: Note[] = course.notes.map((n) => {
    const note: Note = {
      type: n.type,
      time: t.tickToTime(n.tick),
      bpm: t.bpmAt(n.tick),
      scroll: t.scrollAt(n.tick),
      gogo: t.gogoAt(n.tick),
    };
    if (n.endTick !== undefined) note.endTime = t.tickToTime(n.endTick);
    if (n.type === 'balloon') note.hits = n.hits ?? 5;
    return note;
  });
  const bars: BarLine[] = [];
  for (const m of measures(course, contentEnd(course))) {
    if (m.start > contentEnd(course)) break;
    if (!t.barlineAt(m.start)) continue;
    bars.push({ time: t.tickToTime(m.start), bpm: t.bpmAt(m.start), scroll: t.scrollAt(m.start) });
  }
  // ゴーゴー区間は「直前に通過したノーツ」ではなくイベントの時刻で決める
  // （#GOGOEND の後しばらくノーツがなくても、その時刻で解除されるように）
  const gogo: [number, number][] = [];
  let from: number | null = null;
  for (const e of course.events) {
    if (e.kind !== 'gogo') continue;
    const time = t.tickToTime(e.tick);
    if (e.on && from === null) from = time;
    else if (!e.on && from !== null) {
      gogo.push([from, time]);
      from = null;
    }
  }
  if (from !== null) gogo.push([from, Infinity]);
  return { name: course.name, level: course.level, notes, bars, gogo };
}
