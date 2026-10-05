import { analyzeTempo } from './tempo';

/** BPM・OFFSET の測定を、画面を止めないように別のスレッドで行う */
const ctx = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<{ mono: Float32Array; sr: number }>) => void) | null;
};
ctx.onmessage = (e) => {
  const { mono, sr } = e.data;
  try {
    const result = analyzeTempo(mono, sr, (p) => ctx.postMessage({ type: 'progress', p }));
    ctx.postMessage({ type: 'done', result });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
