import type { LogEntry } from '../engine/game';

/** 叩いた位置の見本。pos は画面中央からの横の距離（画面の幅の半分 = 1）、don はドンのつもりだったか */
export interface ZoneSample {
  pos: number;
  don: boolean;
}

/**
 * プレイの記録から「どこを叩いたら何のつもりだったか」を集める。
 * - 判定された打撃: 叩いた色がそのまま狙った色
 * - 色違いで見逃した音符: その音符の近く（114ms 以内）の別の色の打撃は、本当は音符の色を狙っていた
 */
export function zoneSamples(log: readonly LogEntry[], donWidth: number): ZoneSample[] {
  type Tap = Extract<LogEntry, { e: 'tap' }>;
  const taps = log.filter((x): x is Tap => x.e === 'tap' && x.ring !== undefined);
  const out: ZoneSample[] = [];
  const used = new Set<Tap>();
  for (const m of log) {
    if (m.e !== 'miss') continue;
    const isDon = m.type === 'don' || m.type === 'bigDon';
    const tap = taps.find(
      (t) => !used.has(t) && t.res !== 'judged' && Math.abs(t.t - m.t) <= 0.114 && (t.kind === 'don') !== isDon,
    );
    if (tap) {
      used.add(tap);
      out.push({ pos: tap.ring! * donWidth, don: isDon });
    }
  }
  for (const t of taps) {
    if (used.has(t) || t.res !== 'judged') continue;
    out.push({ pos: t.ring! * donWidth, don: t.kind === 'don' });
  }
  return out;
}

export const DON_WIDTH_MIN = 0.3;
export const DON_WIDTH_MAX = 0.9;

/** 間違いがいちばん少なくなるドンの帯の幅。今の幅より 2 回以上減らないときは null */
export function suggestDonWidth(samples: readonly ZoneSample[], current: number): { width: number; before: number; after: number } | null {
  const errors = (w: number) => samples.reduce((n, s) => n + ((s.pos <= w) !== s.don ? 1 : 0), 0);
  const before = errors(current);
  let best = before;
  const bestWs: number[] = [];
  for (let i = Math.round(DON_WIDTH_MIN * 100); i <= Math.round(DON_WIDTH_MAX * 100); i++) {
    const w = i / 100;
    const e = errors(w);
    if (e < best) {
      best = e;
      bestWs.length = 0;
    }
    if (e === best) bestWs.push(w);
  }
  if (best > before - 2 || !bestWs.length) return null;
  // 同じ間違いの数になる幅のうち、境目からいちばん余裕がある真ん中を選ぶ（連続した範囲のうち今の幅に近いもの）
  const runs: number[][] = [];
  for (const w of bestWs) {
    const last = runs[runs.length - 1];
    if (last && Math.abs(w - last[last.length - 1] - 0.01) < 1e-9) last.push(w);
    else runs.push([w]);
  }
  const mid = (r: number[]) => (r[0] + r[r.length - 1]) / 2;
  runs.sort((a, b) => Math.abs(mid(a) - current) - Math.abs(mid(b) - current));
  const width = Math.round(mid(runs[0]) * 100) / 100;
  return { width, before, after: best };
}
