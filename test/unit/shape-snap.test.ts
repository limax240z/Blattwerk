// Formerkennung des Stifts: wackelige Striche werden zu Linie, Rechteck, Dreieck oder Ellipse.
import { describe, expect, it } from 'vitest';
import type { Point } from '../../src/shared/annotations';
import { recognizeShape, transformShape } from '../../src/renderer/features/annotations/shape-snap';

// Kleine, wiederholbare Unruhe statt Zufall
const wobble = (i: number, amount: number) => Math.sin(i * 12.9898) * amount;

// Punkte entlang eines Streckenzugs, alle `step` Punkte ein Stück
function along(corners: Point[], step = 4): Point[] {
  const points: Point[] = [];
  for (let c = 0; c < corners.length - 1; c++) {
    const a = corners[c] as Point;
    const b = corners[c + 1] as Point;
    const n = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let i = 0; i < n; i++) points.push({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
  }
  points.push(corners.at(-1) as Point);
  return points.map((p, i) => ({ x: p.x + wobble(i, 0.8), y: p.y + wobble(i + 7, 0.8) }));
}

describe('Formerkennung', () => {
  it('erkennt eine gerade Linie', () => {
    const path = recognizeShape(along([{ x: 10, y: 10 }, { x: 150, y: 40 }]));
    expect(path).toHaveLength(2);
  });

  it('lässt eine Kurve als Freihandstrich', () => {
    const arc = Array.from({ length: 40 }, (_, i) => ({ x: i * 4, y: Math.sin(i / 6) * 40 }));
    expect(recognizeShape(arc)).toBeNull();
  });

  it('erkennt ein Rechteck und macht es gerade', () => {
    const wonky = along([{ x: 10, y: 10 }, { x: 160, y: 14 }, { x: 158, y: 90 }, { x: 12, y: 88 }, { x: 11, y: 12 }]);
    const path = recognizeShape(wonky);
    expect(path).toHaveLength(5);
    const xs = new Set(path?.map((p) => Math.round(p.x)));
    expect(xs.size).toBe(2);
  });

  it('erkennt ein Dreieck', () => {
    const path = recognizeShape(along([{ x: 10, y: 10 }, { x: 150, y: 20 }, { x: 70, y: 130 }, { x: 11, y: 11 }]));
    expect(path).toHaveLength(4);
  });

  it('erkennt einen Kreis', () => {
    const circle = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 59) * Math.PI * 2;
      return { x: 100 + 50 * Math.cos(a) + wobble(i, 1.5), y: 100 + 50 * Math.sin(a) + wobble(i + 3, 1.5) };
    });
    const path = recognizeShape(circle);
    expect(path).not.toBeNull();
    expect(path?.length).toBeGreaterThan(20);
    // geschlossen
    expect(path?.[0]).toEqual(path?.at(-1));
  });

  it('ignoriert Punkte und kurze Kringel', () => {
    expect(recognizeShape([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }])).toBeNull();
  });
});

describe('Form nach dem Einrasten weiterziehen', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
    { x: 0, y: 0 },
  ];
  const grab = { x: 100, y: 100 };

  it('weiter weg von der Mitte vergrößert, näher verkleinert, die Mitte bleibt', () => {
    const big = transformShape(square, grab, { x: 150, y: 150 });
    expect(big[0]).toEqual({ x: -50, y: -50 });
    expect(big[2]).toEqual({ x: 150, y: 150 });
    const small = transformShape(square, grab, { x: 75, y: 75 });
    expect(small[0]).toEqual({ x: 25, y: 25 });
  });

  it('fast gerade bleibt gerade, deutlich gedreht dreht mit', () => {
    // 5° neben der Ecke: rastet gerade ein
    const a = (5 * Math.PI) / 180;
    const r = Math.hypot(50, 50);
    const near = transformShape(square, grab, { x: 50 + r * Math.cos(Math.PI / 4 + a), y: 50 + r * Math.sin(Math.PI / 4 + a) });
    expect(near[1]?.x).toBeCloseTo(100);
    expect(near[1]?.y).toBeCloseTo(0);
    // 45° gedreht: Ecke wandert
    const turned = transformShape(square, grab, { x: 50, y: 50 + r });
    expect(turned[0]?.x).toBeCloseTo(50);
  });
});
