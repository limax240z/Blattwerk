// Formerkennung für den Stift: Wer nach dem Zeichnen kurz stillhält, bekommt eine saubere Linie, ein Rechteck,
// ein Dreieck oder eine Ellipse statt des Freihandstrichs (wie bei GoodNotes). Ohne DOM, damit testbar.
import type { Point } from '../../../shared/annotations';

// Wie lange der Stift stillstehen muss (ms) und wie weit er dabei wandern darf (Bildschirmpixel)
export const SNAP_HOLD_MS = 550;
export const SNAP_JITTER_PX = 4;

// Kürzere Striche sind Punkte oder Schrift, keine Form
const MIN_LENGTH = 24;
const ELLIPSE_STEPS = 64;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(points: Point[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += dist(points[i - 1] as Point, points[i] as Point);
  return sum;
}

// Abstand eines Punkts von der Strecke a-b
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

// Douglas-Peucker: liefert die Eckpunkte von points[from..to] (beide Enden eingeschlossen)
function corners(points: Point[], from: number, to: number, epsilon: number): Point[] {
  const a = points[from] as Point;
  const b = points[to] as Point;
  let worst = -1;
  let worstDistance = epsilon;
  for (let i = from + 1; i < to; i++) {
    const d = distanceToSegment(points[i] as Point, a, b);
    if (d > worstDistance) {
      worst = i;
      worstDistance = d;
    }
  }
  if (worst < 0) return [a, b];
  const left = corners(points, from, worst, epsilon);
  return [...left.slice(0, -1), ...corners(points, worst, to, epsilon)];
}

// Geschlossener Strich → Eckpunkte (ohne den doppelten Schlusspunkt)
function closedCorners(points: Point[], epsilon: number): Point[] {
  const start = points[0] as Point;
  let far = 0;
  for (let i = 1; i < points.length; i++) if (dist(points[i] as Point, start) > dist(points[far] as Point, start)) far = i;
  if (far === 0) return [];
  const first = corners(points, 0, far, epsilon);
  const second = corners(points, far, points.length - 1, epsilon);
  const all = [...first.slice(0, -1), ...second.slice(0, -1)];
  // Ecken, die fast zusammenfallen (Anfang und Ende des Strichs), nur einmal zählen
  return all.filter((p, i) => dist(p, all[(i + all.length - 1) % all.length] as Point) > epsilon);
}

function bounds(points: Point[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function rectangle(minX: number, minY: number, maxX: number, maxY: number): Point[] {
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
    { x: minX, y: minY },
  ];
}

// Gerade Kanten? Dann ist es ein Rechteck parallel zum Blattrand (Winkelabweichung bis etwa 15 Grad)
function isAxisAligned(quad: Point[]): boolean {
  return quad.every((p, i) => {
    const next = quad[(i + 1) % quad.length] as Point;
    const dx = Math.abs(next.x - p.x);
    const dy = Math.abs(next.y - p.y);
    return Math.min(dx, dy) <= Math.max(dx, dy) * 0.27;
  });
}

function ellipse(minX: number, minY: number, maxX: number, maxY: number): Point[] {
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = (maxX - minX) / 2;
  const ry = (maxY - minY) / 2;
  const path: Point[] = [];
  for (let i = 0; i < ELLIPSE_STEPS; i++) {
    const angle = (i / ELLIPSE_STEPS) * Math.PI * 2;
    path.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  path.push(path[0] as Point);
  return path;
}

// Mittlere Abweichung vom Ellipsenrand, bezogen auf den Radius (0 = perfekt)
function ellipseError(points: Point[], box: ReturnType<typeof bounds>): number {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const rx = box.width / 2;
  const ry = box.height / 2;
  let sum = 0;
  for (const p of points) sum += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
  return sum / points.length;
}

/**
 * Erkennt, ob der Strich eine Form sein soll, und liefert dann den bereinigten Strich.
 * null = keine Form erkannt, der Freihandstrich bleibt.
 */
export function recognizeShape(points: Point[]): Point[] | null {
  if (points.length < 3) return null;
  const length = pathLength(points);
  if (length < MIN_LENGTH) return null;
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  const box = bounds(points);
  const diagonal = Math.hypot(box.width, box.height);

  // Offener Strich: Gerade, wenn er kaum von der Verbindung Anfang-Ende abweicht
  if (dist(first, last) > length * 0.25) {
    const chord = dist(first, last);
    const deviation = Math.max(...points.map((p) => distanceToSegment(p, first, last)));
    return deviation <= chord * 0.06 ? [first, last] : null;
  }

  // Geschlossener Strich: zu flach ist keine Fläche (eher eine hin- und hergezogene Linie)
  if (box.width < MIN_LENGTH / 2 || box.height < MIN_LENGTH / 2) return null;

  const vertices = closedCorners(points, diagonal * 0.07);
  if (vertices.length === 4 && isAxisAligned(vertices)) return rectangle(box.minX, box.minY, box.maxX, box.maxY);
  if (vertices.length === 3 || vertices.length === 4) return [...vertices, vertices[0] as Point];
  if (ellipseError(points, box) < 0.13) return ellipse(box.minX, box.minY, box.maxX, box.maxY);
  return null;
}

// Fast gerade Drehungen (bis zu so vielen Grad neben einem Vielfachen von 90°) rasten gerade ein
const STRAIGHT_DEG = 8;

/**
 * Nach dem Einrasten weiterziehen: Die Form wächst oder schrumpft um ihre Mitte, je nachdem wie weit der Stift sich von
 * der Mitte entfernt, und dreht sich mit ihm. grab = Stiftposition beim Einrasten, at = jetzt.
 */
export function transformShape(base: Point[], grab: Point, at: Point): Point[] {
  const box = bounds(base);
  const c = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  const r0 = dist(grab, c);
  if (r0 < 1) return base;
  const scale = Math.min(50, Math.max(0.05, dist(at, c) / r0));
  let angle = Math.atan2(at.y - c.y, at.x - c.x) - Math.atan2(grab.y - c.y, grab.x - c.x);
  angle = Math.atan2(Math.sin(angle), Math.cos(angle));
  const quarter = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(angle - quarter) <= (STRAIGHT_DEG * Math.PI) / 180) angle = quarter;
  const cos = Math.cos(angle) * scale;
  const sin = Math.sin(angle) * scale;
  return base.map((p) => ({ x: c.x + cos * (p.x - c.x) - sin * (p.y - c.y), y: c.y + sin * (p.x - c.x) + cos * (p.y - c.y) }));
}
