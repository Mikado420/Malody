/**
 * 最初の画面（曲選択）。Malody の曲選択のように、左にロゴ、右にフォルダと曲の一覧、右下に試聴のボタン。
 * 曲を選ぶと大きく開いて、BPM・長さ・難易度と「プレイ」「編集」が出る。
 */
import type { AudioFile } from '../io/load';
import {
  addFolder, deleteFolder, deleteSong, listFolders, listSongs, loadSongAudio, moveSong, renameFolder, type SongEntry,
} from '../io/library';

export interface HomeHost {
  /** 曲を開く（編集・プレイ） */
  open(id: string, mode: 'edit' | 'play'): Promise<void>;
  /** ファイルを選んで読み込む（読み込んだ曲は一覧に入る） */
  importFiles(): void;
  /** 新しい譜面を作って開く */
  create(folder: string): Promise<void>;
  settings(): void;
  toast(msg: string): void;
}

type Sort = 'updated' | 'title' | 'bpm';
const SORT_LABEL: Record<Sort, string> = { updated: '更新順', title: '名前順', bpm: 'BPM 順' };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmtLen = (s: number) => (s > 0 ? `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '--:--');
const fmtBpm = (e: SongEntry) => {
  const r = (x: number) => String(Number(x.toFixed(2)));
  return e.bpmMin !== e.bpmMax ? `${r(e.bpmMin)}-${r(e.bpmMax)}` : r(e.bpm);
};
const COURSE_SHORT: Record<string, string> = { Easy: 'かんたん', Normal: 'ふつう', Hard: 'むずかしい', Oni: 'おに', Edit: 'うら' };

/** 曲名から決まる、ジャケットの代わりの幾何学模様 */
function jacket(e: SongEntry) {
  let h = 0;
  for (const ch of e.title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const rot = h % 360;
  const n = 3 + (h % 4);
  const arcs = Array.from({ length: n }, (_, i) => {
    const r = 14 + i * 7;
    const len = 20 + ((h >> (i * 3)) % 60);
    const off = (h >> (i * 2)) % 100;
    return `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${i % 2 ? '#1e88ff' : '#fff'}" stroke-width="${i % 2 ? 3 : 1.6}" stroke-dasharray="${len} ${100 - len}" pathLength="100" stroke-dashoffset="${off}" opacity="${i % 2 ? 0.95 : 0.8}"/>`;
  }).join('');
  return `<svg class="hj" viewBox="0 0 100 100" aria-hidden="true"><g transform="rotate(${rot} 50 50)">${arcs}</g>
    <circle cx="50" cy="50" r="7" fill="#fff"/><circle cx="50" cy="50" r="3" fill="#1e88ff"/></svg>`;
}

const ICON = {
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h6l2 2h10v10H3z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
};

export class Home {
  private readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private songs: SongEntry[] = [];
  private folders: string[] = [];
  /** 今見ているフォルダ（null は一番上） */
  private folder: string | null = null;
  private sel: string | null = null;
  private sort: Sort = 'updated';
  private query = '';
  private preview = new Audio();
  private previewUrl = '';
  private previewId = '';
  private playing = false;

  constructor(private readonly host: HomeHost) {
    this.el = document.getElementById('home')!;
    this.list = document.getElementById('homeList')!;
    this.preview.loop = true;
    this.preview.addEventListener('play', () => { this.playing = true; this.paintPlayer(); });
    this.preview.addEventListener('pause', () => { this.playing = false; this.paintPlayer(); });
    this.el.querySelectorAll<HTMLButtonElement>('[data-h]').forEach((b) => b.addEventListener('click', () => this.action(b.dataset.h!)));
    const q = document.getElementById('homeQuery') as HTMLInputElement;
    q.addEventListener('input', () => { this.query = q.value.trim(); this.render(); });
    this.list.addEventListener('click', (e) => this.onListClick(e));
  }

  /** 今見ているフォルダ（一番上なら ''） */
  get currentFolder() {
    return this.folder ?? '';
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  /** 画面を出す（select の曲を選んだ状態で、その曲のフォルダを開く） */
  async show(select?: string | null) {
    this.el.classList.remove('hidden');
    await this.reload();
    if (select) {
      const e = this.songs.find((x) => x.id === select);
      if (e) {
        this.folder = e.folder || null;
        this.sel = e.id;
      }
    }
    this.render(true);
  }

  hide() {
    this.el.classList.add('hidden');
    this.stopPreview();
  }

  async reload() {
    this.songs = await listSongs();
    this.folders = await listFolders();
    // 曲が入っているのに一覧に無いフォルダも出す
    for (const s of this.songs) if (s.folder && !this.folders.includes(s.folder)) this.folders.push(s.folder);
    if (this.folder && !this.folders.includes(this.folder)) this.folder = null;
  }

  /** 読み込んだ・作った曲を選ぶ */
  async select(id: string) {
    await this.reload();
    const e = this.songs.find((x) => x.id === id);
    if (e) {
      this.folder = e.folder || null;
      this.sel = id;
    }
    this.render(true);
    if (e) void this.startPreview(e);
  }

  private sorted(list: SongEntry[]) {
    const s = [...list];
    if (this.sort === 'title') s.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
    else if (this.sort === 'bpm') s.sort((a, b) => a.bpm - b.bpm);
    else s.sort((a, b) => b.updatedAt - a.updatedAt);
    return s;
  }

  /** 今の一覧に出す曲（検索中は全部の曲から） */
  private shown(): SongEntry[] {
    if (this.query) {
      const q = this.query.toLowerCase();
      return this.sorted(this.songs.filter((s) => `${s.title} ${s.subtitle}`.toLowerCase().includes(q)));
    }
    return this.sorted(this.songs.filter((s) => (s.folder || null) === this.folder));
  }

  private render(scrollToSel = false) {
    const songs = this.shown();
    const rows: string[] = [];
    if (!this.query && this.folder !== null) {
      rows.push(`<button class="hc hc-back" data-back>${ICON.back}<span class="hc-name">${esc(this.folder)}</span><span class="hc-meta">${songs.length} 曲</span></button>`);
    }
    if (!this.query && this.folder === null) {
      for (const f of [...this.folders].sort((a, b) => a.localeCompare(b, 'ja'))) {
        const n = this.songs.filter((s) => s.folder === f).length;
        rows.push(`<div class="hc hc-folder" data-folder="${esc(f)}">${ICON.folder}<span class="hc-name">${esc(f)}</span><span class="hc-meta">${n} 曲</span><button class="hc-more" data-fmore="${esc(f)}" aria-label="フォルダの操作">${ICON.more}</button></div>`);
      }
    }
    for (const s of songs) {
      if (s.id === this.sel) {
        const courses = s.courses.map((c) => `<span class="hd hd-${esc(c.name.toLowerCase())}">${esc(COURSE_SHORT[c.name] ?? c.name)}<b>${c.level}</b></span>`).join('');
        rows.push(`<div class="hc hc-song hc-sel" data-song="${s.id}">
          <div class="hc-jacket">${jacket(s)}</div>
          <div class="hc-body">
            <div class="hc-title">${esc(s.title)}</div>
            <div class="hc-sub">${esc(s.subtitle || 'Unknown artist')}</div>
            <div class="hc-stat"><span>BPM</span><b>${fmtBpm(s)}</b><span>LENGTH</span><b>${fmtLen(s.length)}</b></div>
            <div class="hc-diffs">${courses}</div>
          </div>
          <div class="hc-acts">
            <button class="hc-play" data-play="${s.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>プレイ</button>
            <button class="hc-edit" data-edit="${s.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>編集</button>
            <button class="hc-more" data-smore="${s.id}" aria-label="曲の操作">${ICON.more}</button>
          </div>
        </div>`);
      } else {
        rows.push(`<div class="hc hc-song" data-song="${s.id}"><span class="hc-dot"></span><span class="hc-name">${esc(s.title)}</span><span class="hc-meta">${fmtBpm(s)}</span></div>`);
      }
    }
    if (!rows.length) {
      rows.push(`<div class="hc-empty">${this.query ? '見つかりませんでした' : 'まだ曲がありません。左上の ⤓ で .tja / .zip を読み込むか、＋で新しく作れます'}</div>`);
    }
    this.list.innerHTML = rows.join('');
    (document.getElementById('homeSort') as HTMLElement).textContent = SORT_LABEL[this.sort];
    (document.getElementById('homePath') as HTMLElement).textContent = this.query ? `「${this.query}」の検索` : this.folder ?? 'すべてのフォルダ';
    (document.getElementById('homeCount') as HTMLElement).textContent = String(this.songs.length);
    if (scrollToSel) this.list.querySelector('.hc-sel')?.scrollIntoView({ block: 'center' });
    this.paintPlayer();
  }

  private onListClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const d = (sel: string) => t.closest<HTMLElement>(sel);
    let x: HTMLElement | null;
    if ((x = d('[data-play]'))) { this.stopPreview(); void this.host.open(x.dataset.play!, 'play'); return; }
    if ((x = d('[data-edit]'))) { this.stopPreview(); void this.host.open(x.dataset.edit!, 'edit'); return; }
    if ((x = d('[data-smore]'))) { this.songMenu(x.dataset.smore!, x); return; }
    if ((x = d('[data-fmore]'))) { this.folderMenu(x.dataset.fmore!, x); return; }
    if (d('[data-back]')) { this.folder = null; this.render(); return; }
    if ((x = d('[data-folder]'))) { this.folder = x.dataset.folder!; this.render(); this.list.scrollTop = 0; return; }
    if ((x = d('[data-song]'))) {
      const id = x.dataset.song!;
      if (this.sel === id) return;
      this.sel = id;
      this.render();
      const s = this.songs.find((q) => q.id === id);
      if (s) void this.startPreview(s);
    }
  }

  private async action(a: string) {
    if (a === 'import') this.host.importFiles();
    else if (a === 'settings') this.host.settings();
    else if (a === 'new') { this.stopPreview(); await this.host.create(this.folder ?? ''); }
    else if (a === 'folder') {
      const name = prompt('新しいフォルダの名前')?.trim();
      if (!name) return;
      await addFolder(name);
      await this.reload();
      this.folder = null;
      this.render();
    } else if (a === 'sort') {
      const order: Sort[] = ['updated', 'title', 'bpm'];
      this.sort = order[(order.indexOf(this.sort) + 1) % order.length];
      this.render(true);
    } else if (a === 'search') {
      const box = document.getElementById('homeSearch')!;
      box.classList.toggle('hidden');
      const q = document.getElementById('homeQuery') as HTMLInputElement;
      if (!box.classList.contains('hidden')) q.focus();
      else { q.value = ''; this.query = ''; this.render(true); }
    } else if (a === 'root') { this.folder = null; this.query = ''; this.render(); }
    else if (a === 'recent') {
      const s = [...this.songs].sort((p, q) => q.updatedAt - p.updatedAt)[0];
      if (s) void this.select(s.id);
    } else if (a === 'prev' || a === 'next') {
      const list = this.shown();
      if (!list.length) return;
      const i = list.findIndex((s) => s.id === this.sel);
      const j = i < 0 ? 0 : (i + (a === 'next' ? 1 : -1) + list.length) % list.length;
      this.sel = list[j].id;
      this.render(true);
      void this.startPreview(list[j]);
    } else if (a === 'pp') {
      if (this.playing) this.preview.pause();
      else {
        const s = this.songs.find((q) => q.id === this.sel);
        if (s && this.previewId === s.id) void this.preview.play().catch(() => {});
        else if (s) void this.startPreview(s);
      }
    }
  }

  // ---------- 試聴 ----------

  private async startPreview(s: SongEntry) {
    const id = s.id;
    this.previewId = id;
    this.preview.pause();
    const a: AudioFile | null = await loadSongAudio(id);
    if (this.previewId !== id || !this.visible) return;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = '';
    if (!a) { this.paintPlayer(); return; }
    this.previewUrl = URL.createObjectURL(new Blob([a.data]));
    this.preview.src = this.previewUrl;
    this.preview.currentTime = 0;
    const start = Math.max(0, s.demoStart || 0);
    this.preview.addEventListener('loadedmetadata', () => { try { this.preview.currentTime = start; } catch { /* 無視 */ } }, { once: true });
    void this.preview.play().catch(() => { this.playing = false; this.paintPlayer(); });
  }

  stopPreview() {
    this.previewId = '';
    this.preview.pause();
  }

  private paintPlayer() {
    const b = this.el.querySelector<HTMLElement>('[data-h="pp"]');
    if (b) b.innerHTML = this.playing
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>';
    this.el.classList.toggle('home-playing', this.playing);
  }

  // ---------- 曲・フォルダの操作 ----------

  private popup(anchor: HTMLElement, items: [string, () => void | Promise<void>, boolean?][]) {
    document.querySelector('.home-pop')?.remove();
    const pop = document.createElement('div');
    pop.className = 'home-pop';
    pop.innerHTML = items.map(([l, , danger], i) => `<button data-i="${i}" class="${danger ? 'bad' : ''}">${esc(l)}</button>`).join('');
    this.el.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const hr = this.el.getBoundingClientRect();
    pop.style.right = `${Math.max(8, hr.right - r.right)}px`;
    pop.style.top = `${Math.min(hr.height - pop.offsetHeight - 8, r.bottom - hr.top + 4)}px`;
    pop.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (!b) return;
      pop.remove();
      void items[Number(b.dataset.i)][1]();
    });
    setTimeout(() => document.addEventListener('pointerdown', (e) => { if (!pop.contains(e.target as Node)) pop.remove(); }, { once: true }), 0);
  }

  private songMenu(id: string, anchor: HTMLElement) {
    const s = this.songs.find((x) => x.id === id);
    if (!s) return;
    const moves: [string, () => Promise<void>][] = [
      ...(s.folder ? [['一番上へ出す', async () => { await moveSong(id, ''); await this.select(id); }] as [string, () => Promise<void>]] : []),
      ...this.folders.filter((f) => f !== s.folder).map((f) => [`「${f}」へ移す`, async () => { await moveSong(id, f); await this.select(id); }] as [string, () => Promise<void>]),
    ];
    this.popup(anchor, [
      ...moves,
      ['新しいフォルダへ移す…', async () => {
        const name = prompt('新しいフォルダの名前')?.trim();
        if (!name) return;
        await addFolder(name);
        await moveSong(id, name);
        await this.select(id);
      }],
      ['この曲を消す', async () => {
        if (!confirm(`「${s.title}」を消しますか？（譜面と音源がこのブラウザから消えます）`)) return;
        this.stopPreview();
        await deleteSong(id);
        this.sel = null;
        await this.reload();
        this.render();
        this.host.toast(`「${s.title}」を消しました`);
      }, true],
    ]);
  }

  private folderMenu(name: string, anchor: HTMLElement) {
    this.popup(anchor, [
      ['名前を変える', async () => {
        const to = prompt('フォルダの名前', name)?.trim();
        if (!to || to === name) return;
        await renameFolder(name, to);
        await this.reload();
        this.render();
      }],
      ['フォルダを消す（曲は残す）', async () => {
        if (!confirm(`フォルダ「${name}」を消しますか？（中の曲は一番上に出ます）`)) return;
        await deleteFolder(name);
        await this.reload();
        this.render();
      }, true],
    ]);
  }
}
