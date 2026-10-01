import type { BarLine, Chart, Note, NoteType } from './types';

/**
 * TJA パーサ（最小実装）
 * 対応: TITLE / SUBTITLE / BPM / OFFSET / WAVE / DEMOSTART / COURSE / LEVEL / BALLOON
 *       #START #END #BPMCHANGE #SCROLL #MEASURE #DELAY #GOGOSTART #GOGOEND #BARLINEON #BARLINEOFF
 * 未対応（無視）: 譜面分岐 (#BRANCHSTART 等) の分岐先選択、#LYRIC など
 *   → 分岐は現状すべて「普通譜面 (#N)」だけを採用する
 */

const COURSE_NAMES = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];

function normalizeCourse(v: string): string {
  const s = v.trim().toLowerCase();
  const idx = ['easy', 'normal', 'hard', 'oni', 'edit'].indexOf(s);
  if (idx >= 0) return COURSE_NAMES[idx];
  const n = Number(s);
  if (Number.isInteger(n) && n >= 0 && n <= 4) return COURSE_NAMES[n];
  return v.trim() || 'Oni';
}

type Item = { kind: 'note'; ch: string } | { kind: 'cmd'; name: string; arg: string };

const NOTE_CHARS = /[0-9AB]/;

interface CourseHeader {
  name: string;
  level: number;
  balloons: number[];
}

export function parseTJA(text: string): Chart {
  const chart: Chart = {
    title: '',
    subtitle: '',
    wave: '',
    bpm: 120,
    offset: 0,
    demoStart: 0,
    courses: [],
  };

  let header: CourseHeader = { name: 'Oni', level: 0, balloons: [] };
  let inChart = false;
  let measureItems: Item[] = [];
  // 譜面分岐: 'N' 以外の分岐中はノーツを読み飛ばす
  let branch: 'none' | 'N' | 'E' | 'M' = 'none';

  // 譜面ごとの状態
  let st = newState(chart);
  let notes: Note[] = [];
  let bars: BarLine[] = [];

  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const m = line.match(/^#([A-Z]+)\s*(.*)$/i);
      if (!m) continue;
      const name = m[1].toUpperCase();
      const arg = m[2].trim();

      if (name === 'START') {
        if (/P2/i.test(arg)) continue; // 2P 譜面は無視
        inChart = true;
        branch = 'none';
        measureItems = [];
        st = newState(chart);
        notes = [];
        bars = [];
        continue;
      }
      if (name === 'END') {
        if (!inChart) continue;
        if (measureItems.some((i) => i.kind === 'note')) {
          processMeasure(measureItems, st, notes, bars, header.balloons);
        }
        chart.courses.push({ name: header.name, level: header.level, notes, bars });
        inChart = false;
        continue;
      }
      if (!inChart) continue;

      // 分岐: 普通譜面だけ読む
      if (name === 'BRANCHSTART') { branch = 'none'; continue; }
      if (name === 'N') { branch = 'N'; continue; }
      if (name === 'E') { branch = 'E'; continue; }
      if (name === 'M') { branch = 'M'; continue; }
      if (name === 'BRANCHEND') { branch = 'none'; continue; }
      if (branch === 'E' || branch === 'M') continue;

      measureItems.push({ kind: 'cmd', name, arg });
      continue;
    }

    if (!inChart) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toUpperCase();
      const val = line.slice(idx + 1).trim();
      switch (key) {
        case 'TITLE': chart.title = val; break;
        case 'SUBTITLE': chart.subtitle = val.replace(/^--|^\+\+/, ''); break;
        case 'BPM': chart.bpm = Number(val) || chart.bpm; break;
        case 'OFFSET': chart.offset = Number(val) || 0; break;
        case 'WAVE': chart.wave = val; break;
        case 'DEMOSTART': chart.demoStart = Number(val) || 0; break;
        case 'COURSE': header = { ...header, name: normalizeCourse(val) }; break;
        case 'LEVEL': header = { ...header, level: Number(val) || 0 }; break;
        case 'BALLOON':
          header = {
            ...header,
            balloons: val.split(',').map((s) => Number(s.trim())).filter((n) => n > 0),
          };
          break;
      }
      continue;
    }

    if (branch === 'E' || branch === 'M') continue;

    // ノーツ行
    for (const ch of line) {
      if (ch === ',') {
        processMeasure(measureItems, st, notes, bars, header.balloons);
        measureItems = [];
      } else if (NOTE_CHARS.test(ch)) {
        measureItems.push({ kind: 'note', ch });
      }
    }
  }

  return chart;
}

interface State {
  time: number;
  bpm: number;
  scroll: number;
  measure: number; // 小節の長さ（4/4 = 1）
  gogo: boolean;
  barline: boolean;
  balloonIndex: number;
  openLong: Note | null;
}

function newState(chart: Chart): State {
  return {
    time: -chart.offset,
    bpm: chart.bpm,
    scroll: 1,
    measure: 1,
    gogo: false,
    barline: true,
    balloonIndex: 0,
    openLong: null,
  };
}

function applyCommand(st: State, name: string, arg: string) {
  switch (name) {
    case 'BPMCHANGE': {
      const v = Number(arg);
      if (v > 0) st.bpm = v;
      break;
    }
    case 'SCROLL': {
      const v = Number(arg);
      if (Number.isFinite(v)) st.scroll = v;
      break;
    }
    case 'MEASURE': {
      const m = arg.match(/^\s*([\d.]+)\s*\/\s*([\d.]+)/);
      if (m && Number(m[2]) > 0) st.measure = Number(m[1]) / Number(m[2]);
      break;
    }
    case 'DELAY': {
      const v = Number(arg);
      if (Number.isFinite(v)) st.time += v;
      break;
    }
    case 'GOGOSTART': st.gogo = true; break;
    case 'GOGOEND': st.gogo = false; break;
    case 'BARLINEON': st.barline = true; break;
    case 'BARLINEOFF': st.barline = false; break;
  }
}

const CHAR_TO_TYPE: Record<string, NoteType | undefined> = {
  '1': 'don',
  '2': 'ka',
  '3': 'bigDon',
  '4': 'bigKa',
  '5': 'roll',
  '6': 'bigRoll',
  '7': 'balloon',
  '9': 'balloon',
  A: 'bigDon',
  B: 'bigKa',
};

function processMeasure(
  items: Item[],
  st: State,
  notes: Note[],
  bars: BarLine[],
  balloons: number[],
) {
  // 先頭（最初のノーツより前）の命令は、小節線より先に適用する
  let i = 0;
  while (i < items.length && items[i].kind === 'cmd') {
    const it = items[i] as Extract<Item, { kind: 'cmd' }>;
    applyCommand(st, it.name, it.arg);
    i++;
  }

  if (st.barline) bars.push({ time: st.time, bpm: st.bpm, scroll: st.scroll });

  const noteCount = items.filter((it) => it.kind === 'note').length;
  if (noteCount === 0) {
    st.time += (240 / st.bpm) * st.measure;
    return;
  }

  for (; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'cmd') {
      applyCommand(st, it.name, it.arg);
      continue;
    }
    const ch = it.ch;
    if (ch === '8') {
      if (st.openLong) {
        st.openLong.endTime = st.time;
        st.openLong = null;
      }
    } else {
      const type = CHAR_TO_TYPE[ch];
      if (type) {
        const note: Note = { type, time: st.time, bpm: st.bpm, scroll: st.scroll, gogo: st.gogo };
        if (type === 'roll' || type === 'bigRoll' || type === 'balloon') {
          // 閉じられていない長いノーツがあれば、ここで閉じる
          if (st.openLong) st.openLong.endTime = st.time;
          if (type === 'balloon') {
            note.hits = balloons[st.balloonIndex++] ?? 5;
          }
          st.openLong = note;
        }
        notes.push(note);
      }
    }
    st.time += ((240 / st.bpm) * st.measure) / noteCount;
  }
}
