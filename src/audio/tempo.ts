/**
 * BPM・OFFSET の自動測定。
 *
 * 1. 音の立ち上がりの強さ（スペクトルの増え方 = spectral flux）を約 11.6ms ごとに求める
 * 2. 8 秒の窓を 1 秒ずつずらしながら、その区間でいちばん繰り返しの強いテンポを求め、
 *    曲全体を通して「なるべく同じテンポが続く」ようにつなぐ（Viterbi）。テンポが変わり続ける所が BPM の変わり目
 * 3. 同じテンポの区間ごとに、区間全体の立ち上がりを重ねて BPM と拍の位置を細かく合わせ、
 *    さらに 1 拍ずつ実際の立ち上がりの時刻を拾って、区間全体で直線に当てはめる（1 小節だけで決めない）
 * 4. きりのいい BPM（整数・小数 1〜2 桁）でも区間全体のずれが小さければ、そちらを使う
 * 5. 低い音（キックなど）の強さから小節の頭（1 拍目）を決め、最初の 1 拍目の時刻から OFFSET を決める
 *
 * 描画や DOM に依存しないので、Web Worker の中でもテストでも動く。
 */

export interface TempoSegment {
  /** 区間の始まり・終わり（秒） */
  start: number;
  end: number;
  /** 使う BPM（きりのいい値に丸めたもの） */
  bpm: number;
  /** 測った BPM（丸める前） */
  rawBpm: number;
  /** 拍の時刻の基準（この区間の拍は phase + k × 60 / bpm） */
  phase: number;
  /** 区間の拍の数と、実際の音の立ち上がりと合った拍の数 */
  beats: number;
  matched: number;
  /** 合った拍の、立ち上がりとのずれ（ミリ秒、二乗平均） */
  jitterMs: number;
}

export interface TempoResult {
  segments: TempoSegment[];
  /** 小節の頭（1 拍目）の時刻（最初の区間の拍のどれか） */
  downbeat: number;
  /** 曲の長さ（秒） */
  duration: number;
}

// ---------- FFT ----------

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// ---------- 立ち上がりの強さ ----------

interface Envelope {
  /** 全体の立ち上がりの強さ（1 フレームごと） */
  all: Float32Array;
  /** 低い音（約 150Hz まで）の立ち上がりの強さ。小節の頭を決めるのに使う */
  low: Float32Array;
  /** 1 秒あたりのフレーム数 */
  fr: number;
  /** フレーム i の時刻 = t0 + i / fr */
  t0: number;
  /** 音の大きさの累積和（約 11kHz の音の 2 乗の和）。立ち上がりの時刻を 1ms 単位で求めるのに使う */
  cum: Float64Array;
  srD: number;
}

const N = 1024;
const HOP = 128;

function envelope(mono: Float32Array, sr: number, progress?: (p: number) => void): Envelope {
  // 約 11kHz に落とす（平均をとって間引く）
  const f = Math.max(1, Math.round(sr / 11025));
  const srD = sr / f;
  const len = Math.floor(mono.length / f);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let k = 0; k < f; k++) s += mono[i * f + k];
    x[i] = s / f;
  }
  const frames = Math.max(0, Math.floor((len - N) / HOP) + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const bins = N / 2;
  const lowBin = Math.max(2, Math.round((150 * N) / srD));
  const prev = new Float64Array(bins);
  const all = new Float32Array(frames);
  const low = new Float32Array(frames);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let fi = 0; fi < frames; fi++) {
    const o = fi * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = x[o + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let sa = 0;
    let sl = 0;
    for (let b = 1; b < bins; b++) {
      const m = Math.log(1 + 100 * Math.hypot(re[b], im[b]));
      const d = m - prev[b];
      prev[b] = m;
      if (d > 0) {
        sa += d;
        if (b <= lowBin) sl += d;
      }
    }
    all[fi] = fi === 0 ? 0 : sa;
    low[fi] = fi === 0 ? 0 : sl;
    if (progress && fi % 2000 === 0) progress((fi / frames) * 0.5);
  }
  // ゆっくりした音量の変化を引いて、立ち上がりだけを残す
  const norm = (a: Float32Array) => {
    const w = 20;
    const out = new Float32Array(a.length);
    let sum = 0;
    const q: number[] = [];
    for (let i = 0; i < a.length; i++) {
      q.push(a[i]);
      sum += a[i];
      if (q.length > w * 2 + 1) sum -= q.shift()!;
      const c = i - w;
      if (c >= 0) out[c] = Math.max(0, a[c] - sum / q.length);
    }
    let s2 = 0;
    for (let i = 0; i < out.length; i++) s2 += out[i] * out[i];
    const sd = Math.sqrt(s2 / Math.max(1, out.length)) || 1;
    for (let i = 0; i < out.length; i++) out[i] /= sd;
    return out;
  };
  const cum = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) cum[i + 1] = cum[i] + x[i] * x[i];
  return { all: norm(all), low: norm(low), fr: srD / HOP, t0: N / 2 / srD, cum, srD };
}

/**
 * t の近く（±radius 秒）で、音が急に大きくなった瞬間（立ち上がり）の時刻を細かく求める。
 * 約 3ms ずつの音の大きさを前後で比べ、いちばん増えた所
 */
function fineOnset(env: Envelope, t: number, radius: number): number {
  const { cum, srD } = env;
  const W = Math.max(8, Math.round(srD * 0.003));
  const n = cum.length - 1;
  const e = (i: number) => (cum[Math.min(n, i + W)] - cum[Math.max(0, i)]) / W + 1e-10;
  const c = Math.round(t * srD);
  const r = Math.round(radius * srD);
  let best = c;
  let bv = -Infinity;
  for (let i = Math.max(W, c - r); i <= Math.min(n - W, c + r); i++) {
    const d = Math.log(e(i)) - Math.log(e(i - W));
    if (d > bv) {
      bv = d;
      best = i;
    }
  }
  return best / srD;
}

// ---------- テンポの流れ ----------

const BPM_MIN = 50;
const BPM_MAX = 320;
const NBIN = 240;
const binBpm = (i: number) => BPM_MIN * Math.pow(BPM_MAX / BPM_MIN, i / (NBIN - 1));

/** 窓ごとのテンポの強さ（自己相関を、拍の倍数の所で足し合わせる） */
function tempogram(env: Float32Array, fr: number, progress?: (p: number) => void) {
  const W = Math.round(8 * fr);
  const H = Math.round(1 * fr);
  const lagMax = Math.ceil((fr * 60 * 4) / BPM_MIN) + 2;
  const out: { center: number; score: Float32Array }[] = [];
  const count = Math.max(1, Math.floor((env.length - W) / H) + 1);
  for (let w = 0; w < count; w++) {
    const a = Math.min(w * H, Math.max(0, env.length - W));
    const b = Math.min(env.length, a + W);
    const r = new Float32Array(Math.min(lagMax, b - a));
    for (let l = 0; l < r.length; l++) {
      let s = 0;
      for (let i = a; i + l < b; i++) s += env[i] * env[i + l];
      r[l] = s;
    }
    const at = (lag: number) => {
      const i = Math.floor(lag);
      if (i + 1 >= r.length) return 0;
      const t = lag - i;
      return r[i] * (1 - t) + r[i + 1] * t;
    };
    const score = new Float32Array(NBIN);
    let mx = 1e-9;
    for (let k = 0; k < NBIN; k++) {
      const bpm = binBpm(k);
      const lag = (60 * fr) / bpm;
      // 拍の長さと、その 2 倍の所の繰り返し。倍数を多く足すと遅いテンポ（半分の速さ）に寄りやすいので 2 倍まで
      let s = at(lag) + 0.5 * at(2 * lag);
      // 太鼓の曲でよくある速さ（130〜230 くらい）を優先する（倍・半分の取り違えを減らす）
      const pr = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 175) / 0.75, 2));
      s *= 0.4 + 0.6 * pr;
      score[k] = s;
      if (s > mx) mx = s;
    }
    for (let k = 0; k < NBIN; k++) score[k] /= mx;
    out.push({ center: (a + (b - a) / 2) / fr, score });
    if (progress && w % 10 === 0) progress(0.5 + (w / count) * 0.3);
  }
  return out;
}

/** 窓ごとのテンポを、曲全体で「なるべく同じテンポが続く」ようにつなぐ */
function tempoPath(tg: { score: Float32Array }[]): number[] {
  const T = tg.length;
  if (!T) return [];
  const JUMP = 1.2; // テンポを大きく変えるときの減点（1 窓だけ外れた値には引っぱられない）
  let cur = Float64Array.from(tg[0].score);
  const back: Int16Array[] = [];
  for (let t = 1; t < T; t++) {
    let best = 0;
    for (let k = 1; k < NBIN; k++) if (cur[k] > cur[best]) best = k;
    const nxt = new Float64Array(NBIN);
    const bk = new Int16Array(NBIN);
    for (let k = 0; k < NBIN; k++) {
      // 近くのテンポ（±2 段 ≒ ±1.6%）へは減点なし、それ以外はどこからでも JUMP の減点で移れる
      let v = cur[best] - JUMP;
      let from = best;
      for (let d = -2; d <= 2; d++) {
        const j = k + d;
        if (j < 0 || j >= NBIN) continue;
        if (cur[j] > v) {
          v = cur[j];
          from = j;
        }
      }
      nxt[k] = v + tg[t].score[k];
      bk[k] = from;
    }
    back.push(bk);
    cur = nxt;
  }
  let k = 0;
  for (let i = 1; i < NBIN; i++) if (cur[i] > cur[k]) k = i;
  const path = new Array<number>(T);
  path[T - 1] = k;
  for (let t = T - 1; t > 0; t--) {
    k = back[t - 1][k];
    path[t - 1] = k;
  }
  return path.map(binBpm);
}

// ---------- 区間ごとに細かく合わせる ----------

/** 拍の長さ P・基準 phase の格子に、区間の立ち上がりがどれだけ乗っているか（位相を重ねたときの山の高さ） */
function foldScore(env: Float32Array, fr: number, t0: number, i0: number, i1: number, P: number) {
  const B = 96;
  const acc = new Float64Array(B);
  for (let i = i0; i < i1; i++) {
    const v = env[i];
    if (v <= 0) continue;
    const t = t0 + i / fr;
    let ph = (t / P) % 1;
    if (ph < 0) ph += 1;
    acc[Math.floor(ph * B) % B] += v;
  }
  let best = 0;
  let bi = 0;
  let mean = 0;
  for (let b = 0; b < B; b++) mean += acc[b];
  mean /= B;
  for (let b = 0; b < B; b++) {
    const s = acc[(b + B - 1) % B] * 0.5 + acc[b] + acc[(b + 1) % B] * 0.5;
    if (s > best) {
      best = s;
      bi = b;
    }
  }
  return { score: best / 2 - mean, phase: ((bi + 0.5) / B) * P };
}

/** フレームの山の位置（放物線で細かく） */
function peakNear(env: Float32Array, fr: number, t0: number, t: number, radius: number) {
  const c = Math.round((t - t0) * fr);
  const r = Math.max(1, Math.round(radius * fr));
  let bi = -1;
  let bv = 0;
  for (let i = Math.max(1, c - r); i <= Math.min(env.length - 2, c + r); i++) {
    if (env[i] > bv && env[i] >= env[i - 1] && env[i] >= env[i + 1]) {
      bv = env[i];
      bi = i;
    }
  }
  if (bi < 0) return null;
  const a = env[bi - 1];
  const b = env[bi];
  const cc = env[bi + 1];
  const den = a - 2 * b + cc;
  const off = den < 0 ? (0.5 * (a - cc)) / den : 0;
  return { t: t0 + (bi + Math.max(-0.5, Math.min(0.5, off))) / fr, v: bv };
}

function refineSegment(env: Envelope, start: number, end: number, roughBpm: number): TempoSegment {
  const { all, fr, t0 } = env;
  const i0 = Math.max(0, Math.floor((start - t0) * fr));
  const i1 = Math.min(all.length, Math.ceil((end - t0) * fr));
  // 速さ（倍・半分の取り違え）はテンポの流れの段階で、曲全体を見て決めてある。ここでは ±2% だけ細かく合わせる
  const base = roughBpm;
  // 区間全体で重ねて、BPM を ±2% の範囲で細かく探す
  let bestBpm = base;
  let best = foldScore(all, fr, t0, i0, i1, 60 / base);
  for (let b = base * 0.98; b <= base * 1.02; b += 0.02) {
    const f = foldScore(all, fr, t0, i0, i1, 60 / b);
    if (f.score > best.score) {
      best = f;
      bestBpm = b;
    }
  }
  // 1 拍ずつ実際の立ち上がりを拾い、区間全体で直線（時刻 = 基準 + k × 拍の長さ）に当てはめる
  let P = 60 / bestBpm;
  let phase = best.phase;
  const k0 = Math.ceil((start - phase) / P);
  const k1 = Math.floor((end - phase) / P);
  const pts: { k: number; t: number; w: number }[] = [];
  const peaks: number[] = [];
  for (let k = k0; k <= k1; k++) {
    const p = peakNear(all, fr, t0, phase + k * P, Math.min(0.06, P * 0.2));
    if (p) {
      // 立ち上がりの時刻は、音の大きさから 1ms 単位で求め直す
      pts.push({ k, t: fineOnset(env, p.t, 0.03), w: p.v });
      peaks.push(p.v);
    }
  }
  peaks.sort((a, b) => a - b);
  const thr = (peaks[Math.floor(peaks.length * 0.5)] ?? 0) * 0.35;
  let use = pts.filter((p) => p.w >= thr);
  let a = phase;
  let jitter = 0;
  for (let iter = 0; iter < 4 && use.length >= 4; iter++) {
    // 重み付き最小二乗
    let sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
    for (const p of use) {
      const w = p.w;
      sw += w; sk += w * p.k; st += w * p.t; skk += w * p.k * p.k; skt += w * p.k * p.t;
    }
    const den = sw * skk - sk * sk;
    if (Math.abs(den) < 1e-9) break;
    P = (sw * skt - sk * st) / den;
    a = (st - P * sk) / sw;
    const res = use.map((p) => Math.abs(p.t - (a + p.k * P)));
    const sorted = [...res].sort((x, y) => x - y);
    const mad = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const lim = Math.max(0.008, mad * 3);
    use = use.filter((_, i) => res[i] <= lim);
    jitter = Math.sqrt(use.reduce((s, p) => s + Math.pow(p.t - (a + p.k * P), 2), 0) / Math.max(1, use.length));
  }
  phase = a;
  const rawBpm = 60 / P;
  // きりのいい BPM でも、区間全体でずれが 6ms 未満ならそちらを使う
  const nBeats = Math.max(1, k1 - k0);
  let bpm = Number(rawBpm.toFixed(3));
  for (const d of [0, 1, 2]) {
    const c = Number(rawBpm.toFixed(d));
    if (Math.abs(60 / c - P) * nBeats < 0.006) {
      bpm = c;
      break;
    }
  }
  // 決めた BPM で基準の時刻を合わせ直す
  if (use.length) {
    const Pc = 60 / bpm;
    let sw = 0, s = 0;
    for (const p of use) {
      sw += p.w;
      s += p.w * (p.t - p.k * Pc);
    }
    phase = s / sw;
  }
  return {
    start, end, bpm, rawBpm,
    phase,
    beats: k1 - k0 + 1,
    matched: use.length,
    jitterMs: jitter * 1000,
  };
}

/** 小節の頭: 4 拍ごとの位置のうち、低い音の立ち上がりがいちばん強い所 */
function findDownbeat(env: Envelope, seg: TempoSegment): number {
  const P = 60 / seg.bpm;
  const k0 = Math.ceil((seg.start - seg.phase) / P);
  const k1 = Math.floor((seg.end - seg.phase) / P);
  const sums = [0, 0, 0, 0];
  const cnt = [0, 0, 0, 0];
  for (let k = k0; k <= k1; k++) {
    const t = seg.phase + k * P;
    const i = Math.round((t - env.t0) * env.fr);
    let v = 0;
    for (let d = -2; d <= 2; d++) v = Math.max(v, env.low[i + d] ?? 0, (env.all[i + d] ?? 0) * 0.3);
    const m = ((k % 4) + 4) % 4;
    sums[m] += v;
    cnt[m]++;
  }
  let bm = 0;
  for (let m = 1; m < 4; m++) if (sums[m] / Math.max(1, cnt[m]) > sums[bm] / Math.max(1, cnt[bm])) bm = m;
  // 区間の中で最初の、その位置の拍
  let k = k0;
  while (((k % 4) + 4) % 4 !== bm) k++;
  return seg.phase + k * P;
}

/** 曲の BPM（途中の変化も）と、小節の頭を測る */
export function analyzeTempo(mono: Float32Array, sr: number, progress?: (p: number) => void): TempoResult {
  const duration = mono.length / sr;
  const env = envelope(mono, sr, progress);
  const tg = tempogram(env.all, env.fr, progress);
  const path = tempoPath(tg);
  progress?.(0.85);
  // 同じテンポ（±2%）が続く所をまとめて区間にする。4 秒未満の短い区間は前後にくっつける
  type Raw = { a: number; b: number; bpm: number[] };
  let raws: Raw[] = [];
  path.forEach((bpm, i) => {
    const last = raws[raws.length - 1];
    const med = last ? last.bpm[Math.floor(last.bpm.length / 2)] : 0;
    if (last && Math.abs(bpm / med - 1) < 0.02) {
      last.b = i;
      last.bpm.push(bpm);
    } else raws.push({ a: i, b: i, bpm: [bpm] });
  });
  const short = (r: Raw) => r.b - r.a + 1 < 4;
  for (let guard = 0; guard < 50 && raws.length > 1 && raws.some(short); guard++) {
    const i = raws.findIndex(short);
    const r = raws[i];
    const j = i === 0 ? 1 : i === raws.length - 1 ? i - 1 : (raws[i - 1].b - raws[i - 1].a > raws[i + 1].b - raws[i + 1].a ? i - 1 : i + 1);
    const o = raws[j];
    o.a = Math.min(o.a, r.a);
    o.b = Math.max(o.b, r.b);
    raws.splice(i, 1);
  }
  // 隣どうしで同じテンポになったものはつなぐ
  raws = raws.reduce<Raw[]>((acc, r) => {
    const last = acc[acc.length - 1];
    const m = (x: Raw) => [...x.bpm].sort((p, q) => p - q)[Math.floor(x.bpm.length / 2)];
    if (last && Math.abs(m(r) / m(last) - 1) < 0.02) {
      last.b = r.b;
      last.bpm.push(...r.bpm);
    } else acc.push(r);
    return acc;
  }, []);
  const segs: TempoSegment[] = [];
  raws.forEach((r, i) => {
    // 区間の境目: 窓の中心の真ん中
    const start = i === 0 ? 0 : (tg[r.a - 1].center + tg[r.a].center) / 2;
    const end = i === raws.length - 1 ? duration : (tg[r.b].center + tg[r.b + 1].center) / 2;
    const med = [...r.bpm].sort((p, q) => p - q)[Math.floor(r.bpm.length / 2)];
    segs.push(refineSegment(env, start, end, med));
  });
  // 区間の変わり目を細かく決める: 前の区間の拍と次の区間の拍が重なる所のうち、
  // 前 4 秒は前の区間の拍に、後ろ 4 秒は次の区間の拍に、いちばんよく音が乗っている所
  const strength = (t: number) => {
    const i = Math.round((t - env.t0) * env.fr);
    let v = 0;
    for (let d = -1; d <= 1; d++) v = Math.max(v, env.all[i + d] ?? 0);
    return v;
  };
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1];
    const b = segs[i];
    const Pa = 60 / a.bpm;
    const Pb = 60 / b.bpm;
    let bestT = b.phase + Math.round((b.start - b.phase) / Pb) * Pb;
    let bestScore = -Infinity;
    // テンポの流れから決めた境目は数秒ずれることがあるので、前後 10 秒（ただし両方の区間の中）を探す
    const lo = Math.max(a.start + 1, b.start - 10);
    const hi = Math.min(b.end - 1, b.start + 10);
    for (let n = Math.ceil((lo - a.phase) / Pa); a.phase + n * Pa <= hi; n++) {
      const T = a.phase + n * Pa;
      const tb = b.phase + Math.round((T - b.phase) / Pb) * Pb;
      if (Math.abs(tb - T) > 0.015) continue;
      // 前の 4 秒は「前の区間の拍のほうが、次の区間の拍より音に合う」、後ろの 4 秒はその逆になっているほど高い点
      const mean = (from: number, to: number, ph: number, P: number) => {
        let sum = 0;
        let n = 0;
        for (let k = Math.ceil((from - ph) / P); ph + k * P < to; k++) {
          sum += strength(ph + k * P);
          n++;
        }
        return n ? sum / n : 0;
      };
      const sc = mean(T - 4, T, a.phase, Pa) - mean(T - 4, T, b.phase, Pb) + mean(tb, tb + 4, b.phase, Pb) - mean(tb, tb + 4, a.phase, Pa);
      if (sc > bestScore) {
        bestScore = sc;
        bestT = tb;
      }
    }
    a.end = bestT;
    b.start = bestT;
  }
  progress?.(1);
  const first = segs[0];
  return { segments: segs, downbeat: first ? findDownbeat(env, first) : 0, duration };
}

// ---------- 譜面に入れる形にする ----------

export interface TempoPlan {
  bpm: number;
  offset: number;
  /** 2 つ目以降の区間の #BPMCHANGE（tick は 1 拍 = tpb） */
  changes: { tick: number; bpm: number }[];
}

/**
 * 測った結果を譜面の形にする。mul = 速さの倍率（2 = 倍、0.5 = 半分。区間ごとに配列でも）、shift = 1 拍目を何拍ずらすか
 * OFFSET は「最初の 1 拍目」の時刻（音源の頭以降でいちばん早い小節の頭）にそろえる
 */
export function tempoPlan(r: TempoResult, tpb: number, mul: number | number[] = 1, shift = 0): TempoPlan | null {
  const m = (i: number) => (Array.isArray(mul) ? mul[i] ?? 1 : mul);
  const segs = r.segments.map((s, i) => ({ ...s, bpm: Number((s.bpm * m(i)).toFixed(3)) }));
  if (!segs.length) return null;
  const P1 = 60 / segs[0].bpm;
  let down = r.downbeat + shift * P1;
  const bar = 4 * P1;
  down -= Math.floor(down / bar) * bar; // 0 以上でいちばん早い小節の頭
  if (down < 0) down += bar;
  const changes: { tick: number; bpm: number }[] = [];
  let beatPos = 0; // 1 拍目からの拍数
  let prevT = down;
  let prevP = P1;
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    const P = 60 / s.bpm;
    // 変わり目（測るときに、前後の区間の拍が重なる所に決めてある）
    const tb = s.start;
    beatPos += (tb - prevT) / prevP;
    // 1/48 拍に丸める（tick を整数にするため）
    const tick = Math.round(beatPos * 48) * (tpb / 48);
    if (tick <= (changes[changes.length - 1]?.tick ?? 0)) continue;
    changes.push({ tick, bpm: s.bpm });
    beatPos = tick / tpb;
    prevT = tb;
    prevP = P;
  }
  return { bpm: segs[0].bpm, offset: Number((-down).toFixed(3)), changes };
}
