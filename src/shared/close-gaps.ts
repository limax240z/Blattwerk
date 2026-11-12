// Nachrücken nach dem Löschen (ADR 0033): Was unter gelöschtem Inhalt steht, rückt nach oben, wie in einer
// Textverarbeitung. Reine Rechnung auf Rechtecken im PDF-Benutzerraum; „oben“ ist oben in der Anzeige (Seitendrehung).
import type { Point, Rect } from './annotations';

export interface GapUnit {
  // alle Objekte der Einheit (sie wandern gemeinsam)
  members: number[];
  bounds: Rect;
}

export interface GapShift {
  members: number[];
  // Verschiebung im PDF-Benutzerraum
  delta: Point;
}

// Ab diesem Abstand (Punkt) zum Inhalt darüber gilt ein Block als eigenständig (Fußzeile, Seitenzahl) und bleibt stehen
export const STOP_GAP = 48;
// Bis zu diesem waagerechten Abstand (Punkt) gehört stehen gebliebener Inhalt zur selben Zeile wie das Gelöschte
export const NEIGHBOUR_GAP = 12;

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// Rechteck in Anzeigerichtung: y wächst nach unten, x nach rechts (Ursprung beliebig, nur Abstände zählen)
function toView([x0, y0, x1, y1]: Rect, rotation: number): Box {
  const xs = [x0, x1];
  const ys = [y0, y1];
  const span = (values: number[]) => [Math.min(...values), Math.max(...values)] as const;
  switch (rotation) {
    case 90: {
      const [left, right] = span(ys);
      const [top, bottom] = span(xs);
      return { left, right, top, bottom };
    }
    case 180: {
      const [left, right] = span(xs.map((v) => -v));
      const [top, bottom] = span(ys);
      return { left, right, top, bottom };
    }
    case 270: {
      const [left, right] = span(ys.map((v) => -v));
      const [top, bottom] = span(xs.map((v) => -v));
      return { left, right, top, bottom };
    }
    default: {
      const [left, right] = span(xs);
      const [top, bottom] = span(ys.map((v) => -v));
      return { left, right, top, bottom };
    }
  }
}

// Um amount nach oben (Anzeige) als Verschiebung im PDF-Benutzerraum
function upward(amount: number, rotation: number): Point {
  switch (rotation) {
    case 90:
      return { x: -amount, y: 0 };
    case 180:
      return { x: 0, y: -amount };
    case 270:
      return { x: amount, y: 0 };
    default:
      return { x: 0, y: amount };
  }
}

// removed: Lage der gelöschten Einheiten; remaining: alle übrigen Einheiten der Seite. Ergebnis: Einheiten, die nach oben
// wandern, mit ihrer Verschiebung. Betroffen ist nur, was waagerecht in den Bereich des Gelöschten ragt („Spalte“). Frei
// wird nur Platz, neben dem nichts stehen bleibt (ein gelöschtes Wort in einer Zeile oder Text in einer Tabellenzelle
// lässt nichts nachrücken). Jeder nachrückende Block landet dort, wo das erste Gelöschte über ihm begann; der Abstand zum
// Inhalt darüber bleibt also der, der vor dem Gelöschten stand.
export function closeGaps(removed: Rect[], remaining: GapUnit[], rotation = 0): GapShift[] {
  if (removed.length === 0) return [];
  const gone = removed.map((rect) => toView(rect, rotation));
  const left = Math.min(...gone.map((box) => box.left));
  const right = Math.max(...gone.map((box) => box.right));
  const top = Math.min(...gone.map((box) => box.top));
  const units = remaining
    .map((unit) => ({ unit, box: toView(unit.bounds, rotation) }))
    .filter(({ box }) => box.left < right && box.right > left && box.bottom > top);
  // Zeilen und Blöcke: Einheiten, die sich in der Höhe überlappen, bilden ein Band
  const sorted = [...units].sort((a, b) => a.box.top - b.box.top);
  const bands: Array<{ top: number; bottom: number; members: typeof units }> = [];
  for (const entry of sorted) {
    const band = bands[bands.length - 1];
    if (band && entry.box.top < band.bottom - 0.5) {
      band.bottom = Math.max(band.bottom, entry.box.bottom);
      band.members.push(entry);
    } else bands.push({ top: entry.box.top, bottom: entry.box.bottom, members: [entry] });
  }
  // Was links oder rechts dicht neben Gelöschtem stehen bleibt (der Rest einer Zeile), hält die Zeile offen; weiter
  // entfernter Inhalt gilt als andere Spalte
  const neighbours = remaining
    .map((unit) => toView(unit.bounds, rotation))
    .filter((box) => gone.some((g) => box.top < g.bottom - 0.5 && box.bottom > g.top + 0.5 && Math.max(g.left - box.right, box.left - g.right) < NEIGHBOUR_GAP));
  // Freie Abschnitte: Höhenbereiche des Gelöschten, die kein verbleibendes Band und kein Nachbar berührt
  const intervals = gone
    .map((box) => ({ top: box.top, bottom: box.bottom }))
    .sort((a, b) => a.top - b.top)
    .reduce<Array<{ top: number; bottom: number }>>((list, next) => {
      const last = list[list.length - 1];
      if (last && next.top <= last.bottom) last.bottom = Math.max(last.bottom, next.bottom);
      else list.push({ ...next });
      return list;
    }, [])
    .filter((interval) => ![...bands, ...neighbours].some((box) => box.top < interval.bottom - 0.5 && box.bottom > interval.top + 0.5));
  const shifts: GapShift[] = [];
  let shift = 0;
  let previousBottom: number | null = null;
  let next = 0;
  for (const band of bands) {
    // Freie Abschnitte zwischen dem vorigen Band und diesem
    const between: Array<{ top: number; bottom: number }> = [];
    while (next < intervals.length && (intervals[next]?.bottom ?? Infinity) <= band.top + 0.5) between.push(intervals[next++] as { top: number; bottom: number });
    const first = between[0];
    const last = between[between.length - 1];
    if (first && last) {
      // Weit unter dem Gelöschten (Fußzeile): ab hier bleibt alles stehen
      if (band.top - last.bottom > STOP_GAP) break;
      shift += band.top - Math.max(first.top, previousBottom ?? -Infinity);
    } else if (shift > 0 && previousBottom !== null && band.top - previousBottom > STOP_GAP) break;
    previousBottom = band.bottom;
    if (shift <= 0.01) continue;
    const delta = upward(shift, rotation);
    for (const { unit } of band.members) shifts.push({ members: unit.members, delta });
  }
  return shifts;
}
