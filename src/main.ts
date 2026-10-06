import './style.css';
import { AudioEngine, type HitSound } from './audio/audio';
import { COURSE_NAMES, contentEnd, newChart, sortCourse, toPlayable, TPB, type ECourse, type EEvent } from './chart/model';
import { parseTJA } from './chart/tja';
import { writeTJA } from './chart/tjaWrite';
import { tjaGutterHtml, tjaLinesHtml, tjaMarks } from './editor/tjaHighlight';
import type { Note } from './chart/types';
import { DEMO_TJA } from './demo';
import { buildAutoEvents, type AutoEvent } from './play/auto';
import { analyzeTempo, computeMeters, planBars, planBeatTimes, planTimeAt, tempoPlan, type Meter, type TempoOptions, type TempoPlan, type TempoResult } from './audio/tempo';
import { meterAt as meterAtTick, moveBoundary, nudge, removeSection, sectionAtTime, sections as editSections, setBpm, setMeter, shiftDownbeat, splitAt } from './editor/tempoEdit';
import { applyGrad, gradValid, type Grad } from './editor/grad';
import { writeCourseBody } from './chart/tjaWrite';

import { DIVISORS, Editor, type Tool } from './editor/editor';
import { EditorView, eventText, EVENT_COLOR, type EventItem, type EventShow } from './editor/view';
import { loadFiles, type AudioFile } from './io/load';
import { loadAudio, loadChart, loadHitSound, saveAudio, saveChart, saveHitSound } from './io/storage';
import { writeZip } from './io/zip';
import { PlayMode } from './play/playmode';
import { fitRoot, localPoint } from './orient';
import { BUILD_ID, startAutoUpdate } from './update';

fitRoot();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------- 設定 ----------

const settings = {
  /** 前の版の「1 拍を何分割」（読み込みの引き継ぎ用） */
  divisor: 0,
  /** グリッド: 1 小節（4/4、全音符）を何分割するか */
  grid: 0,
  zoom: 220,
  /** 拡大率を自分で変えたか（変えるまではプレイ画面と同じ間隔） */
  zoomSet: false,
  rate: 1,
  speed: 1,
  offset: 0,
  hitSound: true,
  metronome: false,
  auto: false,
  showTiming: false,
  pointerInput: false,
  // iPhone / iPad の Safari は両手交互の速い連打でタッチを落とすので、既定で指置きを使う
  restZone: /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  passiveTouch: false,
  /** タッチ用の中央のドンの帯の幅 */
  donWidth: 0.6,
  /** TJA のテキストを太字で表示する */
  tjaBold: false,
  /** 音量の比率（自動で揃えた後に掛ける）。音源 : 打音 : メトロノーム */
  volMusic: 1,
  volHit: 0.8,
  volMetro: 1.2,
  /** 拡大率の決め方の版（2 = プレイ画面と同じ間隔） */
  zoomVer: 0,
  /** レーンの下に出すイベントの種類 */
  evShow: { bpm: true, scroll: true, measure: true, gogo: true, barline: true, delay: true } as EventShow,
  /** 打音の比率の初期値を 0.8 にした版 */
  hitVolVer: 0,
};
try {
  // 横スクロール化で拡大率の意味が変わったので v2 のキーで保存
  Object.assign(settings, JSON.parse(localStorage.getItem('malody-web:settings2') ?? '{}'));
} catch { /* 使えない環境 */ }
const saveSettings = () => {
  try { localStorage.setItem('malody-web:settings2', JSON.stringify(settings)); } catch { /* 無視 */ }
};

// ---------- 本体 ----------

const audio = new AudioEngine();
const ed = new Editor();
// グリッドは 1 小節の分割数。前の版（1 拍の分割数）で保存したものは 4 倍して引き継ぐ
const gridOk = (n: number) => Number.isInteger(n) && n >= 1 && n <= 768 && (TPB * 4) % n === 0;
if (!settings.grid && settings.divisor) settings.grid = settings.divisor * 4;
ed.divisor = gridOk(settings.grid) ? settings.grid : 16;
const view = new EditorView($<HTMLCanvasElement>('editor'), ed);
// 拡大率の初期値をプレイ画面と同じ音符の間隔に変えたので、前の版で自分で変えた拡大率は一度だけ初期値に戻す
// 打音を差し替えたので、打音の音量の比率を一度だけ 0.8 にする
if (!settings.hitVolVer) {
  settings.volHit = 0.8;
  settings.hitVolVer = 1;
}
if (settings.zoomVer !== 2) {
  settings.zoomSet = false;
  settings.zoomVer = 2;
}
view.playSpeed = settings.speed;
settings.evShow = Object.assign({ bpm: true, scroll: true, measure: true, gogo: true, barline: true, delay: true }, settings.evShow);
view.evShow = settings.evShow;
view.onEventTap = (items) => openEvents(items);
const applyMix = () => audio.setMix({ music: settings.volMusic, hit: settings.volHit, metro: settings.volMetro });
/** ハイスピードを変えたら、自分で拡大率を変えていない限りエディタの間隔も合わせる */
const applyPlayZoom = () => {
  view.playSpeed = settings.speed;
  if (!settings.zoomSet) view.setZoom(view.defaultZoom);
};
// 拡大率: 自分で変えるまではプレイ画面と同じ音符の間隔（画面の高さに比例）
// 右のアイコンバーとツールも Malody の画面と同じ比率で大きさを決める（CSS の --es）
const onViewResize = () => {
  document.documentElement.style.setProperty('--es', String(view.s));
  if (!settings.zoomSet) view.setZoom(view.defaultZoom);
};
view.onResize = onViewResize;
onViewResize();
if (settings.zoomSet) view.zoom = Math.min(2400, Math.max(20, settings.zoom));
applyMix();
const play = new PlayMode($('play'), $<HTMLCanvasElement>('game'), $('result'), audio, settings);

let playable: Note[] = [];
let playing = false;
let lastTime = 0;

// ---------- トースト ----------

let toastTimer = 0;
function toast(msg: string) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- 音源 ----------

async function setAudio(file: AudioFile | null, save = true) {
  ed.audio = file;
  try {
    await audio.loadMusic(file ? file.data.slice(0) : null);
  } catch {
    await audio.loadMusic(null);
    toast(`「${file?.name}」はこのブラウザで再生できません（mp3 / m4a なら再生できます）`);
  }
  if (save) void saveAudio(file);
  view.setWave(...computePeaks());
  view.duration = audio.musicDuration;
  updateHeader();
}

/** 波形用に 1 秒あたり 400 個の最大振幅を作る */
function computePeaks(): [Float32Array | null, number] {
  const buf = audio.buffer;
  if (!buf) return [null, 0];
  const rate = 400;
  const n = Math.ceil(buf.duration * rate);
  const peaks = new Float32Array(n);
  const per = buf.sampleRate / rate;
  for (let ch = 0; ch < Math.min(2, buf.numberOfChannels); ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * per);
      const b = Math.min(data.length, Math.floor((i + 1) * per));
      let m = peaks[i];
      for (let k = a; k < b; k += 4) {
        const v = data[k] < 0 ? -data[k] : data[k];
        if (v > m) m = v;
      }
      peaks[i] = m;
    }
  }
  // 小さい曲でも見やすいように正規化
  let max = 0;
  for (const v of peaks) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < n; i++) peaks[i] = Math.min(1, peaks[i] / max);
  return [peaks, rate];
}

// ---------- 再生 ----------

function endTime() {
  const contentT = ed.timing.tickToTime(contentEnd(ed.course)) + 2;
  return Math.max(contentT, audio.musicDuration);
}

let hitEvents: AutoEvent[] = [];
let hitIdx = 0;
let metroEvents: { t: number; strong: boolean }[] = [];
let metroIdx = 0;

async function startPlayback() {
  if (playing) return;
  const from = ed.timing.tickToTime(view.pos);
  playable = toPlayable(ed.chart, ed.course).notes;
  // 打音はプレイ画面のオートと同じ予定（音符・連打・風船）を、その時刻ちょうどに予約して鳴らす。
  // 判定枠にちょうど乗っている音符（再生を始めた位置の音符）も鳴らす
  hitEvents = buildAutoEvents(playable, from).filter((e) => e.t >= from - 0.001);
  hitIdx = 0;
  // メトロノーム: 拍子に合わせて 1 小節に「分子」の回数（4/4 なら 4 回、7/8 なら 8 分音符で 7 回）
  metroEvents = [];
  metroIdx = 0;
  const fromTick = view.pos;
  const endTick = ed.timing.timeToTick(endTime()) + TPB * 4;
  // 曲の頭より前の小節（1 小節目と同じ拍子）でも鳴らす
  const m0 = ed.measureOf(0);
  const lead = [];
  for (let k = Math.round(ed.minPos / m0.length); k < 0; k++) lead.push({ ...m0, start: k * m0.length });
  for (const m of [...lead, ...ed.measuresUntil(endTick)]) {
    if (m.start + m.length <= fromTick - 1) continue;
    if (m.start > endTick) break;
    const beat = (TPB * 4) / m.den;
    for (let k = 0; k < m.num - 1e-9; k++) {
      const tick = m.start + Math.round(k * beat);
      if (tick < fromTick - 1) continue;
      metroEvents.push({ t: ed.timing.tickToTime(tick), strong: k === 0 });
    }
  }
  await audio.startAt(from, settings.rate);
  lastTime = from;
  playing = true;
  view.playing = true;
  view.invalidate();
}

function stopPlayback() {
  if (!playing) return;
  playing = false;
  audio.stop();
  view.playing = false;
  view.invalidate();
}

function tickPlayback() {
  const t = audio.now();
  if (t < lastTime) return; // 再生開始直後
  view.pos = ed.timing.timeToTick(t);

  // これから 0.3 秒以内に鳴る打音を予約する
  while (hitIdx < hitEvents.length && hitEvents[hitIdx].t <= t + 0.3 * settings.rate) {
    const e = hitEvents[hitIdx++];
    if (!settings.hitSound) continue;
    audio.scheduleHit(e.kind, e.t);
    if (e.pop) audio.scheduleHit('balloon', e.t);
  }
  while (metroIdx < metroEvents.length && metroEvents[metroIdx].t <= t + 0.3 * settings.rate) {
    const e = metroEvents[metroIdx++];
    if (settings.metronome) audio.scheduleMetro(e.strong, e.t);
  }
  lastTime = t;
  if (t > endTime()) stopPlayback();
  view.invalidate();
}

function loop() {
  if (playing && !play.isActive) tickPlayback();
  if (tempoPreview.on) tickTempoPreview();
  // プレイ画面を出している間は、隠れているエディタを描き直さない
  if (!document.body.classList.contains('playing')) view.frame();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------- ヘッダ・ツールバー ----------

function updateHeader() {
  $<HTMLButtonElement>('btnUndo').disabled = !ed.canUndo;
  $<HTMLButtonElement>('btnRedo').disabled = !ed.canRedo;
  $('rateLabel').textContent = `${settings.rate.toFixed(settings.rate === 1 ? 1 : 2)}x`;
  $('btnSound').classList.toggle('on', settings.metronome);
  $('divLabel').textContent = `1/${ed.divisor}`;
  view.invalidate();
}

// ノーツのボタンは 4 つ。置いてあるノーツはタップで消える。選んでいるボタンをもう一度タップすると、組になっている音符に切り替わる
const TOOL_GROUPS: Record<string, Tool[]> = {
  small: ['don', 'ka'],
  big: ['bigDon', 'bigKa'],
  roll: ['roll', 'bigRoll'],
  balloon: ['balloon'],
  gogo: ['gogo'],
  scroll: ['scroll'],
  bpm: ['bpm'],
  measure: ['measure'],
};
const TOOL_LOOK: Record<Tool, { label: string; cls: string }> = {
  don: { label: 'ドン', cls: 'don' },
  ka: { label: 'カッ', cls: 'ka' },
  bigDon: { label: '大ドン', cls: 'don big' },
  bigKa: { label: '大カッ', cls: 'ka big' },
  roll: { label: '連打', cls: 'roll' },
  bigRoll: { label: '大連打', cls: 'roll big' },
  balloon: { label: '風船', cls: 'balloon' },
  erase: { label: '消去', cls: 'erase' },
  gogo: { label: 'GOGO', cls: 'gogo' },
  scroll: { label: 'SCROLL・グラデ', cls: 'cmd scroll' },
  bpm: { label: 'BPMCHANGE', cls: 'cmd bpm' },
  measure: { label: 'MEASURE', cls: 'cmd measure' },
};
/** 各ボタンが今どちらの音符になっているか */
const groupTool: Record<string, Tool> = { small: 'don', big: 'bigDon', roll: 'roll', balloon: 'balloon', gogo: 'gogo', scroll: 'scroll', bpm: 'bpm', measure: 'measure' };
const groupOf = (t: Tool) => Object.keys(TOOL_GROUPS).find((g) => TOOL_GROUPS[g].includes(t))!;

function setTool(t: Tool) {
  const prevTool = ed.tool;
  ed.tool = t;
  groupTool[groupOf(t)] = t;
  // 始点を決めた後に別の種類のツールに替えたら、始点を取り消す（連打・大連打・風船どうしはそのまま終点を選べる）
  const longs: Tool[] = ['roll', 'bigRoll', 'balloon'];
  const keep = (longs.includes(t) && longs.includes(prevTool)) || (t === 'gogo' && prevTool === 'gogo') || (t === 'scroll' && prevTool === 'scroll');
  if (ed.pendingLong !== null && !keep) ed.pendingLong = null;
  document.querySelectorAll<HTMLButtonElement>('#tools .tool').forEach((b) => {
    const g = b.dataset.group!;
    const look = TOOL_LOOK[groupTool[g]];
    b.className = `tool ${look.cls}`;
    b.classList.toggle('active', g === groupOf(t));
    b.title = look.label;
  });
  view.invalidate();
}

document.querySelectorAll<HTMLButtonElement>('#tools .tool').forEach((b) => {
  b.addEventListener('click', () => {
    const list = TOOL_GROUPS[b.dataset.group!];
    const cur = groupTool[b.dataset.group!];
    // もう選んでいるなら組のもう一方へ、選んでいなければ前に使っていた方で選ぶ
    setTool(ed.tool === cur ? list[(list.indexOf(cur) + 1) % list.length] : cur);
  });
});
setTool('don');

// グリッド（分割）: ボタンを押すと、右のアイコンバーの少し左に 1/2〜1/32 と「自由グリッド」のメニューを出す
const divMenu = $('divMenu');
const setDivisor = (d: number) => {
  ed.divisor = d;
  settings.grid = d;
  saveSettings();
  updateHeader();
  view.invalidate();
};
const closeDivMenu = () => divMenu.classList.add('hidden');
const openDivMenu = () => {
  const preset = DIVISORS;
  const custom = !preset.includes(ed.divisor);
  divMenu.innerHTML = preset.map((d) => `<button data-div="${d}" class="${d === ed.divisor ? 'on' : ''}">1/${d}</button>`).join('')
    + `<hr><button data-div="free" class="${custom ? 'on' : ''}">${custom ? `自由 1/${ed.divisor}` : '自由…'}</button>`;
  divMenu.classList.remove('hidden');
  // グリッドのボタンの下端にメニューの下端をそろえる（はみ出すときは上にそろえる）
  const btn = $('btnDiv');
  const app = $('app');
  const bottom = btn.offsetTop + btn.offsetHeight - (btn.parentElement as HTMLElement).scrollTop;
  divMenu.style.top = `${Math.max(8, Math.min(bottom - divMenu.offsetHeight, app.offsetHeight - divMenu.offsetHeight - 8))}px`;
};
$('btnDiv').addEventListener('click', (e) => {
  e.stopPropagation();
  closeFlyMenu();
  if (divMenu.classList.contains('hidden')) openDivMenu();
  else closeDivMenu();
});
divMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-div]');
  if (!b) return;
  if (b.dataset.div === 'free') {
    closeDivMenu();
    const v = prompt('1 小節を何分割にするか（例: 20, 28, 36, 40, 96）', String(ed.divisor));
    if (v === null) return;
    const n = Math.round(Number(v));
    if (!gridOk(n)) {
      toast('その分割数は使えません（使える例: 1〜16, 18, 20, 21, 24, 28, 30, 32, 35, 36, 40, 42, 48, 56, 60, 64, 80, 96…）');
      return;
    }
    setDivisor(n);
    toast(`グリッドを 1/${n} にしました`);
    return;
  }
  setDivisor(Number(b.dataset.div));
  closeDivMenu();
});
document.addEventListener('pointerdown', (e) => {
  if (divMenu.classList.contains('hidden')) return;
  const t = e.target as Node;
  if (!divMenu.contains(t) && !$('btnDiv').contains(t)) closeDivMenu();
});

// ---------- 2 段のメニュー（右のアイコンを押すと、その少し左に項目の一覧を出す） ----------

type FlyItem = { label: string; on?: boolean; primary?: boolean; run: () => void } | { head: string } | 'sep';
const flyMenu = $('flyMenu');
let flyKind = '';
const closeFlyMenu = () => {
  flyMenu.classList.add('hidden');
  document.querySelectorAll('.side .open').forEach((b) => b.classList.remove('open'));
  flyKind = '';
};
function flyItems(kind: string): FlyItem[] {
  const rates = [1, 0.75, 0.5, 0.25];
  if (kind === 'edit') {
    return [
      { label: '曲・難易度の情報', run: () => openSheet('info') },
      { label: 'TJA テキスト', run: () => openSheet('events') },
      { label: 'BPM・OFFSET 自動測定', run: () => startTempo() },
    ];
  }
  if (kind === 'file') {
    return [
      { head: '読み込み' },
      { label: '.tja / .zip を開く', primary: true, run: () => void fileAction('open') },
      { label: '音源を読み込む', run: () => void fileAction('audio') },
      { label: '新規作成', run: () => void fileAction('new') },
      { label: 'サンプル譜面', run: () => void fileAction('sample') },
      { head: '書き出し' },
      { label: '.tja を保存', run: () => void fileAction('saveTja') },
      { label: '.zip（譜面＋音源）を保存', run: () => void fileAction('saveZip') },
      { label: 'TJA をコピー', run: () => void fileAction('copy') },
    ];
  }
  if (kind === 'sound') {
    return [
      { label: `メトロノーム ${settings.metronome ? 'ON' : 'OFF'}`, on: settings.metronome, run: () => {
        settings.metronome = !settings.metronome;
        saveSettings();
        updateHeader();
      } },
      { head: '再生速度' },
      ...rates.map((r) => ({ label: `${r.toFixed(r === 1 ? 1 : 2)}x`, on: settings.rate === r, run: () => {
        settings.rate = r;
        saveSettings();
        updateHeader();
        if (playing) { stopPlayback(); void startPlayback(); }
      } })),
    ];
  }
  if (kind === 'test') {
    return [
      { label: '最初から', primary: true, run: () => void startTest(true) },
      { label: '今の位置から', run: () => void startTest(false) },
    ];
  }
  return [];
}
function openFlyMenu(btn: HTMLElement) {
  const kind = btn.dataset.fly!;
  const items = flyItems(kind);
  flyMenu.innerHTML = items.map((it, i) => (it === 'sep' ? '<hr>'
    : 'head' in it ? `<h4>${esc(it.head)}</h4>`
    : `<button data-fi="${i}" class="${it.on ? 'on' : ''} ${it.primary ? 'primary' : ''}">${esc(it.label)}</button>`)).join('');
  flyMenu.classList.remove('hidden');
  document.querySelectorAll('.side .open').forEach((b) => b.classList.remove('open'));
  btn.classList.add('open');
  flyKind = kind;
  // 押したボタンの上端にメニューの上端をそろえる（はみ出すときは下にそろえる）
  const app = $('app');
  const top = btn.offsetTop - (btn.parentElement as HTMLElement).scrollTop;
  flyMenu.style.top = `${Math.max(8, Math.min(top, app.offsetHeight - flyMenu.offsetHeight - 8))}px`;
  flyMenu.onclick = (e) => {
    e.stopPropagation();
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-fi]');
    if (!b) return;
    const it = items[Number(b.dataset.fi)];
    if (typeof it === 'object' && 'run' in it) {
      // メトロノーム・再生速度は、続けて選べるようにメニューを開いたまま作り直す
      if (kind === 'sound') {
        it.run();
        openFlyMenu(btn);
        return;
      }
      closeFlyMenu();
      it.run();
    }
  };
}
document.querySelectorAll<HTMLButtonElement>('.side [data-fly]').forEach((btn) => btn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeDivMenu();
  if (flyKind === btn.dataset.fly) closeFlyMenu();
  else openFlyMenu(btn);
}));
document.addEventListener('pointerdown', (e) => {
  if (!flyKind) return;
  const t = e.target as HTMLElement;
  if (!flyMenu.contains(t) && !t.closest('.side [data-fly]')) closeFlyMenu();
});

view.onZoomChange = (z) => {
  if (Math.abs(z - view.defaultZoom) < 0.5 && !settings.zoomSet) return; // 自動調整のとき
  settings.zoom = z;
  settings.zoomSet = true;
  saveSettings();
};
$('btnUndo').addEventListener('click', () => ed.undo());
$('btnRedo').addEventListener('click', () => ed.redo());
view.onPlayToggle = () => (playing ? stopPlayback() : void startPlayback());

// ---------- 編集 ----------

view.onUserScroll = () => stopPlayback();
view.onTap = (tick) => {
  const r = ed.tap(tick);
  if (r.message) toast(r.message);
  if (r.editBalloon) {
    const v = prompt('風船の打数', String(r.editBalloon.hits ?? 5));
    if (v !== null) ed.setBalloonHits(r.editBalloon, Number(v));
  }
  if (r.newGrad || r.editGrad || r.point) $('toast').classList.remove('show');
  if (r.point) openPoint(r.point.kind, r.point.tick);
  if (r.newGrad) {
    const from = ed.timing.scrollAt(r.newGrad.start);
    gradEdit = { grad: { ...r.newGrad, from, to: from * 2, mode: 'linear', digits: 3, speed: 'visual' } };
    openSheet('grad');
  }
  if (r.editGrad) {
    gradEdit = { grad: { ...r.editGrad }, old: r.editGrad };
    openSheet('grad');
  }
};

/** 設定画面で編集中のグラデ */
let gradEdit: { grad: Grad; old?: Grad } | null = null;

let saveTimer = 0;
ed.onChange((structural) => {
  view.invalidate();
  updateHeader();
  if (structural) {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveChart({ chart: ed.chart, courseIndex: ed.courseIndex, savedAt: Date.now() });
    }, 600);
    refreshSheet();
  }
});

// ---------- キーボード（PC） ----------

const KEY_TOOLS: Record<string, Tool> = {
  Digit1: 'don', Digit2: 'ka', Digit3: 'bigDon', Digit4: 'bigKa',
  Digit5: 'roll', Digit6: 'bigRoll', Digit7: 'balloon',
};

window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (play.isActive || !$('sheet').classList.contains('hidden')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? ed.redo() : ed.undo(); return; }
  if (mod && e.code === 'KeyY') { e.preventDefault(); ed.redo(); return; }
  if (mod) return;
  if (e.code === 'Space') { e.preventDefault(); playing ? stopPlayback() : void startPlayback(); return; }
  if (KEY_TOOLS[e.code]) { setTool(KEY_TOOLS[e.code]); return; }
  const move = (ticks: number) => {
    e.preventDefault();
    stopPlayback();
    view.pos = Math.max(ed.minPos, ed.snapView(view.pos) + ticks);
    view.invalidate();
  };
  if (e.code === 'ArrowRight' || e.code === 'ArrowUp') move(ed.step);
  else if (e.code === 'ArrowLeft' || e.code === 'ArrowDown') move(-ed.step);
  else if (e.code === 'PageUp') move(ed.measureOf(view.pos).length);
  else if (e.code === 'PageDown') move(-ed.measureOf(Math.max(0, view.pos - 1)).length);
  else if (e.code === 'Home') move(-view.pos);
  else if (e.code === 'Equal') view.setZoom(view.zoom * 1.25);
  else if (e.code === 'Minus') view.setZoom(view.zoom / 1.25);
});

// ---------- シート ----------

type SheetKind = 'info' | 'settings' | 'events' | 'grad' | 'point' | 'evlist' | 'tempo';
let sheet: SheetKind | null = null;

function openSheet(kind: SheetKind) {
  stopPlayback();
  stopTempoPreview();
  sheet = kind;
  $('sheet').classList.remove('hidden');
  // TJA の画面は縦いっぱいに使う
  $('sheet').classList.toggle('tja', kind === 'events');
  // グラデの設定は縦いっぱい・横広めで、左に設定、右に .tja の書き方
  $('sheet').classList.toggle('grad', kind === 'grad');
  document.body.classList.toggle('tja-open', kind === 'events');
  renderSheet();
  if (kind === 'events') requestAnimationFrame(showTjaDiag);
}
function closeSheet() {
  stopTempoPreview();
  sheet = null;
  document.body.classList.remove('tja-open');
  $('sheet').classList.add('hidden');
}
function refreshSheet() {
  if (!sheet) return;
  // 入力中は描き直さない（フォーカスが外れるため）
  if ($('sheetBody').contains(document.activeElement) && (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)) return;
  // TJA のテキストは書き換え中かもしれないので、譜面が変わっても勝手に描き直さない
  if (sheet === 'events' && document.getElementById('tjaText')) return;
  if (sheet === 'grad' || sheet === 'point' || sheet === 'tempo') return;
  if (sheet === 'evlist') { renderSheet(); return; }
  renderSheet();
}

$('sheetClose').addEventListener('click', closeSheet);
// 【調査用・一時的】画面の下の隙間の原因を調べるため、画面の高さの値を TJA の見出しの横に小さく出す
function showTjaDiag() {
  const root = document.getElementById('root')!.getBoundingClientRect();
  const panel = document.querySelector('#sheet .sheet-panel')!.getBoundingClientRect();
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;width:1px;top:env(safe-area-inset-top);bottom:env(safe-area-inset-bottom);pointer-events:none;visibility:hidden';
  document.body.appendChild(probe);
  const pr = probe.getBoundingClientRect();
  probe.remove();
  const nav = navigator as Navigator & { standalone?: boolean };
  const v = window.visualViewport;
  $('sheetDiag').textContent = [
    `ih${innerHeight}`, `ch${document.documentElement.clientHeight}`, `vv${v ? Math.round(v.height) : '-'}`,
    `sh${screen.height}`, `st${nav.standalone ? 1 : 0}`, `root${Math.round(root.height)}`, `pan${Math.round(panel.bottom)}`,
    `sa${Math.round(pr.top)}/${Math.round(innerHeight - pr.bottom)}`,
  ].join(' ');
}
// TJA の文字の太さ（ふつう / 太字）。入力欄と色付きの文字の両方を同じ太さにする
const applyTjaBold = () => {
  $('sheet').classList.toggle('tja-bold', settings.tjaBold);
  $('sheetBold').classList.toggle('on', settings.tjaBold);
  $('sheetBold').setAttribute('aria-pressed', String(settings.tjaBold));
};
applyTjaBold();
$('sheetBold').addEventListener('click', () => {
  settings.tjaBold = !settings.tjaBold;
  saveSettings();
  applyTjaBold();
  scheduleTjaHl();
});
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
$('btnSettings').addEventListener('click', () => { closeFlyMenu(); openSheet('settings'); });

function renderSheet() {
  const body = $('sheetBody');
  if (sheet === 'info') {
    $('sheetTitle').textContent = '曲・難易度の情報';
    const c = ed.chart;
    const courses = c.courses
      .map(
        (co, i) => `<div class="item ${i === ed.courseIndex ? 'current' : ''}">
          <div class="grow">${esc(co.name)} ★${co.level}<div class="pos">${co.notes.length}ノーツ</div></div>
          ${i === ed.courseIndex ? '' : `<button data-course="${i}">編集する</button>`}
        </div>`,
      )
      .join('');
    body.innerHTML = `
      <h3>曲</h3>
      <label class="field"><span>タイトル</span><input type="text" data-meta="title" value="${esc(c.title)}"></label>
      <label class="field"><span>サブタイトル</span><input type="text" data-meta="subtitle" value="${esc(c.subtitle)}"></label>
      <label class="field"><span>BPM</span><input type="number" step="any" inputmode="decimal" data-meta="bpm" value="${c.bpm}"></label>
      <label class="field"><span>OFFSET (秒)</span><input type="number" step="0.001" inputmode="decimal" data-meta="offset" value="${c.offset}"></label>
      <div class="btns three">
        <button data-off="-0.01">−10ms</button><button data-off="-0.001">−1ms</button><button data-off="0.01">+10ms</button>
      </div>
      <label class="field"><span>DEMOSTART</span><input type="number" step="0.01" inputmode="decimal" data-meta="demoStart" value="${c.demoStart}"></label>
      <p class="note">音源: ${esc(ed.audio?.name ?? 'なし')}（WAVE: ${esc(c.wave || '-')}）</p>

      <h3>難易度</h3>
      <div class="list">${courses}</div>
      <label class="field"><span>難易度名</span>
        <select data-course-name>${COURSE_NAMES.map((n) => `<option ${n === ed.course.name ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </label>
      <label class="field"><span>レベル</span><input type="number" min="1" max="10" inputmode="numeric" data-course-level value="${ed.course.level}"></label>
      <div class="btns three">
        <button data-act="addCourse">追加</button>
        <button data-act="dupCourse">複製</button>
        <button data-act="delCourse" class="danger" ${c.courses.length <= 1 ? 'disabled' : ''}>削除</button>
      </div>`;
  } else if (sheet === 'settings') {
    $('sheetTitle').textContent = '設定';
    body.innerHTML = `
      <h3>レーンの下に出すイベント</h3>
      <div class="ev-show">${(Object.keys(EV_NAMES) as (keyof EventShow)[]).map((k) => `<label><input type="checkbox" data-evshow="${k}" ${settings.evShow[k] ? 'checked' : ''}><span style="color:${EVENT_COLOR[k]}">${EV_NAMES[k]}</span></label>`).join('')}</div>
      <h3>テストプレイ・再生</h3>
      <label class="field"><span>ハイスピード</span><input type="range" min="0.5" max="4" step="0.1" data-set="speed" value="${settings.speed}"><output>${settings.speed.toFixed(1)}</output></label>
      <label class="field"><span>判定調整 ms</span><input type="range" min="-300" max="300" step="1" data-set="offset" value="${settings.offset}"><output>${settings.offset}</output></label>
      <label class="field"><span>打音</span><input type="checkbox" data-set="hitSound" ${settings.hitSound ? 'checked' : ''}></label>
      <h3>音量（自動で同じ大きさに揃えてから、この比率を掛けます）</h3>
      <label class="field"><span>音源</span><input type="range" min="0" max="2" step="0.05" data-set="volMusic" value="${settings.volMusic}"><output>${settings.volMusic.toFixed(2)}</output></label>
      <label class="field"><span>打音</span><input type="range" min="0" max="2" step="0.05" data-set="volHit" value="${settings.volHit}"><output>${settings.volHit.toFixed(2)}</output></label>
      <label class="field"><span>メトロノーム</span><input type="range" min="0" max="2" step="0.05" data-set="volMetro" value="${settings.volMetro}"><output>${settings.volMetro.toFixed(2)}</output></label>
      <h3>打音</h3>
      <p class="note">ドン: ${esc(hitNames.don ?? '内蔵の音')} ／ カッ: ${esc(hitNames.ka ?? '内蔵の音')} ／ 風船が割れる音: ${esc(hitNames.balloon ?? '内蔵の音')}<br>
        3 つまとめて選べます。ファイル名に「don」が入っているものをドン、「ka」をカッ、「balloon」を風船が割れる音にします（例: dong.ogg / ka.ogg / Balloon.ogg）。読み込んだ音はこの端末の中だけに保存されます。</p>
      <div class="btns">
        <button data-act="hitLoad">打音ファイルを選ぶ</button>
        <button data-act="hitReset" ${hitNames.don || hitNames.ka || hitNames.balloon ? '' : 'disabled'}>内蔵の音に戻す</button>
      </div>
      <button data-act="resetZoom">エディタの拡大率を初期値（プレイ画面と同じ間隔）に戻す</button>
      <label class="field"><span>メトロノーム</span><input type="checkbox" data-set="metronome" ${settings.metronome ? 'checked' : ''}></label>
      <p class="note">編集内容はこのブラウザに自動保存されます。書き出した .tja は UTF-8（BOM付き）です。</p>
      <p class="note">バージョン: ${esc(BUILD_ID.slice(0, 7))}</p>`;
  } else if (sheet === 'tempo') {
    renderTempoSheet(body);
  } else if (sheet === 'evlist' && evList) {
    renderEvListSheet(body);
  } else if (sheet === 'point' && pointEdit) {
    renderPointSheet(body);
  } else if (sheet === 'grad' && gradEdit) {
    renderGradSheet(body);
  } else if (sheet === 'events') {
    // TJA のテキスト（譜面全体）。書き換えて「反映」すると譜面に反映する
    $('sheetTitle').textContent = 'TJA';
    const text = writeTJA(ed.chart);
    body.innerHTML = `
      <p class="tja-status" id="tjaStatus"></p>
      <div class="tja-wrap">
        <pre class="tja-hl" aria-hidden="true"><div id="tjaHl"></div></pre>
        <div class="tja-gutter" aria-hidden="true"><div id="tjaGut"></div></div>
        <textarea id="tjaText" class="tja-text" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off"></textarea>
      </div>`;
    const ta = body.querySelector<HTMLTextAreaElement>('#tjaText')!;
    ta.value = text;
    ta.addEventListener('scroll', scheduleTjaHl, { passive: true });
    tjaHl.text = '';
    tjaHl.lh = 0;
    tjaSync.last = text;
    tjaSync.session = false;
    // 今いる小節の行が見えるところまでスクロールする
    const line = tjaLineOf(text, ed.course.name, ed.measureOf(Math.max(0, view.pos)).index);
    requestAnimationFrame(() => {
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
      ta.scrollTop = Math.max(0, (line - 3) * lh);
      renderTjaHl();
    });
  }
}

// キーボードを出しても TJA の画面の大きさは変えない。入力を終えたら（フォーカスが外れたら）待たずに反映する
$('sheet').addEventListener('focusout', (e) => {
  if ((e.target as HTMLElement).id === 'tjaText') syncTja();
});
window.visualViewport?.addEventListener('resize', scheduleTjaHl);

/** TJA のテキストで、その難易度の n 小節目（0 から）がある行 */
function tjaLineOf(text: string, course: string, measure: number): number {
  const lines = text.split('\n');
  let i = lines.findIndex((l) => l.trim().toUpperCase() === `COURSE:${course}`.toUpperCase());
  if (i < 0) return 0;
  while (i < lines.length && !lines[i].trim().toUpperCase().startsWith('#START')) i++;
  let m = 0;
  for (i++; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.toUpperCase().startsWith('#END')) break;
    if (l.startsWith('#') || l === '') continue;
    if (m === measure) return i;
    m += (l.match(/,/g) ?? []).length;
  }
  return i;
}

/**
 * TJA のテキストの自動反映。軽くするための工夫:
 * - 入力のたびではなく、手を止めて 350ms たってから 1 回だけ読み込む（入力中は何もしない）
 * - 日本語の変換中（確定前）は読み込まない
 * - 前回反映したテキストと同じなら何もしない
 * - 元に戻すの記録（譜面全体の写し）は、書き始めの 1 回だけ作る
 * - 保存は譜面の変更から 600ms 後にまとめて 1 回（既存の仕組み）
 */
const tjaSync = { timer: 0, last: '', session: false, composing: false, status: '' };

function setTjaStatus(text: string, bad = false) {
  if (tjaSync.status === text) return;
  tjaSync.status = text;
  const el = document.getElementById('tjaStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

function syncTja() {
  clearTimeout(tjaSync.timer);
  const ta = document.getElementById('tjaText') as HTMLTextAreaElement | null;
  if (!ta || tjaSync.composing) return;
  const text = ta.value;
  if (text === tjaSync.last) return;
  let chart;
  try {
    chart = parseTJA(text);
  } catch (err) {
    setTjaStatus(`読み込めません: ${err instanceof Error ? err.message : String(err)}`, true);
    return;
  }
  if (!chart.courses.length) {
    setTjaStatus('#START〜#END が見つかりません（反映していません）', true);
    return;
  }
  tjaSync.last = text;
  ed.replaceChart(chart, !tjaSync.session);
  tjaSync.session = true;
  setTjaStatus('反映済み');
}

/**
 * 色分けの表示（入力欄の後ろに重ねた pre に、見えている行だけ色付きで描く）。
 * 入力・スクロールのたびに、次の描画のタイミングで 1 回だけ描き直す
 */
const tjaHl = { raf: 0, text: '', marks: null as ReturnType<typeof tjaMarks> | null, lh: 0 };

function scheduleTjaHl() {
  if (tjaHl.raf) return;
  tjaHl.raf = requestAnimationFrame(() => {
    tjaHl.raf = 0;
    renderTjaHl();
  });
}

function renderTjaHl() {
  const ta = document.getElementById('tjaText') as HTMLTextAreaElement | null;
  const inner = document.getElementById('tjaHl');
  if (!ta || !inner) return;
  const text = ta.value;
  if (text !== tjaHl.text || !tjaHl.marks) {
    tjaHl.text = text;
    tjaHl.marks = tjaMarks(text);
  }
  if (!tjaHl.lh) tjaHl.lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  const lh = tjaHl.lh;
  const first = Math.max(0, Math.floor(ta.scrollTop / lh) - 4);
  const count = Math.ceil(ta.clientHeight / lh) + 8;
  inner.innerHTML = tjaLinesHtml(text, tjaHl.marks, first, first + count);
  inner.style.transform = `translate(${-ta.scrollLeft}px, ${first * lh - ta.scrollTop}px)`;
  // 左端の行番号・小節番号（横にはスクロールしない）
  const gut = document.getElementById('tjaGut');
  if (gut) {
    gut.innerHTML = tjaGutterHtml(tjaHl.marks, first, first + count);
    gut.style.transform = `translateY(${first * lh - ta.scrollTop}px)`;
  }
}

$('sheetBody').addEventListener('input', (e) => {
  if ((e.target as HTMLElement).id !== 'tjaText') return;
  scheduleTjaHl();
  clearTimeout(tjaSync.timer);
  setTjaStatus('入力中…');
  tjaSync.timer = window.setTimeout(syncTja, 350);
});
$('sheetBody').addEventListener('compositionstart', () => { tjaSync.composing = true; });
$('sheetBody').addEventListener('compositionend', () => {
  tjaSync.composing = false;
  clearTimeout(tjaSync.timer);
  tjaSync.timer = window.setTimeout(syncTja, 350);
});

$('sheetBody').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.act) void fileAction(d.act);
  else if (d.course) ed.selectCourse(Number(d.course));
  else if (d.off) ed.mutate(() => { ed.chart.offset = Number((ed.chart.offset + Number(d.off)).toFixed(4)); });
  else if (d.ev) addEventAction(d.ev);
  else if (d.jump) {
    const ev = ed.course.events[Number(d.jump)];
    if (ev) { view.pos = ev.tick; view.invalidate(); closeSheet(); }
  } else if (d.del) {
    const ev = ed.course.events[Number(d.del)];
    if (ev) ed.removeEvent(ev);
  }
});

$('sheetBody').addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const d = el.dataset;
  if (d.meta) {
    const key = d.meta as 'title' | 'subtitle' | 'bpm' | 'offset' | 'demoStart';
    ed.mutate(() => {
      if (key === 'title' || key === 'subtitle') ed.chart[key] = el.value;
      else {
        const v = Number(el.value);
        if (Number.isFinite(v) && (key !== 'bpm' || v > 0)) ed.chart[key] = v;
      }
    });
  } else if (d.courseName !== undefined) {
    ed.mutate(() => { ed.course.name = el.value; });
  } else if (d.courseLevel !== undefined) {
    const v = Number(el.value);
    if (v > 0) ed.mutate(() => { ed.course.level = Math.round(v); });
  }
});

$('sheetBody').addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  const key = el.dataset.set as keyof typeof settings | undefined;
  if (!key) return;
  if (el.type === 'checkbox') (settings[key] as boolean) = el.checked;
  else if (el instanceof HTMLSelectElement || isNaN(Number(el.value))) (settings[key] as unknown as string) = el.value;
  else {
    (settings[key] as number) = Number(el.value);
    const out = el.parentElement?.querySelector('output');
    if (out) out.textContent = key === 'speed' ? Number(el.value).toFixed(1) : key === 'donWidth' ? `${Math.round(Number(el.value) * 100)}%` : key.startsWith('vol') ? Number(el.value).toFixed(2) : el.value;
  }
  saveSettings();
  if (key.startsWith('vol')) applyMix();
  if (key === 'speed') applyPlayZoom();
});

function addEventAction(kind: string) {
  const tick = ed.snap(Math.max(0, view.pos));
  const ask = (label: string, def: string) => {
    const v = prompt(label, def);
    return v === null ? null : v.trim();
  };
  let ev: EEvent | null = null;
  if (kind === 'bpm') {
    const v = ask('BPM', String(ed.timing.bpmAt(tick)));
    if (v && Number(v) > 0) ev = { tick, kind: 'bpm', value: Number(v) };
  } else if (kind === 'scroll') {
    const v = ask('SCROLL（倍率、負の値で逆走）', '1');
    if (v && Number.isFinite(Number(v))) ev = { tick, kind: 'scroll', value: Number(v) };
  } else if (kind === 'measure') {
    const m = ed.measureOf(tick);
    const v = ask('拍子（例: 3/4, 7/8）', `${m.num}/${m.den}`);
    const mm = v?.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (mm && Number(mm[1]) > 0 && Number(mm[2]) > 0) ev = { tick, kind: 'measure', num: Number(mm[1]), den: Number(mm[2]) };
    else if (v) toast('「3/4」の形で入力してください');
  } else if (kind === 'delay') {
    const v = ask('DELAY（秒）', '0.5');
    if (v && Number.isFinite(Number(v))) ev = { tick, kind: 'delay', value: Number(v) };
  } else if (kind === 'gogoOn') ev = { tick, kind: 'gogo', on: true };
  else if (kind === 'gogoOff') ev = { tick, kind: 'gogo', on: false };
  else if (kind === 'barOn') ev = { tick, kind: 'barline', on: true };
  else if (kind === 'barOff') ev = { tick, kind: 'barline', on: false };
  if (ev) {
    ed.addEvent(ev);
    toast(`${eventText(ev)} を追加しました`);
  }
}

// ---------- ファイル ----------

const fileOpen = $<HTMLInputElement>('fileOpen');
const fileAudio = $<HTMLInputElement>('fileAudio');

fileOpen.addEventListener('change', async () => {
  const files = Array.from(fileOpen.files ?? []);
  fileOpen.value = '';
  if (!files.length) return;
  try {
    const r = await loadFiles(files);
    if (r.chart) {
      ed.load(r.chart, null);
      view.pos = 0;
      await setAudio(r.audio);
      void saveChart({ chart: ed.chart, courseIndex: ed.courseIndex, savedAt: Date.now() });
      closeSheet();
    } else if (r.audio) {
      await applyAudioOnly(r.audio);
      closeSheet();
    }
    toast(r.message);
  } catch (err) {
    toast(`読み込めませんでした: ${(err as Error).message}`);
  }
});

fileAudio.addEventListener('change', async () => {
  const f = fileAudio.files?.[0];
  fileAudio.value = '';
  if (!f) return;
  await applyAudioOnly({ name: f.name, data: await f.arrayBuffer() });
  closeSheet();
});

async function applyAudioOnly(a: AudioFile) {
  await setAudio(a);
  ed.mutate(() => {
    ed.chart.wave = a.name;
    if (!ed.chart.title || ed.chart.title === '新しい譜面') ed.chart.title = a.name.replace(/\.[^.]+$/, '');
  });
  toast(`音源「${a.name}」を設定しました`);
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const safeName = (s: string) => (s || 'chart').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

async function fileAction(act: string) {
  if (act === 'open') fileOpen.click();
  else if (act === 'audio') fileAudio.click();
  else if (act === 'tempo') startTempo();
  else if (act === 'new') {
    if (!confirm('新しい譜面を作りますか？（今の譜面はファイル保存していなければ消えます）')) return;
    ed.load(newChart(), null, 0);
    view.pos = 0;
    await setAudio(null);
    closeSheet();
    toast('「読み込み・書き出し → 音源を読み込む」で曲を設定してください');
  } else if (act === 'sample') {
    if (!confirm('サンプル譜面を開きますか？（今の譜面は置き換わります）')) return;
    ed.load(parseTJA(DEMO_TJA), null);
    view.pos = 0;
    await setAudio(null);
    closeSheet();
  } else if (act === 'saveTja') {
    download(new Blob(['﻿' + writeTJA(ed.chart)], { type: 'text/plain' }), `${safeName(ed.chart.title)}.tja`);
  } else if (act === 'saveZip') {
    const name = safeName(ed.chart.title);
    const files: { name: string; data: Uint8Array; compress?: boolean }[] = [];
    if (ed.audio) {
      ed.chart.wave = ed.audio.name;
      files.push({ name: `${name}/${ed.audio.name}`, data: new Uint8Array(ed.audio.data) });
    }
    const tja = new TextEncoder().encode('﻿' + writeTJA(ed.chart));
    files.unshift({ name: `${name}/${name}.tja`, data: tja, compress: true });
    download(await writeZip(files), `${name}.zip`);
  } else if (act === 'copy') {
    try {
      await navigator.clipboard.writeText(writeTJA(ed.chart));
      toast('TJA をコピーしました');
    } catch {
      toast('コピーできませんでした');
    }
  } else if (act === 'addCourse' || act === 'dupCourse') {
    const used = new Set(ed.chart.courses.map((c) => c.name));
    const name = COURSE_NAMES.find((n) => !used.has(n)) ?? 'Edit';
    ed.addCourse(name, act === 'dupCourse' ? ed.course.level : 1, act === 'dupCourse' ? ed.course : undefined);
    toast(`${name} を${act === 'dupCourse' ? '複製して' : ''}追加しました`);
  } else if (act === 'hitLoad') {
    $<HTMLInputElement>('fileHit').click();
  } else if (act === 'hitReset') {
    for (const k of ['don', 'ka', 'balloon'] as const) {
      await audio.setCustomHit(k, null);
      hitNames[k] = null;
      void saveHitSound(k, null);
    }
    renderSheet();
    toast('打音を内蔵の音に戻しました');
  } else if (act === 'calibrate') {
    stopPlayback();
    closeSheet();
    await play.startCalibration();
  } else if (act === 'resetZoom') {
    settings.zoomSet = false;
    saveSettings();
    view.setZoom(view.defaultZoom);
    toast('拡大率を初期値（プレイ画面と同じ間隔）に戻しました');
  } else if (act === 'delCourse') {
    if (confirm(`${ed.course.name} を削除しますか？`)) ed.removeCourse(ed.courseIndex);
  }
}

// ---------- 打音 ----------

const hitNames: Record<HitSound, string | null> = { don: null, ka: null, balloon: null };

async function applyHitSound(kind: HitSound, f: AudioFile | null, save: boolean) {
  try {
    await audio.setCustomHit(kind, f ? f.data : null);
    hitNames[kind] = f ? f.name : null;
    if (save) void saveHitSound(kind, f);
    return true;
  } catch {
    toast(`「${f?.name}」はこのブラウザで再生できません`);
    return false;
  }
}

$<HTMLInputElement>('fileHit').addEventListener('change', async () => {
  const input = $<HTMLInputElement>('fileHit');
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) return;
  const pick = (re: RegExp) => files.find((f) => re.test(f.name.replace(/\.[^.]+$/, '')));
  const balloon = pick(/balloon|fusen|ふうせん|風船/i);
  let don = pick(/don/i);
  let ka = pick(/(^|[^a-z])ka|katsu|kat/i);
  // 名前で分けられないときは 1 つ目をドン、2 つ目をカッ
  if (!don && !ka) [don, ka] = files.filter((f) => f !== balloon);
  const done: string[] = [];
  const label = { don: 'ドン', ka: 'カッ', balloon: '風船が割れる音' };
  for (const [kind, f] of [['don', don], ['ka', ka], ['balloon', balloon]] as const) {
    if (!f) continue;
    if (await applyHitSound(kind, { name: f.name, data: await f.arrayBuffer() }, true)) {
      done.push(label[kind]);
    }
  }
  if (done.length) toast(`${done.join('・')}の打音を読み込みました`);
  renderSheet();
});

// ---------- テストプレイ ----------

/** 最後に「最初から」で始めたか（結果画面の「もう一度」で同じ所から始める） */
let lastTestFromStart = true;

async function startTest(fromStart = lastTestFromStart) {
  lastTestFromStart = fromStart;
  stopPlayback();
  closeSheet();
  const course = toPlayable(ed.chart, ed.course);
  if (!course.notes.length) {
    toast('ノーツがありません');
    return;
  }
  const from = fromStart ? -Infinity : ed.timing.tickToTime(ed.snap(Math.max(0, view.pos)));
  await play.start(course, from, {
    title: ed.chart.title,
    course: ed.course.name,
    level: ed.course.level,
    genre: ed.chart.extra.find(([k]) => k.toUpperCase() === 'GENRE')?.[1],
  });
}

$('growFace').addEventListener('click', () => {
  if (play.suggestedDonWidth == null) return;
  settings.donWidth = play.suggestedDonWidth;
  saveSettings();
  $('growFace').closest('.edgehint')!.classList.add('hidden');
  toast(`ドンの幅を ${Math.round(settings.donWidth * 100)}% にしました`);
});
$('copyLog').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(play.lastLog);
    toast('記録をコピーしました。チャットに貼り付けてください');
  } catch {
    // コピーできない環境では、選択できる形で表示する
    const ta = document.createElement('textarea');
    ta.value = play.lastLog;
    ta.style.cssText = 'position:fixed;inset:10%;z-index:40;font-size:12px';
    document.getElementById('root')!.appendChild(ta);
    ta.select();
    ta.addEventListener('blur', () => ta.remove());
    toast('全部選択してコピーしてください');
  }
});
$('applyCalib').addEventListener('click', () => {
  settings.offset = Math.max(-300, Math.min(300, play.suggested));
  saveSettings();
  $('applyCalib').closest('.calib')!.classList.add('hidden');
  toast(`判定調整を ${settings.offset}ms にしました`);
});
$('back').addEventListener('click', () => play.close());
// ポーズ: 左上のボタン。つづける／はじめから（曲の最初から）／エディタへ
$('playPause').addEventListener('click', () => play.pause());
$('pauseResume').addEventListener('click', () => void play.resume());
$('pauseRestart').addEventListener('click', () => void (play.lastWasCalibration ? play.startCalibration() : startTest(true)));
$('pauseBack').addEventListener('click', () => play.close());
$('retry').addEventListener('click', () => void (play.lastWasCalibration ? play.startCalibration() : startTest()));
play.onExit = () => view.invalidate();

// ---------- 起動 ----------

/**
 * サイトに置かれた打音（public/sounds/dong.* と ka.*）を探す。
 * リポジトリに打音ファイルを置けば、全員の既定の打音になる（端末で読み込んだ音があればそちらが優先）。
 */
async function siteHitSound(kind: HitSound): Promise<AudioFile | null> {
  const names = kind === 'don' ? ['dong', 'don'] : kind === 'ka' ? ['ka'] : ['balloon', 'Balloon'];
  for (const n of names) {
    for (const ext of ['wav', 'ogg', 'mp3', 'm4a']) {
      try {
        const res = await fetch(`sounds/${n}.${ext}`, { cache: 'no-cache' });
        const type = res.headers.get('content-type') ?? '';
        if (res.ok && !type.includes('text/html')) return { name: `${n}.${ext}`, data: await res.arrayBuffer() };
      } catch { /* ない */ }
    }
  }
  return null;
}

async function boot() {
  for (const k of ['don', 'ka', 'balloon'] as const) {
    const f = (await loadHitSound(k)) ?? (await siteHitSound(k));
    if (f) await applyHitSound(k, f, false);
  }
  const saved = await loadChart();
  if (saved?.chart?.courses?.length) {
    ed.load(saved.chart, null, saved.courseIndex);
    await setAudio(await loadAudio(), false);
  } else {
    ed.load(parseTJA(DEMO_TJA), null);
    toast('サンプル譜面を開きました。右の ⇅（読み込み・書き出し）から .tja / .zip を開けます');
  }
  view.pos = 0;
  updateHeader();
}
void boot();

// 動作確認用（URL に ?debug を付けたときだけ）
if (new URLSearchParams(location.search).has('debug')) {
  (window as unknown as { __malody: unknown }).__malody = { ed, view, play, audio, settings };
}

startAutoUpdate({
  canReload: () => !play.isActive && !playing,
  beforeReload: async () => {
    clearTimeout(saveTimer);
    await saveChart({ chart: ed.chart, courseIndex: ed.courseIndex, savedAt: Date.now() });
  },
  notify: toast,
});

// ---------- グラデ ----------

function renderGradSheet(body: HTMLElement) {
  const st = gradEdit!;
  const g = st.grad;
  const m1 = ed.measureOf(g.start);
  const m2 = ed.measureOf(g.end);
  const hasBpm = ed.course.events.some((e) => e.kind === 'bpm' && e.tick > g.start && e.tick < g.end)
    || ed.timing.bpmAt(g.start) !== ed.timing.bpmAt(g.end);
  const seg = (key: string, items: [string, string][], cur: string) =>
    `<div class="btns grad-seg" style="grid-template-columns: repeat(${items.length}, minmax(0, 1fr))">${items.map(([v, label]) => `<button data-gset="${key}" data-v="${v}" class="${v === cur ? 'primary' : ''}">${label}</button>`).join('')}</div>`;
  $('sheetTitle').textContent = st.old ? 'グラデを変更' : 'グラデ';
  body.innerHTML = `
    <div class="grad-layout">
      <div class="grad-form">
        <label class="field"><span>開始値</span><input type="text" autocapitalize="off" autocomplete="off" data-g="from" value="${g.from}"></label>
        <label class="field"><span>終了値</span><input type="text" autocapitalize="off" autocomplete="off" data-g="to" value="${g.to}"></label>
        ${seg('mode', [['linear', '等差'], ['geometric', '等比']], g.mode)}
        <label class="field"><span>小数の桁数</span><input type="number" min="0" max="6" step="1" inputmode="numeric" data-g="digits" value="${g.digits}"></label>
        <h3>#BPMCHANGE${hasBpm ? '' : '（この範囲にはなし）'}</h3>
        ${seg('speed', [['visual', '見た目(終点)'], ['visualBase', '見た目(始点)'], ['scroll', 'SCROLL値']], g.speed ?? 'scroll')}
        <p class="grad-err" id="gradErr"></p>
        <div class="btns${st.old ? ' three' : ''}">
          ${st.old ? '<button data-gact="del">グラデを消す</button>' : ''}
          <button data-gact="cancel">やめる</button>
          <button data-gact="ok" class="primary">${st.old ? '変更' : '置く'}</button>
        </div>
      </div>
      <div class="grad-tja">
        <div class="grad-tja-head">.tja での書き方（小節 ${m1.index + 1} 〜 ${m2.index + 1}）</div>
        <pre id="gradTja"></pre>
      </div>
    </div>`;
  const preview = () => {
    const err = gradValid(g);
    body.querySelector('#gradErr')!.textContent = err ?? '';
    const pre = body.querySelector<HTMLElement>('#gradTja')!;
    if (err) { pre.textContent = ''; return; }
    pre.innerHTML = gradTjaPreview(g, st.old);
  };
  body.querySelectorAll<HTMLInputElement>('input[data-g]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const k = inp.dataset.g as 'from' | 'to' | 'digits';
      if (inp.value.trim() === '') return;
      const v = Number(inp.value);
      g[k] = k === 'digits' ? Math.max(0, Math.min(6, Math.round(v))) : v;
      preview();
    });
  });
  body.querySelectorAll<HTMLButtonElement>('[data-gset]').forEach((b) => {
    b.addEventListener('click', () => {
      const key = b.dataset.gset!;
      const v = b.dataset.v!;
      if (key === 'mode') g.mode = v as Grad['mode'];
      else if (key === 'speed') g.speed = v as Grad['speed'];
      body.querySelectorAll<HTMLButtonElement>(`[data-gset="${key}"]`).forEach((x) => x.classList.toggle('primary', x === b));
      preview();
    });
  });
  body.querySelectorAll<HTMLButtonElement>('[data-gact]').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.dataset.gact;
      if (act === 'ok') {
        const err = gradValid(g);
        if (err) { toast(err); return; }
        ed.setGrad({ ...g }, st.old);
        toast(st.old ? 'グラデを変更しました' : 'グラデを置きました');
      } else if (act === 'del' && st.old) {
        ed.removeGrad(st.old);
        toast('グラデを消しました');
      }
      gradEdit = null;
      closeSheet();
    });
  });
  preview();
}

/** グラデを置いた後の .tja のうち、範囲の小節の部分を色付きの HTML で返す */
function gradTjaPreview(g: Grad, old?: Grad): string {
  const c = JSON.parse(JSON.stringify(ed.course)) as ECourse;
  if (old) c.events = c.events.filter((e) => !(e.kind === 'scroll' && e.tick >= old.start && e.tick <= old.end));
  sortCourse(c);
  applyGrad(c, g, ed.chart.bpm);
  sortCourse(c);
  const text = ['#START', ...writeCourseBody(c), '#END'].join('\n');
  const marks = tjaMarks(text);
  const a = ed.measureOf(g.start).index + 1;
  const b = ed.measureOf(g.end).index + 1;
  const n = marks.lineStarts.length;
  const lineText = (li: number) => text.slice(marks.lineStarts[li], li + 1 < n ? marks.lineStarts[li + 1] - 1 : text.length).trim();
  // 小節の最初の行と、その前に並ぶ命令の行（#SCROLL など）から
  const head = (mNo: number) => {
    let li = -1;
    for (let i = 0; i < n; i++) if (marks.measure[i] === mNo) { li = i; break; }
    if (li < 0) return -1;
    while (li > 1 && lineText(li - 1).startsWith('#')) li--;
    return li;
  };
  const from = Math.max(1, head(a));
  let to = head(b + 1);
  if (to < 0) to = n - 1;
  return tjaLinesHtml(text, marks, from, to);
}

// ---------- SCROLL / BPMCHANGE / MEASURE（1 か所） ----------

let pointEdit: { kind: 'scroll' | 'bpm' | 'measure'; tick: number } | null = null;

function openPoint(kind: 'scroll' | 'bpm' | 'measure', tick: number) {
  pointEdit = { kind, tick };
  openSheet('point');
}

function renderPointSheet(body: HTMLElement) {
  const { kind, tick } = pointEdit!;
  const m = ed.measureOf(tick);
  const beat = (tick - m.start) / ((TPB * 4) / m.den) + 1;
  const cur = ed.eventAt(kind, tick);
  const title = { scroll: '#SCROLL', bpm: '#BPMCHANGE', measure: '#MEASURE' }[kind];
  let value = '';
  if (kind === 'scroll') value = String(cur && cur.kind === 'scroll' ? cur.value : ed.timing.scrollAt(tick));
  else if (kind === 'bpm') value = String(cur && cur.kind === 'bpm' ? cur.value : ed.timing.bpmAt(tick));
  else value = `${m.num}/${m.den}`;
  $('sheetTitle').textContent = title;
  const where = kind === 'measure' ? `小節 ${m.index + 1} から` : `小節 ${m.index + 1}・${Number(beat.toFixed(2))} 拍目から`;
  const label = { scroll: 'SCROLL', bpm: 'BPM', measure: '拍子（例: 3/4）' }[kind];
  body.innerHTML = `
    <p class="note">${where}</p>
    <label class="field"><span>${label}</span><input type="text" autocapitalize="off" autocomplete="off" id="pointValue" value="${value}"></label>
    <div class="btns${cur ? ' three' : ''}">
      ${cur ? '<button data-pact="del">消す</button>' : ''}
      <button data-pact="cancel">やめる</button>
      <button data-pact="ok" class="primary">${cur ? '変更' : '置く'}</button>
    </div>`;
  const inp = body.querySelector<HTMLInputElement>('#pointValue')!;
  const ok = () => {
    const v = inp.value.trim();
    let ev: EEvent | null = null;
    if (kind === 'scroll') {
      if (v !== '' && Number.isFinite(Number(v))) ev = { tick, kind: 'scroll', value: Number(v) };
    } else if (kind === 'bpm') {
      if (Number(v) > 0) ev = { tick, kind: 'bpm', value: Number(v) };
    } else {
      const mm = v.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
      if (mm && Number(mm[1]) > 0 && Number(mm[2]) > 0) ev = { tick, kind: 'measure', num: Number(mm[1]), den: Number(mm[2]) };
    }
    if (!ev) {
      toast(kind === 'measure' ? '「3/4」の形で入力してください' : kind === 'bpm' ? '0 より大きい数を入力してください' : '数を入力してください');
      return;
    }
    ed.addEvent(ev);
    toast(`${eventText(ev)} を置きました`);
    pointEdit = null;
    closeSheet();
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  body.querySelectorAll<HTMLButtonElement>('[data-pact]').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.dataset.pact;
      if (act === 'ok') { ok(); return; }
      if (act === 'del' && cur) {
        ed.removeEvent(cur);
        toast(`${title} を消しました`);
      }
      pointEdit = null;
      closeSheet();
    });
  });
}

// ---------- レーンの下のイベント（タップしたとき） ----------

const EV_NAMES: Partial<Record<keyof EventShow, string>> = {
  bpm: 'BPM', scroll: 'SCROLL', measure: '拍子', delay: 'DELAY', barline: '小節線の表示',
};

/** 一覧に出しているイベント */
let evList: EventItem[] | null = null;

/** 1 つだけならそのまま変更の画面、重なってまとめたものは一覧を出す */
function openEvents(items: EventItem[]) {
  if (items.length === 1) {
    const it = items[0];
    const e = it.events[0];
    if (it.grad) {
      gradEdit = { grad: { ...it.grad }, old: it.grad };
      openSheet('grad');
      return;
    }
    if (e.kind === 'scroll' || e.kind === 'bpm' || e.kind === 'measure') {
      openPoint(e.kind, e.tick);
      return;
    }
  }
  evList = items;
  openSheet('evlist');
}

function renderEvListSheet(body: HTMLElement) {
  const items = (evList ?? []).filter((it) => it.events.some((e) => ed.course.events.includes(e)));
  $('sheetTitle').textContent = 'イベント';
  if (!items.length) {
    body.innerHTML = '<p class="note">イベントはありません</p>';
    return;
  }
  body.innerHTML = `<div class="ev-list">${items.map((it, i) => {
    const e = it.events[0];
    const name = it.grad ? `グラデ ${it.grad.from}→${it.grad.to}（${it.grad.mode === 'linear' ? '等差' : '等比'}）` : eventText(e);
    const editable = !!it.grad || e.kind === 'scroll' || e.kind === 'bpm' || e.kind === 'measure';
    return `<div class="ev-row"><i style="background:${EVENT_COLOR[e.kind]}"></i><div class="ev-name">${name}<small>${posText(it.tick)}</small></div>
      ${editable ? `<button data-evi="${i}" data-evact="edit">変更</button>` : ''}<button data-evi="${i}" data-evact="del">消す</button></div>`;
  }).join('')}</div>`;
  body.querySelectorAll<HTMLButtonElement>('[data-evact]').forEach((b) => {
    b.addEventListener('click', () => {
      const it = items[Number(b.dataset.evi)];
      if (b.dataset.evact === 'edit') {
        openEvents([it]);
        return;
      }
      if (it.grad) ed.removeGrad(it.grad);
      else ed.removeEvent(it.events[0]);
      toast('消しました');
      // 一覧を描き直す（refreshSheet から）
    });
  });
}

$('sheetBody').addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  const k = el.dataset.evshow as keyof EventShow | undefined;
  if (!k) return;
  settings.evShow[k] = el.checked;
  saveSettings();
  view.evShow = settings.evShow;
  view.invalidate();
});

/** 位置の表示（小節・拍） */
function posText(tick: number) {
  const m = ed.measureOf(tick);
  const beat = (tick - m.start) / ((TPB * 4) / m.den) + 1;
  return `小節 ${m.index + 1}・${Number(beat.toFixed(3))} 拍目`;
}

// ---------- BPM・OFFSET の自動測定 ----------

const tempoState: {
  running: boolean; progress: number; result: TempoResult | null; error: string; mul: number[]; shift: number;
  /** OFFSET の手での微調整（秒、＋で拍の線が後ろへ） */
  fine: number;
  /** 波形の表示: 真ん中の時刻と、表示する長さ（秒） */
  viewAt: number; span: number;
  /** 手で決めた 1 拍目（秒）と、波形をタップして置くモード */
  anchors: number[]; anchorMode: boolean;
  /** 区間ごとに手で決めた拍子（null は自動） */
  meterSel: (Meter | null)[];
  /** 手で直した案（区間を分ける・動かす・消す・BPM を書き換えたら、ここに測った案を写して直していく。null は測ったまま） */
  plan: TempoPlan | null;
  /** 元に戻す・やり直す */
  undo: string[]; redo: string[];
  /** 選んでいる区間 */
  sel: number;
} = {
  running: false, progress: 0, result: null, error: '', mul: [], shift: 0, fine: 0, viewAt: 0, span: 2,
  anchors: [], anchorMode: false, meterSel: [], plan: null, undo: [], redo: [], sel: 0,
};

/** 今の案（手で直していればその案、まだなら測った結果から作る） */
function curTempoPlan(): TempoPlan | null {
  const st = tempoState;
  if (!st.result) return null;
  return st.plan ?? tempoPlan(st.result, TPB, st.mul, st.shift, st.fine);
}
/** 測ったままの案で、区間が測った結果の区間と 1 対 1 のとき（拍子の「自動」や ÷2・×2 を測った結果の側で扱える） */
function tempoRaw(): boolean {
  const st = tempoState;
  const p = curTempoPlan();
  return !st.plan && !!st.result && !!p && p.changes.length + 1 === st.result.segments.length;
}
function tempoSnap(): string {
  const st = tempoState;
  return JSON.stringify({ plan: st.plan, mul: st.mul, shift: st.shift, fine: st.fine, meterSel: st.meterSel, meters: st.result?.meters ?? null, sel: st.sel });
}
function tempoPush() {
  const st = tempoState;
  st.undo.push(tempoSnap());
  if (st.undo.length > 200) st.undo.shift();
  st.redo = [];
}
function tempoRestore(s: string) {
  const st = tempoState;
  const v = JSON.parse(s) as { plan: TempoPlan | null; mul: number[]; shift: number; fine: number; meterSel: (Meter | null)[]; meters: TempoResult['meters'] | null; sel: number };
  Object.assign(st, { plan: v.plan, mul: v.mul, shift: v.shift, fine: v.fine, meterSel: v.meterSel, sel: v.sel });
  if (st.result) st.result.meters = v.meters ?? undefined;
}
/** 案を手で直す（変わったときだけ、元に戻せるように覚えてから） */
function tempoEditPlan(fn: (p: TempoPlan) => TempoPlan | null, sel?: number): boolean {
  const st = tempoState;
  const p0 = curTempoPlan();
  if (!p0) return false;
  const p = fn(p0);
  if (!p || JSON.stringify(p) === JSON.stringify(p0)) return false;
  tempoPush();
  st.plan = p;
  if (sel !== undefined) st.sel = sel;
  st.sel = Math.max(0, Math.min(p.changes.length, st.sel));
  return true;
}

/** 測定画面の確認再生: 区間の少し前から音源を流し、案の拍でメトロノームを鳴らす（調整するとすぐ反映） */
const tempoPreview = { on: false, row: -1, scheduled: 0 };
async function startTempoPreview(row: number, from: number) {
  stopPlayback();
  Object.assign(tempoPreview, { on: false, row, scheduled: from - 0.001 });
  tempoState.viewAt = from + tempoState.span * 0.3;
  await audio.startAt(from, 1);
  if (tempoPreview.row === row) tempoPreview.on = true;
}
function stopTempoPreview() {
  if (tempoPreview.row === -1) return;
  tempoPreview.on = false;
  tempoPreview.row = -1;
  audio.stop();
}
function tickTempoPreview() {
  const st = tempoState;
  if (sheet !== 'tempo' || !st.result) { stopTempoPreview(); return; }
  const p = curTempoPlan();
  if (!p) return;
  const now = audio.now();
  if (now > st.result.duration + 0.5) {
    stopTempoPreview();
    renderSheet();
    return;
  }
  // これから 0.25 秒以内に鳴る拍を予約する
  const horizon = now + 0.25;
  for (const b of planBeatTimes(p, TPB, horizon)) {
    if (b.t > tempoPreview.scheduled && b.t >= now - 0.02) audio.scheduleMetro(b.bar, b.t);
  }
  tempoPreview.scheduled = Math.max(tempoPreview.scheduled, horizon);
  // 波形は今の位置を追いかける
  st.viewAt = now + st.span * 0.3;
  drawTempoWave(p, now);
  drawTempoOverview(p, now);
}

/** 音源を 1 ch にまとめて、別のスレッドで測る（使えないときはこの画面で測る） */
function startTempo(again = false) {
  const buf = audio.buffer;
  if (!buf) {
    toast('先に音源を読み込んでください');
    return;
  }
  stopPlayback();
  stopTempoPreview();
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
  }
  // 測り直し（again）のときは、手で決めた 1 拍目・拍子・表示の位置をそのまま使う
  const keep = again ? { viewAt: tempoState.viewAt, span: tempoState.span } : { viewAt: -1, span: 2, anchors: [], meterSel: [], anchorMode: false };
  Object.assign(tempoState, { running: true, progress: 0, result: null, error: '', mul: [], shift: 0, fine: 0, plan: null, undo: [], redo: [], sel: 0, ...keep });
  const opts: TempoOptions = { anchors: [...tempoState.anchors], meters: [...tempoState.meterSel] };
  if (again) renderSheet();
  else openSheet('tempo');
  const done = (r: TempoResult) => {
    tempoState.running = false;
    tempoState.result = r;
    tempoState.mul = r.segments.map(() => 1);
    // 区間の数が変わったら、手で決めた拍子は使えないので自動に戻す
    if (tempoState.meterSel.length !== r.segments.length) tempoState.meterSel = r.segments.map(() => null);
    if (sheet === 'tempo') renderSheet();
  };
  const fail = (msg: string) => {
    tempoState.running = false;
    tempoState.error = msg;
    if (sheet === 'tempo') renderSheet();
  };
  const runHere = () => {
    setTimeout(() => {
      try { done(analyzeTempo(mono, buf.sampleRate, undefined, opts)); } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
    }, 50);
  };
  let worker: Worker;
  try {
    worker = new Worker(new URL('./audio/tempoWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    runHere();
    return;
  }
  let started = false;
  worker.onmessage = (e: MessageEvent<{ type: string; p?: number; result?: TempoResult; message?: string }>) => {
    started = true;
    const m = e.data;
    if (m.type === 'progress') {
      tempoState.progress = m.p ?? 0;
      const bar = document.getElementById('tempoBar');
      if (bar) bar.style.width = `${Math.round(tempoState.progress * 100)}%`;
    } else if (m.type === 'done' && m.result) {
      worker.terminate();
      done(m.result);
    } else if (m.type === 'error') {
      worker.terminate();
      fail(m.message ?? '測れませんでした');
    }
  };
  worker.onerror = () => {
    worker.terminate();
    if (!started) runHere();
    else fail('測れませんでした');
  };
  // 測れなかったときにこの画面で測り直せるよう、データは渡さずに写す（transfer しない）
  worker.postMessage({ mono, sr: buf.sampleRate, opts });
}

const fmtSec = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

const METER_CHOICES = ['2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '3/8', '5/8', '6/8', '7/8', '9/8', '12/8'];
const parseMeter = (v: string): Meter => { const [n, d] = v.split('/').map(Number); return { num: n, den: d }; };
function meterOptions(auto: Meter | undefined, sel: Meter | null, withAuto = true) {
  const a = auto ? `${auto.num}/${auto.den}` : '4/4';
  const cur = sel ? `${sel.num}/${sel.den}` : withAuto ? 'auto' : a;
  const list = METER_CHOICES.includes(cur) || cur === 'auto' ? METER_CHOICES : [...METER_CHOICES, cur];
  return (withAuto ? `<option value="auto" ${cur === 'auto' ? 'selected' : ''}>自動（${a}）</option>` : '') + list.map((m) => `<option value="${m}" ${cur === m ? 'selected' : ''}>${m}</option>`).join('');
}

/** 区間の色（BPM ごとに色相を変える。だんだん変わる所は少しずつ色が変わる） */
function tempoColor(bpm: number, alpha = 1) {
  const h = ((Math.log2(bpm / 60) * 150) % 360 + 360) % 360;
  return `hsla(${h.toFixed(0)}, 42%, 40%, ${alpha})`;
}

/** tick → 「小節 n」「小節 n 拍 b」 */
function tempoBarLabel(p: TempoPlan, tick: number) {
  if (tick < 0) return '曲の頭';
  const bars = planBars(p, TPB, tick);
  const b = bars[bars.length - 1] ?? { tick: 0, n: 1 };
  const beat = (tick - b.tick) / TPB;
  return Math.abs(beat) < 1e-6 ? `小節 ${b.n}` : `小節 ${b.n} 拍 ${Number((beat + 1).toFixed(2))}`;
}

/** 波形のダブルタップを見分けるための、前のタップ（描き直しても消えないように外に置く） */
let tempoLastTap = { at: 0, t: 0 };

function renderTempoSheet(body: HTMLElement) {
  $('sheetTitle').textContent = 'BPM・OFFSET の自動測定';
  const st = tempoState;
  if (st.running) {
    body.innerHTML = `<p class="note">曲全体を調べています…</p><div class="tempo-progress"><i id="tempoBar" style="width:${Math.round(st.progress * 100)}%"></i></div>`;
    return;
  }
  if (st.error || !st.result) {
    body.innerHTML = `<p class="note">測れませんでした: ${st.error}</p>`;
    return;
  }
  const r = st.result;
  const plan0 = curTempoPlan();
  if (!plan0) {
    body.innerHTML = '<p class="note">拍が見つかりませんでした</p>';
    return;
  }
  // 波形の最初の表示: 最初の 1 拍目のあたり
  if (st.viewAt < 0) st.viewAt = Math.max(0, -plan0.offset + st.span * 0.3);
  const secs = editSections(plan0);
  st.sel = Math.max(0, Math.min(secs.length - 1, st.sel));
  const raw = tempoRaw();
  const weak = raw && r.segments.some((s) => s.matched / Math.max(1, s.beats) < 0.6 || s.jitterMs > 8);
  const hasNotes = ed.chart.courses.some((c) => c.notes.length);
  const sec = secs[st.sel];
  const tS = st.sel === 0 ? 0 : Math.max(0, planTimeAt(plan0, TPB, sec.s));
  const tE = sec.e === Infinity ? r.duration : planTimeAt(plan0, TPB, sec.e);
  const seg = raw ? r.segments[st.sel] : null;
  const rate = seg ? Math.round((seg.matched / Math.max(1, seg.beats)) * 100) : -1;
  const meterSel = raw
    ? `<select data-tmeter aria-label="拍子">${meterOptions(r.meterAuto?.[st.sel], st.meterSel[st.sel] ?? null)}</select>`
    : `<select data-tmeter aria-label="拍子">${meterOptions(undefined, meterAtTick(plan0, Math.max(0, sec.s)), false)}</select>`;
  body.innerHTML = `
    <div class="tempo-tools">
      <button data-tundo aria-label="元に戻す" ${st.undo.length ? '' : 'disabled'}>↶</button>
      <button data-tredo aria-label="やり直す" ${st.redo.length ? '' : 'disabled'}>↷</button>
      <span class="tempo-hint">帯をタップで区間を選ぶ・境目をドラッグで動かす・波形をダブルタップでそこから新しい BPM</span>
      ${st.plan ? '<span class="tempo-tag">手で直した案</span>' : ''}
    </div>
    <canvas id="tempoOverview" class="tempo-ov"></canvas>
    <div class="tempo-ov-axis"><span>0:00</span><span>${fmtSec(r.duration / 2)}</span><span>${fmtSec(r.duration)}</span></div>
    ${weak ? '<p class="note bad">合い方が弱い区間があります。下の波形で拍の線と音を見比べてください。</p>' : ''}
    <div class="tempo-wave-wrap">
      <canvas id="tempoWave" class="tempo-wave"></canvas>
      <div class="tempo-wave-bar">
        <button data-tview="-1" aria-label="前へ">◀</button>
        <button data-tzoom="0.5" aria-label="拡大">＋</button>
        <button data-tzoom="2" aria-label="縮小">－</button>
        <button data-tview="1" aria-label="後ろへ">▶</button>
        <button data-tplayhere class="tempo-play">${tempoPreview.row === -2 ? '■ 停止' : '▶ ここから再生'}</button>
        <span class="tempo-fine-label">${st.anchorMode ? 'タップで 1 拍目を置く・消す' : '旗をドラッグ: 変わり目を動かす／ほかをドラッグ: 拍の線を音に合わせる'}</span>
      </div>
    </div>
    <div class="tempo-insp">
      <div class="tempo-insp-pos"><span class="k">区間 ${st.sel + 1} / ${secs.length}</span><b>${tempoBarLabel(plan0, sec.s)} 〜 ${sec.e === Infinity ? '最後' : tempoBarLabel(plan0, sec.e)}</b><small>${fmtSec(tS)} 〜 ${fmtSec(tE)}${rate >= 0 ? `　合った拍 ${rate}%` : ''}</small></div>
      <div><span class="k">BPM</span><span class="tempo-bpm-edit"><button data-tbpm="-1" aria-label="BPM を 1 下げる">−</button><input id="tempoBpmIn" inputmode="decimal" value="${Number(sec.bpm.toFixed(3))}" aria-label="BPM"><button data-tbpm="1" aria-label="BPM を 1 上げる">＋</button></span>
        <button data-tmul="0.5">÷2</button><button data-tmul="2">×2</button></div>
      <div><span class="k">拍子</span>${meterSel}</div>
      <div class="tempo-insp-act"><span class="k">&nbsp;</span>
        <button data-tplay class="tempo-play">${tempoPreview.row === st.sel ? '■ 停止' : '▶ メトロノーム'}</button>
        <button data-tsplit>✂ 分ける</button>
        <button data-tdel class="bad" ${secs.length > 1 ? '' : 'disabled'}>🗑 消す</button>
      </div>
    </div>
    <div class="tempo-wave-bar">
      <button data-tanchor class="${st.anchorMode ? 'on' : ''}">${st.anchorMode ? '✓ 1 拍目を置く' : '1 拍目を置く'}</button>
      <button data-tremeasure class="primary" ${st.anchors.length ? '' : 'disabled'}>この 1 拍目で測り直す${st.anchors.length ? `（${st.anchors.length}）` : ''}</button>
      <button data-tclear ${st.anchors.length ? '' : 'disabled'}>1 拍目を消す</button>
    </div>
    <div class="field grad-pos"><span>微調整</span><button data-tfine="-0.01">-10</button><button data-tfine="-0.001">-1</button><b id="tempoFine"></b><button data-tfine="0.001">+1</button><button data-tfine="0.01">+10</button></div>
    <div class="field grad-pos"><span>1 拍目</span><button data-tshift="-4" aria-label="1 小節前へ">◀◀</button><button data-tshift="-1" aria-label="1 拍前へ">◀</button><b id="tempoOffset"></b><button data-tshift="1" aria-label="1 拍後ろへ">▶</button><button data-tshift="4" aria-label="1 小節後ろへ">▶▶</button></div>
    <p class="note" id="tempoSummary"></p>
    ${st.plan && st.anchors.length ? '<p class="note">測り直すと、手で直した所は消えます。</p>' : ''}
    ${hasNotes ? '<p class="note">今の #BPMCHANGE・#MEASURE は置き換えます。音符の拍の位置はそのままで、時刻が変わります。</p>' : ''}
    <div class="btns"><button data-tact="cancel">やめる</button><button data-tact="ok" class="primary">入れる</button></div>`;
  const rerender = () => renderTempoSheet(body);
  const update = () => {
    const p = curTempoPlan()!;
    const fineMs = Math.round(st.fine * 1000);
    $('tempoFine').textContent = st.plan ? '拍の線' : `${fineMs >= 0 ? '+' : ''}${fineMs} ms`;
    $('tempoOffset').textContent = `OFFSET ${p.offset.toFixed(3)}`;
    // tick → 小節の番号（拍子が変わっても数えられるように）
    const lastTick = Math.max(0, ...p.changes.map((c) => c.tick), ...p.measures.map((m) => m.tick));
    const bars = planBars(p, TPB, lastTick);
    const barNo = (tick: number) => { let n = 1; for (const b of bars) { if (b.tick > tick) break; n = b.n; } return n; };
    const list = <T,>(xs: T[], f: (x: T) => string) => `${xs.slice(0, 6).map(f).join('、')}${xs.length > 6 ? ' …' : ''}`;
    $('tempoSummary').textContent = `入れる内容: BPM ${p.bpm} ／ OFFSET ${p.offset.toFixed(3)}`
      + (p.changes.length ? ` ／ #BPMCHANGE ${p.changes.length} か所（${list(p.changes, (c) => `${barNo(c.tick)} 小節目で ${c.bpm}`)}）` : '')
      + (p.measures.length ? ` ／ #MEASURE ${p.measures.length} か所（${list(p.measures, (m) => `${barNo(m.tick)} 小節目から ${m.num}/${m.den}`)}）` : '');
    drawTempoWave(p, tempoPreview.on ? audio.now() : -1);
    drawTempoOverview(p, tempoPreview.on ? audio.now() : -1);
  };
  update();

  // ---- 曲全体の帯: タップで区間を選ぶ・境目をドラッグ・帯をドラッグで表示する所を動かす ----
  const ov = body.querySelector<HTMLCanvasElement>('#tempoOverview')!;
  const ovTime = (x: number) => Math.max(0, Math.min(r.duration, (x / Math.max(1, ov.clientWidth)) * r.duration));
  bindTempoDrag(ov, ovTime, () => (r.duration / Math.max(1, ov.clientWidth)) * 10, {
    tap: (t) => {
      const p = curTempoPlan()!;
      st.sel = sectionAtTime(p, TPB, t);
      if (!tempoPreview.on) st.viewAt = t;
      rerender();
    },
    pan: (t) => { if (!tempoPreview.on) { st.viewAt = t; update(); } },
    after: rerender,
  });

  // ---- 拡大した波形: 旗をドラッグで変わり目を動かす・ほかをドラッグで拍の線（OFFSET）を動かす・ダブルタップで分ける ----
  const cv = body.querySelector<HTMLCanvasElement>('#tempoWave')!;
  const cvTime = (x: number) => st.viewAt - st.span / 2 + (x / Math.max(1, cv.clientWidth)) * st.span;
  bindTempoDrag(cv, cvTime, () => (st.span / Math.max(1, cv.clientWidth)) * 12, {
    tap: (t) => {
      if (st.anchorMode) {
        const W = Math.max(1, cv.clientWidth);
        const near = st.anchors.findIndex((a) => Math.abs(a - t) < (12 / W) * st.span);
        if (near >= 0) st.anchors.splice(near, 1);
        else if (t >= 0 && t <= r.duration) st.anchors.push(t);
        st.anchors.sort((a, b) => a - b);
        rerender();
        return;
      }
      const now = performance.now();
      const p = curTempoPlan()!;
      if (now - tempoLastTap.at < 400 && Math.abs(t - tempoLastTap.t) < st.span * 0.03) {
        // ダブルタップ: そこから新しい BPM
        tempoLastTap = { at: 0, t: 0 };
        const res = splitAt(p, TPB, t);
        if (res && tempoEditPlan(() => res.plan, res.index)) toast('ここから新しい区間にしました。BPM を直してください');
        rerender();
        return;
      }
      tempoLastTap = { at: now, t };
      const i = sectionAtTime(p, TPB, t);
      // 同じ区間なら描き直さない（描き直すとダブルタップの 2 回目が別のキャンバスになるため）
      if (i === st.sel) return;
      st.sel = i;
      rerender();
    },
    // 何もない所をドラッグ: 拍の線を動かす（OFFSET の微調整）
    slide: (dt, start) => {
      if (st.anchorMode) return;
      if (st.plan) {
        const base = start as TempoPlan;
        st.plan = nudge(base, Math.round(dt * 1000) / 1000);
      } else st.fine = Math.round(((start as number) + dt) * 1000) / 1000;
      update();
    },
    slideStart: () => {
      if (st.anchorMode) return null;
      tempoPush();
      return st.plan ? curTempoPlan() : st.fine;
    },
    after: rerender,
  });

  body.querySelector('[data-tundo]')?.addEventListener('click', () => {
    const s = st.undo.pop();
    if (!s) return;
    st.redo.push(tempoSnap());
    tempoRestore(s);
    rerender();
  });
  body.querySelector('[data-tredo]')?.addEventListener('click', () => {
    const s = st.redo.pop();
    if (!s) return;
    st.undo.push(tempoSnap());
    tempoRestore(s);
    rerender();
  });
  body.querySelector('[data-tanchor]')?.addEventListener('click', () => {
    st.anchorMode = !st.anchorMode;
    rerender();
  });
  body.querySelector('[data-tremeasure]')?.addEventListener('click', () => startTempo(true));
  body.querySelector('[data-tclear]')?.addEventListener('click', () => {
    st.anchors = [];
    rerender();
  });
  // BPM を書き換える（区間の長さはそのままで、後ろの区間の時刻は変わらない）
  const setSelBpm = (b: number) => {
    if (!(b >= 10 && b <= 2000)) { toast('BPM は 10〜2000 で入れてください'); rerender(); return; }
    tempoEditPlan((p) => setBpm(p, TPB, st.sel, b));
    rerender();
  };
  const bpmIn = body.querySelector<HTMLInputElement>('#tempoBpmIn')!;
  bpmIn.addEventListener('change', () => setSelBpm(Number(bpmIn.value)));
  bpmIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') bpmIn.blur(); });
  body.querySelectorAll<HTMLButtonElement>('[data-tbpm]').forEach((b) => b.addEventListener('click', () => {
    const p = curTempoPlan()!;
    const cur = editSections(p)[st.sel].bpm;
    const d = Number(b.dataset.tbpm);
    // 小数の BPM は、まず整数にそろえる
    setSelBpm(cur !== Math.round(cur) ? (d > 0 ? Math.ceil(cur) : Math.floor(cur)) : cur + d);
  }));
  body.querySelectorAll<HTMLButtonElement>('[data-tmul]').forEach((b) => b.addEventListener('click', () => {
    const m = Number(b.dataset.tmul);
    if (tempoRaw()) {
      // 測ったままなら、測った結果の側で倍・半分にする（拍子も合わせて変わる）
      tempoPush();
      st.mul[st.sel] = Math.min(4, Math.max(0.25, st.mul[st.sel] * m));
    } else {
      const p = curTempoPlan()!;
      tempoEditPlan((q) => setBpm(q, TPB, st.sel, editSections(p)[st.sel].bpm * m));
    }
    rerender();
  }));
  body.querySelector<HTMLSelectElement>('[data-tmeter]')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (tempoRaw()) {
      tempoPush();
      st.meterSel[st.sel] = v === 'auto' ? null : parseMeter(v);
      // 拍子だけなら測り直さずに、小節の頭を決め直す
      computeMeters(r, st.meterSel, st.anchors);
    } else tempoEditPlan((p) => setMeter(p, st.sel, parseMeter(v)));
    rerender();
  });
  body.querySelector('[data-tsplit]')?.addEventListener('click', () => {
    // 再生中は今の位置、止まっているときは波形の真ん中で分ける
    const t = tempoPreview.on ? audio.now() : st.viewAt;
    const res = splitAt(curTempoPlan()!, TPB, t);
    if (!res) toast('ここでは分けられません（区間の頭や、1 拍目より前）');
    else if (tempoEditPlan(() => res.plan, res.index)) toast('分けました。新しい区間の BPM を直してください');
    rerender();
  });
  body.querySelector('[data-tdel]')?.addEventListener('click', () => {
    const i = st.sel;
    if (tempoEditPlan((p) => removeSection(p, TPB, i), Math.max(0, i - 1))) toast(i === 0 ? '最初の区間を消しました（次の区間が前に伸びます）' : '区間を消しました（前の区間が伸びます）');
    rerender();
  });
  body.querySelectorAll<HTMLButtonElement>('[data-tfine]').forEach((b) => b.addEventListener('click', () => {
    const d = Number(b.dataset.tfine);
    if (st.plan) tempoEditPlan((p) => nudge(p, d));
    else {
      tempoPush();
      st.fine = Math.round((st.fine + d) * 1000) / 1000;
    }
    update();
  }));
  body.querySelectorAll<HTMLButtonElement>('[data-tzoom]').forEach((b) => b.addEventListener('click', () => {
    st.span = Math.min(16, Math.max(0.5, st.span * Number(b.dataset.tzoom)));
    update();
  }));
  body.querySelectorAll<HTMLButtonElement>('[data-tview]').forEach((b) => b.addEventListener('click', () => {
    st.viewAt = Math.max(0, Math.min(r.duration, st.viewAt + Number(b.dataset.tview) * st.span * 0.8));
    update();
  }));
  body.querySelectorAll<HTMLButtonElement>('[data-tshift]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.tshift);
    if (st.plan) tempoEditPlan((p) => shiftDownbeat(p, TPB, n));
    else {
      tempoPush();
      st.shift += n;
    }
    // 動かした 1 拍目（赤い線）が見えるところへ
    const p = curTempoPlan()!;
    if (!tempoPreview.on) st.viewAt = -p.offset + st.span * 0.3;
    rerender();
  }));
  body.querySelector<HTMLButtonElement>('[data-tplayhere]')?.addEventListener('click', () => {
    if (tempoPreview.row === -2) stopTempoPreview();
    else void startTempoPreview(-2, Math.max(0, st.viewAt - st.span / 2));
    rerender();
  });
  body.querySelector<HTMLButtonElement>('[data-tplay]')?.addEventListener('click', () => {
    if (tempoPreview.row === st.sel) stopTempoPreview();
    else void startTempoPreview(st.sel, Math.max(0, tS - 1));
    rerender();
  });
  body.querySelectorAll<HTMLButtonElement>('[data-tact]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.tact === 'ok') {
      const p = curTempoPlan()!;
      ed.applyTempo(p);
      toast(`BPM ${p.bpm}・OFFSET ${p.offset.toFixed(3)} を入れました`);
    }
    closeSheet();
  }));
}

/**
 * 帯・波形の上の指の操作。境目（区間の頭）の近くを押したらその境目を動かす。
 * それ以外は、動かさずに離したら tap、動かしたら slide（拍の線を動かす）か pan（表示する所を動かす）
 */
function bindTempoDrag(
  cv: HTMLCanvasElement,
  timeAt: (x: number) => number,
  grab: () => number,
  h: {
    tap: (t: number) => void;
    pan?: (t: number) => void;
    slide?: (dt: number, start: unknown) => void;
    slideStart?: () => unknown;
    after: () => void;
  },
) {
  const st = tempoState;
  let drag: { x: number; t: number; moved: boolean; k: number; base: TempoPlan | null; pushed: boolean; start: unknown } | null = null;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const x = localPoint(e, cv).x;
    const t = timeAt(x);
    const p = curTempoPlan();
    let k = -1;
    if (p && !st.anchorMode) {
      // いちばん近い境目（区間 1 以降の頭）
      let best = grab();
      editSections(p).forEach((s, i) => {
        if (i === 0) return;
        const d = Math.abs(planTimeAt(p, TPB, s.s) - t);
        if (d < best) { best = d; k = i; }
      });
    }
    drag = { x, t, moved: false, k, base: p, pushed: false, start: undefined };
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = localPoint(e, cv).x;
    if (!drag.moved && Math.abs(x - drag.x) < 6) return;
    drag.moved = true;
    const t = timeAt(x);
    if (drag.k > 0 && drag.base) {
      // 境目を動かす（前の区間の拍に合わせる）
      const base = drag.base;
      const prev = editSections(base)[drag.k - 1];
      const tp = planTimeAt(base, TPB, prev.s);
      const to = prev.s + ((t - tp) * prev.bpm * TPB) / 60;
      const p = moveBoundary(base, TPB, drag.k, to);
      if (JSON.stringify(p) !== JSON.stringify(curTempoPlan())) {
        if (!drag.pushed) { tempoPush(); drag.pushed = true; }
        st.plan = p;
        st.sel = drag.k;
        drawTempoWave(p, tempoPreview.on ? audio.now() : -1);
        drawTempoOverview(p, tempoPreview.on ? audio.now() : -1);
      }
      return;
    }
    if (h.slide && h.slideStart) {
      if (drag.start === undefined) drag.start = h.slideStart();
      if (drag.start !== null) h.slide(t - drag.t, drag.start);
      return;
    }
    h.pan?.(t);
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) h.tap(d.t);
    else h.after();
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', () => {
    if (drag?.moved) h.after();
    drag = null;
  });
}

/** キャンバスの大きさを画面に合わせる */
function fitCanvas(cv: HTMLCanvasElement) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const W = Math.max(1, cv.clientWidth);
  const H = Math.max(1, cv.clientHeight);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H };
}

/** 曲全体の波形（帯の背景用。音源ごとに 1 度だけ作る） */
let ovPeaks: { buf: AudioBuffer; peaks: Float32Array } | null = null;
function overviewPeaks(buf: AudioBuffer): Float32Array {
  if (ovPeaks?.buf === buf) return ovPeaks.peaks;
  const N = 2048;
  const peaks = new Float32Array(N);
  const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  for (let k = 0; k < N; k++) {
    const a = Math.floor((k / N) * buf.length);
    const b = Math.floor(((k + 1) / N) * buf.length);
    const step = Math.max(1, Math.floor((b - a) / 400));
    let m = 0;
    for (let i = a; i < b; i += step) for (const d of chs) m = Math.max(m, Math.abs(d[i]));
    peaks[k] = m;
  }
  ovPeaks = { buf, peaks };
  return peaks;
}

/** 曲全体の帯: 区間ごとに色を変え、BPM を書く。だんだん変わる所（短い区間が続く所）は「105→145」とまとめて書く */
function drawTempoOverview(plan: TempoPlan, playhead = -1) {
  const cv = document.getElementById('tempoOverview') as HTMLCanvasElement | null;
  const buf = audio.buffer;
  const st = tempoState;
  if (!cv || !buf || !st.result) return;
  const { ctx, W, H } = fitCanvas(cv);
  const dur = st.result.duration;
  const xOf = (t: number) => (Math.max(0, Math.min(dur, t)) / dur) * W;
  ctx.fillStyle = '#111114';
  ctx.fillRect(0, 0, W, H);
  const secs = editSections(plan);
  const xs = secs.map((s, i) => ({
    x0: i === 0 ? 0 : xOf(planTimeAt(plan, TPB, s.s)),
    x1: s.e === Infinity ? W : xOf(planTimeAt(plan, TPB, s.e)),
    bpm: s.bpm,
  }));
  xs.forEach((s) => {
    ctx.fillStyle = tempoColor(s.bpm);
    ctx.fillRect(s.x0, 0, Math.max(1, s.x1 - s.x0), H);
  });
  // 波形
  const peaks = overviewPeaks(buf);
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  for (let x = 0; x < W; x++) {
    const k0 = Math.floor((x / W) * peaks.length);
    const k1 = Math.max(k0 + 1, Math.floor(((x + 1) / W) * peaks.length));
    let m = 0;
    for (let k = k0; k < k1; k++) m = Math.max(m, peaks[k]);
    const h = m * (H - 20);
    ctx.fillRect(x, (H - 18) / 2 - h / 2, 1, Math.max(1, h));
  }
  // BPM の文字（狭い区間が続く所はまとめる）
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  for (let i = 0; i < xs.length; ) {
    let j = i;
    if (xs[i].x1 - xs[i].x0 < 40) while (j + 1 < xs.length && xs[j + 1].x1 - xs[j + 1].x0 < 40) j++;
    const x0 = xs[i].x0;
    const x1 = xs[j].x1;
    const fmt = (b: number) => String(Number(b.toFixed(2)));
    const label = j > i ? `${fmt(xs[i].bpm)}→${fmt(xs[j].bpm)}` : fmt(xs[i].bpm);
    ctx.font = '800 13px system-ui, sans-serif';
    if (ctx.measureText(label).width + 6 > x1 - x0) ctx.font = '800 10px system-ui, sans-serif';
    if (ctx.measureText(label).width + 2 < x1 - x0) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const w = ctx.measureText(label).width + 6;
      ctx.fillRect((x0 + x1) / 2 - w / 2, H - 19, w, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, (x0 + x1) / 2, H - 6);
    }
    i = j + 1;
  }
  ctx.textAlign = 'left';
  // 選んでいる区間
  const s = xs[st.sel];
  if (s) {
    ctx.strokeStyle = '#ffb02e';
    ctx.lineWidth = 3;
    ctx.strokeRect(s.x0 + 1.5, 1.5, Math.max(3, s.x1 - s.x0 - 3), H - 3);
  }
  // 境目（つまみ）。狭い区間が続く所は細い線だけ
  xs.forEach((q, i) => {
    if (i === 0) return;
    const narrow = q.x1 - q.x0 < 12 || q.x0 - xs[i - 1].x0 < 12;
    if (narrow) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(q.x0 - 0.5, 0, 1, H - 20);
      return;
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(q.x0 - 2.5, 0, 5, H);
    ctx.fillStyle = '#fff';
    ctx.fillRect(q.x0 - 1, 0, 2, H);
  });
  // 下の波形に出している範囲
  const v0 = xOf(st.viewAt - st.span / 2);
  const v1 = xOf(st.viewAt + st.span / 2);
  ctx.strokeStyle = 'rgba(79,195,255,0.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(v0, 1, Math.max(3, v1 - v0), H - 2);
  if (playhead >= 0) {
    ctx.fillStyle = '#ff5a4a';
    ctx.fillRect(xOf(playhead) - 1, 0, 2, H);
  }
}

/** 確認画面の波形: 音の波形の上に、案の拍の線（小節の頭は太い線、最初の 1 拍目は赤）と、BPM の変わり目の旗を引く */
function drawTempoWave(plan: TempoPlan, playhead = -1) {
  const cv = document.getElementById('tempoWave') as HTMLCanvasElement | null;
  const buf = audio.buffer;
  if (!cv || !buf) return;
  const st = tempoState;
  const { ctx, W, H } = fitCanvas(cv);
  ctx.fillStyle = '#111114';
  ctx.fillRect(0, 0, W, H);
  const t0 = st.viewAt - st.span / 2;
  const t1 = st.viewAt + st.span / 2;
  const xOf = (t: number) => ((t - t0) / st.span) * W;
  // 選んでいる区間を薄く塗る
  const secs = editSections(plan);
  const sel = secs[st.sel];
  if (sel) {
    const a = st.sel === 0 ? 0 : planTimeAt(plan, TPB, sel.s);
    const b = sel.e === Infinity ? (st.result?.duration ?? t1) : planTimeAt(plan, TPB, sel.e);
    ctx.fillStyle = 'rgba(255,176,46,0.08)';
    ctx.fillRect(xOf(a), 0, xOf(b) - xOf(a), H);
  }
  // 波形（1 px ごとの最大・最小）
  const sr = buf.sampleRate;
  const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  ctx.fillStyle = '#5e6a78';
  const mid = H / 2 + 8;
  const amp = H / 2 - 12;
  for (let x = 0; x < W; x++) {
    const a = Math.floor((t0 + (x / W) * st.span) * sr);
    const b = Math.floor((t0 + ((x + 1) / W) * st.span) * sr);
    if (b <= 0 || a >= buf.length) continue;
    let mn = 0;
    let mx = 0;
    const step = Math.max(1, Math.floor((b - a) / 200));
    for (let i = Math.max(0, a); i < Math.min(buf.length, b); i += step) {
      let v = 0;
      for (const d of chs) v += d[i];
      v /= chs.length;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    ctx.fillRect(x, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
  }
  // 拍の線
  const beats = planBeatTimes(plan, TPB, t1 + 1);
  beats.forEach((b, k) => {
    if (b.t < t0 - 0.01 || b.t > t1 + 0.01) return;
    const x = xOf(b.t);
    ctx.fillStyle = k === 0 ? '#ff5a4a' : b.bar ? '#ffd21f' : 'rgba(255,255,255,0.45)';
    ctx.fillRect(x - (b.bar ? 1 : 0.5), 0, b.bar ? 2 : 1, H);
    if (b.bar) {
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText(String(b.n), x + 3, H - 16);
    }
  });
  // BPM の変わり目の旗（選んでいる区間はオレンジ）
  ctx.font = '800 13px system-ui, sans-serif';
  secs.forEach((s, i) => {
    const t = planTimeAt(plan, TPB, s.s);
    if (i === 0 && t < t0) {
      // 最初の区間の旗は、画面の左端に小さく
      if (st.viewAt - st.span / 2 < (secs[1] ? planTimeAt(plan, TPB, secs[1].s) : Infinity)) {
        ctx.fillStyle = i === st.sel ? '#ffb02e' : '#3fa9f5';
        const label = String(Number(s.bpm.toFixed(3)));
        const w = ctx.measureText(label).width + 10;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(0, 0, w, 20);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#111';
        ctx.fillText(label, 5, 15);
      }
      return;
    }
    if (t < t0 - 1 || t > t1) return;
    const x = xOf(t);
    const label = String(Number(s.bpm.toFixed(3)));
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = i === st.sel ? '#ffb02e' : '#3fa9f5';
    ctx.fillRect(x - 1.5, 0, 3, H);
    ctx.fillRect(x, 0, w, 20);
    ctx.fillStyle = '#111';
    ctx.fillText(label, x + 5, 15);
  });
  // 手で決めた 1 拍目（緑の線と旗）
  for (const a of st.anchors) {
    if (a < t0 - 0.01 || a > t1 + 0.01) continue;
    const x = xOf(a);
    ctx.fillStyle = '#4ade80';
    ctx.fillRect(x - 1, 0, 2, H);
    ctx.beginPath();
    ctx.moveTo(x + 1, H - 22);
    ctx.lineTo(x + 13, H - 16);
    ctx.lineTo(x + 1, H - 10);
    ctx.closePath();
    ctx.fill();
  }
  // 音源の頭（0 秒）
  if (t0 < 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, xOf(0), H);
  }
  // 確認再生中の今の位置
  if (playhead >= t0 && playhead <= t1) {
    ctx.fillStyle = '#4fc3ff';
    ctx.fillRect(xOf(playhead) - 1, 0, 2, H);
  }
  ctx.fillStyle = '#9a9aa2';
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText(fmtSec(Math.max(0, t0)), 4, H - 4);
}
