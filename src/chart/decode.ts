/**
 * TJA は Shift_JIS のことが多いので、まず UTF-8 として厳密に読み、失敗したら Shift_JIS で読み直す。
 */
export function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}
