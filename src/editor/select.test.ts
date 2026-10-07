import { describe, expect, it } from 'vitest';
import { TPB } from '../chart/model';
import { Editor } from './editor';

describe('選択・コピー・貼り付け', () => {
  it('範囲をコピーして別の位置に貼り付け、切り取りで消える', () => {
    const ed = new Editor();
    ed.divisor = 16;
    for (const k of [0, 1, 2, 3]) ed.tap(k * TPB);
    ed.tool = 'select';
    ed.tap(0);
    ed.tap(2 * TPB);
    expect(ed.selectedNotes().length).toBe(3);
    expect(ed.copySelection()).toBe(3);
    expect(ed.paste(8 * TPB)).toBe(3);
    expect(ed.course.notes.map((n) => n.tick / TPB)).toEqual([0, 1, 2, 3, 8, 9, 10]);
    // 貼った範囲が選ばれている → 切り取り
    expect(ed.cutSelection()).toBe(3);
    expect(ed.course.notes.length).toBe(4);
    ed.undo();
    expect(ed.course.notes.length).toBe(7);
  });

  it('貼り付けは範囲のノーツを置き換える', () => {
    const ed = new Editor();
    ed.tap(0);
    ed.tool = 'ka';
    ed.tap(TPB * 4);
    ed.tap(TPB * 4.5);
    ed.tool = 'select';
    ed.tap(0);
    ed.tap(TPB);
    ed.copySelection();
    ed.paste(TPB * 4);
    expect(ed.course.notes.map((n) => `${n.tick / TPB}${n.type}`)).toEqual(['0don', '4don']);
  });

  it('グリッドに乗っていないノーツも、タップで消せる', () => {
    const ed = new Editor();
    ed.divisor = 32;
    ed.tap(TPB + TPB / 8);
    ed.tap(TPB);
    ed.divisor = 8;
    // 外れたノーツの上をタップ → そのノーツが消える（グリッド上のノーツは残る）
    ed.tap(TPB + TPB / 8, TPB / 4);
    expect(ed.course.notes.map((n) => n.tick)).toEqual([TPB]);
  });
});
