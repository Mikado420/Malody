import './style.css';
import { AudioEngine } from './audio/audio';
import { decodeText } from './chart/decode';
import { parseTJA } from './chart/tja';
import type { Chart } from './chart/types';
import { DEMO_TJA } from './demo';
import { Game } from './engine/game';
import { bindInput } from './input';
import { Renderer } from './render/renderer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('game');
const menu = $('menu');
const result = $('result');
const filesInput = $<HTMLInputElement>('files');
const chartInfo = $('chartInfo');
const courseSel = $<HTMLSelectElement>('course');
const speedInput = $<HTMLInputElement>('speed');
const offsetInput = $<HTMLInputElement>('offset');
const startBtn = $<HTMLButtonElement>('start');

const audio = new AudioEngine();
const renderer = new Renderer(canvas);

// 設定はブラウザに保存（使えない環境では無視）
const settings = loadSettings();
speedInput.value = String(settings.speed);
offsetInput.value = String(settings.offset);
syncLabels();

let chart: Chart | null = null;
let musicBuf: ArrayBuffer | null = null;
let game: Game | null = null;
let raf = 0;
let nextBar = 0;

const LEAD_IN = 2; // 開始前の待ち時間（秒）

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('web-taiko:settings') ?? '{}');
    return { speed: Number(s.speed) || 1, offset: Number(s.offset) || 0 };
  } catch {
    return { speed: 1, offset: 0 };
  }
}
function saveSettings() {
  try {
    localStorage.setItem('web-taiko:settings', JSON.stringify(settings));
  } catch { /* 保存できなくても続行 */ }
}
function syncLabels() {
  $('speedVal').textContent = Number(speedInput.value).toFixed(1);
  $('offsetVal').textContent = offsetInput.value;
}

speedInput.addEventListener('input', () => {
  settings.speed = Number(speedInput.value);
  syncLabels();
  saveSettings();
});
offsetInput.addEventListener('input', () => {
  settings.offset = Number(offsetInput.value);
  syncLabels();
  saveSettings();
});

function setChart(c: Chart) {
  chart = c;
  courseSel.innerHTML = '';
  c.courses.forEach((co, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${co.name} ★${co.level}（${co.notes.length}ノーツ）`;
    courseSel.appendChild(opt);
  });
  courseSel.value = String(Math.max(0, c.courses.length - 1));
  courseSel.disabled = c.courses.length === 0;
  startBtn.disabled = c.courses.length === 0;
  const musicNote = musicBuf ? '音源あり' : '音源なし（メトロノーム）';
  chartInfo.textContent = `${c.title || '(無題)'} / BPM ${c.bpm} / ${musicNote}`;
}

filesInput.addEventListener('change', async () => {
  const files = Array.from(filesInput.files ?? []);
  const tja = files.find((f) => f.name.toLowerCase().endsWith('.tja'));
  if (!tja) {
    chartInfo.textContent = '.tja ファイルが含まれていません';
    return;
  }
  const c = parseTJA(decodeText(await tja.arrayBuffer()));
  // WAVE: の名前と一致する音源、なければ最初の音声ファイル
  const audioFiles = files.filter((f) => f !== tja);
  const music =
    audioFiles.find((f) => f.name === c.wave) ?? audioFiles.find((f) => /\.(ogg|mp3|wav|m4a)$/i.test(f.name));
  musicBuf = music ? await music.arrayBuffer() : null;
  setChart(c);
});

$('demo').addEventListener('click', () => {
  musicBuf = null;
  setChart(parseTJA(DEMO_TJA));
  void start();
});
startBtn.addEventListener('click', () => void start());
$('retry').addEventListener('click', () => void start());
$('back').addEventListener('click', () => {
  result.classList.add('hidden');
  menu.classList.remove('hidden');
});

async function start() {
  if (!chart) return;
  const course = chart.courses[Number(courseSel.value) || 0];
  if (!course) return;

  try {
    // decodeAudioData は buffer を detach するのでコピーを渡す
    await audio.loadMusic(musicBuf ? musicBuf.slice(0) : null);
  } catch {
    chartInfo.textContent = '音源を読み込めませんでした（曲なしで開始します）';
    await audio.loadMusic(null);
  }

  game = new Game(course.notes);
  game.onJudge = (e) => renderer.pushJudge(e.judge);
  renderer.speed = settings.speed;
  nextBar = 0;

  menu.classList.add('hidden');
  result.classList.add('hidden');
  await audio.start(LEAD_IN);

  cancelAnimationFrame(raf);
  const info = { title: chart.title, course: `${course.name} ★${course.level}` };
  const lastTime = Math.max(
    0,
    ...course.notes.map((n) => n.endTime ?? n.time),
  );
  const endAt = Math.max(lastTime + 2, audio.hasMusic ? audio.musicDuration : 0);

  const loop = () => {
    const now = gameTime();
    game!.update(now);

    // 曲が無いときは小節線でメトロノームを鳴らす
    if (!audio.hasMusic) {
      while (nextBar < course.bars.length && course.bars[nextBar].time <= now) {
        if (now - course.bars[nextBar].time < 0.05) audio.playTick(true);
        nextBar++;
      }
    }

    renderer.draw(game!, course.bars, now, info);
    if (now > endAt || (game!.finished && now > lastTime + 1.5)) {
      finish();
      return;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}

function gameTime() {
  return audio.now() - settings.offset / 1000;
}

function finish() {
  cancelAnimationFrame(raf);
  audio.stop();
  if (!game) return;
  const s = game.stats;
  const total = game.totalHitNotes || 1;
  const acc = ((s.good + s.ok * 0.5) / total) * 100;
  const rows: [string, string][] = [
    ['スコア', String(s.score)],
    ['良', String(s.good)],
    ['可', String(s.ok)],
    ['不可', String(s.bad)],
    ['最大コンボ', String(s.maxCombo)],
    ['連打', String(s.rolls)],
    ['精度', `${acc.toFixed(2)}%`],
  ];
  $('resultList').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  result.classList.remove('hidden');
}

bindInput(
  canvas,
  () => {
    const L = renderer.layout;
    return { x: L.drumX, y: L.drumY, r: L.drumR, top: L.laneY + L.laneH };
  },
  (kind, side) => {
    if (!game || !menu.classList.contains('hidden') || !result.classList.contains('hidden')) return;
    audio.playHit(kind);
    renderer.pushHit(kind, side);
    game.hit(kind, gameTime());
  },
);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && game && menu.classList.contains('hidden') && result.classList.contains('hidden')) {
    finish();
  }
});
