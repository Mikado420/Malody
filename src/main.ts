import './style.css';
import { AudioEngine, type HitSound } from './audio/audio';
import { COURSE_NAMES, contentEnd, newChart, sortCourse, toPlayable, TPB, type EChart, type ECourse, type EEvent } from './chart/model';
import { parseTJA } from './chart/tja';
import { writeTJA } from './chart/tjaWrite';
import { tjaGutterHtml, tjaLinesHtml, tjaMarks } from './editor/tjaHighlight';
import type { Note } from './chart/types';
import { DEMO_TJA } from './demo';
import { buildAutoEvents, type AutoEvent } from './play/auto';
import { bindTimeline, bindValueBoxes, drawPlayhead, drawRuler, inlineInput, PLAYHEAD, valueBoxHtml, type ValueBox } from './ui/daw';
import { addFadeIn, addFadeOut, arrangeLength, bringToTop, clipAt, clipEnd, envAt, mapTime, MIN_LEN, refShift, renderClips, snapTo, sortEnv, splitClip, trimEnd, trimStart, type Clip, type EnvPoint } from './audio/arrange';
import { analyzeTempo, computeMeters, planBars, planBeatTimes, planTimeAt, tempoPlan, type Meter, type TempoOptions, type TempoPlan, type TempoResult } from './audio/tempo';
import { meterAt as meterAtTick, moveBoundary, nudge, removeSection, sectionAtTime, sections as editSections, setBpm, setEnd, setMeter, setStart, shiftDownbeat, splitAt, tickAtTime } from './editor/tempoEdit';
import { applyGrad, gradValid, type Grad } from './editor/grad';
import { writeCourseBody } from './chart/tjaWrite';

import { DIVISORS, Editor, type Tool } from './editor/editor';
import { EditorView, eventText, EVENT_COLOR, type EventItem, type EventShow } from './editor/view';
import { loadFiles, type AudioFile } from './io/load';
import { encodeSJIS } from './chart/sjis';
import { bufferChannels, isOgg, oggName, pcmToOgg } from './audio/toOgg';
import { fetchLink, testSetup, type LinkResult } from './io/linkFetch';
import { fetchYoutubePublic, youtubeId } from './io/ytPublic';
import { loadAudio, loadChart, loadHitSound, saveHitSound } from './io/storage';
import { getCurrentId, listSongs, loadSongAudio, loadSongData, newId, saveSong, setCurrentId } from './io/library';
import { Home } from './home/home';
import { writeZip } from './io/zip';
import { PlayMode } from './play/playmode';
import { fitRoot, localPoint, typing } from './orient';
import { BUILD_ID, startAutoUpdate } from './update';

fitRoot();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------- 設定 ----------

const settings = {
  /** リンクから読み込む: 処理の入ったリポジトリと、トークン */
  linkRepo: 'Mikado420/Malody',
  linkToken: '',
  /** リンクから読み込む: 中継役（トークン無しで使う）の URL と合言葉 */
  linkRelay: '',
  linkPass: '',
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
// 引き継ぎリンク（…#relay=URL&pass=合言葉）で開いたら、中継役の設定を取り込んで URL から消す
{
  const h = new URLSearchParams(location.hash.slice(1));
  const relay = h.get('relay');
  if (relay && /^https:\/\//.test(relay)) {
    settings.linkRelay = relay;
    settings.linkPass = h.get('pass') ?? '';
    saveSettings();
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => toast('リンク取り込みの設定を引き継ぎました'), 800);
  }
}
const linkSetup = () => ({ repo: settings.linkRepo, token: settings.linkToken, relay: settings.linkRelay || undefined, pass: settings.linkPass });
const linkReady = () => !!settings.linkRelay || (!!settings.linkToken && !!settings.linkRepo);

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
  if (save) void persist(file);
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
  hitHorizon = -Infinity;
  // 始めた位置の音符は、次の画面の書き換えを待たずにすぐ予約する（待つと間に合わず鳴らないことがある）
  scheduleAhead(from);
  view.invalidate();
}

/** 打音・メトロノームを予約し終えた時刻 */
let hitHorizon = -Infinity;
/** これから 0.3 秒以内に鳴る打音を予約する */
function scheduleAhead(t: number) {
  const until = t + 0.3 * settings.rate;
  while (hitIdx < hitEvents.length && hitEvents[hitIdx].t <= until) {
    const e = hitEvents[hitIdx++];
    if (!settings.hitSound) continue;
    audio.scheduleHit(e.kind, e.t);
    if (e.pop) audio.scheduleHit('balloon', e.t);
  }
  while (metroIdx < metroEvents.length && metroEvents[metroIdx].t <= until) {
    const e = metroEvents[metroIdx++];
    if (settings.metronome) audio.scheduleMetro(e.strong, e.t);
  }
  hitHorizon = Math.max(hitHorizon, until);
}

/** 再生中に譜面を変えたら、まだ予約していない打音を作り直す（置いたばかりの音符も鳴るように） */
function rebuildHits() {
  if (!playing) return;
  playable = toPlayable(ed.chart, ed.course).notes;
  const after = hitHorizon;
  hitEvents = buildAutoEvents(playable, after).filter((e) => e.t > after);
  hitIdx = 0;
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

  scheduleAhead(t);
  lastTime = t;
  if (t > endTime()) stopPlayback();
  view.invalidate();
}

function loop() {
  if (playing && !play.isActive) tickPlayback();
  if (tempoPreview.on) tickTempoPreview();
  if (arrPlay.on) tickArrPlay();
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
  select: ['select'],
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
  select: { label: '選択（コピー・切り取り・貼り付け）', cls: 'cmd select' },
};
/** 各ボタンが今どちらの音符になっているか */
const groupTool: Record<string, Tool> = { small: 'don', big: 'bigDon', roll: 'roll', balloon: 'balloon', gogo: 'gogo', scroll: 'scroll', bpm: 'bpm', measure: 'measure', select: 'select' };
const groupOf = (t: Tool) => Object.keys(TOOL_GROUPS).find((g) => TOOL_GROUPS[g].includes(t))!;

function setTool(t: Tool) {
  const prevTool = ed.tool;
  ed.tool = t;
  groupTool[groupOf(t)] = t;
  // 始点を決めた後に別の種類のツールに替えたら、始点を取り消す（連打・大連打・風船どうしはそのまま終点を選べる）
  const longs: Tool[] = ['roll', 'bigRoll', 'balloon'];
  const keep = (longs.includes(t) && longs.includes(prevTool)) || (t === 'gogo' && prevTool === 'gogo') || (t === 'scroll' && prevTool === 'scroll');
  if (ed.pendingLong !== null && !keep) ed.pendingLong = null;
  // 選択ツールをやめたら選んでいる範囲も外す
  if (t !== 'select') ed.sel = null;
  updateSelBar();
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
    const v = prompt('1 小節を何分割にするか（例: 20, 28, 36, 40, 96）', String(ed.divisor));
    if (v === null) return;
    const n = Math.round(Number(v));
    if (!gridOk(n)) {
      toast('その分割数は使えません（使える例: 1〜16, 18, 20, 21, 24, 28, 30, 32, 35, 36, 40, 42, 48, 56, 60, 64, 80, 96…）');
      return;
    }
    setDivisor(n);
    if (!divMenu.classList.contains('hidden')) openDivMenu();
    toast(`グリッドを 1/${n} にしました`);
    return;
  }
  // 選んでもメニューは出したまま（グリッドのボタンをもう一度押すと閉じる）
  setDivisor(Number(b.dataset.div));
  openDivMenu();
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
      { label: '読み込み（.tja / .zip / 音源）', primary: true, run: () => void fileAction('open') },
      { label: '音源を読み込む（ファイル / リンク）', run: () => void fileAction('audio') },
      { label: '音源の切り貼り', run: () => void fileAction('cut') },
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
view.onTap = (tick, tol) => {
  const r = ed.tap(tick, tol);
  if (r.message) toast(r.message);
  updateSelBar();
  if (r.editBalloon) {
    const v = prompt('風船の打数', String(r.editBalloon.hits ?? 5));
    if (v !== null) ed.setBalloonHits(r.editBalloon, Number(v));
  }
  if (r.newGrad || r.editGrad || r.point) $('toast').classList.remove('show');
  if (r.point) openPoint(r.point.kind, r.point.tick);
  if (r.newGrad) {
    const from = ed.timing.scrollAt(r.newGrad.start);
    gradEdit = { grad: { ...r.newGrad, from, to: from * 2, mode: 'linear', digits: 3, speed: 'visual', basis: 'time' } };
    openSheet('grad');
  }
  if (r.editGrad) {
    gradEdit = { grad: { ...r.editGrad }, old: r.editGrad };
    openSheet('grad');
  }
};

// ---------- 選択（コピー・切り取り・貼り付け） ----------

/** 選択ツールのときだけ、ツールの上に操作のボタンを出す */
function updateSelBar() {
  const bar = $('selBar');
  const on = ed.tool === 'select';
  bar.classList.toggle('hidden', !on);
  if (!on) return;
  const n = ed.selectedNotes().length;
  const has = !!ed.sel;
  bar.querySelector<HTMLElement>('.sel-info')!.textContent = has ? `${n} 個` : ed.pendingLong !== null ? '終点をタップ' : '始点をタップ';
  bar.querySelectorAll<HTMLButtonElement>('[data-sel]').forEach((b) => {
    const k = b.dataset.sel!;
    b.disabled = k === 'paste' ? !ed.clip : k === 'clear' ? !has && ed.pendingLong === null : !has || !n;
  });
}
function selAction(k: string) {
  if (k === 'copy') { const n = ed.copySelection(); toast(`${n} 個コピーしました`); }
  else if (k === 'cut') { const n = ed.cutSelection(); toast(`${n} 個切り取りました`); }
  else if (k === 'del') { const n = ed.deleteSelection(); toast(`${n} 個消しました`); }
  else if (k === 'paste') {
    stopPlayback();
    const at = Math.max(0, ed.snap(view.pos));
    const n = ed.paste(at);
    toast(`判定枠の位置に ${n} 個貼り付けました`);
  } else if (k === 'clear') ed.clearSelection();
  updateSelBar();
  view.invalidate();
}
$('selBar').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-sel]');
  if (b && !b.disabled) selAction(b.dataset.sel!);
});

/** 設定画面で編集中のグラデ */
let gradEdit: { grad: Grad; old?: Grad } | null = null;

let saveTimer = 0;
/** 開いている曲（ライブラリの id） */
let currentSongId: string | null = null;
/** 開いている曲を保存する（audio を渡したときは音源も） */
async function persist(audioFile?: AudioFile | null) {
  clearTimeout(saveTimer);
  // 曲を開いていないとき（曲選択の画面だけのとき）は保存しない
  if (!currentSongId) return;
  await saveSong(currentSongId, { chart: ed.chart, courseIndex: ed.courseIndex }, audioFile, audio.buffer ? audio.musicDuration : 0);
}
/** 音源のファイル名を WAVE: に合わせる（曲の情報や TJA のテキストで WAVE: を変えたとき） */
function syncAudioName() {
  const a = ed.audio;
  const w = ed.chart.wave;
  if (!a || !w || w === a.name) return;
  const name = oggName(w);
  ed.chart.wave = name;
  if (name === a.name) return;
  ed.audio = { name, data: a.data };
  void persist(ed.audio);
}
ed.onChange((structural) => {
  view.invalidate();
  updateHeader();
  if (structural) {
    syncAudioName();
    rebuildHits();
    updateSelBar();
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void persist(), 600);
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
  if (play.isActive || !$('sheet').classList.contains('hidden') || !$('home').classList.contains('hidden')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? ed.redo() : ed.undo(); return; }
  if (mod && e.code === 'KeyY') { e.preventDefault(); ed.redo(); return; }
  if (mod && (e.code === 'KeyC' || e.code === 'KeyX' || e.code === 'KeyV')) {
    if (e.code !== 'KeyV' && !ed.sel) return;
    e.preventDefault();
    if (e.code === 'KeyV' && ed.tool !== 'select') setTool('select');
    selAction(e.code === 'KeyC' ? 'copy' : e.code === 'KeyX' ? 'cut' : 'paste');
    return;
  }
  if ((e.code === 'Delete' || e.code === 'Backspace') && ed.sel) { e.preventDefault(); selAction('del'); return; }
  if (e.code === 'Escape' && ed.sel) { selAction('clear'); return; }
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

type SheetKind = 'info' | 'settings' | 'events' | 'grad' | 'point' | 'evlist' | 'tempo' | 'src' | 'link' | 'cut';
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
  // BPM・OFFSET の画面は画面いっぱい
  $('sheet').classList.toggle('tempo', kind === 'tempo' || kind === 'cut');
  document.body.classList.toggle('tja-open', kind === 'events');
  renderSheet();
}
function closeSheet() {
  stopTempoPreview();
  stopArrPlay();
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
  if (sheet === 'grad' || sheet === 'point' || sheet === 'tempo' || sheet === 'link' || sheet === 'cut') return;
  if (sheet === 'evlist') { renderSheet(); return; }
  renderSheet();
}

$('sheetClose').addEventListener('click', closeSheet);
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
        (co, i) => `<div class="item course-item cd-${esc(co.name.toLowerCase())} ${i === ed.courseIndex ? 'current' : ''}">
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
      <label class="field"><span>音源名</span><input type="text" data-meta="wave" value="${esc(c.wave)}" placeholder="${esc(ed.audio?.name ?? '曲名.ogg')}" autocomplete="off"></label>

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
      <p class="note">編集内容はこのブラウザに自動保存されます。書き出した .tja はシフトJIS です。</p>
      <p class="note">バージョン: ${esc(BUILD_ID.slice(0, 7))}</p>`;
  } else if (sheet === 'src') {
    renderSrcSheet(body);
  } else if (sheet === 'link') {
    renderLinkSheet(body);
  } else if (sheet === 'cut') {
    renderCutSheet(body);
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
    const key = d.meta as 'title' | 'subtitle' | 'bpm' | 'offset' | 'demoStart' | 'wave';
    if (key === 'wave') {
      // 音源名（WAVE:）。音源はいつも .ogg なので拡張子は .ogg にそろえる
      const raw = el.value.trim().replace(/[\\/:*?"<>|]+/g, '_');
      const name = raw ? oggName(raw) : '';
      el.value = name;
      ed.mutate(() => { ed.chart.wave = name; });
      return;
    }
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

/** 読み込みの使い方: any = 何でも（譜面は新しい曲に）、audio = 開いている曲の音源を差し替える */
let importMode: 'any' | 'audio' = 'any';
function pickFiles(mode: 'any' | 'audio') {
  importMode = mode;
  fileOpen.click();
}

fileOpen.addEventListener('change', async () => {
  const files = Array.from(fileOpen.files ?? []);
  fileOpen.value = '';
  if (!files.length) return;
  try {
    await importFiles(files, importMode);
  } catch (err) {
    busyEnd();
    toast(`読み込めませんでした: ${(err as Error).message}`);
  }
});

// ---------- 処理中の表示 ----------

function busy(msg: string, p?: number) {
  $('busy').classList.remove('hidden');
  $('busyMsg').textContent = msg;
  $('busyBar').style.width = p === undefined ? '0%' : `${Math.round(p * 100)}%`;
  $('busyBar').parentElement!.classList.toggle('hidden', p === undefined);
}
function busyEnd() {
  $('busy').classList.add('hidden');
}

/** 音源を .ogg にする（.ogg ならそのまま）。長さ（秒）も返す */
async function convertAudio(a: AudioFile, label = a.name): Promise<{ file: AudioFile; length: number }> {
  busy(`「${label}」を読み込んでいます…`);
  const buf = await audio.ctx.decodeAudioData(a.data.slice(0));
  if (isOgg(a.data)) return { file: { name: oggName(a.name), data: a.data }, length: buf.duration };
  const data = await pcmToOgg(bufferChannels(buf), buf.sampleRate, (p) => busy(`「${label}」を .ogg にしています…`, p));
  return { file: { name: oggName(a.name), data }, length: buf.duration };
}

/** 読み込み: .tja・.zip・音源を何でも。譜面は新しい曲として一覧に入れ、音源はすべて .ogg にする */
async function importFiles(files: File[], mode: 'any' | 'audio') {
  busy('読み込んでいます…');
  const r = await loadFiles(files);
  const folder = home.visible ? home.currentFolder : '';
  const added: string[] = [];
  for (const sng of r.songs) {
    let a: AudioFile | null = null;
    let len = 0;
    if (sng.audio) {
      try {
        const c = await convertAudio(sng.audio, sng.chart.title || sng.audio.name);
        a = c.file;
        len = c.length;
        sng.chart.wave = a.name;
      } catch { r.skipped.push(sng.audio.name); }
    }
    const id = newId();
    await saveSong(id, { chart: sng.chart, courseIndex: 0 }, a, len, folder);
    added.push(id);
  }
  // 譜面の無い音源: 編集中で「音源を読み込む」なら今の曲に、ほかは音源ごとに新しい曲
  for (const raw of r.audios) {
    let c: { file: AudioFile; length: number };
    try { c = await convertAudio(raw); } catch { r.skipped.push(raw.name); continue; }
    if (mode === 'audio' && currentSongId && !home.visible) {
      busyEnd();
      await applyAudioOnly(c.file);
      return;
    }
    const chart = newChart(raw.name.replace(/\.[^.]+$/, ''));
    chart.wave = c.file.name;
    const id = newId();
    await saveSong(id, { chart, courseIndex: 0 }, c.file, c.length, folder);
    added.push(id);
  }
  busyEnd();
  closeSheet();
  const skip = r.skipped.length ? `（読めなかったファイル: ${r.skipped.slice(0, 3).join('、')}${r.skipped.length > 3 ? ' ほか' : ''}）` : '';
  if (!added.length) { toast(`読み込めるファイルがありませんでした${skip}`); return; }
  toast(`${added.length} 曲を追加しました${skip}`);
  if (home.visible) await home.select(added[0]);
  else if (added.length === 1) await openSong(added[0], 'edit');
  else await home.show(added[0]);
}

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
  if (act === 'open') pickFiles('any');
  else if (act === 'audio') { srcTarget = 'editor'; openSheet('src'); }
  else if (act === 'cut') openCut();
  else if (act === 'tempo') startTempo();
  else if (act === 'new') {
    await createSong(newChart());
    closeSheet();
    toast('「読み込み・書き出し → 音源を読み込む」で曲を設定してください');
  } else if (act === 'sample') {
    await createSong(parseTJA(DEMO_TJA));
    closeSheet();
  } else if (act === 'saveTja') {
    download(new Blob([encodeSJIS(writeTJA(ed.chart)).buffer as ArrayBuffer], { type: 'text/plain' }), `${safeName(ed.chart.title)}.tja`);
  } else if (act === 'saveZip') {
    const name = safeName(ed.chart.title);
    const files: { name: string; data: Uint8Array; compress?: boolean }[] = [];
    if (ed.audio) {
      ed.chart.wave = ed.audio.name;
      files.push({ name: `${name}/${ed.audio.name}`, data: new Uint8Array(ed.audio.data) });
    }
    const tja = encodeSJIS(writeTJA(ed.chart));
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
  // 前の版で 1 曲だけ保存していた譜面は、曲の一覧に移す。一覧が空ならサンプル譜面を入れておく
  if (!(await listSongs()).length) {
    const saved = await loadChart();
    const id = newId();
    if (saved?.chart?.courses?.length) {
      const a = await loadAudio();
      await saveSong(id, { chart: saved.chart, courseIndex: saved.courseIndex }, a, a ? await audioLength(a) : 0);
    } else await saveSong(id, { chart: parseTJA(DEMO_TJA), courseIndex: 0 }, null, 0);
    await setCurrentId(id);
  }
  ed.load(newChart(), null, 0);
  view.pos = 0;
  updateHeader();
  await home.show(await getCurrentId());
}

/** 音源の長さ（秒）。再生できない形式なら 0 */
function audioLength(a: AudioFile): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([a.data]));
    const el = new Audio();
    const done = (v: number) => { URL.revokeObjectURL(url); resolve(Number.isFinite(v) ? v : 0); };
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(0);
    setTimeout(() => done(0), 4000);
    el.src = url;
  });
}

/** 一覧の曲をエディタで開く（play ならそのままテストプレイ） */
async function openSong(id: string, mode: 'edit' | 'play') {
  const data = await loadSongData(id);
  if (!data?.chart?.courses) { toast('この曲を開けませんでした'); return; }
  clearTimeout(saveTimer);
  stopPlayback();
  currentSongId = id;
  void setCurrentId(id);
  ed.load(data.chart, null, data.courseIndex);
  view.pos = 0;
  let a = await loadSongAudio(id);
  // 前の版で入れた .mp3 などは、開いたときに .ogg にしておく
  if (a && !isOgg(a.data)) {
    try {
      a = (await convertAudio(a, data.chart.title)).file;
      data.chart.wave = a.name;
      ed.chart.wave = a.name;
      await saveSong(id, { chart: ed.chart, courseIndex: ed.courseIndex }, a);
    } catch { /* そのまま使う */ }
    busyEnd();
  }
  await setAudio(a, false);
  // 長さが分からなかった曲は、開いたときに覚える
  if (audio.buffer) void persist();
  home.hide();
  updateHeader();
  if (mode === 'play') void startTest(true);
}

/** 新しい曲を一覧に作って開く */
async function createSong(chart: EChart, folder = '') {
  const id = newId();
  await saveSong(id, { chart, courseIndex: 0 }, null, 0, folder);
  await openSong(id, 'edit');
  toast('「⇅ → 音源を読み込む」で曲を設定してください');
}

const home = new Home({
  open: openSong,
  importFiles: () => { srcTarget = 'home'; openSheet('src'); },
  create: (folder) => createSong(newChart(), folder),
  settings: () => openSheet('settings'),
  toast,
});

$('btnHome').addEventListener('click', async () => {
  closeFlyMenu();
  stopPlayback();
  await persist();
  await home.show(currentSongId);
});
void boot();

// 動作確認用（URL に ?debug を付けたときだけ）
if (new URLSearchParams(location.search).has('debug')) {
  (window as unknown as { __malody: unknown }).__malody = { ed, view, play, audio, settings };
}

startAutoUpdate({
  // テストプレイ・再生中、設定や BPM 測定などの画面を開いている間、読み込み・書き出し中、文字を入力中は待つ
  // （閉じたら、待っていた更新がすぐ入る）
  canReload: () => !play.isActive && !playing && !sheet && !typing() && $('busy').classList.contains('hidden'),
  beforeReload: async () => {
    if (currentSongId) await persist();
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
        <h3>進み方の基準</h3>
        ${seg('basis', [['time', '秒数'], ['count', '個数']], g.basis ?? 'count')}
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
      else if (key === 'basis') g.basis = v as Grad['basis'];
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
  /** 測り直すときに小節の頭にする時刻（秒） */
  anchors: number[];
  /** 波形をタップして置くカーソル（秒、拍の位置。-1 は無し） */
  cursor: number;
  /** 区間ごとに手で決めた拍子（null は自動） */
  meterSel: (Meter | null)[];
  /** 手で直した案（区間を分ける・動かす・消す・BPM を書き換えたら、ここに測った案を写して直していく。null は測ったまま） */
  plan: TempoPlan | null;
  /** 元に戻す・やり直す */
  undo: string[]; redo: string[];
  /** 選んでいる区間 */
  sel: number;
  /** 波形の上の 1 本指の操作（移動・拍の線・分ける） */
  tool: TempoTool;
} = {
  running: false, progress: 0, result: null, error: '', mul: [], shift: 0, fine: 0, viewAt: 0, span: 2,
  anchors: [], cursor: -1, meterSel: [], plan: null, undo: [], redo: [], sel: 0, tool: 'hand',
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
  // 値の箱をドラッグしている間は、最初の 1 回だけ覚える
  if (tempoBatch > 0) {
    if (tempoBatchPushed) return;
    tempoBatchPushed = true;
  }
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
  updateTempoLcd();
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
  const keep = again ? { viewAt: tempoState.viewAt, span: tempoState.span } : { viewAt: -1, span: 2, anchors: [], meterSel: [] };
  Object.assign(tempoState, { running: true, progress: 0, result: null, error: '', mul: [], shift: 0, fine: 0, plan: null, undo: [], redo: [], sel: 0, cursor: -1, ...keep });
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
  // 淡い青（--accent の色相）でそろえ、BPM ごとに色相と濃さを少しずつ変えて見分ける
  const k = ((Math.log2(bpm / 60) * 2.3) % 1 + 1) % 1;
  return `hsla(${(180 + k * 40).toFixed(0)}, ${(32 + k * 14).toFixed(0)}%, ${(30 + k * 18).toFixed(0)}%, ${alpha})`;
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

/** その時刻にいちばん近い拍の時刻 */
function nearestBeat(p: TempoPlan, t: number): number {
  const tick = tickAtTime(p, TPB, t);
  const sec = editSections(p)[sectionAtTime(p, TPB, t)];
  return planTimeAt(p, TPB, sec.s + Math.round((tick - sec.s) / TPB) * TPB);
}

/** 波形の上のルーラー（小節の番号）の高さ */
const T_RULER = 22;
/** 置く・動かすツール（FL Studio Mobile のように、左の列で選ぶ） */
type TempoTool = 'hand' | 'slide' | 'split';
const TEMPO_TOOLS: [TempoTool, string, string][] = [
  ['hand', '移動', '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 11V6.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6 7-2.6 0-4.2-1.4-5.6-3.6L3.6 14.6a1.5 1.5 0 0 1 2.5-1.6L8 15.5"/>'],
  ['slide', '拍の線', '<path d="M4 4v16M10 4v16M16 4v16"/><path d="m18 9 3 3-3 3"/><path d="M13 12h8"/>'],
  ['split', '分ける', '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>'],
];
const ic = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const IC = {
  close: ic('<path d="M6 6l12 12M18 6 6 18"/>'),
  undo: ic('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: ic('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  play: ic('<path d="M7 4.5v15l12.5-7.5z" class="fill"/>'),
  stop: ic('<rect x="6" y="6" width="12" height="12" class="fill"/>'),
  home: ic('<path d="M6 5v14"/><path d="M19 5v14L9 12z" class="fill"/>'),
  plus: ic('<path d="M12 5v14M5 12h14"/>'),
  minus: ic('<path d="M5 12h14"/>'),
  fit: ic('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  ok: ic('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
};

/** 上のバーの表示（カーソルまたは再生中の位置: 小節 : 拍 と、時刻） */
function updateTempoLcd() {
  const st = tempoState;
  const pos = document.getElementById('tempoLcdPos');
  const p = curTempoPlan();
  if (!pos || !p) return;
  const at = tempoPreview.on ? audio.now() : st.cursor >= 0 ? st.cursor : -1;
  pos.textContent = at >= 0 ? tempoBarLabel(p, Math.round(tickAtTime(p, TPB, at))).replace('小節 ', '').replace(' 拍 ', ' : ') : '—';
  $('tempoLcdTime').textContent = at >= 0 ? fmtSec(at) : 'カーソルなし';
}

/** 区間の BPM を変えるドラッグ・tap 入力・‹ › を、元に戻すの記録 1 回にまとめる */
let tempoBatch = 0;
let tempoBatchPushed = false;

function renderTempoSheet(body: HTMLElement) {
  $('sheetTitle').textContent = 'BPM・OFFSET';
  const st = tempoState;
  const bindCancel = () => body.querySelectorAll<HTMLButtonElement>('[data-tact]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.tact === 'ok') {
      const p = curTempoPlan()!;
      ed.applyTempo(p);
      toast(`BPM ${p.bpm}・OFFSET ${p.offset.toFixed(3)} を入れました`);
    }
    closeSheet();
  }));
  if (st.running || st.error || !st.result || !curTempoPlan()) {
    const msg = st.running ? '曲全体を調べています…' : st.error ? `測れませんでした: ${st.error}` : '拍が見つかりませんでした';
    body.innerHTML = `<div class="daw">
      <header class="daw-top"><button class="daw-ic" data-tact="cancel" aria-label="閉じる">${IC.close}</button><b class="daw-title">BPM・OFFSET</b></header>
      <div class="daw-wait"><p>${msg}</p>${st.running ? `<div class="tempo-progress"><i id="tempoBar" style="width:${Math.round(st.progress * 100)}%"></i></div>` : ''}</div>
    </div>`;
    bindCancel();
    return;
  }
  const r = st.result;
  const plan0 = curTempoPlan()!;
  // 波形の最初の表示: 最初の 1 拍目のあたり
  if (st.viewAt < 0) st.viewAt = Math.max(0, -plan0.offset + st.span * 0.3);
  const secs = editSections(plan0);
  st.sel = Math.max(0, Math.min(secs.length - 1, st.sel));
  const raw = tempoRaw();
  const sec = secs[st.sel];
  const fmtB = (b: number) => String(Number(b.toFixed(3)));
  const meterSel = raw
    ? `<select data-tmeter aria-label="拍子">${meterOptions(r.meterAuto?.[st.sel], st.meterSel[st.sel] ?? null)}</select>`
    : `<select data-tmeter aria-label="拍子">${meterOptions(undefined, meterAtTick(plan0, Math.max(0, sec.s)), false)}</select>`;
  const firstBar = (() => {
    // 音源の頭以降で最初の小節の頭（この拍から測り直す所）
    const bars = planBars(plan0, TPB, Math.max(0, ...plan0.changes.map((c) => c.tick)) + 64 * TPB);
    for (const b of bars) { const t = planTimeAt(plan0, TPB, b.tick); if (t >= -0.02) return { t: Math.max(0, t), n: b.n }; }
    return { t: 0, n: 1 };
  })();
  const playing = tempoPreview.row !== -1;
  body.innerHTML = `<div class="daw">
    <header class="daw-top">
      <button class="daw-ic" data-tact="cancel" aria-label="やめる">${IC.close}</button>
      <b class="daw-title">BPM・OFFSET</b>
      <button class="daw-ic" data-tundo aria-label="元に戻す" ${st.undo.length ? '' : 'disabled'}>${IC.undo}</button>
      <button class="daw-ic" data-tredo aria-label="やり直す" ${st.redo.length ? '' : 'disabled'}>${IC.redo}</button>
      <span class="daw-sep"></span>
      <button class="daw-ic" data-thome aria-label="区間の頭へ">${IC.home}</button>
      <button class="daw-ic daw-play ${playing ? 'on' : ''}" data-tplayhere aria-label="${playing ? '止める' : 'カーソルから再生'}">${playing ? IC.stop : IC.play}</button>
      <div class="daw-lcd"><b id="tempoLcdPos"></b><small id="tempoLcdTime"></small></div>
      ${st.plan ? '<span class="tempo-tag">手で直した案</span>' : ''}
      <span class="daw-sp"></span>
      <button class="daw-btn" data-tremeasure title="今の 1 拍目を小節の頭にして、曲全体を測り直す">測り直す</button>
      <button class="daw-ok" data-tact="ok">${IC.ok}<span>入れる</span></button>
    </header>
    <div class="daw-main">
      <nav class="daw-tools">
        ${TEMPO_TOOLS.map(([k, label, d]) => `<button data-ttool="${k}" class="${st.tool === k ? 'on' : ''}">${ic(d)}<small>${label}</small></button>`).join('')}
        <span class="daw-sp"></span>
        <button data-tzoom="0.5" aria-label="拡大">${IC.plus}</button>
        <button data-tzoom="2" aria-label="縮小">${IC.minus}</button>
      </nav>
      <div class="daw-stage">
        <canvas id="tempoOverview" class="daw-ov"></canvas>
        <canvas id="tempoWave" class="daw-wave"></canvas>
      </div>
    </div>
    <footer class="daw-insp" style="--c:${tempoColor(sec.bpm)}">
      ${valueBoxHtml('sec', '区間', { cls: 'dv-sec' })}
      ${valueBoxHtml('bpm', 'BPM', { cls: 'dv-big', extra: '<div class="dv-x"><button data-tmul="0.5">÷2</button><button data-tmul="2">×2</button></div>' })}
      <div class="dv"><span class="dv-l">拍子</span>${meterSel}</div>
      ${valueBoxHtml('start', '始まり')}
      ${valueBoxHtml('end', '終わり')}
      <span class="daw-vsep"></span>
      ${valueBoxHtml('fine', '拍の線')}
      ${valueBoxHtml('shift', '1 拍目')}
      <span class="daw-vsep"></span>
      <div class="daw-acts">
        <button data-tsplit ${st.cursor >= 0 ? '' : 'disabled'}>✂ カーソルで分ける</button>
        <button data-tfrom ${st.cursor >= 0 && st.sel > 0 ? '' : 'disabled'}>⇤ ここから</button>
        <button data-tto ${st.cursor >= 0 && st.sel + 1 < secs.length ? '' : 'disabled'}>ここまで ⇥</button>
        <button data-tplay class="${tempoPreview.row === st.sel ? 'on' : ''}">${tempoPreview.row === st.sel ? '■ 止める' : '▶ 区間を再生'}</button>
        <button data-tdel class="bad" ${secs.length > 1 ? '' : 'disabled'}>消す</button>
      </div>
    </footer>
  </div>`;
  bindCancel();
  const rerender = () => renderTempoSheet(body);
  const cv = body.querySelector<HTMLCanvasElement>('#tempoWave')!;
  const W = () => Math.max(1, cv.clientWidth);
  const lcd = updateTempoLcd;
  let refreshBoxes = () => {};
  const update = () => {
    const p = curTempoPlan()!;
    drawTempoWave(p, tempoPreview.on ? audio.now() : -1);
    drawTempoOverview(p, tempoPreview.on ? audio.now() : -1);
    lcd();
    refreshBoxes();
  };
  const selectAt = (t: number) => { st.sel = sectionAtTime(curTempoPlan()!, TPB, t); };
  const clampView = () => { st.viewAt = Math.max(-st.span * 0.4, Math.min(r.duration + st.span * 0.4, st.viewAt)); };

  // ---- 曲全体の帯: タップで区間を選ぶ・境目をドラッグ・帯をドラッグで表示する所を動かす ----
  const ov = body.querySelector<HTMLCanvasElement>('#tempoOverview')!;
  const ovTime = (x: number) => Math.max(0, Math.min(r.duration, (x / Math.max(1, ov.clientWidth)) * r.duration));
  bindTempoDrag(ov, ovTime, () => (r.duration / Math.max(1, ov.clientWidth)) * 10, {
    tap: (t) => {
      selectAt(t);
      if (!tempoPreview.on) st.viewAt = t;
      rerender();
    },
    pan: (t) => { if (!tempoPreview.on) { st.viewAt = t; update(); } },
    after: rerender,
  });

  // ---- 波形: ルーラーでカーソル・境目のドラッグ・ツールごとの操作・2 本指でピンチ ----
  const cvTime = (x: number) => st.viewAt - st.span / 2 + (x / W()) * st.span;
  const tapAt = (t: number) => {
    const p = curTempoPlan()!;
    if (st.tool === 'split') {
      const res = splitAt(p, TPB, nearestBeat(p, t));
      if (!res) toast('区間の頭では分けられません');
      else tempoEditPlan(() => res.plan, res.index);
      rerender();
      return;
    }
    const now = performance.now();
    if (now - tempoLastTap.at < 400 && Math.abs(t - tempoLastTap.t) < st.span * 0.03) {
      // ダブルタップ: そこから新しい区間
      tempoLastTap = { at: 0, t: 0 };
      const res = splitAt(p, TPB, t);
      if (res) tempoEditPlan(() => res.plan, res.index);
      rerender();
      return;
    }
    tempoLastTap = { at: now, t };
    st.cursor = Math.max(0, Math.min(r.duration, nearestBeat(p, t)));
    selectAt(st.cursor);
    rerender();
  };
  bindTimeline(cv, {
    single: (x, y) => {
      const p = curTempoPlan()!;
      const t = cvTime(x);
      if (y < T_RULER) {
        // ルーラー: なぞってカーソルを拍に合わせて動かす
        const set = (xx: number) => {
          const q = curTempoPlan()!;
          st.cursor = Math.max(0, Math.min(r.duration, nearestBeat(q, cvTime(xx))));
          selectAt(st.cursor);
          update();
        };
        set(x);
        return { move: (xx) => set(xx), end: () => rerender() };
      }
      // 境目（区間の頭）の近く: どのツールでも境目を動かす
      let k = -1;
      let best = (st.span / W()) * 14;
      editSections(p).forEach((s, i) => {
        if (i === 0) return;
        const d = Math.abs(planTimeAt(p, TPB, s.s) - t);
        if (d < best) { best = d; k = i; }
      });
      if (k > 0) {
        const base = p;
        let pushed = false;
        return {
          move: (xx) => {
            const prev = editSections(base)[k - 1];
            const tp = planTimeAt(base, TPB, prev.s);
            const to = prev.s + ((cvTime(xx) - tp) * prev.bpm * TPB) / 60;
            const q = moveBoundary(base, TPB, k, to);
            if (JSON.stringify(q) !== JSON.stringify(curTempoPlan())) {
              if (!pushed) { tempoPush(); pushed = true; }
              st.plan = q;
              st.sel = k;
              update();
            }
          },
          end: (moved) => { if (moved) rerender(); else tapAt(t); },
        };
      }
      if (st.tool === 'slide') {
        // 拍の線ツール: 横にドラッグで拍の線を動かす
        let s0: { plan: TempoPlan | null; fine: number } | null = null;
        return {
          move: (_xx, _yy, dx) => {
            if (!s0) { tempoPush(); s0 = { plan: st.plan ? curTempoPlan() : null, fine: st.fine }; }
            const d = Math.round(((dx / W()) * st.span) * 1000) / 1000;
            if (s0.plan) st.plan = nudge(s0.plan, d);
            st.fine = Math.round((s0.fine + d) * 1000) / 1000;
            update();
          },
          end: (moved) => { if (moved) rerender(); else tapAt(t); },
        };
      }
      // 移動・分けるツール: ドラッグで表示する所を動かす、タップは各ツールの操作
      const v0 = st.viewAt;
      return {
        move: (_xx, _yy, dx) => {
          if (tempoPreview.on) return;
          st.viewAt = v0 - (dx / W()) * st.span;
          clampView();
          update();
        },
        end: (moved) => { if (!moved) tapAt(t); },
      };
    },
    pan: (dx) => {
      if (tempoPreview.on) return;
      st.viewAt -= (dx / W()) * st.span;
      clampView();
      update();
    },
    zoom: (k, x) => {
      const tx = cvTime(x);
      st.span = Math.min(64, Math.max(0.25, st.span * k));
      if (!tempoPreview.on) st.viewAt = tx - (x / W() - 0.5) * st.span;
      clampView();
      update();
    },
  });

  // ---- 値の箱（上下にドラッグ・‹ ›・タップで入力） ----
  const curSec = () => editSections(curTempoPlan()!)[st.sel];
  const goSec = (i: number) => {
    const p = curTempoPlan()!;
    const ss = editSections(p);
    st.sel = Math.max(0, Math.min(ss.length - 1, i));
    const t = st.sel === 0 ? Math.max(0, -p.offset) : planTimeAt(p, TPB, ss[st.sel].s);
    if (!tempoPreview.on) st.viewAt = t + st.span * 0.3;
  };
  // BPM を書き換える（区間の長さはそのままで、後ろの区間の時刻は変わらない）
  const setSelBpm = (b: number) => {
    if (!(b >= 10 && b <= 2000)) { toast('BPM は 10〜2000 で入れてください'); return; }
    tempoEditPlan((p) => setBpm(p, TPB, st.sel, b));
  };
  const stepTick = (tick: number, dir: number) => tick + dir * TPB;
  const box = (k: string) => body.querySelector<HTMLElement>(`[data-dv="${k}"]`)!;
  const nudgeFine = (d: number) => {
    // 手で直した案では案の OFFSET を動かし、表示用に動かした量も数えておく
    if (st.plan) tempoEditPlan((p) => nudge(p, d));
    else tempoPush();
    st.fine = Math.round((st.fine + d) * 1000) / 1000;
  };
  refreshBoxes = bindValueBoxes(body, {
    sec: {
      get: () => `${st.sel + 1}/${editSections(curTempoPlan()!).length}`,
      step: (n) => goSec(st.sel + n),
      px: 28,
    },
    bpm: {
      get: () => fmtB(curSec().bpm),
      step: (n) => {
        const cur = curSec().bpm;
        // 小数の BPM は、まず整数にそろえる
        const base = cur !== Math.round(cur) ? (n > 0 ? Math.ceil(cur) - 1 : Math.floor(cur) + 1) : cur;
        setSelBpm(base + n);
      },
      px: 9,
      tap: () => inlineInput(box('bpm'), fmtB(curSec().bpm), (v) => { setSelBpm(Number(v)); rerender(); }),
    },
    start: {
      get: () => (st.sel === 0 ? '曲の頭' : tempoBarLabel(curTempoPlan()!, curSec().s).replace('小節 ', '').replace(' 拍 ', ' : ')),
      disabled: () => st.sel === 0,
      step: (n) => {
        for (let k = 0; k < Math.abs(n); k++) {
          const i = st.sel;
          tempoEditPlan((p) => {
            const q = setStart(p, TPB, i, stepTick(editSections(p)[i].s, Math.sign(n)));
            // またいで区間が減ったら、選ぶ区間も前へ
            st.sel = Math.min(i, editSections(q).length - 1) - (editSections(p).length - editSections(q).length);
            return q;
          });
        }
      },
      px: 16,
    },
    end: {
      get: () => (curSec().e === Infinity ? '最後' : tempoBarLabel(curTempoPlan()!, curSec().e).replace('小節 ', '').replace(' 拍 ', ' : ')),
      disabled: () => curSec().e === Infinity,
      step: (n) => {
        for (let k = 0; k < Math.abs(n); k++) {
          const i = st.sel;
          tempoEditPlan((p) => { const e = editSections(p)[i].e; return e === Infinity ? null : setEnd(p, TPB, i, stepTick(e, Math.sign(n))); });
        }
      },
      px: 16,
    },
    fine: {
      get: () => { const fm = Math.round(st.fine * 1000); return `${fm >= 0 ? '+' : ''}${fm}ms`; },
      step: (n) => nudgeFine(n * 0.001),
      px: 5,
      tap: () => inlineInput(box('fine'), String(Math.round(st.fine * 1000)), (v) => {
        const ms = Number(v.replace(/ms$/i, ''));
        if (Number.isFinite(ms)) nudgeFine(ms / 1000 - st.fine);
        rerender();
      }),
    },
    shift: {
      get: () => curTempoPlan()!.offset.toFixed(3),
      step: (n) => {
        if (st.plan) tempoEditPlan((p) => shiftDownbeat(p, TPB, n));
        else { tempoPush(); st.shift += n; }
        // 動かした 1 拍目（赤い線）が見えるところへ
        if (!tempoPreview.on) st.viewAt = -curTempoPlan()!.offset + st.span * 0.3;
      },
      px: 26,
    },
  }, {
    begin: () => { tempoBatch++; if (tempoBatch === 1) tempoBatchPushed = false; },
    end: () => { tempoBatch = Math.max(0, tempoBatch - 1); },
    changed: () => update(),
  });
  update();
  // 箱の ‹ › はその場で描き直す。ドラッグが終わったら、ボタンの使える・使えないも直すため作り直す
  body.querySelectorAll<HTMLElement>('[data-dvs]').forEach((b) => b.addEventListener('click', rerender));
  body.querySelectorAll<HTMLElement>('[data-dvv]').forEach((v) => v.addEventListener('pointerup', () => setTimeout(() => { if (!body.querySelector('.dv-in')) rerender(); }, 0)));

  const on = (sel: string, fn: (b: HTMLElement) => void) => body.querySelectorAll<HTMLElement>(sel).forEach((b) => b.addEventListener('click', () => { fn(b); rerender(); }));
  on('[data-ttool]', (b) => { st.tool = b.dataset.ttool as TempoTool; });
  on('[data-tundo]', () => {
    const s = st.undo.pop();
    if (!s) return;
    st.redo.push(tempoSnap());
    tempoRestore(s);
  });
  on('[data-tredo]', () => {
    const s = st.redo.pop();
    if (!s) return;
    st.undo.push(tempoSnap());
    tempoRestore(s);
  });
  on('[data-thome]', () => {
    const p = curTempoPlan()!;
    const s = editSections(p)[st.sel];
    st.cursor = Math.max(0, st.sel === 0 ? Math.max(0, -p.offset) : planTimeAt(p, TPB, s.s));
    if (!tempoPreview.on) st.viewAt = st.cursor + st.span * 0.3;
  });
  on('[data-tsplit]', () => {
    if (st.cursor < 0) return;
    const res = splitAt(curTempoPlan()!, TPB, st.cursor);
    if (!res) toast('区間の頭では分けられません');
    else tempoEditPlan(() => res.plan, res.index);
  });
  const curTick = () => Math.round(tickAtTime(curTempoPlan()!, TPB, st.cursor));
  on('[data-tfrom]', () => { if (st.cursor >= 0) tempoEditPlan((p) => setStart(p, TPB, st.sel, curTick())); });
  on('[data-tto]', () => { if (st.cursor >= 0) tempoEditPlan((p) => setEnd(p, TPB, st.sel, curTick())); });
  on('[data-tmul]', (b) => {
    const m = Number(b.dataset.tmul);
    if (tempoRaw()) {
      // 測ったままなら、測った結果の側で倍・半分にする（拍子も合わせて変わる）
      tempoPush();
      st.mul[st.sel] = Math.min(4, Math.max(0.25, st.mul[st.sel] * m));
    } else {
      const cur = editSections(curTempoPlan()!)[st.sel].bpm;
      tempoEditPlan((q) => setBpm(q, TPB, st.sel, cur * m));
    }
  });
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
  on('[data-tdel]', () => {
    const i = st.sel;
    tempoEditPlan((p) => removeSection(p, TPB, i), Math.max(0, i - 1));
  });
  body.querySelectorAll<HTMLButtonElement>('[data-tzoom]').forEach((b) => b.addEventListener('click', () => {
    st.span = Math.min(64, Math.max(0.25, st.span * Number(b.dataset.tzoom)));
    update();
  }));
  // 今の 1 拍目（OFFSET の所。音源の頭より前なら、その次の小節の頭）を小節の頭として測り直す
  body.querySelector('[data-tremeasure]')?.addEventListener('click', () => {
    st.anchors = [firstBar.t];
    startTempo(true);
  });
  on('[data-tplayhere]', () => {
    if (tempoPreview.row !== -1) stopTempoPreview();
    else void startTempoPreview(-2, st.cursor >= 0 ? st.cursor : Math.max(0, st.viewAt - st.span / 2));
  });
  on('[data-tplay]', () => {
    if (tempoPreview.row === st.sel) stopTempoPreview();
    else {
      const p = curTempoPlan()!;
      const s = editSections(p)[st.sel];
      void startTempoPreview(st.sel, Math.max(0, (st.sel === 0 ? 0 : planTimeAt(p, TPB, s.s)) - 1));
    }
  });
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
    if (p) {
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
  ctx.fillStyle = '#1d2023';
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
    ctx.strokeStyle = '#ffffff';
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
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.strokeRect(v0, 1, Math.max(3, v1 - v0), H - 2);
  if (playhead >= 0) {
    ctx.fillStyle = '#93cde2';
    ctx.fillRect(xOf(playhead) - 1, 0, 2, H);
  }
}

/** 確認画面の波形: 上にルーラー（小節の番号）、音の波形の上に案の拍の線（小節の頭は太い線、最初の 1 拍目は水色）と、BPM の変わり目の旗 */
function drawTempoWave(plan: TempoPlan, playhead = -1) {
  const cv = document.getElementById('tempoWave') as HTMLCanvasElement | null;
  const buf = audio.buffer;
  if (!cv || !buf) return;
  const st = tempoState;
  const { ctx, W, H: HH } = fitCanvas(cv);
  ctx.fillStyle = '#1d2023';
  ctx.fillRect(0, 0, W, HH);
  const t0 = st.viewAt - st.span / 2;
  const t1 = st.viewAt + st.span / 2;
  const xOf = (t: number) => ((t - t0) / st.span) * W;
  const beats = planBeatTimes(plan, TPB, t1 + 1);
  // ルーラー: 拍の目盛りと小節の番号（詰まるときは間引く）
  let lastLabel = -1e9;
  const marks: { x: number; major: boolean; label?: string }[] = [];
  for (const b of beats) {
    if (b.t < t0 - 0.01 || b.t > t1 + 0.01) continue;
    const x = xOf(b.t);
    const m: { x: number; major: boolean; label?: string } = { x, major: b.bar };
    if (b.bar && x - lastLabel >= 30) { m.label = String(b.n); lastLabel = x; }
    marks.push(m);
  }
  drawRuler(ctx, W, T_RULER, marks);
  ctx.save();
  ctx.translate(0, T_RULER);
  const H = HH - T_RULER;
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  // 選んでいる区間を薄く塗る
  const secs = editSections(plan);
  const sel = secs[st.sel];
  if (sel) {
    const a = st.sel === 0 ? 0 : planTimeAt(plan, TPB, sel.s);
    const b = sel.e === Infinity ? (st.result?.duration ?? t1) : planTimeAt(plan, TPB, sel.e);
    ctx.fillStyle = 'rgba(77,159,190,0.16)';
    ctx.fillRect(xOf(a), 0, xOf(b) - xOf(a), H);
  }
  // 波形（1 px ごとの最大・最小）
  const sr = buf.sampleRate;
  const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  ctx.fillStyle = '#5b8fa3';
  const mid = H / 2 + 10;
  const amp = H / 2 - 14;
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
  beats.forEach((b, k) => {
    if (b.t < t0 - 0.01 || b.t > t1 + 0.01) return;
    const x = xOf(b.t);
    ctx.fillStyle = k === 0 ? '#93cde2' : b.bar ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)';
    ctx.fillRect(x - (b.bar ? 1 : 0.5), 0, b.bar ? 2 : 1, H);
  });
  // BPM の変わり目の旗（選んでいる区間は白）
  ctx.font = '800 13px system-ui, sans-serif';
  secs.forEach((s, i) => {
    const t = planTimeAt(plan, TPB, s.s);
    const label = String(Number(s.bpm.toFixed(3)));
    const w = ctx.measureText(label).width + 12;
    if (i === 0 && t < t0) {
      // 最初の区間の旗は、画面の左端に小さく
      if (t0 < (secs[1] ? planTimeAt(plan, TPB, secs[1].s) : Infinity)) {
        ctx.fillStyle = i === st.sel ? '#ffffff' : tempoColor(s.bpm);
        ctx.globalAlpha = 0.9;
        ctx.fillRect(0, 0, w, 20);
        ctx.globalAlpha = 1;
        ctx.fillStyle = i === st.sel ? '#111' : '#fff';
        ctx.fillText(label, 6, 15);
      }
      return;
    }
    if (t < t0 - 1 || t > t1) return;
    const x = xOf(t);
    ctx.fillStyle = i === st.sel ? '#ffffff' : tempoColor(s.bpm);
    ctx.fillRect(x - 1.5, 0, 3, H);
    ctx.fillRect(x, 0, w, 20);
    // つまみ（下の端）
    ctx.fillRect(x - 6, H - 16, 12, 16);
    ctx.fillStyle = i === st.sel ? '#111' : '#fff';
    ctx.fillText(label, x + 6, 15);
  });
  // 音源の頭（0 秒）より前
  if (t0 < 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, xOf(0), H);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText(fmtSec(Math.max(0, t0)), 4, H - 5);
  ctx.restore();
  // カーソル（止まっている間は黄色の再生位置。再生中は点線で残す）
  if (st.cursor >= t0 && st.cursor <= t1) {
    const x = xOf(st.cursor);
    if (playhead < 0) drawPlayhead(ctx, x, HH, T_RULER);
    else {
      ctx.strokeStyle = 'rgba(255,201,77,0.6)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, T_RULER);
      ctx.lineTo(x, HH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // 確認再生中の今の位置
  if (playhead >= t0 && playhead <= t1) drawPlayhead(ctx, xOf(playhead), HH, T_RULER);
}

// ---------- 読み込み（ファイルから / リンクから） ----------

/** 読み込みの画面を出した所（曲選択なら新しい曲、エディタなら今の曲の音源） */
let srcTarget: 'home' | 'editor' = 'home';

function renderSrcSheet(body: HTMLElement) {
  const home_ = srcTarget === 'home';
  $('sheetTitle').textContent = home_ ? '読み込み' : '音源を読み込む';
  body.innerHTML = `
    <div class="src-pick">
      <button data-src="file"><b>ファイルから</b><small>${home_ ? '.tja・.zip・音源（何でも、いくつでも）' : '音源ファイル（.ogg に自動で変換）'}</small></button>
      <button data-src="link"><b>リンクから</b><small>YouTube・SoundCloud などのリンク</small></button>
    </div>`;
  body.querySelector('[data-src="file"]')!.addEventListener('click', () => pickFiles(home_ ? 'any' : 'audio'));
  body.querySelector('[data-src="link"]')!.addEventListener('click', () => openSheet('link'));
}

/** リンクから取り込み中の様子（画面を閉じても続く） */
let linkBusy = '';

function renderLinkSheet(body: HTMLElement) {
  $('sheetTitle').textContent = 'リンクから音源を読み込む';
  const ready = linkReady();
  body.innerHTML = `
    <label class="field"><span>リンク</span><input type="url" id="linkUrl" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off"></label>
    <div class="btns"><button data-act="linkGo" class="primary" ${!linkBusy ? '' : 'disabled'}>取り込む</button><button data-act="linkPaste">貼り付け</button></div>
    <p class="note" id="linkStatus">${linkBusy || (ready ? '' : 'まず下の「はじめに準備」をしてください')}</p>
    <details class="link-setup" ${ready ? '' : 'open'}>
      <summary>${ready ? '準備できています（変えるときはここ）' : 'はじめに準備（1 回だけ）'}</summary>
      <p class="note"><b>引き継ぎリンク</b>をもらった人は、そのリンクを開くだけで準備が終わります（ここは触らなくて大丈夫）。</p>
      <p class="note">自分で入れるときは、下の 2 つを入れて「保存」を押してください。</p>
      <label class="field"><span>中継役 URL</span><input type="url" id="linkRelay" value="${esc(settings.linkRelay)}" placeholder="https://tjacs-relay.○○.workers.dev" autocomplete="off"></label>
      <label class="field"><span>合言葉</span><input type="password" id="linkPass" value="${esc(settings.linkPass)}" autocomplete="off"></label>
      <div class="btns"><button data-act="relaySave" class="primary">保存</button><button data-act="relayClear">消す</button></div>
      <button data-act="relayShare" ${settings.linkRelay ? '' : 'disabled'}>別のスマホ・友だち用の引き継ぎリンクをコピー</button>
      <p class="note">引き継ぎリンクには合言葉が入っています。使ってほしい人にだけ送ってください。</p>
    </details>`;
  const status = (m: string) => { const el = document.getElementById('linkStatus'); if (el) el.textContent = m; };
  body.querySelector('[data-act="relaySave"]')!.addEventListener('click', async () => {
    const relay = ($<HTMLInputElement>('linkRelay').value || '').trim().replace(/\/+$/, '');
    const pass = ($<HTMLInputElement>('linkPass').value || '').trim();
    if (!/^https:\/\//.test(relay)) { status('中継役の URL（https://…）を入れてください'); return; }
    status('確かめています…');
    const err = await testSetup({ repo: '', token: '', relay, pass });
    if (err) { status(err); return; }
    settings.linkRelay = relay;
    settings.linkPass = pass;
    saveSettings();
    toast('準備ができました');
    renderLinkSheet(body);
  });
  body.querySelector('[data-act="relayShare"]')!.addEventListener('click', async () => {
    const u = `${location.origin}${location.pathname}#${new URLSearchParams({ relay: settings.linkRelay, pass: settings.linkPass })}`;
    try { await navigator.clipboard.writeText(u); toast('引き継ぎリンクをコピーしました'); } catch { prompt('このリンクをコピーしてください', u); }
  });
  body.querySelector('[data-act="relayClear"]')!.addEventListener('click', () => {
    settings.linkRelay = '';
    settings.linkPass = '';
    saveSettings();
    renderLinkSheet(body);
  });
  body.querySelector('[data-act="linkPaste"]')?.addEventListener('click', async () => {
    try { $<HTMLInputElement>('linkUrl').value = (await navigator.clipboard.readText()).trim(); } catch { toast('貼り付けできませんでした'); }
  });
  body.querySelector('[data-act="linkGo"]')?.addEventListener('click', () => {
    const url = $<HTMLInputElement>('linkUrl').value.trim();
    if (!/^https?:\/\//.test(url)) { status('リンク（https://…）を入れてください'); return; }
    void importLink(url, srcTarget);
    renderLinkSheet(body);
  });
}

async function importLink(url: string, target: 'home' | 'editor') {
  const ready = linkReady();
  const show = (m: string) => {
    linkBusy = m;
    const el = document.getElementById('linkStatus');
    if (el) el.textContent = m;
  };
  try {
    // YouTube: まず GitHub（クッキーを登録していれば使う）、だめなら公開サーバー（Piped・Invidious）
    let res: LinkResult;
    if (!ready) {
      if (!youtubeId(url)) throw new Error('先に「はじめに準備」をしてください');
      res = await fetchYoutubePublic(url, show);
    } else {
      try {
        res = await fetchLink(linkSetup(), url, show);
      } catch (e) {
        if (!youtubeId(url)) throw e;
        res = await fetchYoutubePublic(url, show);
      }
    }
    show('');
    const c = await convertAudio(res.audio, res.title);
    busyEnd();
    if (target === 'editor' && currentSongId && !home.visible) {
      await applyAudioOnly(c.file);
    } else {
      const chart = newChart(res.title);
      if (res.artist) chart.subtitle = `--${res.artist}`;
      chart.wave = c.file.name;
      const id = newId();
      await saveSong(id, { chart, courseIndex: 0 }, c.file, c.length, home.visible ? home.currentFolder : '');
      toast(`「${res.title}」を追加しました`);
      if (home.visible) await home.select(id);
    }
    if (sheet === 'link') closeSheet();
  } catch (err) {
    busyEnd();
    show('');
    const m = (err as Error).message;
    toast(m);
    const el = document.getElementById('linkStatus');
    if (el) el.textContent = m;
  } finally {
    linkBusy = '';
    if (sheet === 'link') document.querySelector<HTMLButtonElement>('[data-act="linkGo"]')?.removeAttribute('disabled');
  }
}

// ---------- 音源の切り貼り ----------
// FL Studio Mobile のプレイリストのように、音源をクリップにして並べる。トラックを足して重ねられ、別の音源も足せる。
// 画面の横のスクロールは上の小節のバー（ルーラー）をドラッグ（再生中も勝手には動かさない）。縦はトラックの空き所をドラッグ。
// ルーラーをタップすると切り取りのマーク（黄色）がそこへ、マークを長押ししてから動かしても動く。
// マークを下へドラッグして、切りたいトラックの上で離すと、そこでクリップを切る。
// マーク・クリップの移動・端・音量の点はグリッドに合わせる。2 本指で横に拡大・縮小、縦に開くとトラックの高さ。
// 小節は譜面の 1 小節目を 1 として、その前は 0・-1…。「反映」で並べた音を .ogg にし、1 小節目の所に OFFSET を合わせる

/** グリッド: -1 = 小節の頭、0 = なし、n = 1 小節（4/4）を n 分割（エディタのグリッドと同じ数え方） */
const ARR_GRIDS = [-1, 2, 4, 8, 16, 32, 0];
const arrGridLabel = (g: number) => (g === -1 ? '小節' : g === 0 ? 'なし' : `1/${g}`);
type ArrTool = 'move' | 'auto';
/** 音源（0 = 譜面の音源、ほかは足した音源） */
interface ArrSource { name: string; buf: AudioBuffer }
let arrSources: ArrSource[] = [];
const arrState = {
  clips: [] as Clip[],
  /** トラックの数 */
  tracks: 1,
  /** 選んでいるクリップ（-1 は無し） */
  sel: -1,
  /** 譜面の音源の長さ */
  dur: 0,
  viewAt: 0,
  span: 1,
  /** 縦のスクロール（px） */
  vscroll: 0,
  /** トラックの高さの倍率（1 = 画面に収まる高さ） */
  vz: 1,
  /** 切り取りのマーク（再生もここから） */
  play: 0,
  /** グリッド（初めて開いたときはエディタのグリッド） */
  grid: NaN,
  tool: 'move' as ArrTool,
  gridMenu: false,
  /** マークを長押しして掴んでいるか（表示用） */
  markHold: false,
  /** マークを下へドラッグ中（離すと切る）。その指の y（キャンバスの中）。-1 は無し */
  cutDrag: -1,
  undo: [] as string[],
  redo: [] as string[],
};
/** 確認再生（並べた音を作って鳴らす。until 秒で止める） */
const arrPlay = { on: false, until: 0 };
let arrCache: { key: string; buf: AudioBuffer } | null = null;

function openCut() {
  const buf = audio.buffer;
  if (!buf) { toast('先に音源を読み込んでください'); return; }
  const d = Math.round(buf.duration * 1000) / 1000;
  if (Number.isNaN(arrState.grid)) arrState.grid = [2, 4, 8, 16, 32].includes(ed.divisor) ? ed.divisor : 4;
  arrSources = [{ name: ed.audio?.name ?? '音源', buf }];
  Object.assign(arrState, {
    clips: [{ src: 0, len: d, pos: 0, env: [], track: 0, srcId: 0 }],
    tracks: 1, sel: -1, dur: d, viewAt: d / 2, span: d * 1.04, vscroll: 0, vz: 1, play: 0,
    undo: [], redo: [], gridMenu: false, markHold: false, cutDrag: -1, tool: 'move',
  });
  arrCache = null;
  openSheet('cut');
}

const fmtCut = (t: number) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(t) / 60)}:${(Math.abs(t) % 60).toFixed(2).padStart(5, '0')}`;
/** 「1:23.45」「83.45」を秒に */
const parseCut = (v: string) => {
  const m = v.match(/^(\d+):(\d+(?:\.\d*)?)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number(v);
};

const arrSnap = () => JSON.stringify({ clips: arrState.clips, sel: arrState.sel, tracks: arrState.tracks });
function arrPush() {
  arrState.undo.push(arrSnap());
  if (arrState.undo.length > 200) arrState.undo.shift();
  arrState.redo = [];
}
function arrRestore(s: string) {
  const v = JSON.parse(s) as { clips: Clip[]; sel: number; tracks: number };
  arrState.clips = v.clips;
  arrState.sel = v.sel;
  arrState.tracks = v.tracks;
}

/** 表示に使う長さ（譜面の音源より短くしても、その長さまでは見えるように） */
const arrTotal = () => Math.max(arrangeLength(arrState.clips), arrState.dur);
const srcDur = (c: Clip) => arrSources[c.srcId]?.buf.duration ?? arrState.dur;

/** 譜面の 1 小節目の頭の、新しい音源での時刻（OFFSET はこれのマイナス） */
const arrBar1 = () => -ed.chart.offset + refShift(arrState.clips, -ed.chart.offset);

/**
 * 譜面の小節とグリッドの線（新しい音源の時刻）。div: -1 = 小節の頭だけ、n = 1 小節（4/4）を n 分割。
 * 1 小節目は譜面の 1 小節目で、その前は最初の小節の長さ・BPM で 0・-1… と続ける
 */
function arrGrid(t0: number, t1: number, div: number): { t: number; bar: boolean; beat: boolean; n: number }[] {
  const sh = refShift(arrState.clips, -ed.chart.offset);
  const tm = ed.timing;
  const out: { t: number; bar: boolean; beat: boolean; n: number }[] = [];
  const endTick = Math.max(0, tm.timeToTick(t1 - sh)) + TPB * 8;
  const step = div > 0 ? (TPB * 4) / div : Infinity;
  const ms = ed.measuresUntil(endTick);
  if (ms.length) {
    const m0 = ms[0];
    const h0 = tm.tickToTime(0) + sh;
    const st = div > 0 ? step : m0.length;
    const dt = tm.tickToTime(st) - tm.tickToTime(0);
    const beat0 = (TPB * 4) / m0.den;
    const pre: { t: number; bar: boolean; beat: boolean; n: number }[] = [];
    for (let k = 1; dt > 0 && h0 - k * dt >= t0 - 0.5 && k < 100000; k++) {
      const t = h0 - k * dt;
      if (t > t1 + 0.5) continue;
      const back = k * st;
      const tick = (((-back) % m0.length) + m0.length) % m0.length;
      pre.push({ t, bar: tick === 0, beat: Math.abs(tick / beat0 - Math.round(tick / beat0)) < 1e-6, n: Math.floor(-back / m0.length) + 1 });
    }
    out.push(...pre.reverse());
  }
  for (const m of ms) {
    const head = tm.tickToTime(m.start) + sh;
    if (head > t1 + 0.5) break;
    if (tm.tickToTime(m.start + m.length) + sh < t0 - 0.5) continue;
    const beat = (TPB * 4) / m.den;
    for (let k = 0; k * step < m.length - 1e-6 || k === 0; k++) {
      const tick = k * (div > 0 ? step : 0);
      const t = tm.tickToTime(m.start + tick) + sh;
      if (t >= t0 - 0.5 && t <= t1 + 0.5) out.push({ t, bar: k === 0, beat: Math.abs(tick / beat - Math.round(tick / beat)) < 1e-6, n: m.index + 1 });
      if (div <= 0) break;
    }
  }
  return out;
}

/**
 * グリッドに合わせる: いちばん近いグリッドの線へ（タップでもドラッグでも）。
 * ほかのクリップの端・マーク・0 秒が tol 秒以内でグリッドより近ければ、そちらへ。グリッドが「なし」ならそのまま
 */
function arrQuantize(t: number, tol: number, except = -1, withMark = true): number {
  const a = arrState;
  if (a.grid === 0) return t;
  const win = Math.max(4, a.span);
  let g = t;
  let gd = Infinity;
  for (const x of arrGrid(t - win, t + win, a.grid)) { const d = Math.abs(x.t - t); if (d < gd) { gd = d; g = x.t; } }
  const edges = a.clips.flatMap((c, i) => (i === except ? [] : [c.pos, clipEnd(c)]));
  const e = snapTo(t, [...edges, ...(withMark ? [a.play] : []), 0], tol);
  return e !== t && Math.abs(e - t) < gd ? e : g;
}

/** 並べた音（チャンネルごと） */
const arrRender = () => renderClips(arrSources.map((s) => bufferChannels(s.buf)), arrSources[0].buf.sampleRate, arrState.clips);

function stopArrPlay() {
  if (!arrPlay.on) return;
  arrPlay.on = false;
  audio.stop();
}
/** 並べた音を作って（変わっていなければ前に作ったものを使って）、from 秒から鳴らす */
async function startArrPlay(from: number) {
  if (!arrSources.length) return;
  stopPlayback();
  stopArrPlay();
  const key = JSON.stringify(arrState.clips) + arrSources.length;
  if (!arrCache || arrCache.key !== key) {
    const chs = arrRender();
    const b = audio.ctx.createBuffer(chs.length, chs[0].length, arrSources[0].buf.sampleRate);
    chs.forEach((d, i) => b.getChannelData(i).set(d));
    arrCache = { key, buf: b };
  }
  await audio.startAt(from, 1, arrCache.buf);
  Object.assign(arrPlay, { on: true, until: arrangeLength(arrState.clips) });
}
function tickArrPlay() {
  if (sheet !== 'cut') { stopArrPlay(); return; }
  const now = audio.now();
  if (now >= arrPlay.until) {
    stopArrPlay();
    renderSheet();
    return;
  }
  // 画面は動かさない（スクロールは上の小節のバーだけ）
  drawArr(now);
}

/** ルーラーの高さ・クリップの見出しの高さ・上下のすき間・「トラックを足す」の行の高さ */
const A_RULER = 26;
const A_HEAD = 16;
const A_PAD = 4;
const A_ADD = 40;

/** トラックの高さと、縦にスクロールできる量（キャンバスの高さ HH から） */
function arrLanes(HH: number) {
  const a = arrState;
  const avail = Math.max(60, HH - A_RULER - A_ADD);
  const fit = Math.max(64, avail / Math.max(1, a.tracks));
  const laneH = Math.max(44, Math.min(avail * 2, fit * a.vz));
  const content = a.tracks * laneH + A_ADD;
  const maxScroll = Math.max(0, content - (HH - A_RULER));
  a.vscroll = Math.max(0, Math.min(maxScroll, a.vscroll));
  /** トラック i の上端（キャンバスの中） */
  const top = (i: number) => A_RULER + i * laneH - a.vscroll;
  return { laneH, top, maxScroll };
}
/** オートメーションの線を引く範囲（トラックの上端 y0 から） */
const arrEnvBox = (y0: number, laneH: number) => ({ top: y0 + A_PAD + A_HEAD + 5, h: Math.max(8, laneH - A_PAD * 2 - A_HEAD - 10) });

/** クリップの中の波形（その音源の src から、オートメーションの音量を掛けて。上下に余白を残す） */
function drawClipWave(ctx: CanvasRenderingContext2D, c: Clip, x0: number, x1: number, y0: number, h: number, W: number) {
  const buf = arrSources[c.srcId]?.buf;
  if (!buf) return;
  const chs = bufferChannels(buf);
  const sr = buf.sampleRate;
  const a = arrState;
  const t0 = a.viewAt - a.span / 2;
  const mid = y0 + h / 2;
  const amp = (h / 2) * 0.78;
  for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
    const ta = t0 + (x / W) * a.span;
    const tb = t0 + ((x + 1) / W) * a.span;
    const s0 = Math.floor((c.src + ta - c.pos) * sr);
    const s1 = Math.floor((c.src + tb - c.pos) * sr);
    if (s1 <= 0 || s0 >= buf.length) continue;
    let mx = 0;
    const step = Math.max(1, Math.floor((s1 - s0) / 160));
    for (let i = Math.max(0, s0); i < Math.min(buf.length, s1); i += step) for (const ch of chs) { const v = Math.abs(ch[i]); if (v > mx) mx = v; }
    const g = envAt(c.env, c.src + ta - c.pos);
    ctx.fillRect(x, mid - mx * amp * g, 1, Math.max(1, mx * amp * 2 * g));
  }
}

/** トラックの色（音源ごとに少し変える） */
const arrColor = (srcId: number, on: boolean) => {
  const hues = [196, 168, 226, 140, 250];
  const h = hues[srcId % hues.length];
  return { head: on ? `hsl(${h}, 55%, 76%)` : `hsl(${h}, 45%, 52%)`, body: `hsla(${h}, 45%, 52%, ${on ? 0.42 : 0.28})`, wave: on ? `hsl(${h}, 60%, 88%)` : `hsl(${h}, 45%, 70%)` };
};

function drawArr(playhead = -1) {
  const a = arrState;
  if (!arrSources.length) return;
  const len = arrangeLength(a.clips);
  const lcd = document.getElementById('arrLcdPos');
  if (lcd) {
    const t = playhead >= 0 ? playhead : a.play;
    lcd.textContent = fmtCut(t);
    const g = arrGrid(t - 30, t + 0.001, 4).filter((x) => x.t <= t + 1e-6);
    const bars = g.filter((x) => x.bar);
    const bar = bars[bars.length - 1];
    $('arrLcdBar').textContent = bar ? `小節 ${bar.n} 拍 ${g.filter((x) => x.beat && x.t >= bar.t - 1e-6).length}` : '—';
  }
  const info = document.getElementById('arrLen');
  if (info) info.textContent = fmtCut(len);
  const off = document.getElementById('arrOff');
  if (off) off.textContent = `${ed.chart.offset.toFixed(3)} → ${(-arrBar1()).toFixed(3)}`;

  const cv = document.getElementById('arrWave') as HTMLCanvasElement | null;
  if (!cv) return;
  const { ctx, W, H: HH } = fitCanvas(cv);
  const t0 = a.viewAt - a.span / 2;
  const t1 = t0 + a.span;
  const xOf = (t: number) => ((t - t0) / a.span) * W;
  const L = arrLanes(HH);
  ctx.fillStyle = '#1d2023';
  ctx.fillRect(0, 0, W, HH);
  // グリッド（なしのときは拍を薄く）
  const div = a.grid === 0 ? 4 : a.grid;
  const grid = arrGrid(t0, t1, div);
  const fine = grid.filter((g) => !g.bar);
  const pxGrid = fine.length > 1 ? Math.abs(xOf(fine[1].t) - xOf(fine[0].t)) : 99;
  // トラック（下に描いてから、上にルーラー）
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, A_RULER, W, HH - A_RULER);
  ctx.clip();
  for (let i = 0; i < a.tracks; i++) {
    const y = L.top(i);
    ctx.fillStyle = i % 2 ? '#202326' : '#1d2023';
    ctx.fillRect(0, y, W, L.laneH);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(0, y + L.laneH - 1, W, 1);
  }
  for (const g of grid) {
    if (!g.bar && pxGrid < 5) continue;
    ctx.fillStyle = g.bar ? (g.n === 1 ? 'rgba(147,205,226,0.55)' : 'rgba(255,255,255,0.16)') : g.beat ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(Math.round(xOf(g.t)), A_RULER, g.n === 1 && g.bar ? 2 : 1, a.tracks * L.laneH - a.vscroll);
  }
  if (xOf(len) < W) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(Math.max(0, xOf(len)), A_RULER, W, a.tracks * L.laneH - a.vscroll);
  }
  if (t0 < 0) {
    ctx.fillStyle = '#16181b';
    ctx.fillRect(0, A_RULER, xOf(0), a.tracks * L.laneH - a.vscroll);
  }
  // トラックの番号（左の端に薄く）
  ctx.font = '700 11px system-ui, sans-serif';
  for (let i = 0; i < a.tracks; i++) {
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillText(`トラック ${i + 1}`, 6, L.top(i) + L.laneH - 8);
  }
  // クリップ（下から順に）
  const autoMode = a.tool === 'auto';
  a.clips.forEach((c, i) => {
    const xa = xOf(c.pos);
    const xb = xOf(clipEnd(c));
    const y0 = L.top(c.track) + A_PAD;
    const ch = L.laneH - A_PAD * 2;
    if (xb < -2 || xa > W + 2 || y0 + ch < A_RULER || y0 > HH) return;
    const on = i === a.sel;
    const col = arrColor(c.srcId, on);
    ctx.fillStyle = col.body;
    ctx.fillRect(xa, y0, xb - xa, ch);
    ctx.fillStyle = col.head;
    ctx.fillRect(xa, y0, xb - xa, A_HEAD);
    ctx.save();
    ctx.beginPath();
    ctx.rect(xa, y0, Math.max(0, xb - xa), ch);
    ctx.clip();
    ctx.fillStyle = on ? '#1d2023' : '#fff';
    ctx.font = '700 11px system-ui, sans-serif';
    const nm = c.srcId ? `${arrSources[c.srcId]?.name ?? ''} ` : '';
    ctx.fillText(`${nm}${fmtCut(c.src)}〜${fmtCut(c.src + c.len)}`, Math.max(xa, 0) + 6, y0 + 12);
    ctx.fillStyle = col.wave;
    drawClipWave(ctx, c, xa, xb, y0 + A_HEAD + 1, ch - A_HEAD - 2, W);
    // オートメーションの線（音量）。上が 100%、下が 0%。線より上を暗くして、下がっている所を見せる
    if (c.env.length || (autoMode && on)) {
      const eb = arrEnvBox(L.top(c.track), L.laneH);
      const yv = (v: number) => eb.top + (1 - v) * eb.h;
      const pts: [number, number][] = [[xa, yv(envAt(c.env, c.src))]];
      for (const p of c.env) if (p.s > c.src && p.s < c.src + c.len) pts.push([xOf(c.pos + p.s - c.src), yv(p.v)]);
      pts.push([xb, yv(envAt(c.env, c.src + c.len))]);
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.moveTo(xa, eb.top);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.lineTo(xb, eb.top);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = autoMode && on ? '#ffffff' : 'rgba(255,255,255,0.7)';
      ctx.lineWidth = autoMode && on ? 2.5 : 1.5;
      ctx.beginPath();
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      if (autoMode && on) {
        for (const p of c.env) {
          if (p.s < c.src - 1e-6 || p.s > c.src + c.len + 1e-6) continue;
          const x = xOf(c.pos + p.s - c.src);
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(x, yv(p.v), 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#4d9fbe';
          ctx.beginPath();
          ctx.arc(x, yv(p.v), 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
    ctx.fillStyle = '#1d2023';
    ctx.fillRect(xa, y0, 1, ch);
    if (on) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(xa + 1, y0 + 1, xb - xa - 2, ch - 2);
    }
  });
  // 選んでいるクリップの端のつまみ（丸）。オートメーションのときは出さない
  const s = a.clips[a.sel];
  if (s && !autoMode) {
    const cy = L.top(s.track) + L.laneH / 2;
    for (const x of [xOf(s.pos), xOf(clipEnd(s))]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x, cy, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#4d9fbe';
      ctx.fillRect(x - 3, cy - 5, 1.5, 10);
      ctx.fillRect(x + 1.5, cy - 5, 1.5, 10);
    }
  }
  // トラックを足す（いちばん下の行）
  const ay = L.top(a.tracks);
  if (ay < HH) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(8, ay + 6, Math.min(W - 16, 220), A_ADD - 12);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '800 13px system-ui, sans-serif';
    ctx.fillText('＋ トラックを足す', 20, ay + A_ADD / 2 + 5);
  }
  ctx.restore();
  // ルーラー: 小節の番号（1 小節目より前は 0・-1…。詰まるときは間引く）。ここをドラッグすると画面が動く
  let lastLabel = -1e9;
  const marks = grid.filter((g) => g.bar || pxGrid >= 5).map((g) => {
    const x = xOf(g.t);
    const m: { x: number; major: boolean; label?: string } = { x, major: g.bar };
    if (g.bar && (x - lastLabel >= 34 || g.n === 1)) { m.label = String(g.n); lastLabel = x; }
    return m;
  });
  drawRuler(ctx, W, A_RULER, marks);
  // 切り取りのマーク（再生もここから）: 縦の線と、ルーラーの中の三角 1 つ。長押しで掴んでいる間は大きく
  const mx = xOf(a.play);
  ctx.fillStyle = playhead >= 0 ? 'rgba(255,201,77,0.55)' : PLAYHEAD;
  ctx.fillRect(Math.round(mx) - 1, A_RULER, 2, HH - A_RULER);
  const tr = a.markHold || a.cutDrag >= 0 ? 12 : 9;
  ctx.fillStyle = PLAYHEAD;
  ctx.beginPath();
  ctx.moveTo(mx - tr, A_RULER - tr * 1.7);
  ctx.lineTo(mx + tr, A_RULER - tr * 1.7);
  ctx.lineTo(mx, A_RULER);
  ctx.closePath();
  ctx.fill();
  if (a.markHold || a.cutDrag >= 0) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // マークを下へドラッグ中: 切る所を見せる（トラックのクリップの上で離すと、そこで切る）
  if (a.cutDrag >= 0) {
    const tk = Math.floor((a.cutDrag - A_RULER + a.vscroll) / L.laneH);
    const ci = a.cutDrag > A_RULER + 10 && tk >= 0 && tk < a.tracks ? clipAt(a.clips, a.play, tk) : -1;
    const ready = ci >= 0;
    ctx.strokeStyle = ready ? '#ff7a6a' : 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 3;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(mx, A_RULER);
    ctx.lineTo(mx, Math.min(HH, Math.max(A_RULER, a.cutDrag)));
    ctx.stroke();
    ctx.setLineDash([]);
    const label = ready ? `✂ 離すとトラック ${tk + 1} をここで切る` : a.cutDrag > A_RULER + 10 ? 'ここにクリップがありません' : '下へドラッグで切る';
    ctx.font = '800 13px system-ui, sans-serif';
    const lw = ctx.measureText(label).width + 16;
    const lx = Math.max(4, Math.min(W - lw - 4, mx + 10));
    const ly = Math.min(HH - 30, Math.max(A_RULER + 6, a.cutDrag - 14));
    ctx.fillStyle = ready ? '#ff7a6a' : 'rgba(29,32,35,0.92)';
    ctx.fillRect(lx, ly, lw, 26);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx + 8, ly + 18);
  }
  // 再生中の位置
  if (playhead >= 0) drawPlayhead(ctx, xOf(playhead), HH, A_RULER);
  // クリップの上の操作ボタン（選んでいるとき・オートメーションでないとき）
  const bub = document.getElementById('arrBub');
  if (bub) {
    const sc = a.clips[a.sel];
    const by = sc ? L.top(sc.track) + A_PAD + A_HEAD + 6 : 0;
    const vis = !!sc && !autoMode && xOf(clipEnd(sc)) > 0 && xOf(sc.pos) < W && playhead < 0 && by > A_RULER && by + 34 < HH;
    bub.classList.toggle('hidden', !vis);
    if (vis && sc) {
      const cx = Math.max(xOf(sc.pos), 0) / 2 + Math.min(xOf(clipEnd(sc)), W) / 2;
      const bw = bub.offsetWidth;
      bub.style.left = `${Math.max(4, Math.min(W - bw - 4, cx - bw / 2))}px`;
      bub.style.top = `${cv.offsetTop + by}px`;
      bub.querySelector<HTMLButtonElement>('[data-abub="split"]')!.disabled = !(a.play > sc.pos + MIN_LEN && a.play < clipEnd(sc) - MIN_LEN);
    }
  }
}

const ARR_IC = {
  auto: '<path d="M3 17 9 8l6 6 6-9"/><circle cx="9" cy="8" r="2" class="fill"/><circle cx="15" cy="14" r="2" class="fill"/>',
  grid: '<path d="M4 4v16M10 4v16M16 4v16M20 4v16"/><path d="M2 20h20"/>',
};

/** 別の音源を読み込んで、新しいトラックのマークの所に置く */
function arrAddSource(onDone: () => void) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'audio/*,.ogg,.mp3,.wav,.m4a,.aac,.flac';
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      busy(`「${f.name}」を読み込んでいます…`);
      const buf = await audio.ctx.decodeAudioData(await f.arrayBuffer());
      busyEnd();
      const a = arrState;
      arrPush();
      arrSources.push({ name: f.name.replace(/\.[^.]+$/, ''), buf });
      a.tracks += 1;
      a.clips = [...a.clips, { src: 0, len: Math.round(buf.duration * 1000) / 1000, pos: a.play, env: [], track: a.tracks - 1, srcId: arrSources.length - 1 }];
      a.sel = a.clips.length - 1;
      toast(`「${f.name}」をトラック ${a.tracks} に置きました`);
      onDone();
    } catch {
      busyEnd();
      toast(`「${f.name}」は読み込めませんでした`);
    }
  });
  inp.click();
}

function renderCutSheet(body: HTMLElement) {
  $('sheetTitle').textContent = '音源の切り貼り';
  const a = arrState;
  a.sel = a.sel < a.clips.length ? a.sel : -1;
  const sel = a.clips[a.sel];
  const usedTracks = new Set(a.clips.map((c) => c.track));
  const emptyTracks = Array.from({ length: a.tracks }, (_, i) => i).filter((i) => !usedTracks.has(i));
  const insp = (() => {
    if (a.tool === 'auto') {
      return `
        <div class="dv dv-info dv-sec" style="--c:#93cde2"><span class="dv-l">音量（オートメーション）</span><b>${sel ? `トラック ${sel.track + 1}` : '—'}</b></div>
        <div class="daw-acts">
          <button data-aenv="in" ${sel ? '' : 'disabled'}>フェードイン</button>
          <button data-aenv="out" ${sel ? '' : 'disabled'}>フェードアウト</button>
          <button data-aenv="clear" ${sel?.env.length ? '' : 'disabled'}>音量を戻す</button>
        </div>
        <p class="arr-hint">${sel ? '線をタップで点を追加・点をドラッグで動かす・点をダブルタップで消す' : 'クリップをタップして選ぶ'}</p>`;
    }
    if (sel) {
      return `
        <div class="dv dv-info dv-sec dv-narrow" style="--c:#93cde2"><span class="dv-l">トラック</span><b>${sel.track + 1}</b></div>
        ${valueBoxHtml('pos', '位置')}
        ${valueBoxHtml('len', '長さ')}
        ${valueBoxHtml('src', '元の音源の位置')}
        <div class="daw-acts">
          <button data-abub="split">✂ マークで分割</button>
          <button data-abub="dup">⧉ 複製</button>
          <button data-abub="del" class="bad">削除</button>
          <button data-adesel>選ぶのをやめる</button>
        </div>`;
    }
    return `
        <div class="dv dv-info"><span class="dv-l">新しい長さ</span><b id="arrLen"></b></div>
        <div class="dv dv-info"><span class="dv-l">OFFSET（1 小節目の所）</span><b id="arrOff"></b></div>
        <div class="daw-acts three">
          <button data-asplitplay>✂ マークで分割</button>
          <button data-aaddtrack>＋ トラック</button>
          <button data-aaddsrc>＋ 別の音源</button>
          <button data-adelempty ${emptyTracks.length && a.tracks > 1 ? '' : 'disabled'}>空のトラックを消す</button>
          <button data-areset ${a.undo.length ? '' : 'disabled'}>最初に戻す</button>
        </div>`;
  })();
  body.innerHTML = `<div class="daw">
    <header class="daw-top">
      <button class="daw-ic" data-aact="cancel" aria-label="やめる">${IC.close}</button>
      <b class="daw-title">音源の切り貼り</b>
      <button class="daw-ic" data-aundo aria-label="元に戻す" ${a.undo.length ? '' : 'disabled'}>${IC.undo}</button>
      <button class="daw-ic" data-aredo aria-label="やり直す" ${a.redo.length ? '' : 'disabled'}>${IC.redo}</button>
      <span class="daw-sep"></span>
      <button class="daw-ic" data-ahome aria-label="マークを頭へ">${IC.home}</button>
      <button class="daw-ic daw-play ${arrPlay.on ? 'on' : ''}" data-aplay aria-label="${arrPlay.on ? '止める' : 'マークから再生'}">${arrPlay.on ? IC.stop : IC.play}</button>
      <div class="daw-lcd"><b id="arrLcdPos"></b><small id="arrLcdBar"></small></div>
      <span class="daw-sep"></span>
      <button class="daw-tg ${a.tool === 'auto' ? 'on' : ''}" data-aauto aria-pressed="${a.tool === 'auto'}">${ic(ARR_IC.auto)}<span>音量</span></button>
      <button class="daw-tg ${a.gridMenu ? 'open' : ''}" data-agrid>${ic(ARR_IC.grid)}<span>${arrGridLabel(a.grid)}</span></button>
      <span class="daw-sp"></span>
      <button class="daw-ok" data-aact="ok">${IC.ok}<span>反映</span></button>
    </header>
    <div class="daw-main">
      ${a.gridMenu ? `<div class="arr-gridmenu">${ARR_GRIDS.map((g) => `<button data-agridset="${g}" class="${g === a.grid ? 'on' : ''}">${arrGridLabel(g)}</button>`).join('')}</div>` : ''}
      <div class="daw-stage">
        <canvas id="arrWave" class="daw-wave"></canvas>
        <div id="arrBub" class="arr-bub hidden">
          <button data-abub="split">✂ 分割</button><button data-abub="dup">⧉ 複製</button><button data-abub="del">削除</button>
        </div>
      </div>
    </div>
    <footer class="daw-insp fit">${insp}</footer>
  </div>`;
  const rerender = () => renderCutSheet(body);
  // グリッドのメニューは、グリッドのボタンの下に出す
  const gm = body.querySelector<HTMLElement>('.arr-gridmenu');
  if (gm) {
    const gb = body.querySelector<HTMLElement>('[data-agrid]')!;
    gm.style.left = `${Math.max(4, Math.min(gb.offsetLeft, body.clientWidth - gm.offsetWidth - 4))}px`;
  }
  const clampView = () => {
    const total = arrTotal();
    a.span = Math.min(total * 1.3, Math.max(0.05, a.span));
    a.viewAt = Math.max(-a.span * 0.3, Math.min(total + a.span * 0.3, a.viewAt));
  };
  let refreshBoxes = () => {};
  const update = () => { drawArr(arrPlay.on ? audio.now() : -1); refreshBoxes(); };

  const cv = $<HTMLCanvasElement>('arrWave');
  const W = () => Math.max(1, cv.clientWidth);
  const lanes = () => arrLanes(Math.max(1, cv.clientHeight));
  const tAt = (x: number) => a.viewAt - a.span / 2 + (x / W()) * a.span;
  const xAt = (t: number) => ((t - (a.viewAt - a.span / 2)) / a.span) * W();
  /** キャンバスの y にあるトラック（-1 はルーラー、tracks は「トラックを足す」の行より下） */
  const trackAt = (y: number) => Math.floor((y - A_RULER + a.vscroll) / lanes().laneH);
  const tol = () => (12 / W()) * a.span;
  const snap = (t: number, except = -1, withMark = true) => arrQuantize(t, tol(), except, withMark);
  /** 動かし始めたら 1 回だけ元に戻すの記録を取る */
  const once = () => { let done = false; return () => { if (!done) { arrPush(); done = true; } }; };
  let lastPointTap = { at: 0, k: -1 };
  bindTimeline(cv, {
    single: (x, y) => {
      const t = tAt(x);
      if (y < A_RULER) {
        // ルーラー: ドラッグで画面を動かす。タップでマークをそこへ（グリッドに合わせる）。
        // マークを長押ししてから横に動かすとマークが動き、マークを下へドラッグしてトラックの上で離すとそこで切る
        const v0 = a.viewAt;
        const nearMark = Math.abs(x - xAt(a.play)) < 24;
        let hold = false;
        let mode: 'none' | 'scroll' | 'cut' = 'none';
        const timer = nearMark ? window.setTimeout(() => { hold = true; a.markHold = true; navigator.vibrate?.(15); update(); }, 300) : 0;
        const setMark = (xx: number) => { a.play = Math.max(0, snap(tAt(xx), -1, false)); update(); };
        return {
          move: (xx, yy, dx) => {
            const dy = yy - y;
            if (mode === 'none' && nearMark && dy > 14 && dy > Math.abs(dx) * 1.2) mode = 'cut';
            if (mode === 'cut') { clearTimeout(timer); a.markHold = false; a.cutDrag = yy; update(); return; }
            if (hold) { setMark(xx); return; }
            if (mode === 'none' && Math.abs(dx) < 6) return;
            mode = 'scroll';
            clearTimeout(timer);
            a.viewAt = v0 - (dx / W()) * a.span;
            clampView();
            update();
          },
          end: (moved) => {
            clearTimeout(timer);
            a.markHold = false;
            if (mode === 'cut') {
              const yy = a.cutDrag;
              a.cutDrag = -1;
              const tk = trackAt(yy);
              if (yy > A_RULER + 10 && tk >= 0 && tk < a.tracks) {
                const i = clipAt(a.clips, a.play, tk);
                if (i < 0) toast('マークの所にクリップがありません');
                else {
                  const res = splitClip(a.clips, i, a.play);
                  if (!res) toast('マークがクリップの端に近すぎて切れません');
                  else { arrPush(); a.clips = res; a.sel = i + 1; }
                }
              }
              rerender();
              return;
            }
            if (!moved && !hold) setMark(x);
            if (hold || !moved) rerender();
          },
          cancel: () => { clearTimeout(timer); a.markHold = false; a.cutDrag = -1; update(); },
        };
      }
      const tk = trackAt(y);
      // 「トラックを足す」の行
      if (tk === a.tracks && x < 240) {
        return { move: () => {}, end: (moved) => { if (!moved) { arrPush(); a.tracks += 1; rerender(); } } };
      }
      const s = a.clips[a.sel];
      const hit = tk >= 0 && tk < a.tracks ? clipAt(a.clips, t, tk) : -1;
      if (a.tool === 'auto') {
        // オートメーション: 選んでいるクリップの線の上で、点を足す・動かす・消す
        if (!s || hit !== a.sel) {
          return { move: () => {}, end: (moved) => { if (!moved) { a.sel = hit; rerender(); } } };
        }
        const eb = arrEnvBox(lanes().top(s.track), lanes().laneH);
        const vAt = (yyy: number) => Math.max(0, Math.min(1, 1 - (yyy - eb.top) / eb.h));
        const ptX = (p: EnvPoint) => xAt(s.pos + p.s - s.src);
        const ptY = (p: EnvPoint) => eb.top + (1 - p.v) * eb.h;
        let k = -1;
        let best = 18;
        s.env.forEach((p, i) => { const d = Math.hypot(ptX(p) - x, ptY(p) - y); if (d < best) { best = d; k = i; } });
        const push = once();
        const sAt = (xx: number) => {
          const c = a.clips[a.sel];
          const tt = Math.max(c.pos, Math.min(clipEnd(c), snap(tAt(xx), a.sel)));
          return c.src + (tt - c.pos);
        };
        return {
          move: (xx, yyy) => {
            push();
            const c = a.clips[a.sel];
            const v = vAt(yyy);
            if (k < 0) {
              // 何も無い所からドラッグ: 点を作ってそのまま動かす
              const s0 = sAt(xx);
              c.env = sortEnv([...c.env, { s: s0, v }]);
              k = c.env.findIndex((p) => Math.abs(p.s - Math.round(s0 * 1000) / 1000) < 1e-6);
            }
            const lo = k > 0 ? c.env[k - 1].s + 0.001 : -Infinity;
            const hi = k + 1 < c.env.length ? c.env[k + 1].s - 0.001 : Infinity;
            c.env[k] = { s: Math.round(Math.max(lo, Math.min(hi, sAt(xx))) * 1000) / 1000, v: Math.round(v * 1000) / 1000 };
            update();
          },
          end: (moved) => {
            const c = a.clips[a.sel];
            if (!moved) {
              const now = performance.now();
              if (k >= 0 && lastPointTap.k === k && now - lastPointTap.at < 400) {
                // ダブルタップ: 点を消す
                arrPush();
                c.env = c.env.filter((_, i) => i !== k);
                lastPointTap = { at: 0, k: -1 };
              } else if (k >= 0) {
                lastPointTap = { at: now, k };
              } else {
                // 線のあたりをタップ: 点を足す
                arrPush();
                c.env = sortEnv([...c.env, { s: sAt(x), v: vAt(y) }]);
                lastPointTap = { at: 0, k: -1 };
              }
            }
            rerender();
          },
        };
      }
      if (s && s.track === tk) {
        // 端（丸いつまみ・縦の辺）: 詰める・伸ばす
        const nearA = Math.abs(x - xAt(s.pos)) < 16;
        const nearB = Math.abs(x - xAt(clipEnd(s))) < 16;
        if (nearA || nearB) {
          const push = once();
          const left = nearA && (!nearB || Math.abs(x - xAt(s.pos)) <= Math.abs(x - xAt(clipEnd(s))));
          return {
            move: (xx) => {
              push();
              const c = a.clips[a.sel];
              const tt = snap(tAt(xx), a.sel);
              a.clips[a.sel] = left ? trimStart(c, tt) : trimEnd(c, tt, srcDur(c));
              update();
            },
            end: (moved) => { if (moved) rerender(); },
          };
        }
      }
      if (hit >= 0) {
        // クリップ: タップで選ぶ、ドラッグで動かす（横はグリッドに合わせる、縦はトラックを移る）
        const c0 = a.clips[hit];
        const push = once();
        let idx = hit;
        return {
          move: (_xx, yy, dx) => {
            if (idx === hit) {
              push();
              const r = bringToTop(a.clips, hit);
              a.clips = r.clips;
              idx = r.index;
              a.sel = idx;
            }
            let pos = c0.pos + (dx / W()) * a.span;
            const sa = snap(pos, idx);
            const sb = snap(pos + c0.len, idx) - c0.len;
            pos = Math.abs(sa - pos) <= Math.abs(sb - pos) ? sa : sb;
            const track = Math.max(0, Math.min(a.tracks - 1, trackAt(yy)));
            a.clips[idx] = { ...a.clips[idx], pos: Math.max(0, Math.round(pos * 1000) / 1000), track };
            update();
          },
          end: (moved) => {
            if (!moved) a.sel = hit;
            rerender();
          },
        };
      }
      // 何も無い所: 縦にドラッグでトラックを上下に動かす、タップで選ぶのをやめる
      const vs0 = a.vscroll;
      return {
        move: (_xx, yy) => { a.vscroll = vs0 - (yy - y); update(); },
        end: (moved) => { if (!moved && a.sel >= 0) { a.sel = -1; rerender(); } },
      };
    },
    pan: (dx) => { a.viewAt -= (dx / W()) * a.span; clampView(); update(); },
    zoom: (k, x) => {
      const tx = tAt(x);
      a.span *= k;
      clampView();
      a.viewAt = tx - (x / W() - 0.5) * a.span;
      clampView();
      update();
    },
    // 縦に開く・閉じる: トラックの高さ
    vzoom: (k) => { a.vz = Math.max(0.5, Math.min(4, a.vz * k)); update(); },
  });

  // ---- 値の箱（選んでいるクリップ） ----
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const setSel = (fn: (c: Clip) => Clip) => { if (a.clips[a.sel]) a.clips[a.sel] = fn(a.clips[a.sel]); };
  const timeBox = (k: string, get: (c: Clip) => number, set: (c: Clip, v: number) => Clip): ValueBox => ({
    get: () => (a.clips[a.sel] ? fmtCut(get(a.clips[a.sel])) : '—'),
    step: (n: number) => setSel((c) => set(c, r3(get(c) + n * 0.01))),
    px: 4,
    tap: () => {
      const c = a.clips[a.sel];
      const el = body.querySelector<HTMLElement>(`[data-dv="${k}"]`);
      if (!c || !el) return;
      inlineInput(el, fmtCut(get(c)), (v) => { const t = parseCut(v); if (Number.isFinite(t)) { arrPush(); setSel((cc) => set(cc, r3(t))); } rerender(); });
    },
  });
  let pushed = false;
  refreshBoxes = sel && a.tool !== 'auto' ? bindValueBoxes(body, {
    pos: timeBox('pos', (c) => c.pos, (c, v) => ({ ...c, pos: Math.max(0, v) })),
    len: timeBox('len', (c) => c.len, (c, v) => trimEnd(c, c.pos + v, srcDur(c))),
    src: timeBox('src', (c) => c.src, (c, v) => ({ ...c, src: Math.max(0, Math.min(srcDur(c) - c.len, v)) })),
  }, {
    begin: () => { if (!pushed) { arrPush(); pushed = true; } },
    end: () => { pushed = false; },
    changed: () => update(),
  }) : () => {};
  update();
  body.querySelectorAll<HTMLElement>('[data-dvs]').forEach((b) => b.addEventListener('click', rerender));

  // ---- ボタン ----
  const on = (q: string, fn: (b: HTMLElement) => void) => body.querySelectorAll<HTMLElement>(q).forEach((b) => b.addEventListener('click', () => { fn(b); rerender(); }));
  on('[data-aauto]', () => { a.tool = a.tool === 'auto' ? 'move' : 'auto'; a.gridMenu = false; });
  on('[data-agrid]', () => { a.gridMenu = !a.gridMenu; });
  on('[data-agridset]', (b) => { a.grid = Number(b.dataset.agridset); a.gridMenu = false; });
  on('[data-aundo]', () => { const s = a.undo.pop(); if (!s) return; a.redo.push(arrSnap()); arrRestore(s); });
  on('[data-aredo]', () => { const s = a.redo.pop(); if (!s) return; a.undo.push(arrSnap()); arrRestore(s); });
  on('[data-ahome]', () => { a.play = 0; if (a.viewAt - a.span / 2 > 0) a.viewAt = a.span * 0.45; });
  on('[data-adesel]', () => { a.sel = -1; });
  on('[data-aaddtrack]', () => { arrPush(); a.tracks += 1; });
  body.querySelector('[data-aaddsrc]')?.addEventListener('click', () => arrAddSource(rerender));
  on('[data-adelempty]', () => {
    // 空のトラックを消して、残ったトラックを詰める（トラック 1 は残す）
    const used = [...new Set(a.clips.map((c) => c.track))].sort((x, y) => x - y);
    if (!used.length) return;
    arrPush();
    a.clips = a.clips.map((c) => ({ ...c, track: used.indexOf(c.track) }));
    a.tracks = Math.max(1, used.length);
  });
  on('[data-areset]', () => {
    arrPush();
    a.clips = [{ src: 0, len: a.dur, pos: 0, env: [], track: 0, srcId: 0 }];
    a.tracks = 1;
    a.sel = -1;
  });
  // フェードの長さ: 1 小節（譜面の頭の BPM で）、クリップの半分まで
  const fadeLen = (c: Clip) => Math.min(c.len / 2, (60 / (ed.chart.bpm > 0 ? ed.chart.bpm : 120)) * 4);
  on('[data-aenv]', (b) => {
    const c = a.clips[a.sel];
    if (!c) return;
    arrPush();
    const k = b.dataset.aenv;
    a.clips[a.sel] = k === 'in' ? addFadeIn(c, fadeLen(c)) : k === 'out' ? addFadeOut(c, fadeLen(c)) : { ...c, env: [] };
  });
  const splitAtMark = (i: number) => {
    const res = splitClip(a.clips, i, a.play);
    if (!res) { toast('マークがクリップの端に近すぎて分けられません'); return; }
    arrPush();
    a.clips = res;
    a.sel = i + 1;
  };
  on('[data-asplitplay]', () => {
    // どのトラックも、マークの所の上のクリップを切る
    let n = 0;
    for (let tk = 0; tk < a.tracks; tk++) {
      const i = clipAt(a.clips, a.play, tk);
      if (i < 0) continue;
      const res = splitClip(a.clips, i, a.play);
      if (!res) continue;
      if (!n) arrPush();
      a.clips = res;
      n++;
    }
    if (!n) toast('マークの所に切れるクリップがありません');
    a.sel = -1;
  });
  on('[data-abub]', (b) => {
    const i = a.sel;
    const c = a.clips[i];
    if (!c) return;
    const k = b.dataset.abub;
    if (k === 'split') splitAtMark(i);
    else if (k === 'dup') {
      // すぐ後ろに複製して、それを選ぶ（ドラッグで好きな所へ）
      arrPush();
      a.clips = [...a.clips, { ...c, pos: r3(clipEnd(c)), env: c.env.map((p) => ({ ...p })) }];
      a.sel = a.clips.length - 1;
      const e = clipEnd(a.clips[a.sel]);
      if (e > a.viewAt + a.span / 2) a.viewAt = e - a.span * 0.4;
    } else if (k === 'del') {
      if (a.clips.length <= 1) { toast('最後のクリップは消せません'); return; }
      arrPush();
      a.clips = a.clips.filter((_, j) => j !== i);
      a.sel = -1;
    }
  });
  body.querySelector('[data-aplay]')!.addEventListener('click', async () => {
    if (arrPlay.on) { stopArrPlay(); rerender(); return; }
    await startArrPlay(Math.min(a.play, Math.max(0, arrangeLength(a.clips) - 0.05)));
    rerender();
  });
  body.querySelectorAll<HTMLButtonElement>('[data-aact]').forEach((b) => b.addEventListener('click', async () => {
    stopArrPlay();
    if (b.dataset.aact === 'ok') await applyCut();
    closeSheet();
  }));
}

/** 反映: 並べた音を .ogg にして音源を入れ替え、譜面の 1 小節目の所に OFFSET を、DEMOSTART もその音の所に合わせる */
async function applyCut() {
  const a = arrState;
  if (!arrSources.length) return;
  const c0 = a.clips[0];
  if (a.clips.length === 1 && arrSources.length === 1 && c0.pos === 0 && c0.src === 0 && Math.abs(c0.len - a.dur) < 0.002 && !c0.env.length) return; // 変えていない
  const sr = arrSources[0].buf.sampleRate;
  const chs = arrRender();
  try {
    busy('切り貼りした音源を .ogg にしています…', 0);
    const data = await pcmToOgg(chs, sr, (p) => busy('切り貼りした音源を .ogg にしています…', p));
    const name = oggName(ed.audio?.name ?? `${safeName(ed.chart.title)}.ogg`);
    const shift = refShift(a.clips, -ed.chart.offset);
    const demo = mapTime(a.clips, ed.chart.demoStart) ?? ed.chart.demoStart + shift;
    ed.mutate(() => {
      ed.chart.offset = Math.round((ed.chart.offset - shift) * 1000) / 1000;
      ed.chart.demoStart = Math.max(0, Math.round(demo * 1000) / 1000);
      ed.chart.wave = name;
    });
    await setAudio({ name, data });
    busyEnd();
    toast('切り貼りを反映しました');
  } catch (err) {
    busyEnd();
    toast(`反映できませんでした: ${(err as Error).message}`);
  }
}
