/**
 * 音源の切り貼り（クリップを並べて、新しい音源を作る）。
 *
 * クリップ = 元の音源の src 秒から len 秒ぶんを、新しい音源の pos 秒の所に置いたもの。
 * 配列の後ろのクリップほど上にあり、重なった所は上のクリップの音になる
 * （上のクリップのフェードの間は、下の音と混ぜて入れ替える＝クロスフェード）。
 * クリップの無い所は無音（頭を空ければ「頭に無音」）。
 */

export interface Clip {
  /** 元の音源の、使い始めの位置（秒） */
  src: number;
  /** 長さ（秒） */
  len: number;
  /** 新しい音源の中の位置（秒） */
  pos: number;
  fadeIn: number;
  fadeOut: number;
}

/** クリップのいちばん短い長さ（秒） */
export const MIN_LEN = 0.05;

export const clipEnd = (c: Clip) => c.pos + c.len;

/** 新しい音源の長さ（いちばん後ろのクリップの終わり） */
export function arrangeLength(clips: Clip[]) {
  return clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** フェードを長さの半分までにそろえる */
export function fixFades(c: Clip): Clip {
  const h = c.len / 2;
  return { ...c, fadeIn: Math.max(0, Math.min(h, c.fadeIn)), fadeOut: Math.max(0, Math.min(h, c.fadeOut)) };
}

/** 新しい音源の t 秒で、上にあるクリップの番号（無ければ -1） */
export function clipAt(clips: Clip[], t: number): number {
  for (let i = clips.length - 1; i >= 0; i--) if (t >= clips[i].pos && t < clipEnd(clips[i])) return i;
  return -1;
}

/** i 番のクリップを、新しい音源の t 秒の所で 2 つに分ける（分けた後ろのほうは i + 1 番） */
export function splitClip(clips: Clip[], i: number, t: number): Clip[] | null {
  const c = clips[i];
  if (!c) return null;
  const d = r3(t - c.pos);
  if (d < MIN_LEN || c.len - d < MIN_LEN) return null;
  const a = fixFades({ ...c, len: d, fadeOut: 0 });
  const b = fixFades({ ...c, src: r3(c.src + d), pos: r3(c.pos + d), len: r3(c.len - d), fadeIn: 0 });
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
  return fixFades({ ...c, pos: r3(c.pos + d), src: r3(c.src + d), len: r3(c.len - d) });
}

/** 右の端を新しい音源の t 秒へ */
export function trimEnd(c: Clip, t: number, dur: number): Clip {
  const len = Math.max(MIN_LEN, Math.min(dur - c.src, t - c.pos));
  return fixFades({ ...c, len: r3(len) });
}

/** 元の音源の t 秒が、新しい音源の何秒になるか（その音を使っている上のクリップで。使っていなければ null） */
export function mapTime(clips: Clip[], t: number): number | null {
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    if (t >= c.src && t < c.src + c.len) return c.pos + (t - c.src);
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
    const d = t < c.src ? c.src - t : t - (c.src + c.len);
    if (d < best) { best = d; shift = c.pos - c.src; }
  }
  return shift;
}

/** フェードの音量（クリップの中の位置 x 秒） */
function fadeGain(c: Clip, x: number) {
  let g = 1;
  if (c.fadeIn > 0 && x < c.fadeIn) g = x / c.fadeIn;
  if (c.fadeOut > 0 && x > c.len - c.fadeOut) g = Math.min(g, (c.len - x) / c.fadeOut);
  return Math.max(0, Math.min(1, g));
}

/** クリップを並べた新しい音源を作る（チャンネルごと） */
export function renderClips(chs: Float32Array[], sr: number, clips: Clip[]): Float32Array[] {
  const n = Math.max(1, Math.ceil(arrangeLength(clips) * sr));
  const out = chs.map(() => new Float32Array(n));
  for (const c of clips) {
    const s0 = Math.round(c.src * sr);
    const p0 = Math.round(c.pos * sr);
    const L = Math.round(c.len * sr);
    for (let k = 0; k < chs.length; k++) {
      const src = chs[k];
      const dst = out[k];
      for (let i = 0; i < L; i++) {
        const o = p0 + i;
        if (o < 0 || o >= n) continue;
        const si = s0 + i;
        const v = si >= 0 && si < src.length ? src[si] : 0;
        const g = fadeGain(c, i / sr);
        dst[o] = g >= 1 ? v : dst[o] * (1 - g) + v * g;
      }
    }
  }
  return out;
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
