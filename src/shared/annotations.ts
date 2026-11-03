// Datenmodell für Kommentare (PDF-Annotationen). Gemeinsam für Renderer und PDFium-Worker.
// Alle Koordinaten im PDF-Benutzerraum: Punkte, Ursprung unten links, ungedrehte Seite.

export type AnnotationKind =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'note'
  | 'freetext'
  | 'ink'
  | 'square'
  | 'circle'
  | 'line'
  | 'arrow'
  | 'stamp'
  | 'signature'
  | 'redact';

export const MARKUP_KINDS: readonly AnnotationKind[] = ['highlight', 'underline', 'strikeout', 'squiggly'];

export type ReviewStatus = 'None' | 'Accepted' | 'Rejected' | 'Cancelled' | 'Completed';

export const REVIEW_STATUSES: readonly ReviewStatus[] = ['None', 'Accepted', 'Rejected', 'Cancelled', 'Completed'];

export type StampId = 'approved' | 'rejected' | 'draft' | 'confidential' | 'final' | 'reviewed' | 'forComment' | 'custom';

export const STAMP_IDS: readonly StampId[] = ['approved', 'rejected', 'reviewed', 'draft', 'final', 'confidential', 'forComment'];

export type NoteIcon = 'Comment' | 'Note' | 'Key' | 'Help' | 'Insert' | 'Paragraph' | 'NewParagraph';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Point {
  x: number;
  y: number;
}

// Viereck in der Reihenfolge von /QuadPoints: oben links, oben rechts, unten links, unten rechts.
export type Quad = [Point, Point, Point, Point];

// [links, unten, rechts, oben]
export type Rect = [number, number, number, number];

export interface Reply {
  id: string;
  ref: string | null;
  author: string;
  contents: string;
  modified: string;
}

export interface StatusEntry {
  id: string;
  ref: string | null;
  author: string;
  status: ReviewStatus;
  modified: string;
}

export interface AnnotationBase {
  id: string;
  // Objektnummer im PDF ("12R"), wenn die Anmerkung schon in der Datei steht
  ref: string | null;
  pageIndex: number;
  kind: AnnotationKind;
  rect: Rect;
  color: Rgb;
  opacity: number;
  contents: string;
  author: string;
  created: string;
  modified: string;
  replies: Reply[];
  // Verlauf der Statusänderungen; der letzte Eintrag gilt
  statuses: StatusEntry[];
}

export interface MarkupAnnotation extends AnnotationBase {
  kind: 'highlight' | 'underline' | 'strikeout' | 'squiggly';
  quads: Quad[];
}

export interface NoteAnnotation extends AnnotationBase {
  kind: 'note';
  icon: NoteIcon;
}

export interface FreeTextAnnotation extends AnnotationBase {
  kind: 'freetext';
  fontSize: number;
}

// Linienart des Stifts. Das Strichmuster hängt von der Linienstärke ab (siehe dashPattern).
export type LineStyle = 'solid' | 'dotted' | 'dashed';

export const LINE_STYLES: readonly LineStyle[] = ['solid', 'dotted', 'dashed'];

// Strichmuster in Punkt (Strich, Lücke); leer = durchgehend. Die Linienenden sind rund und ragen je eine halbe
// Linienbreite über den Strich hinaus: Ein Strich der Länge 0 ergibt also einen runden Punkt.
export function dashPattern(style: LineStyle, width: number): number[] {
  switch (style) {
    case 'dotted':
      return [0.001, width * 2];
    case 'dashed':
      return [width * 3, width * 3];
    default:
      return [];
  }
}

// Ordnet ein vorhandenes Strichmuster (/BS /D) der nächstliegenden Linienart zu
export function lineStyleOf(dashArray: readonly number[] | undefined, width: number): LineStyle {
  const first = dashArray?.[0];
  if (first === undefined || dashArray?.every((v) => v === 0)) return 'solid';
  return first < width ? 'dotted' : 'dashed';
}

export interface InkAnnotation extends AnnotationBase {
  kind: 'ink';
  paths: Point[][];
  width: number;
  // fehlt bei vorhandenen Zeichnungen: durchgehend
  dash?: LineStyle;
}

export interface ShapeAnnotation extends AnnotationBase {
  kind: 'square' | 'circle';
  width: number;
  // null = keine Füllung, undefined = unbekannt (vorhandene Anmerkung, Füllung bleibt unverändert)
  fill: Rgb | null | undefined;
}

export interface LineAnnotation extends AnnotationBase {
  kind: 'line' | 'arrow';
  start: Point;
  end: Point;
  width: number;
}

export interface StampAnnotation extends AnnotationBase {
  kind: 'stamp';
  stamp: StampId;
  // Beschriftung, wie sie beim Anlegen angezeigt wurde (bleibt fest, wie bei einem Papierstempel)
  label: string;
}

// Unterschrift (gezeichnet, getippt oder als Bild) als Stempel mit Bild. Das Bild ist ein PNG (Base64),
// gespeichert wird es als Stamp-Anmerkung mit dem Bild als Darstellung.
export interface SignatureAnnotation extends AnnotationBase {
  kind: 'signature';
  image: string;
  imageWidth: number;
  imageHeight: number;
}

// Schwärzungsmarkierung (Phase 5): Bereich, dessen Inhalt beim Anwenden endgültig entfernt wird.
// Aufgezogen (nur rect) oder über markiertem Text (quads je Zeile). Gespeichert als /Redact-Anmerkung.
export interface RedactAnnotation extends AnnotationBase {
  kind: 'redact';
  quads: Quad[];
}

export type Annotation =
  | MarkupAnnotation
  | NoteAnnotation
  | FreeTextAnnotation
  | InkAnnotation
  | ShapeAnnotation
  | LineAnnotation
  | StampAnnotation
  | SignatureAnnotation
  | RedactAnnotation;

// Änderungen, die beim Speichern auf die Datei angewendet werden.
export interface AnnotationUpsert {
  annotation: Annotation;
  // false, wenn sich nur Text, Antworten oder Status geändert haben: Dann bleibt die vorhandene
  // Darstellung (Appearance Stream) unangetastet.
  appearance: boolean;
}

export interface AnnotationChanges {
  // neu angelegte oder geänderte Anmerkungen (bei geänderten ist ref gesetzt)
  upserts: AnnotationUpsert[];
  // Objektnummern gelöschter Anmerkungen, Antworten und Statuseinträge
  deletions: string[];
}

// Beschriftung der Stempel (Großbuchstaben wie bei Papierstempeln) und Farbe.
export const STAMP_STYLES: Record<Exclude<StampId, 'custom'>, { color: Rgb }> = {
  approved: { color: { r: 0.13, g: 0.55, b: 0.13 } },
  reviewed: { color: { r: 0.13, g: 0.55, b: 0.13 } },
  final: { color: { r: 0.13, g: 0.55, b: 0.13 } },
  rejected: { color: { r: 0.8, g: 0.1, b: 0.1 } },
  confidential: { color: { r: 0.8, g: 0.1, b: 0.1 } },
  draft: { color: { r: 0.15, g: 0.3, b: 0.75 } },
  forComment: { color: { r: 0.15, g: 0.3, b: 0.75 } },
};

// Farbe eines Stempels: vorgegebene Stempel haben ihre feste Farbe, eigene die gewählte (color)
export function stampColor(a: StampAnnotation): Rgb {
  return a.stamp === 'custom' ? a.color : STAMP_STYLES[a.stamp].color;
}

// Eigene Stempel haben bis zu zwei Zeilen: Text und darunter Datum/Name (getrennt durch einen Zeilenumbruch)
export function stampLines(label: string): string[] {
  return label.split('\n').filter((line) => line.trim() !== '').slice(0, 2);
}

export function rgbEquals(a: Rgb | null, b: Rgb | null): boolean {
  if (!a || !b) return a === b;
  const close = (x: number, y: number) => Math.abs(x - y) < 1 / 255;
  return close(a.r, b.r) && close(a.g, b.g) && close(a.b, b.b);
}

// Rechteck um eine Menge von Punkten, mit Rand.
export function boundsOf(points: Point[], margin = 0): Rect {
  if (points.length === 0) return [0, 0, 0, 0];
  let left = Infinity;
  let bottom = Infinity;
  let right = -Infinity;
  let top = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x);
    right = Math.max(right, p.x);
    bottom = Math.min(bottom, p.y);
    top = Math.max(top, p.y);
  }
  return [left - margin, bottom - margin, right + margin, top + margin];
}

export function normalizeRect(rect: Rect): Rect {
  const [x1, y1, x2, y2] = rect;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

// PDF-Datumsformat D:YYYYMMDDHHmmSS+HH'mm' in lokaler Zeit
export function toPdfDate(date: Date): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}'${pad(offset % 60)}'`
  );
}

// Effektiver Prüfstatus (letzter Eintrag).
export function currentStatus(annotation: Pick<AnnotationBase, 'statuses'>): ReviewStatus {
  return annotation.statuses.at(-1)?.status ?? 'None';
}

// Liest ein PDF-Datum (D:YYYYMMDDHHmmSSOHH'mm'). Fehlende Teile gelten als Anfang des Zeitraums.
export function parsePdfDate(value: string | null | undefined): Date | null {
  const match = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(value ?? '');
  if (!match) return null;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', sign, offH = '00', offM = '00'] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (Number.isNaN(utc)) return null;
  // Ohne Zeitzone: als lokale Zeit lesen
  if (!sign) {
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }
  const offset = sign === '-' ? 1 : sign === '+' ? -1 : 0;
  return new Date(utc + offset * (Number(offH) * 60 + Number(offM)) * 60_000);
}
