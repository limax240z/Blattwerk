// Radierer für Freihandzeichnungen (wie in GoodNotes): Pixel-Radierer löscht nur den überstrichenen Teil eines Strichs,
// Strich-Radierer den ganzen Strich, Textmarker-Radierer nur Markierungen (durchscheinende Striche, Hervorhebungen).
// Alles in PDF-Punkten; der Radierer überstreicht die Strecke von einer Zeigerlage zur nächsten.
import type { Point, Quad } from './annotations';

export type EraserMode = 'pixel' | 'stroke' | 'highlighter';
export type EraserSize = 'small' | 'medium' | 'large';

export const ERASER_MODES: readonly EraserMode[] = ['pixel', 'stroke', 'highlighter'];
export const ERASER_SIZES: readonly EraserSize[] = ['small', 'medium', 'large'];

// Halbmesser des Radierers in Bildschirmpunkten (unabhängig vom Zoom, wie in GoodNotes)
export const ERASER_RADIUS_PX: Record<EraserSize, number> = { small: 4, medium: 10, large: 22 };

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  if (length === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function segmentsCross(p: Point, q: Point, a: Point, b: Point): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(a, b, q);
  const d3 = cross(p, q, a);
  const d4 = cross(p, q, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function segmentDistance(p: Point, q: Point, a: Point, b: Point): number {
  if (segmentsCross(p, q, a, b)) return 0;
  return Math.min(distanceToSegment(p, a, b), distanceToSegment(q, a, b), distanceToSegment(a, p, q), distanceToSegment(b, p, q));
}

// Berührt der Radierer (Strecke from–to, Halbmesser radius) einen der Striche?
export function pathsTouch(paths: Point[][], from: Point, to: Point, radius: number): boolean {
  return paths.some((path) =>
    path.length === 1 ? distanceToSegment(path[0] as Point, from, to) <= radius : path.some((p, i) => i > 0 && segmentDistance(path[i - 1] as Point, p, from, to) <= radius),
  );
}

// Liegt der Radierer über einer Textmarkierung (Vierecke je Zeile)?
export function quadsTouch(quads: Quad[], from: Point, to: Point, radius: number): boolean {
  return quads.some((quad) => {
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    const [left, right, bottom, top] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const corners: Point[] = [
      { x: left, y: bottom },
      { x: right, y: bottom },
      { x: right, y: top },
      { x: left, y: top },
    ];
    const inside = (p: Point) => p.x >= left && p.x <= right && p.y >= bottom && p.y <= top;
    return inside(from) || inside(to) || corners.some((c, i) => segmentDistance(c, corners[(i + 1) % 4] as Point, from, to) <= radius);
  });
}

// Pixel-Radierer: Teile der Striche, die näher als radius an der Strecke from–to liegen, fallen weg; ein Strich kann
// dabei in mehrere zerfallen. null = nichts berührt (Striche unverändert). Ein leeres Ergebnis heißt: alles weg.
export function erasePaths(paths: Point[][], from: Point, to: Point, radius: number): Point[][] | null {
  if (radius <= 0) return null;
  const inside = (p: Point) => distanceToSegment(p, from, to) <= radius;
  // Abstand der Zwischenpunkte auf berührten Abschnitten, damit der Schnitt der Form des Radierers folgt
  const step = Math.max(radius / 3, 0.05);
  let changed = false;
  const result: Point[][] = [];
  for (const path of paths) {
    if (path.length === 1) {
      if (inside(path[0] as Point)) changed = true;
      else result.push(path);
      continue;
    }
    const pieces: Point[][] = [];
    let current: Point[] = [];
    let removed = false;
    const keep = (p: Point) => {
      if (inside(p)) {
        removed = true;
        if (current.length >= 2) pieces.push(current);
        current = [];
      } else {
        current.push(p);
      }
    };
    keep(path[0] as Point);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as Point;
      const b = path[i] as Point;
      if (segmentDistance(a, b, from, to) > radius) {
        current.push(b);
        continue;
      }
      const count = Math.max(1, Math.ceil(distance(a, b) / step));
      for (let k = 1; k <= count; k++) keep({ x: a.x + ((b.x - a.x) * k) / count, y: a.y + ((b.y - a.y) * k) / count });
    }
    if (current.length >= 2) pieces.push(current);
    if (removed) {
      changed = true;
      result.push(...pieces);
    } else {
      result.push(path);
    }
  }
  return changed ? result : null;
}
