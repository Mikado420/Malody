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
 * #BPMCHANGE があるときの選び方（speed）:
 * - 'scroll': #SCROLL の値そのものを滑らかに変える（BPM が変わるとそこで見た目の速さが跳ねる）
 * - 'visual': 見た目の速さ（BPM × SCROLL）を滑らかに変える。各位置の #SCROLL = その位置の見た目の速さ ÷ その位置の BPM。
 *             範囲の中の #BPMCHANGE の位置にも #SCROLL を置く（置かないとそこで速さが跳ねる）
 * 小節線（#MEASURE で長さが変わっても同じ）を対象に入れるかは barlines で選ぶ。
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
  /** #BPMCHANGE があるとき、何を滑らかにするか（無いときは 'scroll'） */
  speed?: 'scroll' | 'visual';
  /** 小節線の位置も対象にするか（無いときは入れる） */
  barlines?: boolean;
}

/** その位置の BPM を返す関数（譜面の最初の BPM と、難易度の #BPMCHANGE から） */
function bpmFn(c: ECourse, baseBpm: number) {
  const evs = c.events.filter((e) => e.kind === 'bpm' && e.value > 0) as { tick: number; value: number }[];
  evs.sort((a, b) => a.tick - b.tick);
  return (tick: number) => {
    let b = baseBpm > 0 ? baseBpm : 120;
    for (const e of evs) {
      if (e.tick > tick) break;
      b = e.value;
    }
    return b;
  };
}

/** 値を置く位置（tick、重なりなし・昇順） */
export function gradTargets(c: ECourse, g: Pick<Grad, 'start' | 'end' | 'speed' | 'barlines'>): number[] {
  const { start, end } = g;
  const set = new Set<number>();
  for (const n of c.notes) if (n.tick >= start && n.tick < end) set.add(n.tick);
  if (g.barlines !== false) for (const m of measures(c, end)) if (m.start >= start && m.start < end) set.add(m.start);
  if (g.speed === 'visual') for (const e of c.events) if (e.kind === 'bpm' && e.tick > start && e.tick < end) set.add(e.tick);
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

const interp = (mode: Grad['mode'], a: number, b: number, t: number) =>
  mode === 'geometric' ? a * Math.pow(b / a, t) : a + (b - a) * t;

/** このグラデで置く #SCROLL（終点の終了値を含む） */
export function gradScrolls(c: ECourse, g: Grad, baseBpm: number): { tick: number; value: number }[] {
  const ts = gradTargets(c, g);
  const n = ts.length;
  const out: { tick: number; value: number }[] = [];
  if (g.speed === 'visual') {
    // 見た目の速さ（BPM × SCROLL）を滑らかにする
    const bpm = bpmFn(c, baseBpm);
    const v0 = g.from * bpm(g.start);
    const v1 = g.to * bpm(g.end);
    ts.forEach((tick, k) => out.push({ tick, value: round(interp(g.mode, v0, v1, k / n) / bpm(tick), g.digits) }));
  } else {
    ts.forEach((tick, k) => out.push({ tick, value: round(interp(g.mode, g.from, g.to, k / n), g.digits) }));
  }
  out.push({ tick: g.end, value: round(g.to, g.digits) });
  return out;
}

/** 範囲 [start, end] の #SCROLL を、このグラデの値で置き直す */
export function applyGrad(c: ECourse, g: Grad, baseBpm: number) {
  c.events = c.events.filter((e) => !(e.kind === 'scroll' && e.tick >= g.start && e.tick <= g.end));
  for (const s of gradScrolls(c, g, baseBpm)) c.events.push({ tick: s.tick, kind: 'scroll', value: s.value });
}

/** 譜面の #SCROLL が、このグラデで置いたとおりになっているか（TJA のテキストを書き換えた後の確認用） */
export function gradMatches(c: ECourse, g: Grad, baseBpm: number, checkEnd = true): boolean {
  // 終点で次のグラデが始まるときは、終点の値は次のグラデの開始値で上書きされているので比べない
  const last = checkEnd ? g.end : g.end - 1;
  const want = gradScrolls(c, g, baseBpm).filter((s) => s.tick <= last);
  const have = c.events.filter((e) => e.kind === 'scroll' && e.tick >= g.start && e.tick <= last) as { tick: number; value: number }[];
  if (have.length !== want.length) return false;
  const sorted = [...have].sort((a, b) => a.tick - b.tick);
  return sorted.every((e, i) => e.tick === want[i].tick && Math.abs(e.value - want[i].value) < 1e-9);
}
