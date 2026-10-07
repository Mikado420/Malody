/**
 * 文字列 → シフトJIS（Windows の CP932）のバイト列。
 * ブラウザには書き出し用の変換が無いので、読み込み用の TextDecoder('shift_jis') で全部の文字コードを読んで、逆引きの表を作る。
 * シフトJIS に無い文字は「?」にする。
 */
let table: Map<number, number> | null = null;

function buildTable(): Map<number, number> {
  const m = new Map<number, number>();
  const dec = new TextDecoder('shift_jis');
  // 1 バイトの文字（半角カナ）
  for (let b = 0xa1; b <= 0xdf; b++) {
    const ch = dec.decode(new Uint8Array([b]));
    if (ch.length === 1 && ch !== '�') m.set(ch.charCodeAt(0), b);
  }
  // 2 バイトの文字。重複（NEC・IBM の拡張文字）は先に出てくるほうを使う
  const leads: number[] = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xfc; b++) leads.push(b);
  for (const lead of leads) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([lead, trail]));
      if (ch.length !== 1 || ch === '�') continue;
      const c = ch.charCodeAt(0);
      if (!m.has(c)) m.set(c, (lead << 8) | trail);
    }
  }
  return m;
}

export function encodeSJIS(text: string): Uint8Array {
  table ??= buildTable();
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) { out.push(c); continue; }
    const v = c <= 0xffff ? table.get(c) : undefined;
    if (v === undefined) out.push(0x3f);
    else if (v < 0x100) out.push(v);
    else out.push(v >> 8, v & 0xff);
  }
  return new Uint8Array(out);
}
