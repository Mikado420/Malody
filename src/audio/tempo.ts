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
  /** 区間の最初の拍と、次の区間の最初の拍（拍の番号） */
  startBeat: number;
  endBeat: number;
  /** 区間の始まり・終わり（秒） */
  start: number;
  end: number;
  /** 使う BPM（曲全体のずれが増えない範囲で、きりのいい値に丸めたもの） */
  bpm: number;
  /** 測った BPM（丸める前、曲全体でつながるように合わせた値） */
  rawBpm: number;
  /** 区間の拍の数と、実際の音の立ち上がりと合った拍の数 */
  beats: number;
  matched: number;
  /** 合った拍の、決めた BPM の拍とのずれ（ミリ秒、二乗平均） */
  jitterMs: number;
}

export interface TempoResult {
  segments: TempoSegment[];
  /** 拍 0 の時刻（曲全体でつながるように合わせた値） */
  t0: number;
  /** 小節の頭（1 拍目）の拍の番号 */
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
      // 太鼓の曲でよくある速さ（140〜250 くらい）を優先する（倍・半分の取り違えを減らす）
      const PC = (globalThis as { TEMPO_PC?: number }).TEMPO_PC ?? 190;
      const PS = (globalThis as { TEMPO_PS?: number }).TEMPO_PS ?? 0.5;
      const pr = Math.exp(-0.5 * Math.pow(Math.log2(bpm / PC) / PS, 2));
      const PW = (globalThis as { TEMPO_PW?: number }).TEMPO_PW ?? 0.75;
      s *= 1 - PW + PW * pr;
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


// ---------- 拍を 1 つずつ追う ----------

/**
 * 拍の列を求める（動的計画法。状態 =「この時刻に拍があり、前の拍との間隔が p フレーム」）。
 * - 間隔は 1 拍ごとに 1 フレームまでなら自由に変えられる（少しずつ・1 小節ごとに速くなる曲を追える）
 * - それより大きく変えるとき（BPM が急に変わる所）は JUMP の減点
 * - テンポの流れ（tempoAt）から大きく離れる間隔（倍・半分の取り違え）は減点
 */
function trackBeats(env: Float32Array, fr: number, tempoAt: (sec: number) => number): number[] {
  const n = env.length;
  const pMin = Math.max(4, Math.floor((60 * fr) / BPM_MAX));
  const pMax = Math.ceil((60 * fr) / BPM_MIN);
  const np = pMax - pMin + 1;
  const C = new Float32Array(n * np).fill(-1e9);
  const back = new Int32Array(n * np).fill(-1); // 前の拍の (時刻 × np + 間隔の番号)、-1 は始まり
  const M = new Float32Array(n).fill(-1e9); // その時刻の拍の、いちばん高い点
  const Marg = new Int32Array(n).fill(-1);
  const JUMP = 2.5;
  const BETA = (globalThis as { TEMPO_BETA?: number }).TEMPO_BETA ?? 3;
  // 拍 1 つごとの減点: 細かい音（8 分のハイハットなど）まで拍として拾うと拍の数が増えて得をしてしまうのを防ぐ
  const peaks: number[] = [];
  for (let i = 1; i + 1 < n; i++) if (env[i] > 0 && env[i] >= env[i - 1] && env[i] > env[i + 1]) peaks.push(env[i]);
  peaks.sort((a, b) => a - b);
  const KAPPA = ((globalThis as { TEMPO_KAPPA?: number }).TEMPO_KAPPA ?? 0.7) * (peaks[Math.floor(peaks.length * 0.75)] ?? 0);
  for (let t = 0; t < n; t++) {
    const pg = (60 * fr) / tempoAt(t / fr);
    const e = env[t];
    let mBest = -1e9;
    let mArg = -1;
    for (let pi = 0; pi < np; pi++) {
      const p = pMin + pi;
      const l = Math.log2(p / pg);
      let best = 0; // 前の拍がない（ここから始まる）
      let arg = -1;
      const u = t - p;
      if (u >= 0) {
        for (let d = -1; d <= 1; d++) {
          const q = pi + d;
          if (q < 0 || q >= np) continue;
          const v = C[u * np + q];
          if (v > best) {
            best = v;
            arg = u * np + q;
          }
        }
        const vj = M[u] - JUMP;
        if (vj > best) {
          best = vj;
          arg = Marg[u];
        }
      }
      const v = e - KAPPA - BETA * l * l + best;
      C[t * np + pi] = v;
      back[t * np + pi] = arg;
      if (v > mBest) {
        mBest = v;
        mArg = t * np + pi;
      }
    }
    M[t] = mBest;
    Marg[t] = mArg;
  }
  // 最後の 1.5 秒の中で、いちばん点の高い所から逆にたどる
  let end = -1;
  let ev = -Infinity;
  for (let t = Math.max(0, n - Math.round(1.5 * fr)); t < n; t++) if (M[t] > ev) { ev = M[t]; end = Marg[t]; }
  const beats: number[] = [];
  for (let s = end; s >= 0; s = back[s]) beats.push(Math.floor(s / np));
  return beats.reverse();
}

// ---------- テンポが一定の区間に分ける ----------

interface Stat { w: number; k: number; t: number; kk: number; kt: number; tt: number; n: number }

/**
 * 拍の列を「BPM が一定の区間」に分ける（区間の数を増やすほど減点し、ずれの合計との兼ね合いで決める）。
 * 区間は 1 小節（4 拍）以上。1 小節ごとに速くなる曲も、1 小節ずつの区間になる
 */
function segmentBeats(t: number[], w: number[], minLen: number, barPhase = -1): number[] {
  const B = t.length;
  const pre: Stat[] = [{ w: 0, k: 0, t: 0, kk: 0, kt: 0, tt: 0, n: 0 }];
  for (let k = 0; k < B; k++) {
    const p = pre[k];
    const wk = w[k];
    pre.push({
      w: p.w + wk, k: p.k + wk * k, t: p.t + wk * t[k], kk: p.kk + wk * k * k,
      kt: p.kt + wk * k * t[k], tt: p.tt + wk * t[k] * t[k], n: p.n + (wk > 0 ? 1 : 0),
    });
  }
  // 拍のずれの大きさ（曲から見積もる）: 隣り合う 3 拍の「間隔の差」のばらつき。テンポの変化にはほとんど左右されない
  const d2: number[] = [];
  for (let k = 1; k + 1 < B; k++) if (w[k - 1] > 0 && w[k] > 0 && w[k + 1] > 0) d2.push(Math.abs(t[k + 1] - 2 * t[k] + t[k - 1]));
  d2.sort((a, b) => a - b);
  const sigEst = ((d2[Math.floor(d2.length / 2)] ?? 0.003) * 1.4826) / Math.sqrt(6);
  const SIGMA = (globalThis as { TEMPO_SIGMA?: number }).TEMPO_SIGMA ?? Math.min(0.006, Math.max(0.0008, sigEst));
  const LAMBDA = (globalThis as { TEMPO_LAMBDA?: number }).TEMPO_LAMBDA ?? 6; // 区間を 1 つ増やす減点
  const OFFBAR = 6;
  // 区間 [i, j) の拍の間隔は、拍 i〜j（次の区間の最初の拍まで）で決まるので、拍 j も入れて当てはめる
  const cost = (i: number, j: number) => {
    const a = pre[i];
    const b = pre[Math.min(j + 1, B)];
    const sw = b.w - a.w;
    const n = b.n - a.n;
    if (n < 3 || sw <= 0) return n === 0 ? LAMBDA : Infinity; // 音のない所は前後とつなぐ
    const sk = b.k - a.k, st = b.t - a.t, skk = b.kk - a.kk, skt = b.kt - a.kt, stt = b.tt - a.tt;
    // 数値の誤差を減らすため、区間の最初の拍を基準にして計算する
    const k0 = i;
    const skc = sk - k0 * sw;
    const skkc = skk - 2 * k0 * sk + k0 * k0 * sw;
    const sktc = skt - k0 * st;
    const den = sw * skkc - skc * skc;
    if (den <= 1e-12) return Infinity;
    const P = (sw * sktc - skc * st) / den;
    const A = (st - P * skc) / sw;
    const sse = Math.max(0, stt - 2 * A * st - 2 * P * sktc + A * A * sw + 2 * A * P * skc + P * P * skkc);
    return sse / sw * (n) / (SIGMA * SIGMA) + LAMBDA;
  };
  const best = new Float64Array(B + 1).fill(Infinity);
  const from = new Int32Array(B + 1).fill(-1);
  best[0] = 0;
  for (let j = minLen; j <= B; j++) {
    for (let i = 0; i <= j - minLen; i++) {
      if (!Number.isFinite(best[i])) continue;
      // BPM の変わり目は小節の頭が多いので、小節の頭でない所で変えるときは少し減点
      const c = best[i] + cost(i, j) + (i > 0 && barPhase >= 0 && (((i - barPhase) % 4) + 4) % 4 !== 0 ? OFFBAR : 0);
      if (c < best[j]) {
        best[j] = c;
        from[j] = i;
      }
    }
  }
  // 最後まで届かない（拍が少ない）ときは 1 区間
  if (!Number.isFinite(best[B])) return [0];
  const starts: number[] = [];
  for (let j = B; j > 0; j = from[j]) starts.push(from[j]);
  return starts.reverse();
}

// ---------- 曲全体でつながるように合わせる ----------

/**
 * 区間ごとの拍の長さ P_j と、拍 0 の時刻 t0 を、曲全体の拍の時刻に重み付きで当てはめる。
 * 拍 k の時刻 = t0 + （それまでの区間の拍数 × その区間の P）の合計 + （区間の中の拍数 × P_j）。
 * fixed[j] が数なら、その区間の P は固定（きりのいい BPM を試すとき）
 */
export function jointFit(t: number[], w: number[], starts: number[], fixed: (number | null)[]) {
  const m = starts.length;
  const B = t.length;
  const free = fixed.map((f, j) => (f === null ? j : -1)).filter((j) => j >= 0);
  const nv = 1 + free.length;
  const idx = new Map(free.map((j, i) => [j, i + 1]));
  const A = Array.from({ length: nv }, () => new Float64Array(nv));
  const bvec = new Float64Array(nv);
  // 拍 k の係数: [1, 区間ごとの拍数...]
  const coef = new Float64Array(m);
  const rowFor = (k: number) => {
    coef.fill(0);
    for (let j = 0; j < m; j++) {
      const s = starts[j];
      const e = j + 1 < m ? starts[j + 1] : Infinity;
      if (k >= e) coef[j] = e - s;
      else if (k > s) coef[j] = k - s;
    }
  };
  for (let k = 0; k < B; k++) {
    if (w[k] <= 0) continue;
    rowFor(k);
    let y = t[k];
    const row = new Float64Array(nv);
    row[0] = 1;
    for (let j = 0; j < m; j++) {
      if (fixed[j] !== null) y -= coef[j] * (fixed[j] as number);
      else row[idx.get(j)!] = coef[j];
    }
    for (let a = 0; a < nv; a++) {
      bvec[a] += w[k] * row[a] * y;
      for (let b = 0; b < nv; b++) A[a][b] += w[k] * row[a] * row[b];
    }
  }
  // ガウスの消去法
  for (let c = 0; c < nv; c++) {
    let piv = c;
    for (let r = c + 1; r < nv; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [bvec[c], bvec[piv]] = [bvec[piv], bvec[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < nv; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (!f) continue;
      for (let q = c; q < nv; q++) A[r][q] -= f * A[c][q];
      bvec[r] -= f * bvec[c];
    }
  }
  const x = Array.from({ length: nv }, (_, i) => (Math.abs(A[i][i]) > 1e-12 ? bvec[i] / A[i][i] : 0));
  const P = fixed.map((f, j) => (f === null ? x[idx.get(j)!] : (f as number)));
  const t0 = x[0];
  // 当てはまり具合
  const pred = (k: number) => {
    rowFor(k);
    let v = t0;
    for (let j = 0; j < m; j++) v += coef[j] * P[j];
    return v;
  };
  let sw = 0;
  let s2 = 0;
  let mx = 0;
  for (let k = 0; k < B; k++) {
    if (w[k] <= 0) continue;
    const r = t[k] - pred(k);
    sw += w[k];
    s2 += w[k] * r * r;
    mx = Math.max(mx, Math.abs(r));
  }
  return { t0, P, rms: Math.sqrt(s2 / Math.max(1e-9, sw)), max: mx, pred };
}

/** 曲の BPM（途中の変化も）と、小節の頭を測る */
export function analyzeTempo(mono: Float32Array, sr: number, progress?: (p: number) => void): TempoResult {
  const duration = mono.length / sr;
  const env = envelope(mono, sr, progress);
  const tg = tempogram(env.all, env.fr, progress);
  const path = tempoPath(tg);
  const tempoAt = (sec: number) => {
    if (!path.length) return 120;
    let i = 0;
    while (i + 1 < tg.length && tg[i + 1].center <= sec) i++;
    return path[i];
  };
  progress?.(0.82);
  // 1. 拍を 1 つずつ追う
  const frames = trackBeats(env.all, env.fr, tempoAt);
  progress?.(0.9);
  // 2. それぞれの拍の、実際の音の立ち上がりの時刻（1ms 単位）と強さ
  const vals: number[] = [];
  const raw = frames.map((f) => {
    const tt = env.t0 + f / env.fr;
    const p = peakNear(env.all, env.fr, env.t0, tt, 0.035);
    if (p) vals.push(p.v);
    return { tt, p };
  });
  const sorted = [...vals].sort((a, b) => a - b);
  const thr = (sorted[Math.floor(sorted.length * 0.5)] ?? 0) * 0.35;
  const t: number[] = [];
  const w: number[] = [];
  for (const r of raw) {
    if (r.p && r.p.v >= thr) {
      t.push(fineOnset(env, r.p.t, 0.03));
      w.push(Math.min(3, r.p.v / (sorted[Math.floor(sorted.length * 0.5)] || 1)));
    } else {
      t.push(r.tt);
      w.push(0);
    }
  }
  if (t.length < 8) {
    return { segments: [], t0: 0, downbeat: 0, duration };
  }
  // 小節の頭の位置（4 拍ごとの位置のうち、低い音の立ち上がりがいちばん強い所）。曲全体で数える
  const barPhaseOf = (timeOf: (k: number) => number) => {
    const sums = [0, 0, 0, 0];
    const cnt = [0, 0, 0, 0];
    for (let k = 0; k < t.length; k++) {
      const i = Math.round((timeOf(k) - env.t0) * env.fr);
      let v = 0;
      for (let d = -2; d <= 2; d++) v = Math.max(v, env.low[i + d] ?? 0, (env.all[i + d] ?? 0) * 0.3);
      sums[k % 4] += v;
      cnt[k % 4]++;
    }
    let bm = 0;
    for (let m = 1; m < 4; m++) if (sums[m] / Math.max(1, cnt[m]) > sums[bm] / Math.max(1, cnt[bm])) bm = m;
    return bm;
  };
  const barPhase = barPhaseOf((k) => t[k]);
  // 3. BPM が一定の区間に分ける（1 小節 = 4 拍以上。変わり目はなるべく小節の頭）
  let starts = segmentBeats(t, w, 4, barPhase);
  // 4. 曲全体でつながるように当てはめ、外れた拍（裏拍を拾ったなど）を除いてもう一度
  let fit = jointFit(t, w, starts, starts.map(() => null));
  for (let iter = 0; iter < 2; iter++) {
    const res = t.map((tt, k) => (w[k] > 0 ? Math.abs(tt - fit.pred(k)) : 0));
    const used = res.filter((_, k) => w[k] > 0).sort((a, b) => a - b);
    const lim = Math.max(0.012, (used[Math.floor(used.length / 2)] ?? 0) * 4);
    for (let k = 0; k < t.length; k++) if (w[k] > 0 && res[k] > lim) w[k] = 0;
    starts = segmentBeats(t, w, 4, barPhase);
    fit = jointFit(t, w, starts, starts.map(() => null));
  }
  // 隣と同じ BPM（差 0.05 未満）になった区間はつなぐ
  for (let j = starts.length - 1; j > 0; j--) {
    if (Math.abs(60 / fit.P[j] - 60 / fit.P[j - 1]) < 0.05) {
      starts.splice(j, 1);
      fit = jointFit(t, w, starts, starts.map(() => null));
    }
  }
  // 5. きりのいい BPM（整数 → 小数 1 桁 → 2 桁）にしても、曲全体のずれがほとんど増えなければそちらにする
  const fixed: (number | null)[] = starts.map(() => null);
  const base = fit;
  const order = starts.map((_, j) => j).sort((a, b) => {
    const len = (j: number) => (j + 1 < starts.length ? starts[j + 1] : t.length) - starts[j];
    return len(b) - len(a);
  });
  for (const j of order) {
    const rawBpm = 60 / fit.P[j];
    for (const d of [0, 1, 2]) {
      const c = Number(rawBpm.toFixed(d));
      const trial = fixed.slice();
      trial[j] = 60 / c;
      const f = jointFit(t, w, starts, trial);
      if (f.rms <= Math.max(base.rms * 1.25, base.rms + 0.0008) && f.max <= base.max + 0.004) {
        fixed[j] = 60 / c;
        fit = f;
        break;
      }
    }
    if (fixed[j] === null) {
      fixed[j] = 60 / Number(rawBpm.toFixed(3));
      fit = jointFit(t, w, starts, fixed);
    }
  }
  // 丸めた結果、隣と同じ BPM になった区間はつなぐ
  for (let j = starts.length - 1; j > 0; j--) {
    if (Math.abs(fixed[j]! - fixed[j - 1]!) < 1e-9) {
      starts.splice(j, 1);
      fixed.splice(j, 1);
    }
  }
  fit = jointFit(t, w, starts, fixed);
  const rawFit = jointFit(t, w, starts, starts.map(() => null));
  // 6. 区間ごとのまとめ
  const segs: TempoSegment[] = starts.map((s, j) => {
    const e = j + 1 < starts.length ? starts[j + 1] : t.length;
    let mt = 0;
    let s2 = 0;
    for (let k = s; k < e; k++) {
      if (w[k] <= 0) continue;
      mt++;
      s2 += Math.pow(t[k] - fit.pred(k), 2);
    }
    return {
      startBeat: s, endBeat: e,
      start: j === 0 ? 0 : fit.pred(s), end: j + 1 < starts.length ? fit.pred(e) : duration,
      bpm: Number((60 / fit.P[j]).toFixed(3)), rawBpm: 60 / rawFit.P[j],
      beats: e - s, matched: mt, jitterMs: Math.sqrt(s2 / Math.max(1, mt)) * 1000,
    };
  });
  // 7. 小節の頭（当てはめた拍の時刻で数え直す）
  const down = barPhaseOf((k) => fit.pred(k));
  progress?.(1);
  return { segments: segs, t0: fit.t0, downbeat: down, duration };
}

// ---------- 譜面に入れる形にする ----------

export interface TempoPlan {
  bpm: number;
  offset: number;
  /** 2 つ目以降の区間の #BPMCHANGE（tick は 1 拍 = tpb） */
  changes: { tick: number; bpm: number }[];
}

/**
 * 測った結果を譜面の形にする。mul = 区間ごとの速さの倍率（2 = 倍、0.5 = 半分）、shift = 1 拍目を何拍ずらすか、
 * fine = OFFSET の手での微調整（秒、＋で拍が後ろへ）
 * OFFSET は「最初の 1 拍目」の時刻（音源の頭以降でいちばん早い小節の頭）にそろえる
 */
export function tempoPlan(r: TempoResult, tpb: number, mul: number | number[] = 1, shift = 0, fine = 0): TempoPlan | null {
  if (!r.segments.length) return null;
  const m = (i: number) => (Array.isArray(mul) ? mul[i] ?? 1 : mul);
  // 区間ごとの拍の長さと拍数（倍率を掛けた後）
  const segs = r.segments.map((s, i) => ({ bpm: Number((s.bpm * m(i)).toFixed(3)), beats: (s.endBeat - s.startBeat) * m(i), start: s.startBeat }));
  // 小節の頭の拍（最初の区間の中で数える。倍率を掛けた拍の番号）
  const P1 = 60 / segs[0].bpm;
  const firstBeat = segs[0].start * m(0);
  let d = r.downbeat * m(0) + shift; // 最初の区間の拍の番号での 1 拍目
  // 拍 b（倍率を掛けた後の番号、最初の区間の中）の時刻
  const t0 = r.t0 + fine + (firstBeat - firstBeat) * P1;
  let down = t0 + (d - firstBeat) * P1;
  // 音源の頭以降で、いちばん早い小節の頭まで、1 小節ずつ戻す・進める
  const bar = 4 * P1;
  const nb = Math.floor(down / bar);
  down -= nb * bar;
  d -= nb * 4;
  const changes: { tick: number; bpm: number }[] = [];
  let beatPos = segs[0].beats + firstBeat - d; // 2 つ目の区間の頭までの、1 拍目からの拍数
  for (let i = 1; i < segs.length; i++) {
    const tick = Math.round(beatPos * tpb);
    if (tick > (changes[changes.length - 1]?.tick ?? 0)) changes.push({ tick, bpm: segs[i].bpm });
    beatPos += segs[i].beats;
  }
  return { bpm: segs[0].bpm, offset: Number((-down).toFixed(3)), changes };
}

/** 案の拍の時刻（確認画面の波形に線を引く用）。tick 0 からの拍の番号 → 時刻 */
export function planBeatTimes(plan: TempoPlan, tpb: number, untilSec: number): { t: number; bar: boolean }[] {
  const out: { t: number; bar: boolean }[] = [];
  let t = -plan.offset;
  let bpm = plan.bpm;
  let ci = 0;
  for (let k = 0; t <= untilSec && k < 100000; k++) {
    while (ci < plan.changes.length && plan.changes[ci].tick <= k * tpb) bpm = plan.changes[ci++].bpm;
    out.push({ t, bar: k % 4 === 0 });
    t += 60 / bpm;
  }
  return out;
}
