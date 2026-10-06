/**
 * 測ったテンポの案（TempoPlan）を手で直す操作。
 * 区間 = 最初の BPM（tick 0 から）と、#BPMCHANGE ごとの範囲。どの操作も、直した区間より後ろの区間が
 * 音源の同じ時刻に来るように（後ろがずれないように）、区間の拍数を切りのよい数（1 拍・半拍・1/4 拍）に合わせ直す。
 * DOM に依存しない（テストできるように）。
 */
import { planTimeAt, type Meter, type TempoPlan } from '../audio/tempo';

export interface Sec {
  /** 区間の番号（0 = 最初の BPM） */
  i: number;
  /** 区間の始まり・終わりの tick（終わりは次の区間の始まり。最後の区間は Infinity） */
  s: number;
  e: number;
  bpm: number;
}

const clone = (p: TempoPlan): TempoPlan => ({ bpm: p.bpm, offset: p.offset, changes: p.changes.map((c) => ({ ...c })), measures: p.measures.map((m) => ({ ...m })) });
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const same = (a: Meter, b: Meter) => a.num * b.den === b.num * a.den && a.den === b.den;

export function sections(p: TempoPlan): Sec[] {
  const out: Sec[] = [{ i: 0, s: 0, e: p.changes[0]?.tick ?? Infinity, bpm: p.bpm }];
  p.changes.forEach((c, k) => out.push({ i: k + 1, s: c.tick, e: p.changes[k + 1]?.tick ?? Infinity, bpm: c.bpm }));
  return out;
}

/** 時刻（秒）→ tick（区間の BPM で数える。最初の区間は tick 0 より前にも伸ばす） */
export function tickAtTime(p: TempoPlan, tpb: number, t: number): number {
  const secs = sections(p);
  for (const s of secs) {
    const ts = planTimeAt(p, tpb, s.s);
    const te = s.e === Infinity ? Infinity : planTimeAt(p, tpb, s.e);
    if (t < te || s.i === secs.length - 1) return s.s + ((t - ts) * s.bpm * tpb) / 60;
  }
  return 0;
}

/** その時刻の区間の番号 */
export function sectionAtTime(p: TempoPlan, tpb: number, t: number): number {
  const tick = tickAtTime(p, tpb, t);
  const secs = sections(p);
  for (let i = secs.length - 1; i > 0; i--) if (tick >= secs[i].s) return i;
  return 0;
}

/** 拍数を切りのよい数に（1 拍に近ければ 1 拍単位、次に半拍、1/4 拍）。最低 1/4 拍 */
export function quantBeats(x: number): number {
  for (const q of [1, 2, 4]) {
    const r = Math.round(x * q) / q;
    if (Math.abs(x - r) < 0.12 / q || q === 4) return Math.max(0.25, r);
  }
  return Math.max(0.25, x);
}

/** その tick に効いている拍子 */
export function meterAt(p: TempoPlan, tick: number): Meter {
  let m: Meter = { num: 4, den: 4 };
  for (const x of p.measures) if (x.tick <= tick) m = { num: x.num, den: x.den };
  return m;
}

/** 拍子の並びを整える（同じ tick は後のもの、前と同じ拍子は消す） */
function tidyMeasures(p: TempoPlan) {
  const byTick = new Map<number, { tick: number; num: number; den: number }>();
  for (const m of [...p.measures].sort((a, b) => a.tick - b.tick)) byTick.set(Math.max(0, Math.round(m.tick)), { ...m, tick: Math.max(0, Math.round(m.tick)) });
  const out: typeof p.measures = [];
  let prev: Meter = { num: 4, den: 4 };
  for (const m of [...byTick.values()].sort((a, b) => a.tick - b.tick)) {
    if (same(m, prev)) continue;
    out.push(m);
    prev = m;
  }
  p.measures = out;
}

function tidy(p: TempoPlan): TempoPlan {
  p.changes = p.changes.map((c) => ({ tick: Math.round(c.tick), bpm: r3(c.bpm) })).sort((a, b) => a.tick - b.tick);
  // 同じ所の変わり目は後のものだけ残す（前と同じ BPM の変わり目は、分けたばかりの区間のこともあるので残す）
  const out: typeof p.changes = [];
  for (const c of p.changes) {
    if (c.tick <= 0) continue;
    if (out.length && out[out.length - 1].tick === c.tick) { out[out.length - 1] = c; continue; }
    out.push(c);
  }
  p.changes = out;
  p.offset = r3(p.offset);
  tidyMeasures(p);
  return p;
}

/** from 以降（from を含む）の変わり目と拍子を delta tick ずらす */
function shiftFrom(p: TempoPlan, from: number, delta: number, skipChange = -1) {
  if (!delta) return;
  p.changes.forEach((c, k) => { if (k !== skipChange && c.tick >= from) c.tick += delta; });
  p.measures.forEach((m) => { if (m.tick >= from) m.tick += delta; });
}

/** 区間 i の BPM を b にする。区間の長さ（秒）はほぼそのまま（拍数を合わせ直す）なので、後ろの区間の時刻は変わらない */
export function setBpm(p0: TempoPlan, tpb: number, i: number, b: number): TempoPlan {
  if (!(b > 0)) return p0;
  const p = clone(p0);
  const sec = sections(p)[i];
  if (!sec) return p0;
  if (sec.e !== Infinity) {
    const oldLen = (sec.e - sec.s) / tpb;
    const newLen = quantBeats((oldLen * b) / sec.bpm);
    shiftFrom(p, sec.e, Math.round((newLen - oldLen) * tpb));
  }
  if (i === 0) p.bpm = r3(b);
  else p.changes[i - 1].bpm = r3(b);
  return tidy(p);
}

/** 区間 k（1 以上）の始まりを toTick へ動かす（前の区間の拍に合わせる）。区間 k の終わりの時刻は変えない */
export function moveBoundary(p0: TempoPlan, tpb: number, k: number, toTick: number): TempoPlan {
  const secs = sections(p0);
  const prev = secs[k - 1];
  const cur = secs[k];
  if (!prev || !cur || k < 1) return p0;
  let to = prev.s + Math.round((toTick - prev.s) / tpb) * tpb;
  to = Math.max(to, prev.s + tpb, 1);
  const p = clone(p0);
  const tPrev = planTimeAt(p0, tpb, prev.s);
  const tsNew = tPrev + ((to - prev.s) / tpb) * (60 / prev.bpm);
  if (cur.e === Infinity) {
    shiftFrom(p, cur.s, to - cur.s, k - 1);
    p.changes[k - 1].tick = to;
    return tidy(p);
  }
  const tEnd = planTimeAt(p0, tpb, cur.e);
  // 区間 k は少なくとも 1 拍残す
  const minLen = 60 / cur.bpm;
  if (tsNew > tEnd - minLen + 1e-6) {
    const maxBeats = Math.floor(((tEnd - minLen - tPrev) * prev.bpm) / 60);
    if (maxBeats < 1) return p0;
    return moveBoundary(p0, tpb, k, prev.s + maxBeats * tpb);
  }
  const newLen = quantBeats(((tEnd - tsNew) * cur.bpm) / 60);
  const newE = to + Math.round(newLen * tpb);
  // 区間 k の中の拍子の変わり目は区間の頭と一緒に動かし、後ろの区間は終わりの合わせ直しの分だけずらす
  p.measures.forEach((m) => {
    if (m.tick >= cur.e) m.tick += newE - cur.e;
    else if (m.tick >= cur.s) m.tick += to - cur.s;
  });
  p.changes.forEach((c, j) => { if (j > k - 1) c.tick += newE - cur.e; });
  p.changes[k - 1].tick = to;
  return tidy(p);
}

/** 時刻 t のいちばん近い拍で区間を 2 つに分ける。新しい区間の番号を返す（分けられないときは null） */
export function splitAt(p0: TempoPlan, tpb: number, t: number): { plan: TempoPlan; index: number } | null {
  const tick0 = tickAtTime(p0, tpb, t);
  const secs = sections(p0);
  const i = sectionAtTime(p0, tpb, t);
  const sec = secs[i];
  const tick = sec.s + Math.round((tick0 - sec.s) / tpb) * tpb;
  if (tick <= sec.s || tick >= sec.e || tick <= 0) return null;
  const p = clone(p0);
  p.changes.splice(i, 0, { tick, bpm: sec.bpm });
  return { plan: tidy(p), index: i + 1 };
}

/** 区間 i を消す（前の区間がその時間まで伸びる。最初の区間なら次の区間が前に伸びる） */
export function removeSection(p0: TempoPlan, tpb: number, i: number): TempoPlan | null {
  const secs = sections(p0);
  if (secs.length < 2 || !secs[i]) return null;
  const p = clone(p0);
  if (i === 0) {
    const next = secs[1];
    const T0 = -p0.offset;
    const T1 = planTimeAt(p0, tpb, next.s);
    const back = quantBeats(((T1 - T0) * next.bpm) / 60);
    const d = next.s - Math.round(back * tpb);
    p.bpm = next.bpm;
    p.offset = -(T1 - (back * 60) / next.bpm);
    p.changes.shift();
    p.changes.forEach((c) => { c.tick -= d; });
    p.measures.forEach((m) => { m.tick -= d; });
    return tidy(p);
  }
  const prev = secs[i - 1];
  const cur = secs[i];
  if (cur.e !== Infinity) {
    const D = planTimeAt(p0, tpb, cur.e) - planTimeAt(p0, tpb, cur.s);
    const newLen = quantBeats((D * prev.bpm) / 60);
    shiftFrom(p, cur.e, Math.round(cur.s + newLen * tpb) - cur.e);
  }
  p.changes.splice(i - 1, 1);
  return tidy(p);
}

/** 1 拍目（tick 0）を最初の区間の n 拍ぶん動かす。音源に対する拍の位置は変えない */
export function shiftDownbeat(p0: TempoPlan, tpb: number, n: number): TempoPlan {
  const p = clone(p0);
  // 最初の変わり目より後ろへは動かせない（最初の区間が 1 拍は残るように）
  const first = p.changes[0]?.tick;
  if (first !== undefined) n = Math.min(n, Math.floor(first / tpb) - 1);
  if (!n) return p0;
  p.offset = -(-p.offset + (n * 60) / p.bpm);
  p.changes.forEach((c) => { c.tick -= n * tpb; });
  // 拍子: 頭より前に出たものは、いちばん後のものを頭に
  let lead: { tick: number; num: number; den: number } | null = null;
  p.measures = p.measures.flatMap((m) => {
    const t = m.tick - n * tpb;
    if (t <= 0) { lead = { ...m, tick: 0 }; return []; }
    return [{ ...m, tick: t }];
  });
  if (lead) p.measures.unshift(lead);
  return tidy(p);
}

/** OFFSET の微調整（秒、＋で拍が後ろへ） */
export function nudge(p0: TempoPlan, dt: number): TempoPlan {
  const p = clone(p0);
  p.offset = r3(p.offset - dt);
  return p;
}

/** 区間 i の拍子を m にする（区間の後ろは前の拍子に戻す） */
export function setMeter(p0: TempoPlan, i: number, m: Meter): TempoPlan {
  const p = clone(p0);
  const sec = sections(p)[i];
  if (!sec) return p0;
  const after = sec.e === Infinity ? null : meterAt(p0, sec.e);
  const hasAtEnd = p.measures.some((x) => x.tick === sec.e);
  p.measures = p.measures.filter((x) => x.tick < sec.s || x.tick >= sec.e);
  p.measures.push({ tick: Math.max(0, sec.s), num: m.num, den: m.den });
  if (after && !hasAtEnd) p.measures.push({ tick: sec.e, num: after.num, den: after.den });
  return tidy(p);
}
