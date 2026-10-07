/**
 * リンク（YouTube・SoundCloud など）から音源を取り込む。
 * GitHub Actions の fetch-audio 処理を API で動かし、できあがった .ogg を受け取ってからブランチを消す。
 * 必要なもの: 処理の入ったリポジトリ（owner/name）と、そのリポジトリの Actions・Contents を読み書きできるトークン
 */
import type { AudioFile } from './load';

export interface LinkSetup {
  repo: string;
  token: string;
  /** 中継役（Cloudflare Workers）の URL。あればトークンの代わりにこちらを通す */
  relay?: string;
  /** 中継役の合言葉 */
  pass?: string;
}

export interface LinkResult {
  audio: AudioFile;
  title: string;
  artist: string;
}

const API = 'https://api.github.com';

async function gh(s: LinkSetup, path: string, init: RequestInit = {}, accept = 'application/vnd.github+json') {
  const ct: Record<string, string> = init.body ? { 'Content-Type': 'application/json' } : {};
  if (s.relay) {
    return fetch(`${s.relay.replace(/\/+$/, '')}${path}`, { ...init, headers: { Accept: accept, 'X-Pass': s.pass ?? '', ...ct }, cache: 'no-store' });
  }
  return fetch(`${API}/repos/${s.repo}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${s.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...ct },
    cache: 'no-store',
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 設定が使えるか確かめる（リポジトリと処理が見えるか） */
export async function testSetup(s: LinkSetup): Promise<string | null> {
  try {
    const r = await gh(s, '/actions/workflows/fetch-audio.yml');
    if (s.relay && r.status === 403) return '合言葉が違います';
    if (s.relay && r.status === 500) return '中継役の設定（GITHUB_TOKEN・REPO）がまだです';
    if (r.status === 401) return 'トークンが正しくありません';
    if (r.status === 404) return 'リポジトリか、その中の fetch-audio.yml が見つかりません（トークンにこのリポジトリへのアクセスがあるかも確認してください）';
    if (!r.ok) return `確認できませんでした（${r.status}）`;
    return null;
  } catch {
    return s.relay ? '中継役につながりませんでした（URL を確認してください）' : 'GitHub につながりませんでした';
  }
}

/** なぜ失敗したかを、取り出しの記録（ログ）から短く */
function reason(log: string): string {
  if (/confirm you.?re not a bot|Sign in to confirm/i.test(log)) return 'YouTube に「ボットではないか」と断られました。時間をおいて試すか、別の方法で音源を用意してください';
  if (/Unsupported URL/i.test(log)) return 'このリンクには対応していません';
  if (/Private video|This video is private/i.test(log)) return '非公開の動画です';
  if (/Video unavailable|not available/i.test(log)) return 'この動画・曲は見られません（削除・地域制限など）';
  if (/HTTP Error 404|404/i.test(log)) return 'リンクの先が見つかりません';
  const last = log.trim().split('\n').filter((l) => /ERROR/i.test(l)).pop();
  return last ? `取り出せませんでした: ${last.replace(/^.*?ERROR:\s*/, '').slice(0, 160)}` : '取り出せませんでした';
}

/** リンクから音源を取り込む（2〜3 分かかることがある） */
export async function fetchLink(s: LinkSetup, url: string, onStatus: (msg: string) => void): Promise<LinkResult> {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  onStatus('GitHub に頼んでいます…');
  const d = await gh(s, '/actions/workflows/fetch-audio.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { url, id } }) });
  if (s.relay && d.status === 403) throw new Error('合言葉が違います（設定を確認してください）');
  if (d.status === 401) throw new Error('トークンが正しくありません（設定を確認してください）');
  if (d.status === 403) throw new Error('トークンに Actions の書き込みの権限がありません');
  if (d.status === 404) throw new Error('リポジトリか fetch-audio.yml が見つかりません（設定を確認してください）');
  if (!d.ok) throw new Error(`頼めませんでした（${d.status}）`);
  const branch = `out-${id}`;
  const t0 = Date.now();
  try {
    for (;;) {
      await sleep(4000);
      const sec = Math.round((Date.now() - t0) / 1000);
      // できあがった？
      const ref = await gh(s, `/git/ref/heads/${branch}`);
      if (ref.ok) break;
      // 処理の様子（失敗していたら止める）
      const runs = await gh(s, '/actions/workflows/fetch-audio.yml/runs?event=workflow_dispatch&per_page=10');
      if (runs.ok) {
        const j = (await runs.json()) as { workflow_runs: { display_title: string; status: string; conclusion: string | null }[] };
        const run = j.workflow_runs.find((w) => w.display_title === `fetch ${id}`);
        if (run) {
          if (run.status === 'completed' && run.conclusion !== 'success') {
            // 置き場所に置いたあとで失敗することはないので、少し待ってもブランチが無ければ失敗
            await sleep(3000);
            if (!(await gh(s, `/git/ref/heads/${branch}`)).ok) throw new Error(`処理が失敗しました（${run.conclusion}）`);
            break;
          }
          onStatus(run.status === 'queued' ? `順番を待っています…（${sec} 秒）` : `取り出して .ogg にしています…（${sec} 秒）`);
        } else onStatus(`処理を始めています…（${sec} 秒）`);
      }
      if (Date.now() - t0 > 12 * 60 * 1000) throw new Error('時間がかかりすぎたので止めました');
    }
    onStatus('受け取っています…');
    const file = async (name: string) => gh(s, `/contents/${name}?ref=${branch}`, {}, 'application/vnd.github.raw');
    const text = async (name: string) => { const r = await file(name); return r.ok ? (await r.text()).trim() : ''; };
    const status = await text('status.txt');
    if (status !== '0') throw new Error(reason(await text('log.txt')));
    const a = await file('audio.ogg');
    if (!a.ok) throw new Error('音源を受け取れませんでした');
    const data = await a.arrayBuffer();
    const title = (await text('title.txt')).split('\n')[0] || 'audio';
    const artist = (await text('artist.txt')).split('\n')[0];
    const safe = title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'audio';
    return { audio: { name: `${safe}.ogg`, data }, title, artist };
  } finally {
    // 受け取り用のブランチを消す（無くても気にしない）
    void gh(s, `/git/refs/heads/${branch}`, { method: 'DELETE' }).catch(() => {});
  }
}
