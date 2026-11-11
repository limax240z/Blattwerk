// Geometrie für Kommentare im PDF-Benutzerraum (Punkte, Ursprung unten links). Ohne DOM, damit testbar.
import type { Annotation, Point, Quad, Rect } from '../../../shared/annotations';
import { boundsOf, normalizeRect } from '../../../shared/annotations';

// Kommentarsorten, die man verschieben bzw. in der Größe ändern kann.
export function isMovable(a: Annotation): boolean {
  return !['highlight', 'underline', 'strikeout', 'squiggly'].includes(a.kind);
}

export function isResizable(a: Annotation): boolean {
  // Schwärzungen über markiertem Text folgen den Zeilen; nur aufgezogene Bereiche lassen sich ziehen.
  if (a.kind === 'redact') return a.quads.length === 0;
  return ['square', 'circle', 'freetext', 'stamp', 'signature'].includes(a.kind);
}

// Rechteck der Seite im Benutzerraum aus den Ecken der Ansicht (auch bei gedrehten Seiten)
export function pageRect({ width, height, toPdf }: { width: number; height: number; toPdf: (x: number, y: number) => Point }): Rect {
  const a = toPdf(0, 0);
  const b = toPdf(width, height);
  return normalizeRect([a.x, a.y, b.x, b.y]);
}

export function clampToRect({ x, y }: Point, [l, b, r, t]: Rect): Point {
  return { x: Math.min(Math.max(x, l), r), y: Math.min(Math.max(y, b), t) };
}

// Beschneidet einen Strich auf ein Rechteck (Seite): Was außerhalb liegt, fällt weg, am Rand endet der Strich genau auf
// der Kante. Geht er hinaus und wieder hinein, entstehen mehrere Stücke.
export function clipPath(path: Point[], [l, b, r, t]: Rect): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] | null = null;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1] as Point;
    const q = path[i] as Point;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    // Liang-Barsky: Abschnitt [t0, t1] der Strecke im Rechteck
    let t0 = 0;
    let t1 = 1;
    let inside = true;
    for (const [direction, distance] of [
      [-dx, p.x - l],
      [dx, r - p.x],
      [-dy, p.y - b],
      [dy, t - p.y],
    ] as const) {
      if (direction === 0) {
        if (distance < 0) inside = false;
        continue;
      }
      const ratio = distance / direction;
      if (direction < 0) t0 = Math.max(t0, ratio);
      else t1 = Math.min(t1, ratio);
    }
    if (!inside || t0 > t1) {
      run = null;
      continue;
    }
    if (!run) {
      run = [t0 === 0 ? p : { x: p.x + dx * t0, y: p.y + dy * t0 }];
      runs.push(run);
    }
    run.push(t1 === 1 ? q : { x: p.x + dx * t1, y: p.y + dy * t1 });
    if (t1 < 1) run = null;
  }
  return runs;
}

const movePoint = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy });
const moveRect = ([l, b, r, t]: Rect, dx: number, dy: number): Rect => [l + dx, b + dy, r + dx, t + dy];

export function translate(a: Annotation, dx: number, dy: number): Annotation {
  const rect = moveRect(a.rect, dx, dy);
  switch (a.kind) {
    case 'ink':
      return { ...a, rect, paths: a.paths.map((path) => path.map((p) => movePoint(p, dx, dy))) };
    case 'line':
    case 'arrow':
      return { ...a, rect, start: movePoint(a.start, dx, dy), end: movePoint(a.end, dx, dy) };
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
    case 'redact':
      return { ...a, rect, quads: a.quads.map((q) => q.map((p) => movePoint(p, dx, dy)) as Quad) };
    default:
      return { ...a, rect };
  }
}

export function withRect(a: Annotation, rect: Rect): Annotation {
  return { ...a, rect: normalizeRect(rect) };
}

// Größe ändern an einer Ecke (fixed bleibt stehen). Unterschriften behalten ihr Seitenverhältnis. Mit page endet die
// Ecke am Seitenrand.
export function resizeFrom(a: Annotation, fixed: Point, target: Point, page?: Rect): Annotation {
  const to = page ? clampToRect(target, page) : target;
  if (a.kind !== 'signature') return withRect(a, [fixed.x, fixed.y, to.x, to.y]);
  const aspect = a.imageHeight / a.imageWidth;
  let width = Math.max(8, Math.abs(to.x - fixed.x));
  if (page) {
    // Die Höhe folgt der Breite: so weit begrenzen, dass auch sie auf die Seite passt
    const room = to.y >= fixed.y ? page[3] - fixed.y : fixed.y - page[1];
    if (room > 0) width = Math.min(width, room / aspect);
  }
  const height = width * aspect;
  const x2 = to.x >= fixed.x ? fixed.x + width : fixed.x - width;
  const y2 = to.y >= fixed.y ? fixed.y + height : fixed.y - height;
  return withRect(a, [fixed.x, fixed.y, x2, y2]);
}

// Rahmen für eine Linie: Endpunkte plus Platz für Linienstärke und Pfeilspitze.
export function lineRect(start: Point, end: Point, width: number): Rect {
  return boundsOf([start, end], Math.max(4, width * 4));
}

export function inkRect(paths: Point[][], width: number): Rect {
  return boundsOf(paths.flat(), Math.max(1, width));
}

// Rechteck aus zwei Eckpunkten, mit Mindestgröße (Klick ohne Ziehen ergibt die Standardgröße).
export function dragRect(from: Point, to: Point, minimum: { width: number; height: number }): Rect {
  const width = Math.abs(to.x - from.x);
  const height = Math.abs(to.y - from.y);
  if (width < 4 && height < 4) {
    return [from.x, from.y - minimum.height, from.x + minimum.width, from.y];
  }
  return normalizeRect([from.x, from.y, to.x, to.y]);
}

// Bildschirm-Rechtecke einer Textauswahl (bereits in PDF-Punkte umgerechnet) zu Zeilen zusammenfassen.
// Rechtecke derselben Zeile (große vertikale Überlappung) werden zu einem Viereck verbunden.
export function quadsFromRects(rects: Rect[]): Quad[] {
  const lines: Rect[] = [];
  const sorted = rects
    .map(normalizeRect)
    .filter(([l, b, r, t]) => r - l > 0.5 && t - b > 0.5)
    .sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  for (const rect of sorted) {
    const line = lines.find(([, lb, , lt]) => {
      const overlap = Math.min(lt, rect[3]) - Math.max(lb, rect[1]);
      return overlap > 0.6 * Math.min(lt - lb, rect[3] - rect[1]);
    });
    if (line) {
      line[0] = Math.min(line[0], rect[0]);
      line[1] = Math.min(line[1], rect[1]);
      line[2] = Math.max(line[2], rect[2]);
      line[3] = Math.max(line[3], rect[3]);
    } else {
      lines.push([...rect] as Rect);
    }
  }
  return lines.map(([l, b, r, t]) => [
    { x: l, y: t },
    { x: r, y: t },
    { x: l, y: b },
    { x: r, y: b },
  ]);
}

export function rectOfQuads(quads: Quad[]): Rect {
  return boundsOf(quads.flat());
}

// Inhalt eines Kommentars ohne Zugabe für Strichstärke oder Pfeilspitze (für die Begrenzung auf die Seite)
export function contentBounds(a: Annotation): Rect {
  if (a.kind === 'ink') return boundsOf(a.paths.flat());
  if (a.kind === 'line' || a.kind === 'arrow') return boundsOf([a.start, a.end]);
  return a.rect;
}

// Verschiebung so begrenzen, dass bounds nicht über die Seite hinausgeht. Was schon hinausragt (etwa aus einer anderen
// App), darf bleiben, aber nicht weiter hinaus.
export function clampMove([l, b, r, t]: Rect, dx: number, dy: number, [pl, pb, pr, pt]: Rect): { dx: number; dy: number } {
  const limit = (value: number, low: number, high: number) => Math.min(Math.max(value, Math.min(0, low)), Math.max(0, high));
  return { dx: limit(dx, pl - l, pr - r), dy: limit(dy, pb - b, pt - t) };
}

// Verschiebung, die bounds ganz auf die Seite bringt. Ist es größer als die Seite, bündig links bzw. oben.
export function fitOnPage([l, b, r, t]: Rect, [pl, pb, pr, pt]: Rect): { dx: number; dy: number } {
  const axis = (low: number, high: number, pageLow: number, pageHigh: number, alignHigh: boolean) => {
    if (high - low > pageHigh - pageLow) return alignHigh ? pageHigh - high : pageLow - low;
    if (low < pageLow) return pageLow - low;
    if (high > pageHigh) return pageHigh - high;
    return 0;
  };
  return { dx: axis(l, r, pl, pr, false), dy: axis(b, t, pb, pt, true) };
}

// Neuen Kommentar ganz auf die Seite schieben (Klick am Rand: Stempel, Notiz, Textfeld in Standardgröße)
export function keepOnPage<T extends Annotation>(a: T, page: Rect): T {
  const { dx, dy } = fitOnPage(contentBounds(a), page);
  return dx === 0 && dy === 0 ? a : (translate(a, dx, dy) as T);
}

// Lage eines Textfelds in der Ansicht: mindestens so hoch wie aufgezogen, mit dem Text wachsend, nie über die Seite
export function fitFreeText(r: { y: number; h: number }, needed: number, pageHeight: number): { y: number; h: number } {
  const h = Math.min(pageHeight, Math.max(r.h, Math.ceil(needed) + 2));
  const y = Math.max(0, Math.min(r.y, pageHeight - h));
  return { y, h };
}

// Größter Faktor, um den bounds um fixed wachsen kann, ohne über die Seite hinauszuragen. Ragt es schon hinaus,
// bleibt wenigstens die jetzige Größe möglich.
export function maxScale([l, b, r, t]: Rect, fixed: Point, [pl, pb, pr, pt]: Rect): number {
  let limit = Infinity;
  const check = (value: number, origin: number, low: number, high: number) => {
    const d = value - origin;
    if (d > 1e-6) limit = Math.min(limit, (high - origin) / d);
    else if (d < -1e-6) limit = Math.min(limit, (low - origin) / d);
  };
  for (const x of [l, r]) check(x, fixed.x, pl, pr);
  for (const y of [b, t]) check(y, fixed.y, pb, pt);
  return Math.max(1, limit);
}
