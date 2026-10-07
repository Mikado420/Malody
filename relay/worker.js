// TJA Chart Studio のリンク取り込み用の中継役（Cloudflare Workers に貼るコード）
// トークンをここにだけ置き、アプリからはトークン無しで GitHub の fetch-audio 処理を使えるようにする。
// 設定（Workers の Settings → Variables and Secrets）:
//   GITHUB_TOKEN（Secret）: fetch-audio.yml のあるリポジトリの Actions・Contents を読み書きできるトークン
//   REPO（Text）         : そのリポジトリ（例: Mikado420/Malody）
//   PASS（Secret）       : 合言葉（空なら誰でも使える）
//   ALLOW_ORIGIN（Text） : アプリのサイト（例: https://mikado420.github.io）。空なら * 
export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Accept,X-Pass,X-GitHub-Api-Version',
      'Access-Control-Max-Age': '86400',
    };
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (env.PASS && req.headers.get('X-Pass') !== env.PASS) return json(403, { message: '合言葉が違います' });
    if (!env.GITHUB_TOKEN || !env.REPO) return json(500, { message: '中継役の設定（GITHUB_TOKEN・REPO）がありません' });

    const u = new URL(req.url);
    const path = u.pathname;
    const ref = u.searchParams.get('ref') || '';
    const outRef = /^out-[a-z0-9]{4,40}$/;
    // 使ってよい GitHub の API だけ通す
    const allowed =
      (req.method === 'POST' && path === '/actions/workflows/fetch-audio.yml/dispatches') ||
      (req.method === 'GET' && (path === '/actions/workflows/fetch-audio.yml' || path === '/actions/workflows/fetch-audio.yml/runs')) ||
      (req.method === 'GET' && /^\/git\/ref\/heads\/out-[a-z0-9]{4,40}$/.test(path)) ||
      (req.method === 'GET' && /^\/contents\/(audio\.ogg|status\.txt|log\.txt|title\.txt|artist\.txt)$/.test(path) && outRef.test(ref)) ||
      (req.method === 'DELETE' && /^\/git\/refs\/heads\/out-[a-z0-9]{4,40}$/.test(path));
    if (!allowed) return json(404, { message: 'not allowed' });

    let body;
    if (req.method === 'POST') {
      // 頼む内容を確かめる（main の処理に、url と id だけ）
      let j;
      try { j = await req.json(); } catch { return json(400, { message: 'bad body' }); }
      const url = String(j?.inputs?.url || '');
      const id = String(j?.inputs?.id || '');
      if (!/^https?:\/\//.test(url) || url.length > 500 || !/^[a-z0-9]{4,40}$/.test(id)) return json(400, { message: 'bad input' });
      body = JSON.stringify({ ref: 'main', inputs: { url, id } });
    }
    const r = await fetch(`https://api.github.com/repos/${env.REPO}${path}${u.search}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: req.headers.get('Accept') || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tjacs-relay',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });
    const h = new Headers(cors);
    h.set('content-type', r.headers.get('content-type') || 'application/octet-stream');
    return new Response(r.body, { status: r.status, headers: h });
  },
};
