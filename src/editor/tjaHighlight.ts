/**
 * TJA のテキストの色分け（入力欄の後ろに、同じ位置で色付きの文字を重ねて表示する）。
 *
 * 軽くするための工夫:
 * - テキスト全体を見るのは、行の始まりの位置・#START〜#END の中かどうか・連打/風船の範囲を調べる 1 回だけ
 *   （文字列を 1 回なぞるだけ。色付きの HTML は作らない）
 * - 色付きの HTML を作るのは、画面に見えている行（＋前後に少し）だけ
 * - 同じ色が続く文字は 1 つの span にまとめる
 */

export const TJA_COLOR = {
  header: '#f4f4f4', // #START より前（曲名・難易度など）
  command: '#c792ea', // #BPMCHANGE などの命令
  commandArg: '#e3c8f5',
  don: '#ff5a4a', // 1, 3
  ka: '#5cc8f0', // 2, 4
  roll: '#ffd23a', // 5, 6 と、8 までのつなぎ
  balloon: '#ff9a2e', // 7, 9 と、8 までのつなぎ
  zero: '#55555c', // 0
  other: '#9a9aa2', // カンマなど
  comment: '#6e6e76', // // から後ろ
} as const;

export interface TjaMarks {
  /** 各行の先頭の文字位置 */
  lineStarts: number[];
  /** 各行が #START〜#END の中か */
  inside: Uint8Array;
  /** 連打・風船の範囲 [始まり, 終わり(8 の位置), 色]。8 で閉じたものだけ */
  ranges: [number, number, string][];
}

/** テキスト全体を 1 回なぞって、色分けに必要な情報を集める */
export function tjaMarks(text: string): TjaMarks {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const inside = new Uint8Array(lineStarts.length);
  const ranges: [number, number, string][] = [];
  let inChart = false;
  let open: { at: number; color: string } | null = null;
  for (let li = 0; li < lineStarts.length; li++) {
    const a = lineStarts[li];
    const b = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : text.length;
    const line = text.slice(a, b);
    const t = line.trimStart();
    const head = t.slice(0, 6).toUpperCase();
    if (!inChart) {
      if (head.startsWith('#START')) {
        inChart = true;
        inside[li] = 1;
        open = null;
      }
      continue;
    }
    inside[li] = 1;
    if (head.startsWith('#END')) {
      inChart = false;
      open = null;
      continue;
    }
    if (t.startsWith('#')) continue;
    const cut = line.indexOf('//');
    const end = cut >= 0 ? a + cut : b;
    for (let i = a; i < end; i++) {
      const c = text.charCodeAt(i);
      if (c === 53 || c === 54) {
        // 5, 6
        if (!open) open = { at: i, color: TJA_COLOR.roll };
      } else if (c === 55 || c === 57) {
        // 7, 9
        if (!open) open = { at: i, color: TJA_COLOR.balloon };
      } else if (c === 56) {
        // 8
        if (open) {
          ranges.push([open.at, i, open.color]);
          open = null;
        }
      }
    }
  }
  return { lineStarts, inside, ranges };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function digitColor(c: string): string {
  switch (c) {
    case '1':
    case '3':
      return TJA_COLOR.don;
    case '2':
    case '4':
      return TJA_COLOR.ka;
    case '5':
    case '6':
      return TJA_COLOR.roll;
    case '7':
    case '9':
      return TJA_COLOR.balloon;
    case '0':
      return TJA_COLOR.zero;
    default:
      return TJA_COLOR.other;
  }
}

/** 行 from〜to（to は含まない）の色付き HTML */
export function tjaLinesHtml(text: string, m: TjaMarks, from: number, to: number): string {
  const out: string[] = [];
  // 範囲は位置の順に並んでいるので、表示する最初の行より前で終わるものを飛ばしておく
  let ri = 0;
  const startPos = m.lineStarts[from] ?? text.length;
  while (ri < m.ranges.length && m.ranges[ri][1] < startPos) ri++;
  for (let li = from; li < to && li < m.lineStarts.length; li++) {
    const a = m.lineStarts[li];
    const b = li + 1 < m.lineStarts.length ? m.lineStarts[li + 1] - 1 : text.length;
    const line = text.slice(a, b);
    if (!m.inside[li]) {
      out.push(`<span style="color:${TJA_COLOR.header}">${esc(line)}</span>`);
      continue;
    }
    const t = line.trimStart();
    if (t.startsWith('#')) {
      const lead = line.length - t.length;
      const sp = t.search(/\s/);
      const name = sp < 0 ? t : t.slice(0, sp);
      const rest = sp < 0 ? '' : t.slice(sp);
      out.push(
        `${esc(line.slice(0, lead))}<span style="color:${TJA_COLOR.command}">${esc(name)}</span><span style="color:${TJA_COLOR.commandArg}">${esc(rest)}</span>`,
      );
      continue;
    }
    const cut = line.indexOf('//');
    const body = cut >= 0 ? line.slice(0, cut) : line;
    let html = '';
    let runColor = '';
    let run = '';
    for (let k = 0; k < body.length; k++) {
      const pos = a + k;
      while (ri < m.ranges.length && m.ranges[ri][1] < pos) ri++;
      const r = m.ranges[ri];
      const ch = body[k];
      const color = r && r[0] <= pos && pos <= r[1] && ch >= '0' && ch <= '9' ? r[2] : digitColor(ch);
      if (color !== runColor) {
        if (run) html += `<span style="color:${runColor}">${esc(run)}</span>`;
        run = '';
        runColor = color;
      }
      run += ch;
    }
    if (run) html += `<span style="color:${runColor}">${esc(run)}</span>`;
    if (cut >= 0) html += `<span style="color:${TJA_COLOR.comment}">${esc(line.slice(cut))}</span>`;
    out.push(html);
  }
  return out.join('\n');
}
