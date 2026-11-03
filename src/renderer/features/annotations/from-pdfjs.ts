// Wandelt Anmerkungen, wie pdf.js sie liefert (getAnnotations), in das eigene Kommentarmodell um.
// Nicht unterstützte Arten (Links, Formularfelder, Popups, Dateianhänge …) werden ausgelassen;
// pdf.js zeigt sie weiterhin an.
import type {
  Annotation,
  AnnotationBase,
  NoteIcon,
  Point,
  Quad,
  Rect,
  Reply,
  ReviewStatus,
  Rgb,
  StatusEntry,
} from '../../../shared/annotations';
import { lineStyleOf, REVIEW_STATUSES } from '../../../shared/annotations';

// Ausschnitt der pdf.js-Daten, den wir nutzen (pdf.js liefert untypisierte Objekte).
export interface PdfjsAnnotationData {
  id: string;
  subtype: string;
  rect: number[];
  color?: ArrayLike<number> | null;
  opacity?: number;
  contentsObj?: { str?: string };
  titleObj?: { str?: string };
  creationDate?: string | null;
  modificationDate?: string | null;
  inReplyTo?: string;
  replyType?: string;
  state?: string;
  stateModel?: string;
  quadPoints?: ArrayLike<number> | null;
  inkLists?: Array<ArrayLike<number>>;
  lineCoordinates?: ArrayLike<number>;
  lineEndings?: string[];
  // style: 1 durchgehend, 2 gestrichelt (pdf.js-Konstanten)
  borderStyle?: { width?: number; style?: number; dashArray?: number[] };
  name?: string;
  defaultAppearanceData?: { fontSize?: number; fontColor?: ArrayLike<number> | Record<string, number> };
}

const NOTE_ICONS: readonly NoteIcon[] = ['Comment', 'Note', 'Key', 'Help', 'Insert', 'Paragraph', 'NewParagraph'];

function toRgb(color: ArrayLike<number> | Record<string, number> | null | undefined, fallback: Rgb): Rgb {
  if (!color) return fallback;
  const values = Array.from({ length: 3 }, (_, i) => (color as Record<number, number>)[i]);
  if (values.some((v) => typeof v !== 'number')) return fallback;
  const [r, g, b] = values as [number, number, number];
  return { r: r / 255, g: g / 255, b: b / 255 };
}

function toRect(rect: number[]): Rect {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = rect;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

// pdf.js liefert QuadPoints als flache Liste je 8 Werte (oben links, oben rechts, unten links, unten rechts).
export function toQuads(points: ArrayLike<number> | null | undefined): Quad[] {
  if (!points) return [];
  const quads: Quad[] = [];
  for (let i = 0; i + 7 < points.length; i += 8) {
    const p = (j: number): Point => ({ x: points[i + j] as number, y: points[i + j + 1] as number });
    quads.push([p(0), p(2), p(4), p(6)]);
  }
  return quads;
}

function toPath(list: ArrayLike<number>): Point[] {
  const path: Point[] = [];
  for (let i = 0; i + 1 < list.length; i += 2) path.push({ x: list[i] as number, y: list[i + 1] as number });
  return path;
}

function baseOf(data: PdfjsAnnotationData, pageIndex: number, fallbackColor: Rgb): Omit<AnnotationBase, 'kind'> {
  return {
    id: data.id,
    ref: data.id,
    pageIndex,
    rect: toRect(data.rect),
    color: toRgb(data.color, fallbackColor),
    opacity: typeof data.opacity === 'number' ? data.opacity : 1,
    contents: data.contentsObj?.str ?? '',
    author: data.titleObj?.str ?? '',
    created: data.creationDate ?? '',
    modified: data.modificationDate ?? data.creationDate ?? '',
    replies: [],
    statuses: [],
  };
}

function convertOne(data: PdfjsAnnotationData, pageIndex: number): Annotation | null {
  const black: Rgb = { r: 0, g: 0, b: 0 };
  switch (data.subtype) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const kind = data.subtype === 'StrikeOut' ? 'strikeout' : (data.subtype.toLowerCase() as 'highlight' | 'underline' | 'squiggly');
      return { ...baseOf(data, pageIndex, { r: 1, g: 0.9, b: 0 }), kind, quads: toQuads(data.quadPoints) };
    }
    case 'Text': {
      const icon = NOTE_ICONS.find((n) => n === data.name) ?? 'Comment';
      return { ...baseOf(data, pageIndex, { r: 1, g: 0.85, b: 0 }), kind: 'note', icon };
    }
    case 'FreeText':
      return {
        ...baseOf(data, pageIndex, black),
        kind: 'freetext',
        color: toRgb(data.defaultAppearanceData?.fontColor, black),
        fontSize: data.defaultAppearanceData?.fontSize || 12,
      };
    case 'Ink':
      return {
        ...baseOf(data, pageIndex, black),
        kind: 'ink',
        paths: (data.inkLists ?? []).map(toPath),
        width: data.borderStyle?.width ?? 1,
        dash: data.borderStyle?.style === 2 ? lineStyleOf(data.borderStyle.dashArray, data.borderStyle.width ?? 1) : 'solid',
      };
    case 'Square':
    case 'Circle':
      return {
        ...baseOf(data, pageIndex, black),
        kind: data.subtype === 'Square' ? 'square' : 'circle',
        width: data.borderStyle?.width ?? 1,
        // pdf.js liefert die Füllfarbe nicht; undefined bedeutet „unverändert lassen“.
        fill: undefined,
      };
    case 'Line': {
      const c = data.lineCoordinates ?? [0, 0, 0, 0];
      const arrow = (data.lineEndings ?? []).some((e) => /Arrow/.test(e));
      return {
        ...baseOf(data, pageIndex, black),
        kind: arrow ? 'arrow' : 'line',
        start: { x: c[0] as number, y: c[1] as number },
        end: { x: c[2] as number, y: c[3] as number },
        width: data.borderStyle?.width ?? 1,
      };
    }
    case 'Redact':
      // pdf.js liefert für Schwärzungsmarkierungen keine QuadPoints; beim Anwenden liest PDFium die genaue Lage
      // aus der Datei (redact.ts). Angezeigt wird bis dahin das umgebende Rechteck.
      return { ...baseOf(data, pageIndex, { r: 0.85, g: 0.11, b: 0.11 }), kind: 'redact', quads: toQuads(data.quadPoints) };
    case 'Stamp':
      // Fremde Stempel behalten ihre Darstellung; Beschriftung ist unbekannt.
      return { ...baseOf(data, pageIndex, black), kind: 'stamp', stamp: 'approved', label: '' };
    default:
      return null;
  }
}

function toStatus(value: string | undefined): ReviewStatus | null {
  return REVIEW_STATUSES.find((s) => s === value) ?? null;
}

// pdf.js liefert State und StateModel als rohe PDF-Zeichenketten; UTF-16 mit Byte-Order-Mark hier entschlüsseln.
export function pdfText(value: string | null | undefined): string {
  if (!value) return '';
  const bytes = Array.from(value, (c) => c.charCodeAt(0) & 0xff);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(new Uint8Array(bytes.slice(2)));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(new Uint8Array(bytes.slice(2)));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(new Uint8Array(bytes.slice(3)));
  return value;
}

// Liest alle Anmerkungen einer Seite und hängt Antworten und Prüfstatus an ihre Kommentare.
export function convertPageAnnotations(items: PdfjsAnnotationData[], pageIndex: number): Annotation[] {
  const result: Annotation[] = [];
  const byId = new Map<string, Annotation>();
  for (const data of items) {
    if (data.inReplyTo) continue;
    const annotation = convertOne(data, pageIndex);
    if (annotation) {
      result.push(annotation);
      byId.set(annotation.id, annotation);
    }
  }
  for (const data of items) {
    if (!data.inReplyTo) continue;
    const parent = byId.get(data.inReplyTo);
    if (!parent) continue;
    const modified = data.modificationDate ?? data.creationDate ?? '';
    const author = data.titleObj?.str ?? '';
    if (data.state) {
      // Prüfstatus (StateModel Review). Markierungen (Marked/Unmarked) zeigt die App nicht an.
      const status = pdfText(data.stateModel) === 'Review' ? toStatus(pdfText(data.state)) : null;
      if (status) parent.statuses.push({ id: data.id, ref: data.id, author, status, modified } satisfies StatusEntry);
    } else if (data.replyType !== 'Group') {
      parent.replies.push({ id: data.id, ref: data.id, author, contents: data.contentsObj?.str ?? '', modified } satisfies Reply);
    }
  }
  // Statusverlauf zeitlich ordnen, damit der letzte Eintrag gilt.
  for (const annotation of result) annotation.statuses.sort((a, b) => a.modified.localeCompare(b.modified));
  return result;
}
