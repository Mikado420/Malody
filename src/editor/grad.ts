import { measures, type ECourse } from '../chart/model';

/**
 * グラデ（#SCROLL を少しずつ変えて、音符の見た目を滑らかに加速・減速させる）。
 *
 * 決まり:
 * - 対象は範囲 [start, end) の中の「音符（1〜7。連打・風船は始まりだけ。8 は対象外）」と「小節の頭（小節線）」の位置
 * - 対象の数を n として、開始値から終了値までを n 等分し、k 番目（0 から）の対象の直前に値を置く
 *   等差: from + (to - from) * k / n、等比: from * (to / from)^(k / n)
 * - 終点 end には終了値を置く
 *
 * グラデの設定はエディタの中だけで覚えておき、.tja には書き込まない（書き出すのは普通の #SCROLL）。
 */
export interface Grad {
  start: number;
  end: number;
  from: number;
  to: number;
  mode: 'linear' | 'geometric';
  /** 小数の桁数 */
  digits: number;
}

/** 値を置く位置（tick、重なりなし・昇順） */
export function gradTargets(c: ECourse, start: number, end: number): number[] {
  const set = new Set<number>();
  for (const n of c.notes) if (n.tick >= start && n.tick < end) set.add(n.tick);
  for (const m of measures(c, end)) if (m.start >= start && m.start < end) set.add(m.start);
  return [...set].sort((a, b) => a - b);
}

export function gradValid(g: Pick<Grad, 'from' | 'to' | 'mode'>): string | null {
  if (!Number.isFinite(g.from) || !Number.isFinite(g.to)) return '数値を入力してください';
  if (g.mode === 'geometric' && !(g.from * g.to > 0)) return '等比は、開始値と終了値が両方とも正（または両方とも負）のときだけ使えます';
  return null;
}

const round = (v: number, digits: number) => {
  const r = Number(v.toFixed(Math.max(0, Math.min(6, Math.round(digits)))));
  return Object.is(r, -0) ? 0 : r;
};

/** k / n の位置の値 */
export function gradValue(g: Grad, k: number, n: number): number {
  const t = n > 0 ? k / n : 1;
  const v = g.mode === 'geometric' ? g.from * Math.pow(g.to / g.from, t) : g.from + (g.to - g.from) * t;
  return round(v, g.digits);
}

/** このグラデで置く #SCROLL（終点の終了値を含む） */
export function gradScrolls(c: ECourse, g: Grad): { tick: number; value: number }[] {
  const ts = gradTargets(c, g.start, g.end);
  const out = ts.map((tick, k) => ({ tick, value: gradValue(g, k, ts.length) }));
  out.push({ tick: g.end, value: round(g.to, g.digits) });
  return out;
}

/** 範囲 [start, end] の #SCROLL を、このグラデの値で置き直す */
export function applyGrad(c: ECourse, g: Grad) {
  c.events = c.events.filter((e) => !(e.kind === 'scroll' && e.tick >= g.start && e.tick <= g.end));
  for (const s of gradScrolls(c, g)) c.events.push({ tick: s.tick, kind: 'scroll', value: s.value });
}

/** 譜面の #SCROLL が、このグラデで置いたとおりになっているか（TJA のテキストを書き換えた後の確認用） */
export function gradMatches(c: ECourse, g: Grad, checkEnd = true): boolean {
  // 終点で次のグラデが始まるときは、終点の値は次のグラデの開始値で上書きされているので比べない
  const last = checkEnd ? g.end : g.end - 1;
  const want = gradScrolls(c, g).filter((s) => s.tick <= last);
  const have = c.events.filter((e) => e.kind === 'scroll' && e.tick >= g.start && e.tick <= last) as { tick: number; value: number }[];
  if (have.length !== want.length) return false;
  const sorted = [...have].sort((a, b) => a.tick - b.tick);
  return sorted.every((e, i) => e.tick === want[i].tick && Math.abs(e.value - want[i].value) < 1e-9);
}
