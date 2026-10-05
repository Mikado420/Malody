import {
  measureAt, measures, newChart, newCourse, sortCourse, Timing, TPB, contentEnd, isLong,
  type EChart, type ECourse, type EEvent, type ENote, type Measure,
} from '../chart/model';
import type { NoteType } from '../chart/types';
import type { AudioFile } from '../io/load';
import { applyGrad, gradMatches, type Grad } from './grad';

export type Tool = NoteType | 'erase' | 'gogo' | 'grad';

/** 1拍あたりの分割数（Malody の 1/n 表記と同じ） */
export const DIVISORS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

export interface TapResult {
  message?: string;
  /** UI 側で打数を聞く風船 */
  editBalloon?: ENote;
  /** UI 側で設定を聞くグラデ（新しく作る範囲） */
  newGrad?: { start: number; end: number };
  /** UI 側で設定を変えるグラデ */
  editGrad?: Grad;
}

/**
 * エディタの状態と編集操作。描画・DOM からは独立。
 * 変更はすべて mutate() を通すので Undo/Redo と自動保存が効く。
 */
export class Editor {
  chart: EChart;
  courseIndex = 0;
  audio: AudioFile | null = null;
  tool: Tool = 'don';
  divisor = 4;
  /** 連打・風船・ゴーゴーの始点（終点のタップ待ち） */
  pendingLong: number | null = null;
  timing!: Timing;

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<(structural: boolean) => void>();
  private measureCache: Measure[] = [];

  constructor(chart: EChart = newChart()) {
    this.chart = chart;
    this.refresh();
  }

  get course(): ECourse {
    return this.chart.courses[this.courseIndex];
  }

  onChange(fn: (structural: boolean) => void) {
    this.listeners.add(fn);
  }

  /** structural=true: 譜面の内容が変わった（保存対象） */
  emit(structural = false) {
    if (structural) this.refresh();
    for (const fn of this.listeners) fn(structural);
  }

  private refresh() {
    if (!this.chart.courses.length) this.chart.courses.push(newCourse());
    this.courseIndex = Math.min(this.courseIndex, this.chart.courses.length - 1);
    for (const c of this.chart.courses) sortCourse(c);
    this.timing = new Timing(this.chart, this.course);
    this.measureCache = [];
  }

  load(chart: EChart, audio: AudioFile | null, courseIndex?: number) {
    this.chart = chart;
    this.audio = audio;
    // 指定がなければ一番難しい（最後の）難易度を開く
    this.courseIndex = courseIndex ?? Math.max(0, chart.courses.length - 1);
    this.pendingLong = null;
    this.undoStack = [];
    this.redoStack = [];
    this.emit(true);
  }

  // ---------- Undo / Redo ----------

  private snapshot() {
    return JSON.stringify({ chart: this.chart, courseIndex: this.courseIndex });
  }

  private restore(s: string) {
    const o = JSON.parse(s) as { chart: EChart; courseIndex: number };
    this.chart = o.chart;
    this.courseIndex = o.courseIndex;
    this.pendingLong = null;
    this.emit(true);
  }

  mutate(fn: () => void) {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    fn();
    this.applyGrads();
    this.emit(true);
  }

  /** グラデの範囲の #SCROLL を置き直す（範囲の中の音符が増えたり減ったりしても、値が合うように） */
  private applyGrads() {
    for (const c of this.chart.courses) {
      if (!c.grads?.length) continue;
      sortCourse(c);
      for (const g of c.grads) applyGrad(c, g);
    }
  }

  /**
   * 譜面全体を差し替える（TJA のテキストを書き換えたとき）。
   * pushUndo = false のときは元に戻すの記録を増やさない（入力中の自動反映は、書き始めの 1 回だけ記録する）
   */
  replaceChart(chart: EChart, pushUndo = true) {
    const apply = () => {
      const name = this.chart.courses[this.courseIndex]?.name;
      // グラデは .tja に書かないので、前の譜面から引き継ぐ。#SCROLL がグラデのとおりに残っているものだけ
      for (const c of chart.courses) {
        const old = this.chart.courses.find((o) => o.name === c.name);
        if (!old?.grads?.length) continue;
        sortCourse(c);
        const keep = old.grads.filter((g) => gradMatches(c, g, !old.grads!.some((o) => o !== g && o.start === g.end)));
        if (keep.length) c.grads = keep.map((g) => ({ ...g }));
      }
      this.chart = chart;
      const i = chart.courses.findIndex((c) => c.name === name);
      this.courseIndex = i >= 0 ? i : Math.max(0, Math.min(this.courseIndex, chart.courses.length - 1));
      this.pendingLong = null;
    };
    if (pushUndo) this.mutate(apply);
    else {
      apply();
      this.emit(true);
    }
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  // ---------- 小節・スナップ ----------

  measuresUntil(tick: number): Measure[] {
    const last = this.measureCache[this.measureCache.length - 1];
    if (!last || last.start + last.length <= tick) {
      this.measureCache = measures(this.course, Math.max(tick, contentEnd(this.course)) + TPB * 64);
    }
    return this.measureCache;
  }

  measureOf(tick: number): Measure {
    return measureAt(this.measuresUntil(Math.max(0, tick)), Math.max(0, tick));
  }

  get step() {
    return TPB / this.divisor;
  }

  snap(tick: number): number {
    if (tick <= 0) return 0;
    const m = this.measureOf(tick);
    const step = this.step;
    return Math.max(0, m.start + Math.round((tick - m.start) / step) * step);
  }

  /** 「小節 3 ・ 2.5拍」のような表示 */
  label(tick: number): string {
    const m = this.measureOf(tick);
    const beat = (tick - m.start) / TPB + 1;
    return `${m.index + 1}小節 ${Number(beat.toFixed(3))}拍`;
  }

  // ---------- ノーツ ----------

  private noteAt(tick: number) {
    return this.course.notes.find((n) => n.tick === tick);
  }

  /** tick が連打・風船の途中〜終点にあるならそのノーツ */
  private longCovering(tick: number) {
    return this.course.notes.find(
      (n) => n.endTick !== undefined && n.tick < tick && tick <= n.endTick,
    );
  }

  private remove(n: ENote) {
    const i = this.course.notes.indexOf(n);
    if (i >= 0) this.course.notes.splice(i, 1);
  }

  tap(rawTick: number): TapResult {
    const tick = this.snap(rawTick);
    const tool = this.tool;
    const exact = this.noteAt(tick);
    const covering = this.longCovering(tick);

    if (tool === 'gogo') return this.tapGogo(tick);
    if (tool === 'grad') return this.tapGrad(tick);

    // 置いてあるノーツ（連打・風船はその範囲のどこでも）をタップしたら、選んでいる音符に関係なく消す。
    // ただし風船を選んでいて風船の始点をタップしたときは、打数を変える
    const target = exact ?? covering;
    if (this.pendingLong === null && target) {
      if (tool === 'balloon' && target === exact && exact.type === 'balloon') return { editBalloon: exact };
      this.mutate(() => this.remove(target));
      return {};
    }
    if (tool === 'erase') return {};

    if (!isLong(tool)) {
      this.mutate(() => this.course.notes.push({ tick, type: tool }));
      return {};
    }

    // 連打・風船
    if (this.pendingLong === null) {
      this.pendingLong = tick;
      this.emit();
      return { message: '終点をタップしてください（始点をもう一度タップで取り消し）' };
    }

    const a = this.pendingLong;
    this.pendingLong = null;
    if (tick === a) {
      this.emit();
      return { message: '取り消しました' };
    }
    const start = Math.min(a, tick);
    const end = Math.max(a, tick);
    this.mutate(() => {
      // 範囲内のノーツと重なる連打を消す
      this.course.notes = this.course.notes.filter((n) => {
        const nEnd = n.endTick ?? n.tick;
        return nEnd < start || n.tick > end;
      });
      const note: ENote = { tick: start, type: tool, endTick: end };
      if (tool === 'balloon') note.hits = Math.max(3, Math.round(((end - start) / TPB) * 2));
      this.course.notes.push(note);
    });
    return {};
  }

  /** ゴーゴータイムの区間 [始まり, 終わり]（終わりがなければ Infinity） */
  gogoRanges(): [number, number][] {
    const ranges: [number, number][] = [];
    let from: number | null = null;
    for (const e of this.course.events) {
      if (e.kind !== 'gogo') continue;
      if (e.on && from === null) from = e.tick;
      if (!e.on && from !== null) { ranges.push([from, e.tick]); from = null; }
    }
    if (from !== null) ranges.push([from, Infinity]);
    return ranges;
  }

  /** ゴーゴー: 始点と終点をタップして区間を作る。区間の中をタップするとその区間を消す */
  private tapGogo(tick: number): TapResult {
    const ranges = this.gogoRanges();
    if (this.pendingLong === null) {
      const hit = ranges.find(([a, b]) => tick >= a && tick < b);
      if (hit) {
        this.mutate(() => {
          this.course.events = this.course.events.filter(
            (e) => !(e.kind === 'gogo' && e.tick >= hit[0] && (hit[1] === Infinity || e.tick <= hit[1])),
          );
        });
        return { message: 'ゴーゴーを消しました' };
      }
      this.pendingLong = tick;
      this.emit();
      return { message: 'ゴーゴーの終点をタップしてください（始点をもう一度タップで取り消し）' };
    }
    const p = this.pendingLong;
    this.pendingLong = null;
    if (tick === p) {
      this.emit();
      return { message: '取り消しました' };
    }
    let start = Math.min(p, tick);
    let end = Math.max(p, tick);
    // 重なる・つながる区間はひとつにまとめる
    for (const [a, b] of ranges) {
      if (a <= end && b >= start) {
        start = Math.min(start, a);
        end = Math.max(end, b === Infinity ? end : b);
      }
    }
    this.mutate(() => {
      this.course.events = this.course.events.filter((e) => !(e.kind === 'gogo' && e.tick >= start && e.tick <= end));
      this.course.events.push({ tick: start, kind: 'gogo', on: true }, { tick: end, kind: 'gogo', on: false });
    });
    return {};
  }

  /** その位置を含むグラデ */
  gradAt(tick: number): Grad | undefined {
    return this.course.grads?.find((g) => tick >= g.start && tick <= g.end);
  }

  /** グラデ: 始点と終点をタップして範囲を決める（設定は UI 側で聞く）。グラデの中をタップするとその設定を開く */
  private tapGrad(tick: number): TapResult {
    if (this.pendingLong === null) {
      const g = this.gradAt(tick);
      if (g) return { editGrad: g };
      this.pendingLong = tick;
      this.emit();
      return { message: 'グラデの終点をタップしてください（始点をもう一度タップで取り消し）' };
    }
    const p = this.pendingLong;
    this.pendingLong = null;
    this.emit();
    if (tick === p) return { message: '取り消しました' };
    return { newGrad: { start: Math.min(p, tick), end: Math.max(p, tick) } };
  }

  /** グラデを追加・変更する（old を渡すと置き換え）。重なる別のグラデは外す（その #SCROLL は新しい値で上書き） */
  setGrad(g: Grad, old?: Grad) {
    this.mutate(() => {
      const c = this.course;
      const list = (c.grads ?? []).filter((x) => x !== old && (x.end <= g.start || x.start >= g.end));
      if (old) c.events = c.events.filter((e) => !(e.kind === 'scroll' && e.tick >= old.start && e.tick <= old.end));
      list.push(g);
      list.sort((a, b) => a.start - b.start);
      c.grads = list;
    });
  }

  /** グラデを消す（置いていた #SCROLL も消す） */
  removeGrad(g: Grad) {
    this.mutate(() => {
      const c = this.course;
      c.grads = (c.grads ?? []).filter((x) => x !== g);
      c.events = c.events.filter((e) => !(e.kind === 'scroll' && e.tick >= g.start && e.tick <= g.end));
    });
  }

  setBalloonHits(n: ENote, hits: number) {
    if (!(hits > 0)) return;
    this.mutate(() => { n.hits = Math.round(hits); });
  }

  // ---------- イベント ----------

  addEvent(ev: EEvent) {
    if (ev.kind === 'measure') ev = { ...ev, tick: this.measureOf(ev.tick).start };
    this.mutate(() => {
      const ev2 = ev;
      this.course.events = this.course.events.filter((e) => !(e.tick === ev2.tick && e.kind === ev2.kind));
      this.course.events.push(ev2);
    });
  }

  removeEvent(ev: EEvent) {
    this.mutate(() => {
      this.course.events = this.course.events.filter((e) => e !== ev);
    });
  }

  // ---------- 難易度 ----------

  selectCourse(i: number) {
    this.courseIndex = i;
    this.pendingLong = null;
    this.emit(true);
  }

  addCourse(name: string, level: number, copyFrom?: ECourse) {
    this.mutate(() => {
      const c = copyFrom
        ? { ...(JSON.parse(JSON.stringify(copyFrom)) as ECourse), name, level }
        : newCourse(name, level);
      this.chart.courses.push(c);
      this.courseIndex = this.chart.courses.length - 1;
    });
  }

  removeCourse(i: number) {
    if (this.chart.courses.length <= 1) return;
    this.mutate(() => {
      this.chart.courses.splice(i, 1);
      this.courseIndex = Math.min(this.courseIndex, this.chart.courses.length - 1);
    });
  }
}
