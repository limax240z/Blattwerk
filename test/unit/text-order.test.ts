// Reihenfolge der Textebene: Fuß- und Kopfzeilen, die im PDF an falscher Stelle stehen, klappen sonst die Auswahl um.
import { describe, expect, it } from 'vitest';
import { misplacedRuns, type TextBox } from '../../src/renderer/features/annotations/text-order';

const box = (top: number, left = 50, right = 500): TextBox => ({ top, bottom: top + 12, left, right });
const body = (from: number, count: number, left = 50, right = 500) => Array.from({ length: count }, (_, i) => box(from + i * 16, left, right));
const HEIGHT = 842;

describe('Reihenfolge der Textebene', () => {
  it('lässt normalen Text in Ruhe', () => {
    expect(misplacedRuns(body(60, 40), HEIGHT)).toEqual({ head: 0, tail: 0 });
  });

  it('erkennt eine Fußzeile am Anfang, auch aus mehreren Stücken', () => {
    expect(misplacedRuns([box(800, 280, 320), ...body(60, 20)], HEIGHT)).toEqual({ head: 1, tail: 0 });
    expect(misplacedRuns([box(800, 50, 200), box(800, 400, 500), ...body(60, 20)], HEIGHT)).toEqual({ head: 2, tail: 0 });
  });

  it('erkennt eine Kopfzeile am Ende', () => {
    expect(misplacedRuns([...body(100, 20), box(30, 280, 320)], HEIGHT)).toEqual({ head: 0, tail: 1 });
  });

  it('lässt zwei Spalten in Ruhe', () => {
    expect(misplacedRuns([...body(60, 40, 50, 280), ...body(60, 40, 310, 540)], HEIGHT)).toEqual({ head: 0, tail: 0 });
  });

  it('kleine Sprünge zählen nicht', () => {
    expect(misplacedRuns([box(200), box(100), ...body(120, 10)], HEIGHT)).toEqual({ head: 0, tail: 0 });
  });
});
