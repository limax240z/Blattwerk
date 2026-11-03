// Erzeugt neue Kommentare aus den Werkzeugeinstellungen. Ohne DOM und Speicher, damit testbar.
import type {
  Annotation,
  AnnotationBase,
  FreeTextAnnotation,
  InkAnnotation,
  LineAnnotation,
  LineStyle,
  MarkupAnnotation,
  NoteAnnotation,
  Point,
  Quad,
  Rect,
  RedactAnnotation,
  Rgb,
  ShapeAnnotation,
  SignatureAnnotation,
  StampAnnotation,
  StampId,
} from '../../../shared/annotations';
import { inkRect, lineRect, rectOfQuads } from './geometry';

export type Base = Omit<AnnotationBase, 'kind' | 'rect' | 'color'>;

// Standardgrößen in Punkt, wenn man nur klickt statt zu ziehen
export const NOTE_SIZE = { width: 20, height: 20 };
export const FREETEXT_SIZE = { width: 180, height: 40 };
export const SHAPE_SIZE = { width: 100, height: 60 };
export const LINE_LENGTH = 100;
// Freihand-Textmarker (Zug mit dem Hervorheben-Werkzeug, wo kein Text liegt): Breite in Punkt und Deckkraft
export const MARKER_WIDTH = 12;
export const MARKER_OPACITY = 0.4;
export const STAMP_SIZE = { width: 160, height: 48 };
// Breite einer neu gesetzten Unterschrift (Höhe nach Seitenverhältnis des Bildes, höchstens 80 pt)
export const SIGNATURE_WIDTH = 180;
const SIGNATURE_MAX_HEIGHT = 80;

export function createMarkup(base: Base, kind: MarkupAnnotation['kind'], quads: Quad[], color: Rgb): MarkupAnnotation {
  return { ...base, kind, quads, rect: rectOfQuads(quads), color };
}

// Schwärzungsmarkierung: aufgezogener Bereich (ohne quads) oder markierter Text (quads je Zeile)
export function createRedaction(base: Base, rect: Rect, quads: Quad[], color: Rgb): RedactAnnotation {
  return { ...base, kind: 'redact', quads, rect: quads.length > 0 ? rectOfQuads(quads) : rect, color };
}

// Notiz: Symbol mit der linken oberen Ecke am Klickpunkt
export function createNote(base: Base, at: Point, color: Rgb): NoteAnnotation {
  const rect: Rect = [at.x, at.y - NOTE_SIZE.height, at.x + NOTE_SIZE.width, at.y];
  return { ...base, kind: 'note', icon: 'Comment', rect, color };
}

export function createFreeText(base: Base, rect: Rect, color: Rgb, fontSize: number): FreeTextAnnotation {
  return { ...base, kind: 'freetext', rect, color, fontSize };
}

export function createInk(base: Base, paths: Point[][], color: Rgb, width: number, dash: LineStyle = 'solid'): InkAnnotation {
  return { ...base, kind: 'ink', paths, width, dash, rect: inkRect(paths, width), color };
}

// Ein einzelner Punkt (Klick ohne Ziehen): ein winziger Strich, der mit runden Enden als Punkt erscheint
// (ein Pfad mit nur einem Punkt wird weder von PDFium noch von anderen Programmen gezeichnet).
export function dotPath(at: Point): Point[] {
  return [at, { x: at.x + 0.01, y: at.y }];
}

export function createShape(
  base: Base,
  kind: ShapeAnnotation['kind'],
  rect: Rect,
  color: Rgb,
  width: number,
  fill: Rgb | null = null,
): ShapeAnnotation {
  return { ...base, kind, rect, color, width, fill };
}

export function createLine(
  base: Base,
  kind: LineAnnotation['kind'],
  start: Point,
  end: Point,
  color: Rgb,
  width: number,
): LineAnnotation {
  const tooShort = Math.hypot(end.x - start.x, end.y - start.y) < 4;
  const target = tooShort ? { x: start.x + LINE_LENGTH, y: start.y } : end;
  return { ...base, kind, start, end: target, rect: lineRect(start, target, width), color, width };
}

// Stempel: mittig um den Klickpunkt
export function createStamp(base: Base, at: Point, stamp: StampId, label: string, color: Rgb): StampAnnotation {
  const { width, height } = STAMP_SIZE;
  const rect: Rect = [at.x - width / 2, at.y - height / 2, at.x + width / 2, at.y + height / 2];
  return { ...base, kind: 'stamp', stamp, label, rect, color };
}

// Unterschrift: mittig um den Klickpunkt, Seitenverhältnis des Bildes bleibt erhalten
export function createSignature(base: Base, at: Point, image: string, imageWidth: number, imageHeight: number): SignatureAnnotation {
  const aspect = imageHeight / imageWidth;
  let width = SIGNATURE_WIDTH;
  let height = width * aspect;
  if (height > SIGNATURE_MAX_HEIGHT) {
    height = SIGNATURE_MAX_HEIGHT;
    width = height / aspect;
  }
  const rect: Rect = [at.x - width / 2, at.y - height / 2, at.x + width / 2, at.y + height / 2];
  return { ...base, kind: 'signature', image, imageWidth, imageHeight, rect, color: { r: 0, g: 0, b: 0 } };
}

// Hängt einen weiteren Strich an eine Freihandzeichnung an.
export function appendInkStroke(annotation: InkAnnotation, path: Point[]): InkAnnotation {
  const paths = [...annotation.paths, path];
  return { ...annotation, paths, rect: inkRect(paths, annotation.width) };
}

// Wenige Punkte reichen für eine glatte Linie: Punkte, die näher als `tolerance` am Vorgänger liegen, entfallen.
export function simplifyPath(path: Point[], tolerance = 0.75): Point[] {
  if (path.length <= 2) return path;
  const result: Point[] = [path[0] as Point];
  for (let i = 1; i < path.length - 1; i++) {
    const p = path[i] as Point;
    const last = result[result.length - 1] as Point;
    if (Math.hypot(p.x - last.x, p.y - last.y) >= tolerance) result.push(p);
  }
  result.push(path[path.length - 1] as Point);
  return result;
}

export function isEmptyFreeText(annotation: Annotation): boolean {
  return annotation.kind === 'freetext' && annotation.contents.trim() === '';
}
