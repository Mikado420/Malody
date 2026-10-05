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
  /** 測り方の途中経過（うまく測れないときの確認用） */
  info?: string;
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
      const PC = 190;
      const PS = 0.5;
      // 優先するのは「倍・半分のうちどれか」を選ぶときだけ。倍・半分の関係にない速さ（175 と 130 など）どうしは公平に比べる
      const prf = (b: number) => Math.exp(-0.5 * Math.pow(Math.log2(b / PC) / PS, 2));
      let pm = 0;
      for (let j = -3; j <= 3; j++) {
        const b2 = bpm * Math.pow(2, j);
        if (b2 >= BPM_MIN && b2 <= BPM_MAX) pm = Math.max(pm, prf(b2));
      }
      const pr = prf(bpm) / pm;
      const PW = 0.75;
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
  const BETA = 3;
  // 拍 1 つごとの減点: 細かい音（8 分のハイハットなど）まで拍として拾うと拍の数が増えて得をしてしまうのを防ぐ
  const peaks: number[] = [];
  for (let i = 1; i + 1 < n; i++) if (env[i] > 0 && env[i] >= env[i - 1] && env[i] > env[i + 1]) peaks.push(env[i]);
  peaks.sort((a, b) => a - b);
  const KAPPA = (0.7) * (peaks[Math.floor(peaks.length * 0.75)] ?? 0);
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
  const SIGMA = Math.min(0.006, Math.max(0.0008, sigEst));
  const LAMBDA = 6; // 区間を 1 つ増やす減点
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

/** 細かい測り方: 拍を 1 つずつ追い、BPM が変わる所（1 小節ごとの変化も）を見つける */
function analyzeFine(env: Envelope, tg: { center: number; score: Float32Array }[], path: number[], duration: number, progress?: (p: number) => void): TempoResult {
  const tempoAt = (sec: number) => {
    if (!path.length) return 120;
    let i = 0;
    while (i + 1 < tg.length && tg[i + 1].center <= sec) i++;
    return path[i];
  };
  progress?.(0.82);
  // 1. 拍を 1 つずつ追う
  // 拍を追うときは、低い音（キック・太鼓など）の立ち上がりを重く見る（裏拍のハイハットなどに乗りにくくする）
  const LOWW = 1.5;
  const beatEnv = new Float32Array(env.all.length);
  for (let i = 0; i < beatEnv.length; i++) beatEnv[i] = env.all[i] + LOWW * env.low[i];
  const frames = trackBeats(beatEnv, env.fr, tempoAt);
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
  // 拍の番号は、追った拍を数えるのではなく「前の確かな拍からの時間 ÷ 拍の長さ」を丸めて決める。
  // 追った拍が一時的に裏拍や 3 連のリズムに引っぱられても、拍の数え間違い（曲全体のずれ）にならない
  const med = sorted[Math.floor(sorted.length * 0.5)] || 1;
  const pts: { k: number; t: number; w: number }[] = [];
  let lastT = -1;
  let lastK = 0;
  let lastI = 0;
  let skips = 0;
  // 拍の長さの目安: 追った拍の間隔の、その近くでの真ん中の値（BPM が急に変わった所でもすぐ合う）
  const ibi = frames.map((f, i) => (i ? (f - frames[i - 1]) / env.fr : 0));
  const localP = (i0: number, i1: number) => {
    const v: number[] = [];
    for (let i = Math.max(1, i0 - 3); i <= Math.min(ibi.length - 1, i1 + 3); i++) v.push(ibi[i]);
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] || 60 / tempoAt(frames[i0] / env.fr);
  };
  for (let ri = 0; ri < raw.length; ri++) {
    const r = raw[ri];
    if (!r.p || r.p.v < thr) continue;
    const tt = fineOnset(env, r.p.t, 0.03);
    const ww = Math.min(3, r.p.v / med);
    let k = 0;
    if (lastT >= 0) {
      const P = localP(lastI, ri);
      const x = (tt - lastT) / P;
      const nn = Math.round(x);
      if (nn >= 1 && Math.abs(x - nn) <= 0.22) {
        k = lastK + nn;
        skips = 0;
      } else if (++skips >= 8) {
        // 8 回続けて拍の格子から外れた → 拍の位置そのものがずれた（BPM が急に変わった等）とみなして、ここから数え直す
        k = lastK + Math.max(1, nn);
        skips = 0;
      } else continue;
    }
    pts.push({ k, t: tt, w: ww });
    lastT = tt;
    lastK = k;
    lastI = ri;
  }
  const K = (pts[pts.length - 1]?.k ?? -1) + 1;
  const t: number[] = new Array(K).fill(NaN);
  const w: number[] = new Array(K).fill(0);
  for (const p of pts) {
    t[p.k] = p.t;
    w[p.k] = p.w;
  }
  // 音のない拍の時刻は前後から補う（小節の頭を数えるときだけ使う）
  for (let k = 0; k < K; k++) {
    if (!Number.isNaN(t[k])) continue;
    let a = k - 1;
    let b = k + 1;
    while (b < K && Number.isNaN(t[b])) b++;
    const ta = t[a];
    const tb = b < K ? t[b] : ta + (b - a) * (60 / tempoAt(ta));
    for (let q = k; q < b; q++) t[q] = ta + ((tb - ta) * (q - a)) / (b - a);
    k = b - 1;
  }
  if (t.length < 8) {
    return { segments: [], t0: 0, downbeat: 0, duration };
  }
  // 小節の頭の位置（4 拍ごとの位置のうち、低い音の立ち上がりがいちばん強い所）。曲全体で数える
  const barPhaseOf = (timeOf: (k: number) => number) => {
    const sums = [0, 0, 0, 0];
    const cnt = [0, 0, 0, 0];
    for (let k = 0; k < t.length; k++) {
      // 低い音の立ち上がりは少し遅れて大きくなるので、少し後ろまで見る
      const i = Math.round((timeOf(k) - env.t0) * env.fr);
      // スネアなど全体に広がる音ではなく、低い音が「目立って」強い所（キック・太鼓）を見る
      let lo = 0;
      let al = 0;
      for (let d = -2; d <= 5; d++) {
        lo = Math.max(lo, env.low[i + d] ?? 0);
        al = Math.max(al, env.all[i + d] ?? 0);
      }
      sums[k % 4] += lo - 0.4 * al;
      cnt[k % 4]++;
    }
    let bm = 0;
    for (let m = 1; m < 4; m++) if (sums[m] / Math.max(1, cnt[m]) > sums[bm] / Math.max(1, cnt[bm])) bm = m;
    return bm;
  };
  const barPhase = barPhaseOf((k) => t[k]);
  // 区間を分けたことで、ずれが本当に小さくなったかを確かめる。実際の曲は音の立ち上がりのずれが大きく、
  // 外れた拍もあるので、ずれの「真ん中の値」で比べ、つないでもほとんど変わらない隣どうしはつなぐ
  const segMad = (s0: number, e0: number) => {
    const ks: number[] = [];
    for (let k = s0; k <= Math.min(e0, t.length - 1); k++) if (w[k] > 0) ks.push(k);
    if (ks.length < 3) return { mad: 0, n: ks.length };
    let sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
    for (const k of ks) {
      const x = k - s0;
      sw += w[k]; sk += w[k] * x; st += w[k] * t[k]; skk += w[k] * x * x; skt += w[k] * x * t[k];
    }
    const den = sw * skk - sk * sk;
    if (den <= 1e-12) return { mad: 0, n: ks.length };
    const P = (sw * skt - sk * st) / den;
    const A = (st - P * sk) / sw;
    const r = ks.map((k) => Math.abs(t[k] - (A + (k - s0) * P))).sort((x, y) => x - y);
    return { mad: r[Math.floor(r.length / 2)], n: ks.length };
  };
  const mergeSegs = () => {
    for (let guard = 0; guard < 500 && starts.length > 1; guard++) {
      let best = -1;
      let bestGain = Infinity;
      for (let j = 1; j < starts.length; j++) {
        const a0 = starts[j - 1];
        const b0 = starts[j];
        const c0 = j + 1 < starts.length ? starts[j + 1] : t.length - 1;
        const A = segMad(a0, b0);
        const B = segMad(b0, c0);
        const M = segMad(a0, c0);
        const worst = Math.max(A.mad, B.mad);
        if (M.mad <= worst * 1.15 + 0.0003 && M.mad - worst < bestGain) {
          bestGain = M.mad - worst;
          best = j;
        }
      }
      if (best < 0) break;
      starts.splice(best, 1);
    }
  };
  // 3. BPM が一定の区間に分ける（1 小節 = 4 拍以上。変わり目はなるべく小節の頭）→ 分けすぎた所をつなぐ
  let starts = segmentBeats(t, w, 4, barPhase);
  mergeSegs();
  // 4. 曲全体でつながるように当てはめ、外れた拍（裏拍を拾ったなど）を除いてもう一度
  let fit = jointFit(t, w, starts, starts.map(() => null));
  for (let iter = 0; iter < 3; iter++) {
    const res = t.map((tt, k) => (w[k] > 0 ? Math.abs(tt - fit.pred(k)) : 0));
    const used = res.filter((_, k) => w[k] > 0).sort((a, b) => a - b);
    const lim = Math.max(0.012, (used[Math.floor(used.length / 2)] ?? 0) * 4);
    for (let k = 0; k < t.length; k++) if (w[k] > 0 && res[k] > lim) w[k] = 0;
    starts = segmentBeats(t, w, 4, barPhase);
    mergeSegs();
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
      // その桁で切り下げ・切り上げの 2 つを試し、曲全体のずれが小さいほう（短い区間は測った値が少しぶれるため）
      const m = Math.pow(10, d);
      let bestF: ReturnType<typeof jointFit> | null = null;
      let bestC = 0;
      for (const c of [Math.floor(rawBpm * m) / m, Math.ceil(rawBpm * m) / m]) {
        const trial = fixed.slice();
        trial[j] = 60 / c;
        const f = jointFit(t, w, starts, trial);
        if (!bestF || f.rms < bestF.rms) {
          bestF = f;
          bestC = c;
        }
      }
      if (bestF && bestF.rms <= Math.max(base.rms * 1.25, base.rms + 0.0008) && bestF.max <= base.max + 0.004) {
        fixed[j] = 60 / bestC;
        fit = bestF;
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


// ---------- 大まかな測り方（区間ごとに、区間全体の立ち上がりを重ねて合わせる） ----------
// 実際の曲（音が多く、立ち上がりのずれも大きい）では、こちらのほうが拍の数え間違いが起きにくい

interface CoarseSeg {
  start: number;
  end: number;
  /** この区間の拍のうち、小節の頭の 1 つ（分かっているとき） */
  down?: number;
  bpm: number;
  rawBpm: number;
  phase: number;
  beats: number;
  matched: number;
  jitterMs: number;
}

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

function refineCoarse(env: Envelope, start: number, end: number, roughBpm: number): CoarseSeg {
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
  // 16 分音符が続く曲では、拍の 1/4・1/2・3/4 ずれた所にも同じくらい音が乗る。
  // 低い音（キック・太鼓など）も合わせて見て、いちばん強い所を拍にする
  {
    const hitAt = (t: number) => {
      const i = Math.round((t - t0) * fr);
      let a = 0;
      let l = 0;
      for (let d = -3; d <= 2; d++) {
        a = Math.max(a, all[i + d] ?? 0);
        l = Math.max(l, env.low[i + d] ?? 0);
      }
      return a + l;
    };
    let bq = 0;
    let bv = -Infinity;
    for (let q = 0; q < 4; q++) {
      const ph = phase + (q * P) / 4;
      let sum = 0;
      let n = 0;
      for (let t = ph + Math.ceil((start - ph) / P) * P; t < end; t += P) { sum += hitAt(t); n++; }
      const v = n ? sum / n : 0;
      if (v > bv * 1.02) { bv = v; bq = q; }
    }
    phase += (bq * P) / 4;
  }
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
  // きりのいい BPM（整数 → 小数 1 桁 → 2 桁）にしても、区間全体のずれがほとんど増えなければそちらを使う
  const rmsWith = (Pc: number) => {
    let sw = 0, s = 0;
    for (const p of use) { sw += p.w; s += p.w * (p.t - p.k * Pc); }
    const ac = sw ? s / sw : 0;
    let s2 = 0;
    for (const p of use) s2 += p.w * Math.pow(p.t - (ac + p.k * Pc), 2);
    return Math.sqrt(s2 / Math.max(1e-9, sw));
  };
  const baseRms = rmsWith(P);
  let bpm = Number(rawBpm.toFixed(3));
  for (const d of [0, 1, 2]) {
    const c = Number(rawBpm.toFixed(d));
    if (rmsWith(60 / c) <= Math.max(baseRms * 1.1, baseRms + 0.001)) {
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



/**
 * BPM が変わる所を細かく決める（だんだん速く・遅くなる所も）。
 * G = 続いた区間（最初 A・途中・最後 Z）。A の拍から始めて、1 拍ずつ「どの BPM で次の拍に進むか」を選び、Z の BPM で終わる道のうち、
 * 拍の位置に音がいちばんよく乗るものを探す（動的計画法）。BPM を変えるたびに減点し、同じ BPM は 4 拍（1 小節）以上続ける。
 * BPM は今の区間から次の区間の BPM へ向かう向きにだけ変え、小節の頭以外で変えるときは減点する。
 * 戻り値は A と Z の間の区間（A.end・Z.start も直す）。見つからないときは null
 */
const KERN = [0.5, 0.85, 1, 0.85, 0.5];
/** 短い区間（16 拍以下）の BPM は細かく測れないので、5 の倍数まで 1.5% 以内なら 5 の倍数にする */
function snap5(bpm: number, beats: number) {
  const r = Math.round(bpm / 5) * 5;
  return beats <= 16 && Math.abs(bpm / r - 1) <= 0.015 ? r : bpm;
}
function bridge(env: Envelope, G: CoarseSeg[]): CoarseSeg[] | null {
  const { fr, t0, all } = env;
  const A = G[0];
  const Z = G[G.length - 1];
  // 途中の区間のうち短いもの（16 秒未満）は、だんだん変わる所を大まかに 1 つの BPM で見ただけのことが多いので、目印にしない
  const inner = G.slice(1, -1).filter((g) => g.end - g.start >= 16);
  const lo = Math.max(A.start, A.end - 12);
  const hi = Math.min(Z.end, Z.start + 12);
  if (hi - lo < 6) return null;
  const PA = 60 / A.bpm;
  const PZ = 60 / Z.bpm;
  // 立ち上がりの山は拍の位置より少し早めに出る。どれだけ早いかは、A の拍の所で山がいちばん高くなるずれから決める
  let lag = 0;
  {
    let bv = -Infinity;
    for (let d = -4; d <= 2; d++) {
      let sum = 0;
      for (let t = A.phase + Math.ceil((lo - A.phase) / PA) * PA; t < A.end; t += PA) sum += all[Math.round((t - t0) * fr) + d] ?? 0;
      if (sum > bv) { bv = sum; lag = d; }
    }
  }
  const hit = (t: number) => {
    const i = Math.round((t - t0) * fr) + lag;
    // 拍の位置から離れるほど弱く数える
    // （低い音は使わない。裏にキックがある曲で、拍の位置を取り違えやすいため）
    let a = 0;
    for (let d = -2; d <= 2; d++) a = Math.max(a, (all[i + d] ?? 0) * KERN[d + 2]);
    return a;
  };
  let mu = 0;
  let cnt = 0;
  for (let t = lo; t < hi; t += 0.01) { mu += hit(t); cnt++; }
  mu /= Math.max(1, cnt);
  if (!(mu > 0)) return null;
  const LAMBDA = 3 * mu;
  // BPM の候補: 0 = A、1 = Z（同じ BPM でも別に扱う）、途中の区間の BPM、その間（少し外側まで）の整数
  const all3 = G.map((g) => g.bpm);
  const bl = Math.min(...all3) * 0.97;
  const bh = Math.max(...all3) * 1.03;
  const cand: number[] = [A.bpm, Z.bpm];
  for (const g of inner) if (!cand.slice(2).includes(g.bpm)) cand.push(g.bpm);
  const nAnchor = cand.length;
  for (let b = Math.ceil(bl); b <= bh; b++) if (!cand.slice(2).includes(b)) cand.push(b);
  const nT = cand.length;
  // きりのいい BPM（5 の倍数）を少し優先する
  const odd = (k: number) => (k >= nAnchor && cand[k] % 5 !== 0 ? LAMBDA : 0);
  // 途中の区間の中ほどは、その区間の BPM のままでいて、拍は数えない。
  // 途中の区間の拍の位置は、区間の中の音の強さ（裏拍が強い曲などで迷う）ではなく、前後の BPM の変わり目からのつながりで決める。
  // 中ほど = 4 秒の窓で見て、その区間の BPM がほかの候補の BPM よりよく合う所が続く範囲（両端を少し内側に）
  const WIN = 4;
  const inside = inner.map((g) => {
    const others = cand.filter((b) => Math.abs(b / g.bpm - 1) > 0.05);
    const wins: { T: number; w: boolean }[] = [];
    const from = Math.max(lo, g.start - 10);
    const to = Math.min(hi, g.end + 10) - WIN;
    for (let T = from; T <= to + 1e-9; T += 0.5) {
      const i0 = Math.max(0, Math.round((T - t0) * fr));
      const i1 = Math.min(all.length, Math.round((T + WIN - t0) * fr));
      const own = foldScore(all, fr, t0, i0, i1, 60 / g.bpm).score;
      let w = own > 0;
      for (const b of others) if (foldScore(all, fr, t0, i0, i1, 60 / b).score * 0.9 > own) { w = false; break; }
      wins.push({ T, w });
    }
    // 勝つ窓が続く、いちばん長い範囲（1 つだけ負けた窓ははさんでもよい）
    let best: [number, number] | null = null;
    for (let i = 0; i < wins.length; i++) {
      if (!wins[i].w || (i > 0 && wins[i - 1].w)) continue;
      let j = i;
      while (j + 1 < wins.length && (wins[j + 1].w || (j + 2 < wins.length && wins[j + 2].w))) j++;
      if (!wins[j].w) j--;
      if (!best || wins[j].T - wins[i].T > best[1] - best[0]) best = [wins[i].T, wins[j].T];
    }
    // 窓の中に前後の BPM が少し入っていても勝つことがあるので、内側に 2.5 秒ずつ寄せる
    return best && best[1] + WIN - 2.5 > best[0] + 2.5 ? [best[0] + 2.5, best[1] + WIN - 2.5] : null;
  });
  const innerAt = (t: number) => {
    for (let j = 0; j < inner.length; j++) { const r = inside[j]; if (r && t > r[0] && t < r[1]) return j; }
    return -1;
  };
  const score = (_k: number, t: number) => (innerAt(t) >= 0 ? 0 : hit(t) - mu);
  // 区間の順番（A → 途中の区間 → Z）。BPM は今の区間から次の区間の BPM へ向かう向きにだけ変える
  // （行ってすぐ戻るような変化は、拍の位置を合わせるためだけのものになりやすいので使わない）
  const ord = [0, ...inner.map((g) => cand.indexOf(g.bpm, 2)), 1];
  const nSt = ord.length - 1;
  const ts = Math.ceil((lo - A.phase) / PA);
  const tStart = A.phase + ts * PA;
  // 小節の中の拍の位置（0 = 小節の頭）。BPM は小節の頭で変わることが多いので、それ以外で変えるときは減点
  const aDown = A.down ?? findDownbeatCoarse(env, A);
  const bp0 = ((Math.round((tStart - aDown) / PA) % 4) + 4) % 4;
  const OFFBAR = LAMBDA;
  const NB = 4;
  // 状態は時刻を 2 フレームごとにまとめて持つ（メモリを減らすため。時刻そのものは別に細かく覚える）
  const BK = fr / 2;
  const nF = Math.ceil((hi - tStart) * BK) + 2;
  // 同じ BPM は 4 拍以上続ける（c = 今の BPM になってからの拍数。4 で止める）
  const MINLEN = 4;
  const S = nF * nT * NB * MINLEN * nSt;
  const val = new Float32Array(S).fill(-Infinity);
  // 時刻は tStart からの秒数
  const tim = new Float32Array(S);
  const back = new Int32Array(S).fill(-1);
  const key = (f: number, k: number, bp: number, c: number, st: number) => (((f * nT + k) * NB + bp) * MINLEN + (c - 1)) * nSt + st;
  const s0 = key(0, 0, bp0, MINLEN, 0);
  val[s0] = 0;
  tim[s0] = 0;
  const relax = (s2: number, v2: number, t2: number, from: number) => {
    if (v2 > val[s2]) {
      val[s2] = v2;
      tim[s2] = t2 - tStart;
      back[s2] = from;
    }
  };
  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < nT; k++) {
      for (let bp = 0; bp < NB; bp++) for (let c = 1; c <= MINLEN; c++) {
        for (let st = 0; st < nSt; st++) {
          const s = key(f, k, bp, c, st);
          const v = val[s];
          if (v === -Infinity) continue;
          const t = tStart + tim[s];
          const bp2 = (bp + 1) % NB;
          // 同じ BPM で次の拍へ
          {
            const t2 = t + 60 / cand[k];
            const j = innerAt(t2);
            if (t2 < hi && (j < 0 || ord[j + 1] === k)) relax(key(Math.round((t2 - tStart) * BK), k, bp2, Math.min(MINLEN, c + 1), st), v + score(k, t2), t2, s);
          }
          if (k === 1 || c < MINLEN) continue;
          // ここ（拍 t）から BPM を変える
          const target = cand[ord[st + 1]];
          for (let k2 = 0; k2 < nT; k2++) {
            if (k2 === k) continue;
            let st2 = st;
            if (k2 === ord[st + 1]) st2 = Math.min(nSt - 1, st + 1);
            else if (k2 < nAnchor) continue;
            else if (!((cand[k2] - cand[k]) * (target - cand[k2]) > 0)) continue;
            const pen = LAMBDA + odd(k2) + (bp === 0 ? 0 : OFFBAR);
            const t2 = t + 60 / cand[k2];
            const j = innerAt(t2);
            if (t2 < hi && (j < 0 || ord[j + 1] === k2)) relax(key(Math.round((t2 - tStart) * BK), k2, bp2, 1, st2), v + score(k2, t2) - pen, t2, s);
          }
        }
      }
    }
  }
  // 終わり: Z の BPM で、Z の拍の位置（±15ms）にいる所。
  // 16 分が続く曲では Z の拍が 1/4 拍ずれて測られていることがあるので、1/4 拍ずれた所も（少し減点して）認める
  let end = -1;
  let ev = -Infinity;
  for (let f = Math.max(0, nF - Math.ceil(PZ * BK) - 2); f < nF; f++) {
    for (let bp = 0; bp < NB; bp++) for (let c = 1; c <= MINLEN; c++) {
      const s = key(f, 1, bp, c, nSt - 1);
      if (val[s] === -Infinity) continue;
      const t = tStart + tim[s];
      const x = (t - Z.phase) / PZ;
      const q4 = Math.round(x * 4);
      const d = Math.abs(x * 4 - q4) * (PZ / 4);
      if (d > 0.015) continue;
      const v = val[s] - (q4 % 4 === 0 ? 0 : LAMBDA * 0.5);
      if (v > ev) { ev = v; end = s; }
    }
  }
  if (end < 0) return null;
  // たどって、BPM ごとの区間にする（拍 i から i+1 までは、拍 i+1 の状態の BPM）
  const path: { t: number; k: number }[] = [];
  for (let s = end; s >= 0; s = back[s]) path.push({ t: tStart + tim[s], k: Math.floor(s / (NB * MINLEN * nSt)) % nT });
  path.reverse();
  const endBp = Math.floor(end / (MINLEN * nSt)) % NB;
  const pieces: { k: number; start: number; end: number; beats: number }[] = [];
  for (let i = 1; i < path.length; i++) {
    const k = path[i].k;
    const last = pieces[pieces.length - 1];
    if (last && last.k === k) { last.end = path[i].t; last.beats++; }
    else pieces.push({ k, start: path[i - 1].t, end: path[i].t, beats: 1 });
  }
  // ほとんど同じ BPM（1.5% 未満の差）の隣どうしはつなぐ（A・Z・途中の区間の BPM、または長いほうにする）
  for (let i = 1; i < pieces.length; ) {
    const p = pieces[i - 1];
    const q = pieces[i];
    if (Math.abs(cand[p.k] / cand[q.k] - 1) >= 0.015) { i++; continue; }
    const rank = (x: typeof p) => (x.k <= 1 ? Infinity : x.k < nAnchor ? 1e6 + x.end - x.start : x.end - x.start);
    const k = rank(p) >= rank(q) ? p.k : q.k;
    const P = 60 / cand[k];
    pieces.splice(i - 1, 2, { k, start: p.start, end: q.end, beats: Math.max(0.25, Math.round((4 * (q.end - p.start)) / P) / 4) });
  }
  const out: CoarseSeg[] = [];
  let aEnd = A.end;
  let zStart = A.end;
  for (const p of pieces) {
    if (p.k === 0) { aEnd = p.end; zStart = p.end; }
    else if (p.k === 1) { zStart = p.start; break; }
    else {
      // 途中の区間と同じ BPM なら、その区間の測った値（ずれの大きさなど）を使う
      const g = inner.find((x) => x.bpm === cand[p.k]);
      out.push(g && p.end - p.start > 8
        ? { ...g, start: p.start, end: p.end, phase: p.start }
        : { start: p.start, end: p.end, bpm: snap5(cand[p.k], p.beats), rawBpm: cand[p.k], phase: p.start, beats: p.beats, matched: p.beats, jitterMs: 0 });
    }
  }
  A.end = aEnd;
  Z.start = zStart;
  // Z の拍の位置は、つながった所に合わせる（次の境目を探すときに使う）
  Z.phase = tStart + tim[end];
  Z.down = Z.phase - endBp * PZ;
  return out;
}

/** 小節の頭: 4 拍ごとの位置のうち、低い音の立ち上がりがいちばん強い所 */
function findDownbeatCoarse(env: Envelope, seg: CoarseSeg): number {
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

function analyzeCoarse(env: Envelope, tg: { center: number; score: Float32Array }[], path: number[], duration: number): { segs: CoarseSeg[]; downbeat: number } {
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
  const segs: CoarseSeg[] = [];
  raws.forEach((r, i) => {
    // 区間の境目: 窓の中心の真ん中
    const start = i === 0 ? 0 : (tg[r.a - 1].center + tg[r.a].center) / 2;
    const end = i === raws.length - 1 ? duration : (tg[r.b].center + tg[r.b + 1].center) / 2;
    const med = [...r.bpm].sort((p, q) => p - q)[Math.floor(r.bpm.length / 2)];
    segs.push(refineCoarse(env, start, end, med));
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
  const first = segs[0];
  return { segs, downbeat: first ? findDownbeatCoarse(env, first) : 0 };
}

// ---------- 譜面に入れる形にする ----------

/** 大まかな測り方の結果を、拍の番号で表す形にする */
function coarseToResult(c: { segs: CoarseSeg[]; downbeat: number }, duration: number): TempoResult {
  const segs = c.segs;
  if (!segs.length) return { segments: [], t0: 0, downbeat: 0, duration };
  const P1 = 60 / segs[0].bpm;
  // 拍 0 = 最初の区間の拍のうち、0 秒以降でいちばん早いもの
  const t0 = segs[0].phase + Math.ceil((0 - segs[0].phase) / P1) * P1;
  const out: TempoSegment[] = [];
  let beat = 0;
  let tPrev = t0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const P = 60 / s.bpm;
    const endT = i + 1 < segs.length ? segs[i + 1].start : duration;
    // BPM は拍の途中（1/4 拍単位）でも変わることがある
    const n = i + 1 < segs.length ? Math.max(0.25, Math.round((4 * (endT - tPrev)) / P) / 4) : Math.max(1, Math.floor((endT - tPrev) / P));
    out.push({
      startBeat: beat, endBeat: beat + n, start: i === 0 ? 0 : tPrev, end: endT,
      bpm: s.bpm, rawBpm: s.rawBpm, beats: s.beats, matched: s.matched, jitterMs: s.jitterMs,
    });
    beat += n;
    tPrev += n * P;
  }
  const down = ((Math.round((c.downbeat - t0) / P1) % 4) + 4) % 4;
  return { segments: out, t0, downbeat: down, duration };
}

/** 案の拍が、曲の音の立ち上がりにどれだけ乗っているか（高いほどよい）。2 つの測り方のどちらを使うか決めるのに使う */
function alignScore(env: Envelope, r: TempoResult, phaseFree = false): number {
  if (!r.segments.length) return -Infinity;
  let sum = 0;
  let n = 0;
  let ts = r.t0;
  for (const s of r.segments) {
    const P = 60 / s.bpm;
    const nb = s.endBeat - s.startBeat;
    // phaseFree: 区間ごとに、拍を 1/4 拍ずつずらした中でいちばん合う所で数える（BPM が合っているかだけを見る。
    // 裏拍が強い曲では、正しい拍の位置より 1/4 拍ずれた所のほうが音が強いことがあるため）
    let best = -Infinity;
    for (const q of phaseFree ? [0, 0.25, 0.5, 0.75] : [0]) {
      let sq = 0;
      for (let j = 0; j < nb; j++) {
        // 立ち上がりの山は少し早めに出るので、少し前を広めに見る（-35ms〜+12ms）
        const i = Math.round((ts + (j + q) * P - env.t0) * env.fr);
        let v = 0;
        for (let d = -3; d <= 1; d++) v = Math.max(v, env.all[i + d] ?? 0);
        sq += v;
      }
      best = Math.max(best, sq);
    }
    sum += best;
    n += Math.max(0, Math.ceil(nb));
    ts += nb * P;
  }
  return n ? sum / n : -Infinity;
}

/**
 * 曲の BPM（途中の変化も）と、小節の頭を測る。
 * 2 つの測り方（大まかに区間全体で合わせる／拍を 1 つずつ追う）で測り、曲の音の立ち上がりによく乗っているほうを使う
 */
export function analyzeTempo(mono: Float32Array, sr: number, progress?: (p: number) => void): TempoResult {
  const duration = mono.length / sr;
  const env = envelope(mono, sr, progress);
  const tg = tempogram(env.all, env.fr, progress);
  const path = tempoPath(tg);
  const craw = analyzeCoarse(env, tg, path, duration);
  const rawInfo = craw.segs.map((x) => Math.round(x.bpm)).join('→');
  let bridgeFail = 0;
  // 大まかな測り方の区間の整理: 8 秒未満の短い区間（裏拍や 3 連のリズムが目立つだけのことが多い）は隣につなぎ、
  // BPM の差が 1.5% 未満の隣どうしもつなぐ（つないだ所は、つないだ範囲全体で合わせ直す）
  {
    let segs = craw.segs;
    // 倍・半分の取り違えを直す: いちばん長い区間を基準に、隣の区間との BPM の比が 1 に近くなるほうの倍・半分を選ぶ
    if (segs.length > 1) {
      const len = (x: CoarseSeg) => x.end - x.start;
      let a = 0;
      segs.forEach((x, i) => { if (len(x) > len(segs[a])) a = i; });
      const fix = (i: number, ref: number) => {
        const x = segs[i];
        let c = x.bpm;
        for (const m of [0.5, 2]) {
          const b = x.bpm * m;
          if (b >= BPM_MIN && b <= BPM_MAX && Math.abs(Math.log2(b / ref)) < Math.abs(Math.log2(c / ref)) - 0.1) c = b;
        }
        if (c !== x.bpm) segs[i] = refineCoarse(env, x.start, x.end, c);
      };
      for (let i = a + 1; i < segs.length; i++) fix(i, segs[i - 1].bpm);
      for (let i = a - 1; i >= 0; i--) fix(i, segs[i + 1].bpm);
    }
    for (let guard = 0; guard < 50 && segs.length > 1; guard++) {
      let j = segs.findIndex((x) => x.end - x.start < 8);
      if (j < 0) j = segs.findIndex((x, i) => i > 0 && Math.abs(x.bpm / segs[i - 1].bpm - 1) < 0.015);
      if (j < 0) break;
      const k = j === 0 ? 1 : j === segs.length - 1 ? j - 1 : segs[j - 1].end - segs[j - 1].start >= segs[j + 1].end - segs[j + 1].start ? j - 1 : j + 1;
      const a0 = Math.min(j, k);
      const keep = segs[j].end - segs[j].start >= segs[k].end - segs[k].start ? segs[j] : segs[k];
      const merged = refineCoarse(env, segs[a0].start, segs[a0 + 1].end, keep.bpm);
      segs = [...segs.slice(0, a0), merged, ...segs.slice(a0 + 2)];
    }
    // 境目を細かく決め、だんだん変わる所は小さな区間に分ける。
    // 短い（40 秒未満の）区間をはさむときは、その前後の区間とまとめて 1 度に決める
    if (segs.length > 1) {
      const out: CoarseSeg[] = [segs[0]];
      let i = 0;
      while (i < segs.length - 1) {
        let j = i + 1;
        while (j < segs.length - 1 && segs[j].end - segs[j].start < 40) j++;
        const mid = bridge(env, segs.slice(i, j + 1));
        if (!mid) bridgeFail++;
        out.push(...(mid ?? segs.slice(i + 1, j)), segs[j]);
        i = j;
      }
      segs = out;
    }
    craw.segs = segs;
    if (segs.length) craw.downbeat = segs[0].down ?? findDownbeatCoarse(env, segs[0]);
  }
  const coarse = coarseToResult(craw, duration);
  const fine = analyzeFine(env, tg, path, duration, progress);
  progress?.(1);
  // 曲全体を 1 つの BPM として合わせた案。多くの曲は BPM が変わらないので、変わる案ははっきりよいときだけ使う
  // （裏拍や 3 連のリズムが目立つ所を、BPM が変わったと取り違えないように）
  const med = [...path].sort((p, q) => p - q)[Math.floor(path.length / 2)] ?? 120;
  const one = refineCoarse(env, 0, duration, med);
  const single = coarseToResult({ segs: [one], downbeat: findDownbeatCoarse(env, one) }, duration);
  const ss = alignScore(env, single);
  const sc = alignScore(env, coarse);
  const sf = alignScore(env, fine);
  // 区間が多い案ほど、はっきりよいときだけ使う
  let best = single;
  let bs = ss;
  // 1 つの BPM と区間ごとのどちらにするかは、拍の位置（1/4 拍のずれ）を問わずに、BPM が合っているかで比べる
  if (coarse.segments.length > 1 && alignScore(env, coarse, true) > alignScore(env, single, true) * 1.04) {
    best = coarse;
    bs = sc;
  }
  // 細かい測り方は、BPM が隣の区間と大きく（8% 以上）違う所が多いときは使わない（拍の数え間違いの印）
  let jumps = 0;
  for (let i = 1; i < fine.segments.length; i++) if (Math.abs(fine.segments[i].bpm / fine.segments[i - 1].bpm - 1) > 0.08) jumps++;
  const fineOk = jumps <= Math.max(2, fine.segments.length / 10);
  if (fineOk && sf > bs * 1.03 && sf > ss * 1.04) best = fine;
  const name = best === single ? '1 つの BPM' : best === coarse ? '区間ごと' : '1 拍ずつ';
  const bpms = (r: TempoResult) => r.segments.map((x) => x.bpm).join('→');
  best.info = `大まかな区間 ${rawInfo}／区間ごと ${bpms(coarse)}${bridgeFail ? `（つなぎ失敗 ${bridgeFail}）` : ''}／合い方 1 つ ${ss.toFixed(3)}・区間 ${sc.toFixed(3)}・1 拍ずつ ${sf.toFixed(3)}／採用 ${name}`;
  return best;
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
  // BPM は拍の途中で変わることもあるので、tick ごとの時刻を区間ごとに足していく
  let t = -plan.offset;
  let tick = 0;
  let bpm = plan.bpm;
  let ci = 0;
  for (let k = 0; t <= untilSec && k < 100000; k++) {
    const target = k * tpb;
    while (ci < plan.changes.length && plan.changes[ci].tick <= target) {
      t += ((plan.changes[ci].tick - tick) / tpb) * (60 / bpm);
      tick = plan.changes[ci].tick;
      bpm = plan.changes[ci++].bpm;
    }
    t += ((target - tick) / tpb) * (60 / bpm);
    tick = target;
    if (t > untilSec) break;
    out.push({ t, bar: k % 4 === 0 });
  }
  return out;
}
