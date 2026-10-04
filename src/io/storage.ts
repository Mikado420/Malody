import type { EChart } from '../chart/model';
import type { AudioFile } from './load';

/**
 * 作業中の譜面と音源をブラウザ内（IndexedDB）に自動保存する。
 * 音源は大きいので、譜面とは別のキーに、変わったときだけ保存する。
 * 使えない環境（プライベートブラウズ等）では黙って何もしない。
 */

const DB = 'malody-web-editor';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(key: string, value: unknown) {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* 保存できない環境 */
  }
}

async function get<T>(key: string): Promise<T | null> {
  try {
    const db = await open();
    const v = await new Promise<T | null>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return v;
  } catch {
    return null;
  }
}

export interface SavedChart {
  chart: EChart;
  courseIndex: number;
  savedAt: number;
}

export const saveChart = (v: SavedChart) => put('chart', v);
export const saveAudio = (v: AudioFile | null) => put('audio', v);
export const loadChart = () => get<SavedChart>('chart');
export const loadAudio = () => get<AudioFile>('audio');

/** 自分で読み込んだ打音（ドン / カッ） */
export const saveHitSound = (kind: 'don' | 'ka' | 'balloon', v: AudioFile | null) => put(`hit-${kind}`, v);
export const loadHitSound = (kind: 'don' | 'ka' | 'balloon') => get<AudioFile>(`hit-${kind}`);
