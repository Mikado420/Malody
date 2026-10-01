import './style.css';
import { AudioEngine } from './audio/audio';
import { COURSE_NAMES, contentEnd, newChart, toPlayable, TPB, type EEvent } from './chart/model';
import { parseTJA } from './chart/tja';
import { writeTJA } from './chart/tjaWrite';
import type { Note } from './chart/types';
import { DEMO_TJA } from './demo';
import { DIVISORS, Editor, type Tool } from './editor/editor';
import { EditorView, eventText } from './editor/view';
import { loadFiles, type AudioFile } from './io/load';
import { loadAudio, loadChart, loadHitSound, saveAudio, saveChart, saveHitSound } from './io/storage';
import { writeZip } from './io/zip';
import { PlayMode } from './play/playmode';
import { fitRoot } from './orient';
import { BUILD_ID, startAutoUpdate } from './update';

fitRoot();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------- 設定 ----------

const settings = {
  divisor: 4,
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
ed.divisor = DIVISORS.includes(settings.divisor) ? settings.divisor : 4;
const view = new EditorView($<HTMLCanvasElement>('editor'), ed);
// 拡大率: 自分で変えるまでは Malody と同じ間隔（画面の高さに比例）
// 右のアイコンバーとツールも Malody の画面と同じ比率で大きさを決める（CSS の --es）
const onViewResize = () => {
  document.documentElement.style.setProperty('--es', String(view.s));
  if (!settings.zoomSet) view.setZoom(view.defaultZoom);
};
view.onResize = onViewResize;
onViewResize();
if (settings.zoomSet) view.zoom = Math.min(2400, Math.max(20, settings.zoom));
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

async function startPlayback() {
  if (playing) return;
  const from = ed.timing.tickToTime(Math.max(0, view.pos));
  playable = toPlayable(ed.chart, ed.course).notes;
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

  if (settings.hitSound) {
    for (const n of playable) {
      if (n.time > lastTime && n.time <= t) {
        audio.playHit(n.type === 'ka' || n.type === 'bigKa' ? 'ka' : 'don');
      }
    }
  }
  if (settings.metronome) {
    const a = ed.timing.timeToTick(lastTime);
    const b = view.pos;
    for (const m of ed.measuresUntil(b)) {
      if (m.start + m.length <= a) continue;
      if (m.start > b) break;
      for (let k = m.start; k < m.start + m.length; k += TPB) {
        if (k > a && k <= b) audio.playTick(k === m.start);
      }
    }
  }
  lastTime = t;
  if (t > endTime()) stopPlayback();
  view.invalidate();
}

function loop() {
  if (playing && !play.isActive) tickPlayback();
  view.frame();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------- ヘッダ・ツールバー ----------

function updateHeader() {
  $<HTMLButtonElement>('btnUndo').disabled = !ed.canUndo;
  $<HTMLButtonElement>('btnRedo').disabled = !ed.canRedo;
  $('btnRate').querySelector('small')!.textContent = `${settings.rate.toFixed(settings.rate === 1 ? 1 : 2)}x`;
  $('btnMetro').classList.toggle('on', settings.metronome);
  $('divLabel').textContent = `1/${ed.divisor}`;
  view.invalidate();
}

function setTool(t: Tool) {
  ed.tool = t;
  if (ed.pendingLong !== null && t !== 'roll' && t !== 'bigRoll' && t !== 'balloon') ed.pendingLong = null;
  document.querySelectorAll<HTMLButtonElement>('#tools .tool').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === t);
  });
  view.invalidate();
}

document.querySelectorAll<HTMLButtonElement>('#tools .tool').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool));
});
setTool('don');

const divSel = $<HTMLSelectElement>('divisor');
divSel.innerHTML = DIVISORS.map((d) => `<option value="${d}">1/${d}</option>`).join('');
divSel.value = String(ed.divisor);
divSel.addEventListener('change', () => {
  ed.divisor = Number(divSel.value);
  updateHeader();
  settings.divisor = ed.divisor;
  saveSettings();
  view.invalidate();
});

view.onZoomChange = (z) => {
  if (Math.abs(z - view.defaultZoom) < 0.5 && !settings.zoomSet) return; // 自動調整のとき
  settings.zoom = z;
  settings.zoomSet = true;
  saveSettings();
};
$('btnMetro').addEventListener('click', () => {
  settings.metronome = !settings.metronome;
  saveSettings();
  updateHeader();
  toast(settings.metronome ? 'メトロノーム ON' : 'メトロノーム OFF');
});
$('btnUndo').addEventListener('click', () => ed.undo());
$('btnRedo').addEventListener('click', () => ed.redo());
view.onPlayToggle = () => (playing ? stopPlayback() : void startPlayback());
$('btnRate').addEventListener('click', () => {
  const rates = [1, 0.75, 0.5, 0.25];
  settings.rate = rates[(rates.indexOf(settings.rate) + 1) % rates.length] ?? 1;
  saveSettings();
  updateHeader();
  if (playing) { stopPlayback(); void startPlayback(); }
});

// ---------- 編集 ----------

view.onUserScroll = () => stopPlayback();
view.onTap = (tick) => {
  const r = ed.tap(tick);
  if (r.message) toast(r.message);
  if (r.editBalloon) {
    const v = prompt('風船の打数', String(r.editBalloon.hits ?? 5));
    if (v !== null) ed.setBalloonHits(r.editBalloon, Number(v));
  }
};

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
  Digit5: 'roll', Digit6: 'bigRoll', Digit7: 'balloon', Digit0: 'erase', KeyE: 'erase',
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
    view.pos = Math.max(0, ed.snap(view.pos) + ticks);
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

type SheetKind = 'file' | 'info' | 'events';
let sheet: SheetKind | null = null;

function openSheet(kind: SheetKind) {
  stopPlayback();
  sheet = kind;
  $('sheet').classList.remove('hidden');
  renderSheet();
}
function closeSheet() {
  sheet = null;
  $('sheet').classList.add('hidden');
}
function refreshSheet() {
  if (!sheet) return;
  // 入力中は描き直さない（フォーカスが外れるため）
  if ($('sheetBody').contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return;
  renderSheet();
}

$('sheetClose').addEventListener('click', closeSheet);
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
$('btnFile').addEventListener('click', () => openSheet('file'));
$('btnInfo').addEventListener('click', () => openSheet('info'));
$('btnEvents').addEventListener('click', () => openSheet('events'));

function renderSheet() {
  const body = $('sheetBody');
  if (sheet === 'file') {
    $('sheetTitle').textContent = 'ファイル';
    body.innerHTML = `
      <h3>開く</h3>
      <div class="btns">
        <button data-act="open" class="primary">.tja / .zip を開く</button>
        <button data-act="audio">音源を差し替え</button>
        <button data-act="new">新規作成</button>
        <button data-act="sample">サンプル譜面</button>
      </div>
      <p class="note">.tja と音源を一緒に選ぶか、まとめた .zip を選んでください。</p>
      <h3>書き出し</h3>
      <div class="btns">
        <button data-act="saveTja">.tja を保存</button>
        <button data-act="saveZip">.zip（譜面＋音源）</button>
        <button data-act="copy">TJA をコピー</button>
      </div>
      <p class="note">編集内容はこのブラウザに自動保存されます。書き出した .tja は UTF-8（BOM付き）です。</p>
      <p class="note">バージョン: ${esc(BUILD_ID.slice(0, 7))}</p>`;
  } else if (sheet === 'info') {
    $('sheetTitle').textContent = '譜面情報';
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
      </div>

      <h3>テストプレイ・再生</h3>
      <label class="field"><span>ハイスピード</span><input type="range" min="0.5" max="4" step="0.1" data-set="speed" value="${settings.speed}"><output>${settings.speed.toFixed(1)}</output></label>
      <label class="field"><span>判定調整 ms</span><input type="range" min="-300" max="300" step="1" data-set="offset" value="${settings.offset}"><output>${settings.offset}</output></label>
      <label class="field"><span>打音</span><input type="checkbox" data-set="hitSound" ${settings.hitSound ? 'checked' : ''}></label>
      <h3>打音</h3>
      <p class="note">ドン: ${esc(hitNames.don ?? '内蔵の音')} ／ カッ: ${esc(hitNames.ka ?? '内蔵の音')}<br>
        ファイル名に「don」が入っているものをドン、「ka」が入っているものをカッにします（例: dong.ogg / ka.ogg）。読み込んだ音はこの端末の中だけに保存されます。</p>
      <div class="btns">
        <button data-act="hitLoad">打音ファイルを選ぶ</button>
        <button data-act="hitReset" ${hitNames.don || hitNames.ka ? '' : 'disabled'}>内蔵の音に戻す</button>
      </div>
      <button data-act="resetZoom">エディタの拡大率を初期値（Malody と同じ間隔）に戻す</button>
      <button data-act="calibrate" class="primary">タイミングを測って判定調整を合わせる</button>
      <p class="note">クリック音に合わせてドンを 24 回叩くと、端末の音の遅れを測って判定調整を提案します。音がずれて「正確に叩いても判定されない・不可になる」ときに使ってください。</p>
      <label class="field"><span>ずれを表示</span><input type="checkbox" data-set="showTiming" ${settings.showTiming ? 'checked' : ''}></label>
      <p class="note">オンにすると、叩くたびに判定枠の下にずれ（ms）が出ます。判定されなかったときは「判定なし」と、近くの音符とのずれが出ます。</p>
      <label class="field"><span>オート</span><input type="checkbox" data-set="auto" ${settings.auto ? 'checked' : ''}></label>
      <label class="field"><span>メトロノーム</span><input type="checkbox" data-set="metronome" ${settings.metronome ? 'checked' : ''}></label>`;
  } else if (sheet === 'events') {
    $('sheetTitle').textContent = 'イベント';
    const pos = ed.snap(Math.max(0, view.pos));
    const list = ed.course.events
      .map(
        (e, i) => `<div class="item">
          <div class="grow">${esc(eventText(e))}<div class="pos">${ed.label(e.tick)}</div></div>
          <button data-jump="${i}">移動</button>
          <button data-del="${i}" class="danger">削除</button>
        </div>`,
      )
      .join('');
    body.innerHTML = `
      <p class="note">判定線の位置（${ed.label(pos)}）に追加します。拍子は小節の頭に入ります。</p>
      <div class="btns">
        <button data-ev="bpm">BPM 変更</button>
        <button data-ev="scroll">SCROLL 変更</button>
        <button data-ev="measure">拍子 変更</button>
        <button data-ev="delay">DELAY</button>
        <button data-ev="gogoOn">GOGO 開始</button>
        <button data-ev="gogoOff">GOGO 終了</button>
        <button data-ev="barOff">小節線 OFF</button>
        <button data-ev="barOn">小節線 ON</button>
      </div>
      <h3>この難易度のイベント（${ed.course.events.length}）</h3>
      <div class="list">${list || '<p class="note">まだありません</p>'}</div>`;
  }
}

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
  else {
    (settings[key] as number) = Number(el.value);
    const out = el.parentElement?.querySelector('output');
    if (out) out.textContent = key === 'speed' ? Number(el.value).toFixed(1) : el.value;
  }
  saveSettings();
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
  else if (act === 'new') {
    if (!confirm('新しい譜面を作りますか？（今の譜面はファイル保存していなければ消えます）')) return;
    ed.load(newChart(), null, 0);
    view.pos = 0;
    await setAudio(null);
    closeSheet();
    toast('「音源を差し替え」で曲を設定してください');
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
    for (const k of ['don', 'ka'] as const) {
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
    toast('拡大率を初期値（Malody と同じ間隔）に戻しました');
  } else if (act === 'delCourse') {
    if (confirm(`${ed.course.name} を削除しますか？`)) ed.removeCourse(ed.courseIndex);
  }
}

// ---------- 打音 ----------

const hitNames: Record<'don' | 'ka', string | null> = { don: null, ka: null };

async function applyHitSound(kind: 'don' | 'ka', f: AudioFile | null, save: boolean) {
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
  let don = pick(/don/i);
  let ka = pick(/(^|[^a-z])ka|katsu|kat/i);
  // 名前で分けられないときは 1 つ目をドン、2 つ目をカッ
  if (!don && !ka) [don, ka] = files;
  const done: string[] = [];
  for (const [kind, f] of [['don', don], ['ka', ka]] as const) {
    if (!f) continue;
    if (await applyHitSound(kind, { name: f.name, data: await f.arrayBuffer() }, true)) {
      done.push(kind === 'don' ? 'ドン' : 'カッ');
    }
  }
  if (done.length) toast(`${done.join('・')}の打音を読み込みました`);
  renderSheet();
});

// ---------- テストプレイ ----------

async function startTest() {
  stopPlayback();
  closeSheet();
  const course = toPlayable(ed.chart, ed.course);
  if (!course.notes.length) {
    toast('ノーツがありません');
    return;
  }
  const from = ed.timing.tickToTime(ed.snap(Math.max(0, view.pos)));
  await play.start(course, from, { title: ed.chart.title, course: ed.course.name, level: ed.course.level });
}

$('btnTest').addEventListener('click', () => void startTest());
$('applyCalib').addEventListener('click', () => {
  settings.offset = Math.max(-300, Math.min(300, play.suggested));
  saveSettings();
  $('applyCalib').closest('.calib')!.classList.add('hidden');
  toast(`判定調整を ${settings.offset}ms にしました`);
});
$('playExit').addEventListener('click', () => play.close());
$('back').addEventListener('click', () => play.close());
$('retry').addEventListener('click', () => void (play.lastWasCalibration ? play.startCalibration() : startTest()));
play.onExit = () => view.invalidate();

// ---------- 起動 ----------

/**
 * サイトに置かれた打音（public/sounds/dong.* と ka.*）を探す。
 * リポジトリに打音ファイルを置けば、全員の既定の打音になる（端末で読み込んだ音があればそちらが優先）。
 */
async function siteHitSound(kind: 'don' | 'ka'): Promise<AudioFile | null> {
  const names = kind === 'don' ? ['dong', 'don'] : ['ka'];
  for (const n of names) {
    for (const ext of ['ogg', 'mp3', 'm4a', 'wav']) {
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
  for (const k of ['don', 'ka'] as const) {
    const f = (await loadHitSound(k)) ?? (await siteHitSound(k));
    if (f) await applyHitSound(k, f, false);
  }
  const saved = await loadChart();
  if (saved?.chart?.courses?.length) {
    ed.load(saved.chart, null, saved.courseIndex);
    await setAudio(await loadAudio(), false);
  } else {
    ed.load(parseTJA(DEMO_TJA), null);
    toast('サンプル譜面を開きました。☰ から .tja / .zip を開けます');
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
