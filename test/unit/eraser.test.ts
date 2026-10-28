import { describe, expect, it } from 'vitest';
import { erasePaths, pathsTouch, quadsTouch } from '../../src/shared/eraser';
import type { Point, Quad } from '../../src/shared/annotations';

const line = (from: number, to: number, y = 0): Point[] => [
  { x: from, y },
  { x: to, y },
];

describe('Radierer', () => {
  it('Pixel-Radierer teilt einen Strich in zwei', () => {
    const result = erasePaths([line(0, 100)], { x: 50, y: 0 }, { x: 50, y: 0 }, 5);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    const [left, right] = result as Point[][];
    expect(Math.max(...(left as Point[]).map((p) => p.x))).toBeLessThan(45.1);
    expect(Math.min(...(right as Point[]).map((p) => p.x))).toBeGreaterThan(54.9);
    expect((left as Point[])[0]).toEqual({ x: 0, y: 0 });
    expect((right as Point[]).at(-1)).toEqual({ x: 100, y: 0 });
  });

  it('Pixel-Radierer: weit weg ändert nichts, ganz darüber löscht alles', () => {
    expect(erasePaths([line(0, 100)], { x: 50, y: 30 }, { x: 60, y: 30 }, 5)).toBeNull();
    expect(erasePaths([line(0, 10)], { x: -5, y: 0 }, { x: 15, y: 0 }, 5)).toEqual([]);
  });

  it('Pixel-Radierer folgt der ganzen überstrichenen Strecke', () => {
    // Senkrecht quer über einen waagerechten Strich gewischt: Lücke in der Mitte
    const result = erasePaths([line(0, 100)], { x: 50, y: -20 }, { x: 50, y: 20 }, 2);
    expect(result).toHaveLength(2);
  });

  it('Strich-Radierer und Textmarker-Radierer erkennen Berührung', () => {
    expect(pathsTouch([line(0, 100)], { x: 50, y: 3 }, { x: 50, y: 3 }, 4)).toBe(true);
    expect(pathsTouch([line(0, 100)], { x: 50, y: 10 }, { x: 60, y: 10 }, 4)).toBe(false);
    const quad: Quad = [
      { x: 0, y: 10 },
      { x: 100, y: 10 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(quadsTouch([quad], { x: 50, y: 5 }, { x: 50, y: 5 }, 1)).toBe(true);
    expect(quadsTouch([quad], { x: 50, y: 30 }, { x: 60, y: 30 }, 1)).toBe(false);
  });
});
