// Seiteninhalt bearbeiten (Phase 5, „Inhalt bearbeiten“): Text und Bilder einfügen, verschieben, skalieren, löschen,
// vorhandene Textzeilen ändern. Gemeinsam für Oberfläche und Worker. Koordinaten im PDF-Benutzerraum.
import type { Point, Rect, Rgb } from './annotations';
import type { ImageSource } from './pages';
import type { TextFont } from './fonts';
import type { OcrWord } from './ocr';
import { normalizeRuns, runsText, type TextRun } from './rich-text';

// path: Linien und Flächen (Tabellenrahmen, Hinterlegungen, Unterstreichungen)
export type PageObjectKind = 'text' | 'image' | 'form' | 'path';

// Ein Seitenobjekt, wie PDFium es kennt. index ist die Position in der Objektliste der Seite (gilt nur für genau
// diesen Dokumentstand).
export interface PageObjectInfo {
  index: number;
  kind: PageObjectKind;
  bounds: Rect;
  // nur Text
  text?: string;
  // Schriftgröße im Textzustand (Tf). Viele PDFs setzen 1 und skalieren über die Textmatrix.
  fontSize?: number;
  // Größe, in der der Text auf der Seite erscheint (Punkte, Tf mal senkrechte Skalierung)
  visualSize?: number;
  // Schlüssel in PageObjects.fonts
  font?: string;
  color?: Rgb;
  // Text läuft waagerecht von links nach rechts (nicht gedreht oder gespiegelt); nur solche Zeilen bilden Absätze
  upright?: boolean;
  // Höhe der Grundlinie und Anfang der Zeile (nur bei upright)
  baseline?: number;
  x?: number;
  // Von Blattwerk gesetzter Text (Kennzeichnung im PDF)
  mark?: TextMark;
}

// Kennzeichnung gesetzter Texte: p = Absatz, w = Breite (Punkt, vom Zeilenanfang), h = Zeile endet mit hartem Umbruch,
// b = so viele Leerzeilen folgen (bei gemischten Größen lässt sich das nicht aus dem Abstand ablesen)
export interface TextMark {
  p: number;
  w?: number;
  h?: boolean;
  b?: number;
  // Leerzeichen am Anfang des Objekts (Einzug einer Liste): PDFium liest mehrere davon nicht zuverlässig aus
  l?: number;
}

export interface PageFontInfo {
  name: string;
  embedded: boolean;
  // Zeichen, die die Schrift sicher darstellen kann (bei eingebetteten Teilschriften: alle, die auf der Seite in
  // dieser Schrift vorkommen; sonst null = westeuropäischer Zeichensatz)
  chars: string | null;
}

export interface PageObjects {
  pageIndex: number;
  objects: PageObjectInfo[];
  fonts: Record<string, PageFontInfo>;
  // Mehr Objekte als angezeigt (z. B. sehr viele Textstücke); die übrigen sind nicht auswählbar
  truncated: boolean;
}

export type Matrix = [number, number, number, number, number, number];

export type ContentOperation =
  // Neuer Text, erste Grundlinie bei origin; jede Zeile ein eigenes Textobjekt. Aufrecht zur Anzeige der Seite.
  // width: Breite (Punkt), in der die Zeilen umbrechen; ohne Angabe nur an harten Umbrüchen.
  // flow: Fließtext wie in einer Textverarbeitung; Zeilen unterhalb von bottom (Grundlinie, PDF-y) wandern auf neue
  // Seiten gleicher Größe direkt dahinter, dort ab der Grundlinie top. Nur auf ungedrehten Seiten.
  | { type: 'addText'; pageIndex: number; origin: Point; lines: string[]; font: TextFont; size: number; color: Rgb; width?: number; flow?: { top: number; bottom: number }; fontData?: ArrayBuffer }
  // Text mit gemischter Gestaltung (shared/rich-text.ts). origin: Anfang und Oberkante der ersten Zeile. Jede Zeile ist
  // LINE_HEIGHT mal so hoch wie ihre größte Schrift. width und flow wie bei addText, flow.top ist hier die Oberkante der
  // ersten Zeile auf neuen Seiten. replace: Objekte, an deren Stelle der Text tritt (der bisherige Absatz); Stücke mit
  // source behalten die Schrift dieser Objekte.
  | { type: 'addRichText'; pageIndex: number; origin: Point; runs: TextRun[]; width?: number; flow?: { top: number; bottom: number }; replace?: number[] }
  | { type: 'addImage'; pageIndex: number; rect: Rect; image: ImageSource }
  // Zusätzliche Abbildung (Verschieben, Skalieren) auf ein vorhandenes Objekt
  | { type: 'transform'; pageIndex: number; index: number; matrix: Matrix }
  | { type: 'delete'; pageIndex: number; indices: number[] }
  // Text einer vorhandenen Zeile ersetzen. merge: weitere Textstücke derselben Zeile, die dabei entfallen (der neue
  // Text steht dann ganz im Objekt index)
  | { type: 'editText'; pageIndex: number; index: number; text: string; merge?: number[] }
  // Absatz neu setzen: lines = Stücke je bisheriger Zeile (Anker zuerst), text mit harten Zeilenumbrüchen (\n). Der
  // Worker bricht mit den echten Zeichenbreiten in der Breite des Absatzes um.
  // Erkannter Text als unsichtbare Textebene (Texterkennung); Lage in einem Bild der Seite (width × height Bildpunkte)
  | { type: 'ocrText'; pageIndex: number; width: number; height: number; words: OcrWord[] }
  | {
      type: 'editParagraph';
      pageIndex: number;
      lines: number[][];
      text: string;
      // Neue Ränder (Seitenkoordinaten der sichtbaren Kanten); der Text bricht in dieser Breite um
      box?: { left: number; right: number };
      style?: ParagraphStyle;
    };

// Neue Gestaltung eines Absatzes oder einer Zeile (Größe in Punkt, wie sie auf der Seite erscheint)
export interface ParagraphStyle {
  size?: number;
  // Standardschrift oder Schrift des Rechners (dann mit fontData, siehe shared/fonts.ts)
  font?: TextFont;
  fontData?: ArrayBuffer;
  color?: Rgb;
}

// Höchstens so viele Objekte je Seite werden zum Bearbeiten angeboten
export const MAX_PAGE_OBJECTS = 3000;
// davon höchstens so viele Linien und Flächen
export const MAX_PAGE_PATHS = 600;
// Flächen, die mehr als diesen Anteil der Seite bedecken, gelten als Hintergrund und werden nicht angeboten (sonst fängt
// ein Klick neben dem Text den Hintergrund und verschiebt ihn)
export const BACKGROUND_SHARE = 0.6;

export const LINE_HEIGHT = 1.2;
// Abstand der Grundlinie von der Oberkante ihrer Zeile, als Anteil der Schriftgröße: halber Durchschuss 0,1 plus
// Oberlänge der Standardschriften (etwa 0,76)
export const FIRST_BASELINE = 0.86;

// Zeichen des westeuropäischen Zeichensatzes (WinAnsi), die Standardschriften ohne Einbetten darstellen
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

export function isWinAnsi(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.includes(char);
}

// Zeichen, die die Schrift einer Zeile nicht darstellen kann (dann verwendet die App eine Standardschrift)
export function missingChars(text: string, font: PageFontInfo | undefined): string {
  const chars = [...new Set([...text])].filter((char) => char !== ' ' && char !== '\n');
  if (!font) return chars.filter((char) => !isWinAnsi(char)).join('');
  if (font.chars === null) return chars.filter((char) => !isWinAnsi(char)).join('');
  const known = new Set([...font.chars]);
  return chars.filter((char) => !known.has(char)).join('');
}

// Bild (Einheitsquadrat) aufrecht in das angezeigte Rechteck legen; rotation = EXIF-Drehung im Uhrzeigersinn
export function imageMatrix([left, bottom, right, top]: Rect, rotation: 0 | 90 | 180 | 270): Matrix {
  const width = right - left;
  const height = top - bottom;
  switch (rotation) {
    case 90:
      return [0, -height, width, 0, left, top];
    case 180:
      return [-width, 0, 0, -height, right, top];
    case 270:
      return [0, height, -width, 0, right, bottom];
    default:
      return [width, 0, 0, height, left, bottom];
  }
}

// Verschieben um (dx, dy)
export const translation = (dx: number, dy: number): Matrix => [1, 0, 0, 1, dx, dy];

// Gleichmäßig skalieren um den festen Punkt (fx, fy)
export const scalingAbout = (factor: number, fx: number, fy: number): Matrix => [factor, 0, 0, factor, fx - factor * fx, fy - factor * fy];

// Ein PDF speichert Text in Stücken (oft Wörter oder Wortteile). Für das Bearbeiten werden Stücke zu einer Zeile
// zusammengefasst, die auf derselben Höhe liegen, gleich aussehen (Schrift, Größe, Farbe) und nur durch kleine
// Lücken getrennt sind. Große Lücken (Spalten, Tabellen) und andere Schriften (z. B. ein fettes Wort) trennen.
const sameRgb = (a: Rgb | undefined, b: Rgb | undefined) =>
  (a === undefined && b === undefined) || (a !== undefined && b !== undefined && Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 0.02);

const sizeOf = (object: PageObjectInfo) => object.visualSize ?? object.fontSize ?? 0;

// Schriften vergleichen über den Namen: Textprogramme legen Ligaturen (fi, ff, ft …) oft in einen eigenen Teil derselben
// Schrift, der in der PDF-Datei eine eigene Schrift ist.
type Fonts = Record<string, PageFontInfo> | undefined;
const sameFont = (a: PageObjectInfo, b: PageObjectInfo, fonts: Fonts) =>
  a.font === b.font || (a.font !== undefined && b.font !== undefined && Boolean(fonts?.[a.font]?.name) && fonts?.[a.font]?.name === fonts?.[b.font]?.name);

function sameLine(a: PageObjectInfo, b: PageObjectInfo, fonts: Fonts): boolean {
  if (a.kind !== 'text' || b.kind !== 'text') return false;
  const size = sizeOf(a);
  // Ein Leerzeichen zwischen zwei Schriften (fett, normal) gehört trotzdem zur Zeile
  const space = a.text === ' ' || b.text === ' ';
  if (!space && (!sameFont(a, b, fonts) || !sameRgb(a.color, b.color))) return false;
  if (size <= 0 || (!space && Math.abs(size - sizeOf(b)) > size * 0.05)) return false;
  // Höhe: Grundlinien nahe beieinander (die Unterkante schwankt mit Unterlängen, deshalb Mitte und Überlappung)
  // Aufrechte Stücke: gleiche Grundlinie (Satzzeichen wie das Komma liegen unten und überlappen kaum mit Buchstaben;
  // Leerzeichen haben gar keine Höhe)
  if (a.upright && b.upright && a.baseline !== undefined && b.baseline !== undefined && Math.abs(a.baseline - b.baseline) < size * 0.1) return true;
  const [, ab, , at] = a.bounds;
  const [, bb, , bt] = b.bounds;
  const overlap = Math.min(at, bt) - Math.max(ab, bb);
  return overlap > 0.5 * Math.min(at - ab, bt - bb) && Math.abs(ab - bb) < size * 0.35;
}

// Alle Stücke der Zeile, zu der das Objekt index gehört, von links nach rechts
export function lineOf(objects: PageObjectInfo[], index: number, fonts?: Record<string, PageFontInfo>): PageObjectInfo[] {
  const start = objects.find((object) => object.index === index);
  if (!start || start.kind !== 'text') return start ? [start] : [];
  const candidates = objects.filter((object) => object === start || sameLine(start, object, fonts)).sort((a, b) => a.bounds[0] - b.bounds[0]);
  const at = candidates.indexOf(start);
  const size = sizeOf(start);
  const fits = (left: PageObjectInfo, right: PageObjectInfo) => {
    const gap = right.bounds[0] - left.bounds[2];
    return gap < size * 1.2 && gap > -size * 0.5;
  };
  let first = at;
  while (first > 0 && fits(candidates[first - 1] as PageObjectInfo, candidates[first] as PageObjectInfo)) first--;
  let last = at;
  while (last < candidates.length - 1 && fits(candidates[last] as PageObjectInfo, candidates[last + 1] as PageObjectInfo)) last++;
  return candidates.slice(first, last + 1);
}

// Lücke (Anteil der Schriftgröße), ab der zwischen zwei Stücken ein Leerzeichen steht. Setzt das PDF Leerzeichen als
// eigene Stücke (Browser drucken jedes Zeichen einzeln), sind kleinere Lücken nur Abstände zwischen Buchstaben.
function gapFactor(pieces: PageObjectInfo[]): number {
  return pieces.some((piece) => piece.text === ' ') ? 0.35 : 0.12;
}

// Text der Zeile; zwischen Stücken mit sichtbarer Lücke steht ein Leerzeichen (PDFium hängt es oft schon selbst an)
export function lineText(pieces: PageObjectInfo[]): string {
  const gap = gapFactor(pieces);
  let text = '';
  pieces.forEach((piece, i) => {
    const previous = pieces[i - 1];
    // PDFium hängt beim Auslesen oft selbst ein Leerzeichen an ein Stück; beginnt das nächste mit einem, entfällt es
    const own = /\s$/.test(text) ? (piece.text ?? '').replace(/^\s+/, '') : (piece.text ?? '');
    if (previous && !/\s$/.test(text) && !/^\s/.test(own) && piece.bounds[0] - previous.bounds[2] > sizeOf(piece) * gap) text += ' ';
    text += own;
  });
  return text.trimEnd();
}

// Gestaltung eines Textstücks; die Schrift bleibt die des Stücks (source). Gleiche Schriften, die das PDF mehrfach
// enthält (jedes neue Stück in einer Standardschrift bekommt eine eigene), tragen denselben Schlüssel.
function styleOfPiece(piece: PageObjectInfo, fonts: Fonts) {
  const font = piece.font ? fonts?.[piece.font] : undefined;
  const same = font && fonts ? Object.keys(fonts).find((key) => fonts[key]?.name === font.name && fonts[key]?.embedded === font.embedded && fonts[key]?.chars === font.chars) : undefined;
  const key = same ?? piece.font;
  return { size: sizeOf(piece), color: piece.color ?? { r: 0, g: 0, b: 0 }, source: piece.index, ...(key ? { key } : {}) };
}

// Stücke einer Zeile mit ihrer Gestaltung, Lücken wie in lineText
function lineRuns(pieces: PageObjectInfo[], fonts: Fonts): TextRun[] {
  const gap = gapFactor(pieces);
  const runs: TextRun[] = [];
  let text = '';
  pieces.forEach((piece, i) => {
    const previous = pieces[i - 1];
    const lead = piece.mark?.l;
    const own = lead ? ' '.repeat(lead) + (piece.text ?? '').replace(/^\s+/, '') : (piece.text ?? '');
    const last = runs[runs.length - 1];
    // PDFium hängt beim Auslesen oft selbst ein Leerzeichen an ein Stück; beginnt das nächste mit einem, gilt dieses
    if (last && /\s$/.test(last.text) && /^\s/.test(own)) {
      last.text = last.text.slice(0, -1);
      text = text.slice(0, -1);
    }
    if (previous && last && !/\s$/.test(text) && !/^\s/.test(own) && piece.bounds[0] - previous.bounds[2] > sizeOf(piece) * gap) {
      last.text += ' ';
      text += ' ';
    }
    runs.push({ ...styleOfPiece(piece, fonts), text: own });
    text += own;
  });
  // wie trimEnd: Leerraum am Zeilenende entfällt
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i] as TextRun;
    run.text = run.text.trimEnd();
    if (run.text !== '') break;
  }
  return runs;
}

// Seitenobjekte für die Bearbeitung: Textstücke einer Zeile als eine Einheit (Anker = erstes Stück, members = alle
// Stücke einschließlich Anker), Bilder und Grafikgruppen einzeln
// lines: nur bei Absätzen, Stücke je Zeile
// runs, origin: nur bei von Blattwerk gesetztem Text, die Stücke mit Gestaltung und Anfang/Oberkante der ersten Zeile
export type EditUnit = PageObjectInfo & { members: number[]; lines?: number[][]; runs?: TextRun[]; origin?: Point };

export function editUnits(objects: PageObjectInfo[], fonts?: Record<string, PageFontInfo>): EditUnit[] {
  const assigned = new Set<number>();
  const units: EditUnit[] = markedUnits(objects, assigned, fonts);
  // Leerzeichen zuletzt: Sie schließen sich einer Zeile an, sollen aber keine Zeile aus Stücken verschiedener Schriften bilden
  const ordered = [...objects.filter((object) => object.text !== ' '), ...objects.filter((object) => object.text === ' ')];
  for (const object of ordered) {
    if (assigned.has(object.index)) continue;
    if (object.kind !== 'text') {
      units.push({ ...object, members: [object.index] });
      continue;
    }
    const pieces = lineOf(objects, object.index, fonts).filter((piece) => !assigned.has(piece.index));
    for (const piece of pieces) assigned.add(piece.index);
    const [anchor = object] = pieces;
    units.push({ ...anchor, bounds: unionBounds(pieces), text: lineText(pieces), members: pieces.map((piece) => piece.index) });
  }
  return groupParagraphs(units, fonts);
}

// Von Blattwerk gesetzte Texte (Kennzeichnung im PDF): Stücke mit derselben Absatzkennzahl bilden eine Einheit,
// unabhängig von Breite und Abständen. Zeilen nach Grundlinie, harte Umbrüche und Leerzeilen aus der Kennzeichnung.
function markedUnits(objects: PageObjectInfo[], assigned: Set<number>, fonts: Fonts): EditUnit[] {
  const groups = new Map<number, PageObjectInfo[]>();
  for (const object of objects) {
    if (object.kind !== 'text' || !object.mark || !object.upright || object.baseline === undefined) continue;
    const group = groups.get(object.mark.p) ?? [];
    group.push(object);
    groups.set(object.mark.p, group);
  }
  const units: EditUnit[] = [];
  for (const pieces of groups.values()) {
    const size = sizeOf(pieces[0] as PageObjectInfo) || 12;
    const sorted = [...pieces].sort((a, b) => (b.baseline ?? 0) - (a.baseline ?? 0) || a.bounds[0] - b.bounds[0]);
    const lines: PageObjectInfo[][] = [];
    for (const piece of sorted) {
      const line = lines[lines.length - 1];
      const head = line?.[0];
      if (line && head && Math.abs((head.baseline ?? 0) - (piece.baseline ?? 0)) < size * 0.3) line.push(piece);
      else lines.push([piece]);
    }
    for (const line of lines) line.sort((a, b) => a.bounds[0] - b.bounds[0]);
    const step = size * LINE_HEIGHT;
    const runs: TextRun[] = [];
    lines.forEach((line, i) => {
      const own = lineRuns(line, fonts);
      runs.push(...own);
      const next = lines[i + 1];
      if (!next) return;
      const hard = line.some((piece) => piece.mark?.h);
      // Leerzeilen zwischen Absätzen haben kein eigenes Objekt: aus der Kennzeichnung, sonst aus dem Abstand der Grundlinien
      const marked = line.find((piece) => piece.mark?.b !== undefined)?.mark?.b;
      const skipped = marked ?? Math.max(0, Math.round(((line[0]?.baseline ?? 0) - (next[0]?.baseline ?? 0)) / step) - 1);
      const separator = hard ? '\n'.repeat(1 + skipped) : ' ';
      const last = own[own.length - 1];
      if (last) last.text += separator;
      else runs.push({ ...styleOfPiece(line[0] as PageObjectInfo, fonts), text: separator });
    });
    const merged = normalizeRuns(runs);
    const text = runsText(merged);
    const all = lines.flat();
    for (const piece of all) assigned.add(piece.index);
    const [anchor] = lines[0] as [PageObjectInfo];
    const bounds = unionBounds(all);
    const width = anchor.mark?.w;
    if (width) bounds[2] = Math.max(bounds[2], Math.min(...lines.map((line) => line[0]?.bounds[0] ?? Infinity)) + width);
    const first = lines[0] as PageObjectInfo[];
    const origin = {
      x: Math.min(...lines.map((line) => line[0]?.x ?? line[0]?.bounds[0] ?? Infinity)),
      y: (anchor.baseline ?? 0) + FIRST_BASELINE * Math.max(...first.map(sizeOf)),
    };
    units.push({
      ...anchor,
      bounds,
      text,
      members: all.map((piece) => piece.index),
      ...(lines.length > 1 ? { lines: lines.map((line) => line.map((piece) => piece.index)) } : {}),
      runs: merged,
      origin,
    });
  }
  return units;
}

// Zeilen, die direkt untereinander stehen, links bündig sind (die erste darf eingerückt sein), gleich aussehen und
// gleichmäßigen Abstand haben, bilden einen Absatz. Zeilen mit weiteren Textstücken daneben (anders formatiertes
// Wort, zweite Spalte) und gedrehter Text bleiben einzelne Zeilen.
function sameStyle(a: PageObjectInfo, b: PageObjectInfo, fonts: Fonts): boolean {
  const size = sizeOf(a);
  return sameFont(a, b, fonts) && sameRgb(a.color, b.color) && size > 0 && Math.abs(size - sizeOf(b)) <= size * 0.05;
}

function groupParagraphs(units: EditUnit[], fonts: Fonts): EditUnit[] {
  const texts = units.filter((unit) => unit.kind === 'text');
  // Nur Textspalten (mindestens acht Schriftgrößen breit): Sehr schmale Blöcke (Adressen, Tabellenzellen) bleiben
  // einzelne Zeilen, dort sind Umbrüche fast immer gewollt
  const lines = texts.filter((unit) => unit.upright === true && unit.baseline !== undefined && sizeOf(unit) > 0).sort((a, b) => b.bounds[3] - a.bounds[3]);
  // Weitere Textstücke in derselben Zeile innerhalb der Breite [left, right]? Links davor (Nummer, Aufzählungszeichen)
  // stört nicht.
  const hasNeighbour = (line: EditUnit, left: number, right: number) =>
    texts.some((other) => {
      if (other === line) return false;
      const middle = (other.bounds[1] + other.bounds[3]) / 2;
      return middle > line.bounds[1] && middle < line.bounds[3] && other.bounds[0] < right && other.bounds[2] > left;
    });
  const used = new Set<EditUnit>();
  const paragraphs: EditUnit[][] = [];
  for (const start of lines) {
    if (used.has(start)) continue;
    const size = sizeOf(start);
    const paragraph = [start];
    let left = start.bounds[0];
    let right = start.bounds[2];
    if (hasNeighbour(start, left, right + size)) continue;
    let gap = 0;
    for (;;) {
      const current = paragraph[paragraph.length - 1] as EditUnit;
      // Nächste Zeile darunter, die sich waagerecht mit dem Absatz überschneidet
      const next = lines.find(
        (line) => !used.has(line) && !paragraph.includes(line) && line.bounds[3] < current.bounds[3] - size * 0.5 && line.bounds[0] < right && line.bounds[2] > left,
      );
      if (!next || !sameStyle(start, next, fonts)) break;
      const step = (current.baseline ?? 0) - (next.baseline ?? 0);
      if (step < size * 0.9 || step > size * 2.3 || (gap > 0 && Math.abs(step - gap) > size * 0.15)) break;
      const second = paragraph[1];
      const aligned = second
        ? Math.abs(next.bounds[0] - second.bounds[0]) <= size * 0.6
        : Math.abs(next.bounds[0] - start.bounds[0]) <= size * 0.6 || (start.bounds[0] > next.bounds[0] && start.bounds[0] - next.bounds[0] <= size * 4);
      if (!aligned || hasNeighbour(next, Math.min(left, next.bounds[0]), Math.max(right, next.bounds[2]))) break;
      gap = gap || step;
      paragraph.push(next);
      left = Math.min(left, next.bounds[0]);
      right = Math.max(right, next.bounds[2]);
    }
    if (paragraph.length < 2 || right - left < size * 8) continue;
    for (const line of paragraph) used.add(line);
    paragraphs.push(paragraph);
  }
  if (paragraphs.length === 0) return units;
  const result = units.filter((unit) => !used.has(unit));
  for (const paragraph of paragraphs) {
    const [first] = paragraph as [EditUnit];
    result.push({
      ...first,
      bounds: unionBounds(paragraph),
      text: paragraphText(paragraph),
      members: paragraph.flatMap((line) => line.members),
      lines: paragraph.map((line) => line.members),
    });
  }
  return result;
}

// Text eines Absatzes zum Bearbeiten. Endet eine Zeile deutlich vor dem rechten Rand, obwohl das erste Wort der
// nächsten noch gepasst hätte, war der Umbruch gewollt (Adresse, Aufzählung, Absatzende): Er bleibt als \n erhalten.
// Sonst werden die Zeilen mit Leerzeichen verbunden; Trennstriche am Zeilenende (Silbentrennung) entfallen.
export function paragraphText(lines: PageObjectInfo[]): string {
  const right = Math.max(...lines.map((line) => line.bounds[2]));
  let text = '';
  lines.forEach((line, i) => {
    const own = (line.text ?? '').trim();
    const next = lines[i + 1];
    if (!next) {
      text += own;
      return;
    }
    const following = (next.text ?? '').trim();
    const firstWord = following.split(/\s/)[0] ?? '';
    const size = sizeOf(line);
    if (line.bounds[2] + (firstWord.length * 0.5 + 0.3) * size < right) text += `${own}\n`;
    else if (/\p{L}-$/u.test(own) && /^\p{Ll}/u.test(following)) text += own.slice(0, -1);
    else text += `${own} `;
  });
  return text;
}

export function unionBounds(pieces: PageObjectInfo[]): Rect {
  return pieces.reduce<Rect>(
    (acc, { bounds }) => [Math.min(acc[0], bounds[0]), Math.min(acc[1], bounds[1]), Math.max(acc[2], bounds[2]), Math.max(acc[3], bounds[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}
