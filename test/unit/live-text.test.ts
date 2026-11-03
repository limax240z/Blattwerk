// Live-Text: Bildanteil einer Seite, Zeilen aus der Erkennung und Abgleich mit echtem Text.
import { describe, expect, it } from 'vitest';
import { selectableLines, type OcrBlock } from '../../src/shared/ocr';
import { imageCoverage, mostlyInside, type OpCodes } from '../../src/renderer/features/live-text/coverage';

const OPS: OpCodes = { save: 10, restore: 11, transform: 12, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageMaskXObject: 83 };
const A4 = [0, 0, 595, 842];

describe('Bildanteil einer Seite', () => {
  it('ganzseitiger Scan bedeckt die Seite', () => {
    const fn = [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore];
    const args = [null, [595, 0, 0, 842, 0, 0], ['img1', 595, 842], null];
    expect(imageCoverage(fn, args, OPS, A4)).toBeCloseTo(1);
  });

  it('kleines Logo zählt kaum, und nach restore gilt die alte Matrix', () => {
    const fn = [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.paintImageXObject];
    const args = [null, [60, 0, 0, 30, 20, 780], ['logo'], null, ['punkt']];
    const share = imageCoverage(fn, args, OPS, A4);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(0.01);
  });

  it('Bild in einem Formular-Objekt wird mit dessen Matrix gerechnet und auf die Seite beschnitten', () => {
    const fn = [OPS.paintFormXObjectBegin, OPS.transform, OPS.paintImageXObject, OPS.paintFormXObjectEnd];
    const args = [[[2, 0, 0, 2, 0, 0], [0, 0, 1, 1]], [400, 0, 0, 600, 0, 0], ['foto'], null];
    expect(imageCoverage(fn, args, OPS, A4)).toBeCloseTo(1);
  });
});

describe('Zeilen aus der Erkennung', () => {
  it('gleiche Höhe je Zeile, unsichere Wörter fallen weg, Reihenfolge von links nach rechts', () => {
    const bbox = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
    const blocks: OcrBlock[] = [
      {
        paragraphs: [
          {
            lines: [
              {
                baseline: { x0: 0, y0: 40, x1: 300, y1: 40 },
                bbox: bbox(0, 10, 300, 45),
                words: [
                  { text: 'Welt', confidence: 90, bbox: bbox(120, 12, 200, 40) },
                  { text: 'Hallo', confidence: 95, bbox: bbox(10, 10, 100, 45) },
                  { text: '~', confidence: 5, bbox: bbox(220, 20, 230, 30) },
                  { text: 'ﬁnal', confidence: 80, bbox: bbox(240, 15, 300, 40) },
                ],
              },
            ],
          },
        ],
      },
    ];
    const [line] = selectableLines(blocks);
    expect(line?.top).toBe(10);
    expect(line?.bottom).toBe(45);
    expect(line?.words.map((w) => w.text)).toEqual(['Hallo', 'Welt', 'final']);
  });
});

describe('Abgleich mit echtem Text', () => {
  const word = { topLeft: { x: 100, y: 520 }, topRight: { x: 160, y: 520 }, bottomLeft: { x: 100, y: 500 } };
  it('Wort über echtem Text gilt als vorhanden', () => {
    expect(mostlyInside(word, [95, 498, 170, 522])).toBe(true);
  });
  it('Wort daneben oder nur angeschnitten wird erkannt', () => {
    expect(mostlyInside(word, [300, 498, 400, 522])).toBe(false);
    expect(mostlyInside(word, [150, 498, 400, 522])).toBe(false);
  });
});
