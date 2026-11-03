// Geometrie für Live-Text, ohne DOM, damit testbar: Wie viel der Seite ist Bild? Rechnet die Bilder einer
// pdf.js-Befehlsliste (getOperatorList) mit ihrer Lage (Transformationsmatrix) auf die Seitenfläche um.
import type { Point, Rect } from '../../../shared/annotations';

type Matrix = [number, number, number, number, number, number];

// Befehlsnummern von pdf.js (pdfjs.OPS), nur die benötigten
export interface OpCodes {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// m · n (erst n, dann m), wie in PDF: neue Matrix vor die aktuelle
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    n[0] * m[0] + n[1] * m[2],
    n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2],
    n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4],
    n[4] * m[1] + n[5] * m[3] + m[5],
  ];
}

const isMatrix = (value: unknown): value is Matrix => Array.isArray(value) && value.length === 6 && value.every((v) => typeof v === 'number');

// Anteil der Seite (0 bis 1), den Bilder bedecken; view = [x0, y0, x1, y1] der Seite
export function imageCoverage(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, ops: OpCodes, view: number[]): number {
  const [vx0 = 0, vy0 = 0, vx1 = 0, vy1 = 0] = view;
  const pageArea = (vx1 - vx0) * (vy1 - vy0);
  if (pageArea <= 0) return 0;
  const stack: Matrix[] = [];
  let ctm = IDENTITY;
  let covered = 0;
  const imageOps = new Set([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageMaskXObject]);
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    if (fn === ops.save) {
      stack.push(ctm);
    } else if (fn === ops.restore) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (fn === ops.transform && args && args.length === 6) {
      ctm = multiply(ctm, args as Matrix);
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      if (isMatrix(args?.[0])) ctm = multiply(ctm, args[0]);
    } else if (fn === ops.paintFormXObjectEnd) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (fn !== undefined && imageOps.has(fn)) {
      // Bilder füllen das Einheitsquadrat; dessen Ecken über die aktuelle Matrix, auf die Seite beschnitten
      const corners = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([x = 0, y = 0]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]] as const);
      const xs = corners.map(([x]) => Math.min(Math.max(x, vx0), vx1));
      const ys = corners.map(([, y]) => Math.min(Math.max(y, vy0), vy1));
      covered += (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    }
  }
  return Math.min(1, covered / pageArea);
}

// Liegt das Wort zum großen Teil in echtem Text? Dann gibt es dort schon etwas zum Auswählen.
export function mostlyInside(word: { topLeft: Point; topRight: Point; bottomLeft: Point }, rect: Rect): boolean {
  const { topLeft, topRight, bottomLeft } = word;
  const xs = [topLeft.x, topRight.x, bottomLeft.x, topRight.x + bottomLeft.x - topLeft.x];
  const ys = [topLeft.y, topRight.y, bottomLeft.y, topRight.y + bottomLeft.y - topLeft.y];
  const [l, b, r, t] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const area = (r - l) * (t - b);
  if (area <= 0) return false;
  const w = Math.min(r, rect[2]) - Math.max(l, rect[0]);
  const h = Math.min(t, rect[3]) - Math.max(b, rect[1]);
  return w > 0 && h > 0 && (w * h) / area > 0.5;
}
