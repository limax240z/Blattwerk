// Begrenzung auf die Seite: Verschieben, Anlegen am Rand, Größe ändern, wachsende Textfelder, Skalieren.
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/shared/annotations';
import { createLine, createStamp, createSignature, type Base } from '../../src/renderer/features/annotations/create';
import { clampMove, contentBounds, fitFreeText, fitOnPage, keepOnPage, maxScale, resizeFrom } from '../../src/renderer/features/annotations/geometry';

const page: Rect = [0, 0, 600, 800];
const base: Base = { id: 'a', ref: null, pageIndex: 0, author: 'Test', created: 'D:20260101120000Z', modified: 'D:20260101120000Z', contents: '', replies: [], opacity: 1 } as unknown as Base;
const black = { r: 0, g: 0, b: 0 };

describe('Verschieben am Seitenrand', () => {
  it('hält ein Rechteck auf der Seite', () => {
    expect(clampMove([500, 700, 580, 780], 50, 50, page)).toEqual({ dx: 20, dy: 20 });
    expect(clampMove([10, 10, 50, 50], -30, -5, page)).toEqual({ dx: -10, dy: -5 });
  });

  it('lässt schon hinausragende Teile stehen, aber nicht weiter hinaus', () => {
    expect(clampMove([-20, 100, 50, 150], -10, 0, page)).toEqual({ dx: 0, dy: 0 });
    expect(clampMove([-20, 100, 50, 150], 15, 0, page)).toEqual({ dx: 15, dy: 0 });
  });
});

describe('Anlegen am Seitenrand', () => {
  it('schiebt einen Stempel an der Kante ganz auf die Seite', () => {
    const stamp = keepOnPage(createStamp(base, { x: 590, y: 5 }, 'approved', 'OK', black), page);
    expect(stamp.rect[2]).toBeCloseTo(600);
    expect(stamp.rect[1]).toBeCloseTo(0);
  });

  it('schiebt eine Linie in Standardlänge zurück', () => {
    const line = keepOnPage(createLine(base, 'line', { x: 560, y: 400 }, { x: 560, y: 400 }, black, 2), page);
    expect(Math.max(line.start.x, line.end.x)).toBeCloseTo(600);
    expect(contentBounds(line)[0]).toBeGreaterThanOrEqual(0);
  });

  it('richtet Übergroßes links oben aus', () => {
    expect(fitOnPage([-50, -50, 700, 900], page)).toEqual({ dx: 50, dy: -100 });
  });
});

describe('Größe ändern', () => {
  it('endet an der Seitenkante', () => {
    const stamp = createStamp(base, { x: 300, y: 400 }, 'approved', 'OK', black);
    const resized = resizeFrom(stamp, { x: stamp.rect[0], y: stamp.rect[1] }, { x: 900, y: 1000 }, page);
    expect(resized.rect[2]).toBe(600);
    expect(resized.rect[3]).toBe(800);
  });

  it('behält bei Unterschriften das Seitenverhältnis und bleibt auf der Seite', () => {
    const signature = createSignature(base, { x: 300, y: 700 }, 'data:', 200, 100);
    const resized = resizeFrom(signature, { x: signature.rect[0], y: signature.rect[1] }, { x: 590, y: 1000 }, page);
    const [l, b, r, t] = resized.rect;
    expect(t).toBeLessThanOrEqual(800 + 1e-9);
    expect((t - b) / (r - l)).toBeCloseTo(0.5);
  });
});

describe('Textfeld wächst mit', () => {
  it('wächst nach unten und bleibt mindestens so groß wie aufgezogen', () => {
    expect(fitFreeText({ y: 100, h: 40 }, 20, 800)).toEqual({ y: 100, h: 40 });
    expect(fitFreeText({ y: 100, h: 40 }, 120, 800)).toEqual({ y: 100, h: 122 });
  });

  it('weicht am unteren Rand nach oben aus', () => {
    expect(fitFreeText({ y: 760, h: 40 }, 100, 800)).toEqual({ y: 698, h: 102 });
  });
});

describe('Skalieren', () => {
  it('begrenzt den Faktor auf die Seite', () => {
    expect(maxScale([100, 100, 200, 200], { x: 100, y: 100 }, page)).toBeCloseTo(5);
  });

  it('lässt hinausragende Objekte wenigstens so groß, wie sie sind', () => {
    expect(maxScale([500, 100, 700, 200], { x: 500, y: 100 }, page)).toBe(1);
  });
});
