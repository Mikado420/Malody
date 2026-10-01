import { decodeText } from '../chart/decode';

/**
 * 依存ライブラリなしの zip 読み書き。
 * 展開はブラウザ標準の DecompressionStream('deflate-raw') を使う（iOS Safari 16.4 以降 / Chrome / Firefox）。
 * 日本語ファイル名は UTF-8 フラグが無ければ Shift_JIS として読む（Windows で作った zip 対策）。
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw' as CompressionFormat);
  return streamToBytes(new Blob([data as BlobPart]).stream().pipeThrough(ds));
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw' as CompressionFormat);
  return streamToBytes(new Blob([data as BlobPart]).stream().pipeThrough(cs));
}

export function isZip(buf: ArrayBuffer) {
  if (buf.byteLength < 4) return false;
  return new DataView(buf).getUint32(0, true) === 0x04034b50;
}

export async function readZip(buf: ArrayBuffer): Promise<ZipEntry[]> {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip ファイルとして読めませんでした');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const nameBytes = u8.slice(p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;

    const name = flags & 0x800 ? new TextDecoder().decode(nameBytes) : decodeText(nameBytes.buffer);
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    if (flags & 0x1) continue; // 暗号化は非対応

    const lnlen = dv.getUint16(lho + 26, true);
    const lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    const comp = u8.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: comp.slice() });
    else if (method === 8) out.push({ name, data: await inflateRaw(comp) });
  }
  return out;
}

// ---------- 書き出し ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** compress=true のファイルは deflate、それ以外（音源など）は無圧縮で格納 */
export async function writeZip(files: { name: string; data: Uint8Array; compress?: boolean }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const body = f.compress ? await deflateRaw(f.data) : f.data;
    const method = f.compress ? 8 : 0;

    const lh = new Uint8Array(30 + name.length);
    const l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x800, true); // UTF-8 ファイル名
    l.setUint16(8, method, true);
    l.setUint16(12, 0x21, true); // 1980-01-01
    l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, f.data.length, true);
    l.setUint16(26, name.length, true);
    lh.set(name, 30);

    const ch = new Uint8Array(46 + name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true);
    c.setUint16(10, method, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    ch.set(name, 46);

    parts.push(lh, body);
    central.push(ch);
    offset += lh.length + body.length;
  }

  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const eocd = new Uint8Array(22);
  const e = new DataView(eocd.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, offset, true);

  return new Blob([...parts, ...central, eocd] as BlobPart[], { type: 'application/zip' });
}
