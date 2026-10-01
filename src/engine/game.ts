import { isDon, isHitNote, type Note } from '../chart/types';

export type Judge = 'good' | 'ok' | 'bad';
export type HitKind = 'don' | 'ka';

/** 判定幅（秒）。片側の幅 */
export const WINDOW = { good: 0.035, ok: 0.09, bad: 0.12 } as const;

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
      if (now - s.note.time > WINDOW.bad) {
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

  /** 叩いたときに呼ぶ */
  hit(kind: HitKind, now: number) {
    // 1) 判定幅内の普通ノーツを優先
    const s = this.nextHitNote();
    if (s) {
      const delta = now - s.note.time;
      const ad = Math.abs(delta);
      if (ad <= WINDOW.bad) {
        const colorOk = (kind === 'don') === isDon(s.note.type);
        let judge: Judge = 'bad';
        if (colorOk) judge = ad <= WINDOW.good ? 'good' : ad <= WINDOW.ok ? 'ok' : 'bad';
        this.apply(s, judge, delta);
        return;
      }
    }

    // 2) 連打・風船の最中なら加算
    for (const ls of this.states) {
      const n = ls.note;
      if (ls.done || isHitNote(n.type)) continue;
      if (now < n.time) break; // states は時刻順
      if (now > (n.endTime ?? n.time)) continue;
      if (n.type === 'balloon') {
        if (kind !== 'don') return;
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
  }

  private nextHitNote(): NoteState | undefined {
    for (let i = this.cursor; i < this.hitIdx.length; i++) {
      const s = this.states[this.hitIdx[i]];
      if (!s.done) return s;
    }
    return undefined;
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
    this.onJudge({ judge, note: s.note, delta, missed: !!s.missed });
  }
}
