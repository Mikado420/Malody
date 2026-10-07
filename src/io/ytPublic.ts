/**
 * YouTube の音声を、公開サーバー（Piped・Invidious）を通して受け取る。
 * GitHub のサーバーからは YouTube に断られることがあるので、そのときの 2 番目の手段。
 * 公開サーバーは止まったり断られたりするので、一覧から順に試す。
 */
import type { AudioFile } from './load';
import type { LinkResult } from './linkFetch';

/** リンクから動画の ID を取り出す（YouTube のリンクでなければ null） */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (h === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v');
      if (v) return v.slice(0, 11);
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      return m ? m[1] : null;
    }
  } catch { /* リンクでない */ }
  return null;
}

/** 一覧を取れなかったときの予備 */
const PIPED_FALLBACK = ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de', 'https://api.piped.private.coffee', 'https://pipedapi.r4fo.com'];
const INVIDIOUS_FALLBACK = ['https://inv.nadeko.net', 'https://invidious.nerdvpn.de', 'https://yewtu.be', 'https://invidious.f5.si'];

async function getJson<T>(url: string, ms = 12000): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function pipedList(): Promise<string[]> {
  try {
    const j = await getJson<{ api_url: string; up_to_date?: boolean }[]>('https://piped-instances.kavin.rocks/', 8000);
    const l = j.map((x) => x.api_url).filter(Boolean);
    return [...new Set([...l, ...PIPED_FALLBACK])];
  } catch { return PIPED_FALLBACK; }
}

async function invidiousList(): Promise<string[]> {
  try {
    const j = await getJson<[string, { uri: string; api?: boolean; type?: string }][]>('https://api.invidious.io/instances.json?sort_by=health', 8000);
    const l = j.filter(([, v]) => v.api && v.type === 'https').map(([, v]) => v.uri.replace(/\/$/, ''));
    return [...new Set([...l, ...INVIDIOUS_FALLBACK])];
  } catch { return INVIDIOUS_FALLBACK; }
}

interface Stream { url: string; mime: string; bitrate: number; size: number }

/** 音声を受け取る（大きいファイルは googlevideo の range で分けて受け取る） */
async function download(s: Stream, onP: (p: number) => void): Promise<ArrayBuffer> {
  const ac = new AbortController();
  let t = setTimeout(() => ac.abort(), 30000);
  const bump = () => { clearTimeout(t); t = setTimeout(() => ac.abort(), 30000); };
  try {
    const CH = 2_000_000;
    if (s.size > CH && /videoplayback/.test(s.url)) {
      const out = new Uint8Array(s.size);
      for (let a = 0; a < s.size; a += CH) {
        const b = Math.min(s.size, a + CH) - 1;
        const r = await fetch(`${s.url}${s.url.includes('?') ? '&' : '?'}range=${a}-${b}`, { signal: ac.signal });
        if (!r.ok) throw new Error(String(r.status));
        const part = new Uint8Array(await r.arrayBuffer());
        if (!part.length) throw new Error('empty');
        out.set(part.subarray(0, Math.min(part.length, s.size - a)), a);
        onP(Math.min(1, (b + 1) / s.size));
        bump();
      }
      return out.buffer;
    }
    const r = await fetch(s.url, { signal: ac.signal });
    if (!r.ok) throw new Error(String(r.status));
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 10000) throw new Error('too small');
    onP(1);
    return buf;
  } finally {
    clearTimeout(t);
  }
}

/** iPhone でも読める AAC（mp4）を先に、なければ Opus（webm） */
const pick = (list: Stream[]) => [...list].sort((a, b) => Number(/mp4/.test(b.mime)) - Number(/mp4/.test(a.mime)) || b.bitrate - a.bitrate);

async function viaPiped(api: string, id: string) {
  const j = await getJson<{ title: string; uploader: string; audioStreams: { url: string; mimeType: string; bitrate: number; contentLength?: number }[] }>(`${api}/streams/${id}`);
  const streams = pick(j.audioStreams.map((a) => ({ url: a.url, mime: a.mimeType, bitrate: a.bitrate, size: a.contentLength ?? 0 })));
  return { title: j.title, artist: j.uploader, streams };
}

async function viaInvidious(api: string, id: string) {
  const j = await getJson<{ title: string; author: string; adaptiveFormats: { url: string; type: string; bitrate: string; clen?: string; itag: string }[] }>(`${api}/api/v1/videos/${id}?local=true`);
  const audio = j.adaptiveFormats.filter((f) => f.type.startsWith('audio/'));
  const streams = pick(audio.map((f) => ({
    // local=true のときは、公開サーバーを通す URL（/videoplayback?…）になっている
    url: f.url.startsWith('/') ? `${api}${f.url}` : f.url,
    mime: f.type, bitrate: Number(f.bitrate) || 0, size: Number(f.clen) || 0,
  })));
  return { title: j.title, artist: j.author, streams };
}

/** 公開サーバーを順に試して、YouTube の音声を受け取る */
export async function fetchYoutubePublic(url: string, onStatus: (m: string) => void): Promise<LinkResult> {
  const id = youtubeId(url);
  if (!id) throw new Error('YouTube のリンクではありません');
  const tries: { name: string; run: () => Promise<{ title: string; artist: string; streams: Stream[] }> }[] = [];
  onStatus('公開サーバーを探しています…');
  const [pl, il] = await Promise.all([pipedList(), invidiousList()]);
  for (const api of pl.slice(0, 8)) tries.push({ name: new URL(api).hostname, run: () => viaPiped(api, id) });
  for (const api of il.slice(0, 8)) tries.push({ name: new URL(api).hostname, run: () => viaInvidious(api, id) });
  let n = 0;
  for (const t of tries) {
    n++;
    try {
      onStatus(`公開サーバーで試しています（${n}/${tries.length}: ${t.name}）…`);
      const info = await t.run();
      for (const s of info.streams.slice(0, 3)) {
        try {
          const data = await download(s, (p) => onStatus(`受け取っています…（${t.name} ${Math.round(p * 100)}%）`));
          const ext = /mp4/.test(s.mime) ? 'm4a' : 'webm';
          const safe = (info.title || 'audio').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'audio';
          const audio: AudioFile = { name: `${safe}.${ext}`, data };
          return { audio, title: info.title || 'audio', artist: info.artist || '' };
        } catch { /* 次の音声・次のサーバー */ }
      }
    } catch { /* 次のサーバー */ }
  }
  throw new Error('公開サーバーでも取れませんでした（どのサーバーも止まっているか、YouTube に断られています）');
}
