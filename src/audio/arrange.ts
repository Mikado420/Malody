/**
 * 音源の切り貼り（クリップを並べて、新しい音源を作る）。
 *
 * クリップ = 音源 srcId の src 秒から len 秒ぶんを、トラック track の、新しい音源の pos 秒の所に置いたもの。
 * 音源 0 は譜面の音源（譜面の OFFSET はこの音源の時刻で決める）。ほかは足した音源。
 * トラックどうしは足し合わせる（FL Studio のように重ねられる）。
 * 同じトラックの中では、配列の後ろのクリップほど上にあり、重なった所は上のクリップの音になる。
 * 音量はクリップごとのオートメーション（点を線でつないだもの、FL Studio のオートメーションのように）。
 * 点の時刻は元の音源の時刻で持つので、分けても端を詰めても音と点の位置は変わらない。
 * 上のクリップの音量が 1 より小さい所は、下の音と混ぜる（フェードインを重ねればクロスフェード）。
 * クリップの無い所は無音（頭を空ければ「頭に無音」）。
 * 並べる時刻（pos）は 0 より前にもできる。新しい音源は 0 秒か、いちばん前のクリップのどちらか前から始まる
 * （arrangeStart。0 より前に置いた分だけ音源が前に伸びる）。
 */

/** オートメーションの点: 元の音源の s 秒で音量 v（0〜1） */
export interface EnvPoint {
  s: number;
  v: number;
}

export interface Clip {
  /** 元の音源の、使い始めの位置（秒） */
  src: number;
  /** 長さ（秒） */
  len: number;
  /** 新しい音源の中の位置（秒） */
  pos: number;
  /** トラック（0 から） */
  track: number;
  /** 音源（0 = 譜面の音源） */
  srcId: number;
  /** 音量のオートメーション（s の順。空なら音量 1 のまま） */
  env: EnvPoint[];
}

/** クリップのいちばん短い長さ（秒） */
export const MIN_LEN = 0.05;

export const clipEnd = (c: Clip) => c.pos + c.len;

/** 並べた時刻での、いちばん後ろのクリップの終わり */
export function arrangeLength(clips: Clip[]) {
  return clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

/** 新しい音源の頭の、並べた時刻（0 か、0 より前に置いたいちばん前のクリップ） */
export function arrangeStart(clips: Clip[]) {
  return clips.reduce((m, c) => Math.min(m, c.pos), 0);
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** 元の音源の s 秒での音量（点のあいだは直線、最初の点より前・最後の点より後ろはその点の音量） */
export function envAt(env: EnvPoint[], s: number): number {
  if (!env.length) return 1;
  if (s <= env[0].s) return env[0].v;
  for (let i = 1; i < env.length; i++) {
    const b = env[i];
    if (s <= b.s) {
      const a = env[i - 1];
      return b.s - a.s < 1e-9 ? b.v : a.v + ((b.v - a.v) * (s - a.s)) / (b.s - a.s);
    }
  }
  return env[env.length - 1].v;
}

/** 点を時刻の順に並べ、音量を 0〜1 に */
export function sortEnv(env: EnvPoint[]): EnvPoint[] {
  return env.map((p) => ({ s: r3(p.s), v: Math.round(Math.max(0, Math.min(1, p.v)) * 1000) / 1000 })).sort((a, b) => a.s - b.s);
}

/** フェードイン: クリップの頭から d 秒で 0 → 今の音量（その間にあった点は消す） */
export function addFadeIn(c: Clip, d: number): Clip {
  const a = c.src;
  const b = c.src + Math.min(d, c.len);
  const top = envAt(c.env, b);
  return { ...c, env: sortEnv([...c.env.filter((p) => p.s < a - 1e-6 || p.s > b + 1e-6), { s: a, v: 0 }, { s: b, v: top }]) };
}

/** フェードアウト: クリップの終わりの d 秒前から 今の音量 → 0 */
export function addFadeOut(c: Clip, d: number): Clip {
  const b = c.src + c.len;
  const a = b - Math.min(d, c.len);
  const top = envAt(c.env, a);
  return { ...c, env: sortEnv([...c.env.filter((p) => p.s < a - 1e-6 || p.s > b + 1e-6), { s: a, v: top }, { s: b, v: 0 }]) };
}

/** 新しい音源の t 秒で、上にあるクリップの番号（track を渡すとそのトラックの中だけ。無ければ -1） */
export function clipAt(clips: Clip[], t: number, track = -1): number {
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    if ((track < 0 || c.track === track) && t >= c.pos && t < clipEnd(c)) return i;
  }
  return -1;
}

/** i 番のクリップを、新しい音源の t 秒の所で 2 つに分ける（分けた後ろのほうは i + 1 番） */
export function splitClip(clips: Clip[], i: number, t: number): Clip[] | null {
  const c = clips[i];
  if (!c) return null;
  const d = r3(t - c.pos);
  if (d < MIN_LEN || c.len - d < MIN_LEN) return null;
  // オートメーションは元の音源の時刻で持っているので、両方にそのまま写す
  const a = { ...c, len: d, env: c.env.map((p) => ({ ...p })) };
  const b = { ...c, src: r3(c.src + d), pos: r3(c.pos + d), len: r3(c.len - d), env: c.env.map((p) => ({ ...p })) };
  return [...clips.slice(0, i), a, b, ...clips.slice(i + 1)];
}

/** i 番のクリップをいちばん上へ（動かしたクリップが重なりの上に来るように）。新しい番号も返す */
export function bringToTop(clips: Clip[], i: number): { clips: Clip[]; index: number } {
  if (i < 0 || i === clips.length - 1) return { clips, index: i };
  return { clips: [...clips.slice(0, i), ...clips.slice(i + 1), clips[i]], index: clips.length - 1 };
}

/** 左の端を新しい音源の t 秒へ（中身はその場のまま、見える所だけ変わる） */
export function trimStart(c: Clip, t: number): Clip {
  let d = t - c.pos;
  d = Math.max(-c.src, Math.min(c.len - MIN_LEN, d));
  return { ...c, pos: r3(c.pos + d), src: r3(c.src + d), len: r3(c.len - d) };
}

/** 右の端を新しい音源の t 秒へ */
export function trimEnd(c: Clip, t: number, dur: number): Clip {
  const len = Math.max(MIN_LEN, Math.min(dur - c.src, t - c.pos));
  return { ...c, len: r3(len) };
}

/** 譜面の音源の t 秒が、新しい音源の何秒になるか（その音を使っている上のクリップで。使っていなければ null） */
export function mapTime(clips: Clip[], t: number): number | null {
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    if (c.srcId === 0 && t >= c.src && t < c.src + c.len) return c.pos + (t - c.src);
  }
  return null;
}

/**
 * 譜面の基準にするずれ（新しい時刻 − 元の時刻）。
 * 元の音源の t 秒（譜面の頭）を使っているクリップのずれ。使っていなければ、元の位置がいちばん近いクリップのずれ
 */
export function refShift(clips: Clip[], t: number): number {
  const m = mapTime(clips, t);
  if (m !== null) return m - t;
  let best = Infinity;
  let shift = 0;
  for (const c of clips) {
    if (c.srcId !== 0) continue;
    const d = t < c.src ? c.src - t : t - (c.src + c.len);
    if (d < best) { best = d; shift = c.pos - c.src; }
  }
  return shift;
}

/**
 * クリップを並べた新しい音源を作る（チャンネルごと）。sources[音源][チャンネル]、どれも同じサンプリング周波数。
 * トラックごとに作ってから足し合わせる。モノラルの音源はステレオの両方に入れる
 */
/** 並べた音の長さ（サンプル数）とチャンネル数 */
export function renderSize(sources: Float32Array[][], sr: number, clips: Clip[]): { n: number; nch: number } {
  const origin = arrangeStart(clips);
  const n = Math.max(1, Math.ceil((arrangeLength(clips) - origin) * sr));
  const used = new Set(clips.map((c) => c.srcId));
  const nch = Math.max(1, ...[...used].map((i) => Math.min(2, sources[i]?.length ?? 1)));
  return { n, nch };
}

/**
 * 並べた音を作る。out を渡すと、そこ（0 で埋まった、renderSize の大きさの配列）に書く。
 * 曲の長さぶんの配列はとても大きい（3 分のステレオで約 70MB）ので、余計に作らない:
 * トラックが 1 つなら out に直接、2 つ以上なら作業用を 1 組だけ使い回して足していく
 */
export function renderClips(sources: Float32Array[][], sr: number, clips: Clip[], outArg?: Float32Array[]): Float32Array[] {
  const origin = arrangeStart(clips);
  const { n, nch } = renderSize(sources, sr, clips);
  const out = outArg ?? Array.from({ length: nch }, () => new Float32Array(n));
  const tracks = [...new Set(clips.map((c) => c.track))].sort((x, y) => x - y);
  let tb: Float32Array[] | null = null;
  for (const tr of tracks) {
    const mine = clips.filter((c) => c.track === tr);
    if (tracks.length === 1) {
      for (const c of mine) writeClip(out, sources[c.srcId] ?? [], sr, { ...c, pos: c.pos - origin }, n);
      continue;
    }
    tb ??= Array.from({ length: nch }, () => new Float32Array(n));
    // このトラックが使う所だけ、作業用を 0 に戻して書き、out に足す
    let lo = n;
    let hi = 0;
    for (const c of mine) {
      lo = Math.min(lo, Math.max(0, Math.round((c.pos - origin) * sr)));
      hi = Math.max(hi, Math.min(n, Math.round((c.pos - origin + c.len) * sr) + 1));
    }
    if (hi <= lo) continue;
    for (const t of tb) t.fill(0, lo, hi);
    for (const c of mine) writeClip(tb, sources[c.srcId] ?? [], sr, { ...c, pos: c.pos - origin }, n);
    for (let k = 0; k < nch; k++) { const o = out[k]; const t = tb[k]; for (let i = lo; i < hi; i++) o[i] += t[i]; }
  }
  return out;
}

/** 1 つのクリップを書き込む（重なった所は上書き、音量が 1 より小さい所は混ぜる） */
function writeClip(out: Float32Array[], chs: Float32Array[], sr: number, c: Clip, n: number) {
  {
    const s0 = Math.round(c.src * sr);
    const p0 = Math.round(c.pos * sr);
    const L = Math.round(c.len * sr);
    for (let k = 0; k < out.length; k++) {
      const src = chs[k] ?? chs[0];
      const dst = out[k];
      if (!src) continue;
      for (let i = 0; i < L; i++) {
        const o = p0 + i;
        if (o < 0 || o >= n) continue;
        const si = s0 + i;
        const v = si >= 0 && si < src.length ? src[si] : 0;
        const g = c.env.length ? envAt(c.env, c.src + i / sr) : 1;
        dst[o] = g >= 1 ? v : dst[o] * (1 - g) + v * g;
      }
    }
  }
}

/** t にいちばん近い候補（tol 秒以内）。無ければ t のまま */
export function snapTo(t: number, cands: number[], tol: number): number {
  let best = t;
  let bd = tol;
  for (const c of cands) {
    const d = Math.abs(c - t);
    if (d <= bd) { bd = d; best = c; }
  }
  return best;
}
