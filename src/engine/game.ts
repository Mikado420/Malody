import { isDon, isHitNote, type Note } from '../chart/types';

export type Judge = 'good' | 'ok' | 'bad';
export type HitKind = 'don' | 'ka';

/** 判定幅（秒）。片側の幅。本家と同じ 良 ±25ms / 可 ±75ms / 不可 ±114ms */
/** 浮動小数点の誤差の吸収（0.001ms） */
const EPS = 1e-6;

/** 大音符の両手打ちを待つ時間（秒）。TNDE の BigNotesWaitTime と同じ 50ms */
export const BIG_WAIT = 0.05;

export const WINDOW = { good: 0.025, ok: 0.075, bad: 0.114 } as const;

export interface NoteState {
  note: Note;
  /** 普通ノーツ: 判定済みか。長いノーツ: 終了したか */
  done: boolean;
  judge?: Judge;
  /** 連打数・風船の打数 */
  count: number;
  /** 叩かずに見逃した（画面左まで流れ続ける） */
  missed?: boolean;
}

export interface JudgeEvent {
  judge: Judge;
  note: Note;
  delta: number; // 叩いた時刻 - ノーツ時刻（＋で遅い）
  missed: boolean;
}

export interface Stats {
  good: number;
  ok: number;
  bad: number;
  combo: number;
  maxCombo: number;
  rolls: number;
  score: number;
  /** 魂ゲージ 0〜100（80 でクリア） */
  gauge: number;
}

export const CLEAR_LINE = 80;

/**
 * 判定ロジック本体。描画や入力から独立しているのでテストしやすい。
 */
export class Game {
  readonly states: NoteState[];
  readonly stats: Stats = { good: 0, ok: 0, bad: 0, combo: 0, maxCombo: 0, rolls: 0, score: 0, gauge: 0 };
  /** 次に判定する普通ノーツのインデックス */
  private cursor = 0;
  private readonly hitIdx: number[];
  /** 叩いたノーツのずれ（秒、＋で遅い）。色が合っていたものだけ。結果画面で平均を出して判定調整に使う */
  readonly deltas: number[] = [];
  onJudge: (e: JudgeEvent) => void = () => {};
  /** 連打・風船を叩いたとき */
  onRoll: (s: NoteState) => void = () => {};

  constructor(notes: Note[]) {
    this.states = notes
      .slice()
      .sort((a, b) => a.time - b.time)
      .map((note) => ({ note, done: false, count: 0 }));
    this.hitIdx = this.states.map((_, i) => i).filter((i) => isHitNote(this.states[i].note.type));
  }

  get totalHitNotes() {
    return this.hitIdx.length;
  }

  get finished() {
    return this.states.every((s) => s.done);
  }

  /** 毎フレーム呼ぶ。見逃したノーツを「不可」にし、終わった連打を閉じる */
  update(now: number) {
    while (this.cursor < this.hitIdx.length) {
      const s = this.states[this.hitIdx[this.cursor]];
      if (s.done) { this.cursor++; continue; }
      if (now - s.note.time > WINDOW.bad + EPS) {
        s.missed = true;
        this.apply(s, 'bad', now - s.note.time);
        this.cursor++;
      } else break;
    }
    for (const s of this.states) {
      if (!s.done && !isHitNote(s.note.type) && now > (s.note.endTime ?? s.note.time)) {
        s.done = true;
      }
    }
  }

  /** 大音符を叩いた直後の、両手打ちの 2 打目を待っている状態 */
  private bigWait: { kind: HitKind; at: number } | null = null;

  /** 叩いたときに呼ぶ */
  hit(kind: HitKind, now: number) {
    // 1) 大音符の両手打ち: 大音符を叩いてから 50ms 以内の同じ色の 2 打目は、次のノーツの判定に使わない
    //    （使うと次のノーツが「早い不可」になる。TNDE の BigNotesWaitTime=50ms と同じ考え方）
    const bw = this.bigWait;
    if (bw && kind === bw.kind && now >= bw.at - EPS && now - bw.at <= BIG_WAIT + EPS) {
      this.bigWait = null;
      this.stats.score += 500;
      return;
    }

    // 2) 連打・風船の最中なら、そちらに入れる（次のノーツを早く叩いたことにしない）
    for (const ls of this.states) {
      const n = ls.note;
      if (ls.done || isHitNote(n.type)) continue;
      if (now < n.time) break; // states は時刻順
      if (now > (n.endTime ?? n.time)) continue;
      if (n.type === 'balloon') {
        if (kind !== 'don') return; // 風船はドンだけ。カッは何も起きない
        ls.count++;
        this.stats.score += 300;
        if (ls.count >= (n.hits ?? 5)) {
          ls.done = true;
          this.stats.score += 5000;
        }
      } else {
        ls.count++;
        this.stats.rolls++;
        this.stats.score += n.type === 'bigRoll' ? 200 : 100;
      }
      this.onRoll(ls);
      return;
    }

    // 3) 判定幅の中で、叩いた色と同じ色のノーツのうち、叩いた時刻にいちばん近いものを判定する
    //    - 色違いのノーツは対象にしない（色違いで叩いても不可にはせず、ノーツは残る。TNDE/TJAPlayer3 と同じ）
    //    - いちばん古いノーツにすると、1つ見逃しただけで後のノーツが全部「遅い」扱いになってしまう
    let best: NoteState | undefined;
    let bestAd = Infinity;
    for (let i = this.cursor; i < this.hitIdx.length; i++) {
      const st = this.states[this.hitIdx[i]];
      const d = now - st.note.time;
      if (d < -WINDOW.bad - EPS) break; // ここから先はもっと未来
      if (st.done) continue;
      if ((kind === 'don') !== isDon(st.note.type)) continue;
      const ad = Math.abs(d);
      if (ad <= WINDOW.bad + EPS && ad < bestAd - 1e-9) {
        best = st;
        bestAd = ad;
      }
    }
    if (!best) return; // 判定幅の中に同じ色のノーツがない: 音が鳴るだけ

    const delta = now - best.note.time;
    // 境界ちょうど（例: 25ms）が浮動小数点の誤差で外れないよう、わずかに余裕を持たせる
    const ad = Math.abs(delta) - EPS;
    const judge: Judge = ad <= WINDOW.good ? 'good' : ad <= WINDOW.ok ? 'ok' : 'bad';
    this.deltas.push(delta);
    this.apply(best, judge, delta);
    const big = best.note.type === 'bigDon' || best.note.type === 'bigKa';
    this.bigWait = big && judge !== 'bad' ? { kind, at: now } : null;
  }

  private apply(s: NoteState, judge: Judge, delta: number) {
    s.done = true;
    s.judge = judge;
    const st = this.stats;
    st[judge]++;
    if (judge === 'bad') {
      st.combo = 0;
    } else {
      st.combo++;
      st.maxCombo = Math.max(st.maxCombo, st.combo);
      const big = s.note.type === 'bigDon' || s.note.type === 'bigKa';
      let pts = judge === 'good' ? 1000 : 500;
      if (big) pts *= 2;
      if (s.note.gogo) pts = Math.round(pts * 1.2);
      st.score += pts;
    }
    // 全部「良」でちょうど満タン、「可」は半分、「不可」は 2 倍減る
    const unit = 100 / Math.max(1, this.hitIdx.length);
    const dg = judge === 'good' ? unit : judge === 'ok' ? unit * 0.5 : -unit * 2;
    st.gauge = Math.min(100, Math.max(0, st.gauge + dg));
    if (st.gauge > 100 - 1e-6) st.gauge = 100; // 小数の誤差で満タンにならないのを防ぐ
    this.onJudge({ judge, note: s.note, delta, missed: !!s.missed });
  }
}
