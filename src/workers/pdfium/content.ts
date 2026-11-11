// Seiteninhalt bearbeiten mit PDFium (Phase 5): Objekte auflisten, Text und Bilder einfügen, verschieben, skalieren,
// löschen, Textzeilen ändern. PDFium schreibt danach den Inhalt der Seite neu (FPDFPage_GenerateContent); gespeichert
// wird inkrementell. Siehe docs/entscheidungen/0010-inhalt-bearbeiten.md.
import type { Rgb } from '../../shared/annotations';
import {
  FIRST_BASELINE,
  imageMatrix,
  LINE_HEIGHT,
  MAX_PAGE_OBJECTS,
  MAX_PAGE_PATHS,
  BACKGROUND_SHARE,
  missingChars,
  type ContentOperation,
  type ParagraphStyle,
  type TextMark,
  type PageFontInfo,
  type PageObjectInfo,
  type PageObjects,
} from '../../shared/content';
import type { StampFont } from '../../shared/stamping';
import { isSystemFontKey, type SystemFontKey, type TextFont } from '../../shared/fonts';
import type { OcrWord } from '../../shared/ocr';
import type { TextRun } from '../../shared/rich-text';
import { hangingPrefix } from '../../shared/lists';
import { withBuffer, withFloats, withWString, type Pdfium } from './memory';
import type { Allocations } from './pages';

export class ContentError extends Error {
  constructor(
    message: string,
    // content-characters: Zeichen, die weder die Schrift der Zeile noch eine Standardschrift kennt (message = Zeichen)
    readonly code: 'content-missing' | 'content-characters' = 'content-missing',
  ) {
    super(message);
    this.name = 'ContentError';
  }
}

const OBJECT = { text: 1, path: 2, image: 3, shading: 4, form: 5 } as const;

// PDFium-Namen der Standardschriften
const STANDARD_FONT: Record<StampFont, string> = {
  Helvetica: 'Helvetica',
  HelveticaBold: 'Helvetica-Bold',
  TimesRoman: 'Times-Roman',
  TimesRomanBold: 'Times-Bold',
  Courier: 'Courier',
};

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

function readFloats(m: Pdfium, count: number, fill: (ptr: number) => boolean): number[] | null {
  return withBuffer(m, count * 4, (ptr) => (fill(ptr) ? Array.from({ length: count }, (_, i) => m.pdfium.getValue(ptr + i * 4, 'float') as number) : null));
}

function objectText(m: Pdfium, object: number, textPage: number): string {
  const length = m.FPDFTextObj_GetText(object, textPage, 0, 0);
  if (length <= 2) return '';
  return withBuffer(m, length, (ptr) => {
    m.FPDFTextObj_GetText(object, textPage, ptr, length);
    return m.pdfium.UTF16ToString(ptr);
  });
}

// Pfad mit Füllung oder Kontur (reine Beschneidungspfade zeichnen nichts)
function visiblePath(m: Pdfium, object: number): boolean {
  return withBuffer(m, 8, (ptr) => {
    if (!m.FPDFPath_GetDrawMode(object, ptr, ptr + 4)) return false;
    return (m.pdfium.getValue(ptr, 'i32') as number) !== 0 || (m.pdfium.getValue(ptr + 4, 'i32') as number) !== 0;
  });
}

function fontName(m: Pdfium, font: number): string {
  const length = m.FPDFFont_GetBaseFontName(font, 0, 0);
  if (length <= 1) return '';
  return withBuffer(m, length + 1, (ptr) => {
    m.FPDFFont_GetBaseFontName(font, ptr, length);
    return m.pdfium.UTF8ToString(ptr);
  });
}

function fillColor(m: Pdfium, object: number): Rgb | undefined {
  return withBuffer(m, 16, (ptr) => {
    if (!m.FPDFPageObj_GetFillColor(object, ptr, ptr + 4, ptr + 8, ptr + 12)) return undefined;
    const value = (offset: number) => (m.pdfium.getValue(ptr + offset, 'i32') as number) / 255;
    return { r: value(0), g: value(4), b: value(8) };
  });
}

function withPage<T>(m: Pdfium, doc: number, pageIndex: number, fn: (page: number) => T): T {
  const page = m.FPDF_LoadPage(doc, pageIndex);
  if (!page) throw new ContentError(`Seite ${pageIndex + 1} lässt sich nicht laden`);
  try {
    return fn(page);
  } finally {
    m.FPDF_ClosePage(page);
  }
}

export function listPageObjects(m: Pdfium, doc: number, pageIndex: number): PageObjects {
  return withPage(m, doc, pageIndex, (page) => {
    const textPage = m.FPDFText_LoadPage(page);
    try {
      const objects: PageObjectInfo[] = [];
      const fontsByPointer = new Map<number, string>();
      const fonts: Record<string, PageFontInfo & { seen: Set<string>; handle: number }> = {};
      const count = m.FPDFPage_CountObjects(page);
      let truncated = false;
      let paths = 0;
      const pageArea = m.FPDF_GetPageWidthF(page) * m.FPDF_GetPageHeightF(page);
      for (let index = 0; index < count; index++) {
        const object = m.FPDFPage_GetObject(page, index);
        const type = m.FPDFPageObj_GetType(object);
        const kind = type === OBJECT.text ? 'text' : type === OBJECT.image ? 'image' : type === OBJECT.form ? 'form' : type === OBJECT.path ? 'path' : null;
        if (!kind) continue;
        // Linien und Flächen (Tabellen, Rahmen, Unterstreichungen): nur sichtbare, keine seitenfüllenden Hintergründe, und
        // höchstens MAX_PAGE_PATHS, damit Text auf Seiten mit vielen Vektorgrafiken auswählbar bleibt
        if (kind === 'path' && (!visiblePath(m, object) || paths >= MAX_PAGE_PATHS)) {
          if (paths >= MAX_PAGE_PATHS) truncated = true;
          continue;
        }
        // Unsichtbarer Text (z. B. aus der Texterkennung) ist nicht zum Bearbeiten gedacht
        if (kind === 'text' && m.FPDFTextObj_GetTextRenderMode(object) === TEXT_INVISIBLE) continue;
        if (objects.length >= MAX_PAGE_OBJECTS) {
          truncated = true;
          break;
        }
        const bounds = readFloats(m, 4, (ptr) => Boolean(m.FPDFPageObj_GetBounds(object, ptr, ptr + 4, ptr + 8, ptr + 12)));
        if (!bounds) continue;
        if (kind === 'path') {
          const [left = 0, bottom = 0, right = 0, top = 0] = bounds;
          if ((right - left) * (top - bottom) > pageArea * BACKGROUND_SHARE) continue;
          paths++;
        }
        const info: PageObjectInfo = { index, kind, bounds: bounds as PageObjectInfo['bounds'] };
        if (kind === 'text') {
          let text = textPage ? objectText(m, object, textPage) : '';
          // Ein Objekt nur aus einem Leerzeichen (Browser setzen jedes Zeichen einzeln) liest PDFium als leeren Text und
          // ohne Fläche: als Leerzeichen behandeln, damit es zu seiner Zeile gehört
          if (text === '' && bounds[0] === bounds[2]) text = ' ';
          const size = readFloats(m, 1, (ptr) => Boolean(m.FPDFTextObj_GetFontSize(object, ptr)));
          const font = m.FPDFTextObj_GetFont(object);
          let key = fontsByPointer.get(font);
          if (key === undefined) {
            key = `f${fontsByPointer.size}`;
            fontsByPointer.set(font, key);
            fonts[key] = { name: fontName(m, font), embedded: Boolean(m.FPDFFont_GetIsEmbedded(font)), chars: null, seen: new Set(), handle: font };
          }
          for (const char of text) fonts[key]?.seen.add(char);
          const fontSize = size?.[0] ?? 0;
          const matrix = readFloats(m, 6, (ptr) => Boolean(m.FPDFPageObj_GetMatrix(object, ptr)));
          const scale = matrix ? Math.hypot(matrix[2] ?? 0, matrix[3] ?? 0) : 1;
          const upright = matrix !== null && (matrix[0] ?? 0) > 0 && (matrix[3] ?? 0) > 0 && Math.abs(matrix[1] ?? 0) < 1e-3 && Math.abs(matrix[2] ?? 0) < 1e-3;
          const mark = readMark(m, object);
          Object.assign(info, { text, fontSize, visualSize: fontSize * (scale || 1), font: key, color: fillColor(m, object), upright, ...(upright ? { baseline: matrix[5], x: matrix[4] } : {}), ...(mark ? { mark } : {}) });
        }
        objects.push(info);
      }
      const result: Record<string, PageFontInfo> = {};
      for (const [key, font] of Object.entries(fonts)) {
        // Nicht eingebettete Schriften ersetzt das Anzeigeprogramm (westeuropäischer Zeichensatz). Eingebettete enthalten
        // oft nur die verwendeten Zeichen: geprüft wird, für welche Zeichen die Schrift wirklich eine Form hat.
        result[key] = { name: font.name, embedded: font.embedded, chars: font.embedded ? renderableChars(m, font.handle, font.seen) : null };
      }
      return { pageIndex, objects, fonts: result, truncated };
    } finally {
      if (textPage) m.FPDFText_ClosePage(textPage);
    }
  });
}

// Kandidaten: westeuropäischer Zeichensatz und alle Zeichen, die auf der Seite in dieser Schrift vorkommen
const CANDIDATES = (() => {
  const chars: string[] = [];
  for (let code = 0x21; code <= 0x7e; code++) chars.push(String.fromCharCode(code));
  for (let code = 0xa1; code <= 0xff; code++) chars.push(String.fromCharCode(code));
  return [...chars, ...'€‚ƒ„…†‡‰Š‹ŒŽ‘’“”•–—™š›œžŸ'];
})();

// Fehlt ein Zeichen, liefert PDFium die Form des Ersatzzeichens (.notdef, meist ein Kästchen). Dessen Form ergibt sich
// aus einem Zeichen, das keine Schrift enthält (Privatbereich von Unicode).
// PDFium hält Glyphenpfade im Zwischenspeicher je Glyphe: Alle fehlenden Zeichen liefern denselben Pfad.
function renderableChars(m: Pdfium, font: number, seen: Set<string>): string {
  const notdef = m.FPDFFont_GetGlyphPath(font, 0xf8ff, 12);
  const result: string[] = [];
  for (const char of new Set([...CANDIDATES, ...seen])) {
    if (/\s/.test(char)) continue;
    const path = m.FPDFFont_GetGlyphPath(font, char.codePointAt(0) ?? 0, 12);
    if (path && path !== notdef && m.FPDFGlyphPath_CountGlyphSegments(path) > 0) result.push(char);
  }
  return result.join('');
}

// Ähnliche Standardschrift für eine Zeile, deren Schrift die neuen Zeichen nicht hat
function substituteFont(name: string, weight: number): StampFont {
  const lower = name.toLowerCase();
  const bold = weight >= 600 || /bold|black|heavy|semibold/.test(lower);
  if (/courier|mono|consol/.test(lower)) return 'Courier';
  if (/times|serif|roman|georgia|garamond|cambria|minion/.test(lower) && !/sans/.test(lower)) return bold ? 'TimesRomanBold' : 'TimesRoman';
  return bold ? 'HelveticaBold' : 'Helvetica';
}

// Schriften des Rechners (ADR 0024): Daten aus der Operation, geladen einmal je Operation (eingebettet, Unicode)
const systemFontData = new Map<string, Uint8Array>();
const systemFontHandles = new Map<string, number>();

function useSystemFonts(operation: ContentOperation): void {
  const register = (font: TextFont | undefined, data: ArrayBuffer | undefined) => {
    if (font && isSystemFontKey(font) && data) systemFontData.set(font, new Uint8Array(data));
  };
  if (operation.type === 'addText') register(operation.font, operation.fontData);
  if (operation.type === 'addRichText') for (const run of operation.runs) register(run.font, run.fontData);
  if (operation.type === 'editParagraph') register(operation.style?.font, operation.style?.fontData);
}

function releaseSystemFonts(m: Pdfium): void {
  for (const handle of systemFontHandles.values()) m.FPDFFont_Close(handle);
  systemFontHandles.clear();
  systemFontData.clear();
}

function systemFont(m: Pdfium, doc: number, font: SystemFontKey, memory: Allocations): number {
  const cached = systemFontHandles.get(font);
  if (cached) return cached;
  const data = systemFontData.get(font);
  if (!data) throw new ContentError(`Schrift ${font} fehlt`);
  // TrueType, als CID-Schrift (alle Zeichen der Schrift, nicht nur Westeuropa)
  const handle = m.FPDFText_LoadFont(doc, memory.copy(data), data.length, 2, true);
  if (!handle) throw new ContentError(`Schrift ${font} lässt sich nicht laden`);
  systemFontHandles.set(font, handle);
  return handle;
}

let currentMemory: Allocations | null = null;

function newTextObject(m: Pdfium, doc: number, font: TextFont, size: number, text: string, color: Rgb): number {
  const object = isSystemFontKey(font)
    ? m.FPDFPageObj_CreateTextObj(doc, systemFont(m, doc, font, currentMemory as Allocations), size)
    : m.FPDFPageObj_NewTextObj(doc, STANDARD_FONT[font], size);
  if (!object) throw new ContentError('Textobjekt lässt sich nicht anlegen');
  withWString(m, text, (ptr) => m.FPDFText_SetText(object, ptr));
  m.FPDFPageObj_SetFillColor(object, byte(color.r), byte(color.g), byte(color.b), 255);
  return object;
}

function objectAt(m: Pdfium, page: number, index: number): number {
  if (index < 0 || index >= m.FPDFPage_CountObjects(page)) throw new ContentError(`Objekt ${index} fehlt`);
  const object = m.FPDFPage_GetObject(page, index);
  if (!object) throw new ContentError(`Objekt ${index} fehlt`);
  return object;
}

// Wendet eine Inhaltsoperation an und schreibt den Inhalt der Seite neu.
export function applyContentOperation(m: Pdfium, doc: number, operation: ContentOperation, memory: Allocations): void {
  useSystemFonts(operation);
  currentMemory = memory;
  try {
    applyOperation(m, doc, operation, memory);
  } finally {
    releaseSystemFonts(m);
    currentMemory = null;
  }
}

function applyOperation(m: Pdfium, doc: number, operation: ContentOperation, memory: Allocations): void {
  // Vorher auflisten: Ein zweites Laden derselben Seite, während sie offen ist, macht Schrift-Handles ungültig
  const listing = operation.type === 'editParagraph' || operation.type === 'addRichText' ? listPageObjects(m, doc, operation.pageIndex) : null;
  withPage(m, doc, operation.pageIndex, (page) => {
    switch (operation.type) {
      case 'addText': {
        const rotation = (m.FPDFPage_GetRotation(page) * 90) % 360;
        // Aufrecht zur Anzeige: Die Seite wird um rotation im Uhrzeigersinn gedreht angezeigt, der Text also gegenläufig gedreht.
        const angle = (rotation * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        let lines: WrappedLine[] = operation.lines.map((text) => ({ text, hard: true }));
        if (operation.width) {
          // In der gewählten Breite umbrechen, gemessen in der Schrift des neuen Textes
          const ruler = newTextObject(m, doc, operation.font, operation.size, 'x', operation.color);
          try {
            const widthOf = measureWith(m, ruler, 1, 1);
            const width = operation.width;
            lines = wrapText(operation.lines.join('\n'), (line, _i, indent) => indent + widthOf(line) <= width + 0.5, advanceWith(widthOf));
          } finally {
            m.FPDFPageObj_Destroy(ruler);
          }
        }
        const step = operation.size * LINE_HEIGHT;
        // Zeilen auf eine Seite setzen, ab der Grundlinie startY; liefert die Zeilen, die nicht mehr passen (Fließtext)
        const place = (target: number, rows: WrappedLine[], startY: number): WrappedLine[] => {
          const paragraph = newParagraphId();
          for (let i = 0; i < rows.length; i++) {
            // Zeile i liegt um i · Zeilenhöhe unter der ersten, in der Leserichtung der angezeigten Seite
            const offset = i * step;
            const indent = rows[i]?.indent ?? 0;
            const x = operation.origin.x + sin * offset + cos * indent;
            const y = startY - cos * offset + sin * indent;
            if (operation.flow && rotation === 0 && i > 0 && y < operation.flow.bottom) return rows.slice(i);
            const line = rows[i] as WrappedLine;
            if (line.text === '') continue;
            const object = newTextObject(m, doc, operation.font, operation.size, line.text, operation.color);
            writeMark(m, doc, object, { p: paragraph, ...(operation.width ? { w: operation.width } : {}), ...(line.hard ? { h: true } : {}), ...leading(line.text) });
            m.FPDFPageObj_Transform(object, cos, sin, -sin, cos, x, y);
            m.FPDFPage_InsertObject(target, object);
          }
          return [];
        };
        let rest = place(page, lines, operation.origin.y);
        // Überlauf: neue Seiten gleicher Größe direkt hinter dieser, oben am Rand weiter
        const size = { width: m.FPDF_GetPageWidthF(page), height: m.FPDF_GetPageHeightF(page) };
        for (let next = operation.pageIndex + 1; rest.length > 0 && operation.flow && next < operation.pageIndex + 200; next++) {
          const added = m.FPDFPage_New(doc, next, size.width, size.height);
          if (!added) throw new ContentError('Neue Seite lässt sich nicht anlegen');
          try {
            // Leerzeilen am Seitenanfang entfallen, wie in einer Textverarbeitung
            while (rest.length > 0 && rest[0]?.text === '') rest = rest.slice(1);
            rest = place(added, rest, operation.flow.top);
            if (!m.FPDFPage_GenerateContent(added)) throw new ContentError(`Seite ${next + 1} lässt sich nicht schreiben`);
          } finally {
            m.FPDF_ClosePage(added);
          }
        }
        break;
      }
      case 'addRichText':
        if (listing) addRichText(m, doc, page, listing, operation);
        break;
      case 'addImage': {
        const { image, rect } = operation;
        const object = m.FPDFPageObj_NewImageObj(doc);
        if (!object) throw new ContentError('Bildobjekt lässt sich nicht anlegen');
        const data = new Uint8Array(image.data);
        const ptr = memory.copy(data);
        const ok = image.kind === 'jpeg' ? m.EPDFImageObj_SetJpeg(0, 0, object, ptr, data.length) : m.EPDFImageObj_SetPng(0, 0, object, ptr, data.length);
        if (!ok) {
          m.FPDFPageObj_Destroy(object);
          throw new ContentError('Bild lässt sich nicht einbetten');
        }
        // Einheitsquadrat auf das Rechteck legen, EXIF-Drehung inklusive
        withFloats(m, imageMatrix(rect, image.rotation), (matrix) => m.FPDFPageObj_SetMatrix(object, matrix));
        m.FPDFPage_InsertObject(page, object);
        break;
      }
      case 'transform': {
        const object = objectAt(m, page, operation.index);
        const [a, b, c, d, e, f] = operation.matrix;
        m.FPDFPageObj_Transform(object, a, b, c, d, e, f);
        break;
      }
      case 'delete': {
        for (const index of [...new Set(operation.indices)].sort((x, y) => y - x)) {
          const object = objectAt(m, page, index);
          if (m.FPDFPage_RemoveObject(page, object)) m.FPDFPageObj_Destroy(object);
        }
        break;
      }
      case 'editText': {
        // Erst den Text ins erste Stück schreiben (behält seine Lage in der Objektliste), dann die übrigen Stücke der
        // Zeile von hinten entfernen, damit die Positionen davor gültig bleiben
        replaceText(m, doc, page, operation.pageIndex, operation.index, operation.text);
        for (const index of [...new Set(operation.merge ?? [])].filter((i) => i !== operation.index).sort((x, y) => y - x)) {
          const object = objectAt(m, page, index);
          if (m.FPDFPage_RemoveObject(page, object)) m.FPDFPageObj_Destroy(object);
        }
        break;
      }
      case 'ocrText':
        addOcrText(m, doc, page, operation.width, operation.height, operation.words);
        break;
      case 'editParagraph':
        if (listing) setParagraph(m, doc, page, listing, operation.lines, operation.text, operation.box, operation.style);
        break;
    }
    if (!m.FPDFPage_GenerateContent(page)) throw new ContentError(`Seite ${operation.pageIndex + 1} lässt sich nicht neu schreiben`);
  });
}

// Text einer Zeile ersetzen. Kennt die Schrift alle Zeichen, bleibt sie; sonst wird die Zeile mit einer ähnlichen
// Standardschrift neu angelegt (gleiche Lage, Größe, Farbe und Darstellungsart).
function replaceText(m: Pdfium, doc: number, page: number, pageIndex: number, index: number, text: string): void {
  const object = objectAt(m, page, index);
  if (m.FPDFPageObj_GetType(object) !== OBJECT.text) throw new ContentError(`Objekt ${index} ist kein Text`);
  const listing = listPageObjects(m, doc, pageIndex);
  const info = listing.objects.find((entry) => entry.index === index);
  const font = info?.font ? listing.fonts[info.font] : undefined;
  if (missingChars(text, font) === '') {
    withWString(m, text, (ptr) => m.FPDFText_SetText(object, ptr));
    return;
  }
  // Die Standardschriften kennen nur den westeuropäischen Zeichensatz
  const impossible = missingChars(text, undefined);
  if (impossible) throw new ContentError(impossible, 'content-characters');
  const matrix = readFloats(m, 6, (ptr) => Boolean(m.FPDFPageObj_GetMatrix(object, ptr)));
  const size = info?.fontSize ?? 12;
  const weight = m.FPDFFont_GetWeight(m.FPDFTextObj_GetFont(object));
  const replacement = newTextObject(m, doc, substituteFont(font?.name ?? '', weight), size, text, info?.color ?? { r: 0, g: 0, b: 0 });
  m.FPDFTextObj_SetTextRenderMode(replacement, m.FPDFTextObj_GetTextRenderMode(object));
  if (matrix) withFloats(m, matrix, (ptr) => m.FPDFPageObj_SetMatrix(replacement, ptr));
  m.FPDFPage_InsertObjectAtIndex(page, replacement, index);
  if (m.FPDFPage_RemoveObject(page, object)) m.FPDFPageObj_Destroy(object);
}

function removeObject(m: Pdfium, page: number, object: number): void {
  if (m.FPDFPage_RemoveObject(page, object)) m.FPDFPageObj_Destroy(object);
}

// Bricht Text in Zeilen um: harte Umbrüche (\n) bleiben, sonst Wort für Wort, solange die Zeile in ihre Breite passt.
// Ein Wort, das allein nicht passt, steht in einer eigenen Zeile. Leere Zeilen am Ende entfallen. Einzug am Anfang
// einer Zeile bleibt; Folgezeilen eines Listeneintrags beginnen hinter seinem Zeichen (hängender Einzug, braucht
// measure: Vorschub eines Textes).
interface WrappedLine {
  text: string;
  // Zeile endet mit einem harten Umbruch (Absatzende oder Eingabetaste)
  hard: boolean;
  // Abstand vom linken Rand (Punkt), nur bei Folgezeilen eines Listeneintrags
  indent?: number;
}

function wrapText(text: string, fits: (line: string, index: number, indent: number) => boolean, measure?: (value: string) => number): WrappedLine[] {
  const out: WrappedLine[] = [];
  for (const block of text.split('\n')) {
    const lead = /^[ \t]*/.exec(block)?.[0] ?? '';
    const prefix = hangingPrefix(block);
    const hang = prefix > 0 && measure ? measure(block.slice(0, prefix)) : 0;
    const words = block.split(/[ \t]+/).filter((word) => word !== '');
    let current = '';
    let first = true;
    for (const word of words) {
      const indent = first ? 0 : hang;
      const candidate = current ? `${current} ${word}` : first ? lead + word : word;
      if (!current || fits(candidate, out.length, indent)) current = candidate;
      else {
        out.push({ text: current, hard: false, ...(indent > 0 ? { indent } : {}) });
        first = false;
        current = word;
      }
    }
    const indent = first ? 0 : hang;
    out.push({ text: current, hard: true, ...(indent > 0 ? { indent } : {}) });
  }
  while (out.length > 0 && out[out.length - 1]?.text === '') out.pop();
  return out;
}

// Eigene Kennzeichnung gesetzter Texte (Marked Content): Absatz, Breite, harter Umbruch. So bleibt ein Textfeld beim
// erneuten Öffnen ein Absatz, egal wie schmal es ist, und behält seine Breite und Umbrüche.
const MARK = 'BlattwerkText';

function markName(m: Pdfium, mark: number): string {
  return withBuffer(m, 4, (lengthPtr) => {
    if (!m.FPDFPageObjMark_GetName(mark, 0, 0, lengthPtr)) return '';
    const length = m.pdfium.getValue(lengthPtr, 'i32') as number;
    if (length <= 2) return '';
    return withBuffer(m, length, (buffer) => {
      m.FPDFPageObjMark_GetName(mark, buffer, length, lengthPtr);
      return m.pdfium.UTF16ToString(buffer);
    });
  });
}

function ownMark(m: Pdfium, object: number): number | null {
  const count = m.FPDFPageObj_CountMarks(object);
  for (let i = 0; i < count; i++) {
    const mark = m.FPDFPageObj_GetMark(object, i);
    if (mark && markName(m, mark) === MARK) return mark;
  }
  return null;
}

function readMark(m: Pdfium, object: number): TextMark | undefined {
  const mark = ownMark(m, object);
  if (!mark) return undefined;
  const int = (key: string) => withBuffer(m, 4, (ptr) => (m.FPDFPageObjMark_GetParamIntValue(mark, key, ptr) ? (m.pdfium.getValue(ptr, 'i32') as number) : null));
  const p = int('P');
  if (p === null) return undefined;
  const w = withBuffer(m, 4, (ptr) => (m.FPDFPageObjMark_GetParamFloatValue(mark, 'W', ptr) ? (m.pdfium.getValue(ptr, 'float') as number) : null));
  const b = int('B');
  const l = int('L');
  return {
    p,
    ...(w !== null && w > 0 ? { w } : {}),
    ...(int('H') === 1 ? { h: true } : {}),
    ...(b !== null && b > 0 ? { b } : {}),
    ...(l !== null && l > 0 ? { l } : {}),
  };
}

function writeMark(m: Pdfium, doc: number, object: number, value: TextMark): void {
  for (let mark = ownMark(m, object); mark; mark = ownMark(m, object)) if (!m.FPDFPageObj_RemoveMark(object, mark)) break;
  const mark = m.FPDFPageObj_AddMark(object, MARK);
  if (!mark) return;
  m.FPDFPageObjMark_SetIntParam(doc, object, mark, 'P', value.p);
  if (value.w) m.FPDFPageObjMark_SetFloatParam(doc, object, mark, 'W', value.w);
  if (value.h) m.FPDFPageObjMark_SetIntParam(doc, object, mark, 'H', 1);
  if (value.b) m.FPDFPageObjMark_SetIntParam(doc, object, mark, 'B', value.b);
  if (value.l) m.FPDFPageObjMark_SetIntParam(doc, object, mark, 'L', value.l);
}

// Leerzeichen am Anfang eines Textes für die Kennzeichnung (fehlt, wenn keine da sind)
const leading = (text: string): { l?: number } => {
  const count = /^ */.exec(text)?.[0].length ?? 0;
  return count > 0 ? { l: count } : {};
};

// Kennzahl eines neuen Absatzes (nur innerhalb der Seite von Bedeutung)
const newParagraphId = () => 1 + Math.floor(Math.random() * 2 ** 30);

// Breite eines Textes in Seiteneinheiten, gemessen mit einem nicht eingefügten Objekt (Ursprung 0, nur Skalierung).
// PDFium stürzt bei leerem Text in neu angelegten Objekten ab; gemessen wird deshalb nie ein leerer Text.
function measureWith(m: Pdfium, ruler: number, scaleX: number, scaleY: number): (value: string) => number {
  withFloats(m, [scaleX, 0, 0, scaleY, 0, 0], (ptr) => m.FPDFPageObj_SetMatrix(ruler, ptr));
  return (value) => {
    if (value === '') return 0;
    withWString(m, value, (ptr) => m.FPDFText_SetText(ruler, ptr));
    return readFloats(m, 4, (ptr) => Boolean(m.FPDFPageObj_GetBounds(ruler, ptr, ptr + 4, ptr + 8, ptr + 12)))?.[2] ?? 0;
  };
}

// Vorschub eines Textes aus einer Messung seiner Breite: zählt auch Leerzeichen am Ende mit
function advanceWith(widthOf: (value: string) => number): (value: string) => number {
  const x = widthOf('x');
  return (value) => (value === '' ? 0 : widthOf(`${value}x`) - x);
}

// Absatz oder Zeile neu setzen (ContentOperation editParagraph). Ohne Angaben behalten die Zeilen Schrift, Größe,
// Farbe, linken Rand, Breite und Zeilenabstand; umgebrochen wird mit den echten Zeichenbreiten der Schrift.
// box ändert linken und rechten Rand (die erste Zeile behält ihren Einzug), style Größe, Schrift oder Farbe. Neue
// Größe oder Schrift erfordern neue Textobjekte (PDFium kann sie an vorhandenen nicht ändern); die Oberkante bleibt.
// Kennt die Schrift nicht alle Zeichen, bekommt der ganze Absatz eine ähnliche Standardschrift.
function setParagraph(
  m: Pdfium,
  doc: number,
  page: number,
  listing: PageObjects,
  lines: number[][],
  text: string,
  box: { left: number; right: number } | undefined,
  style: ParagraphStyle | undefined,
): void {
  if (lines.length === 0 || lines.some((line) => line.length === 0)) throw new ContentError('Absatz ohne Zeilen');
  const infos = new Map(listing.objects.map((info) => [info.index, info]));
  // Erst alle Objekte holen: Nach dem Entfernen gelten die Positionen in der Objektliste nicht mehr
  const groups = lines.map((members) =>
    members.map((index) => {
      const object = objectAt(m, page, index);
      if (m.FPDFPageObj_GetType(object) !== OBJECT.text) throw new ContentError(`Objekt ${index} ist kein Text`);
      return object;
    }),
  );
  const anchors = groups.map((group) => group[0] as number);
  const matrices = anchors.map((anchor) => readFloats(m, 6, (ptr) => Boolean(m.FPDFPageObj_GetMatrix(anchor, ptr))));
  if (matrices.some((matrix) => !matrix || Math.abs(matrix[1] ?? 0) > 1e-3 || Math.abs(matrix[2] ?? 0) > 1e-3 || (matrix[0] ?? 0) <= 0)) {
    throw new ContentError('Absatz ist gedreht');
  }
  const [first, ...rest] = matrices as number[][];
  const firstInfo = infos.get(lines[0]?.[0] ?? -1);
  if (!first || !firstInfo) throw new ContentError('Absatz fehlt');
  const members = lines.flat().map((index) => infos.get(index)?.bounds);
  const oldLeft = Math.min(...members.map((bounds) => bounds?.[0] ?? Infinity));
  const oldRight = Math.max(...members.map((bounds) => bounds?.[2] ?? -Infinity));
  const visual = firstInfo.visualSize ?? firstInfo.fontSize ?? 12;
  const factor = style?.size && visual > 0 ? style.size / visual : 1;
  const firstX = first[4] ?? 0;
  const restX = rest[0]?.[4] ?? firstX;
  const indent = firstX - restX;
  // box gilt für die sichtbaren Ränder; die Zeilen beginnen um denselben Betrag verschoben
  const left = box ? restX + (box.left - oldLeft) : restX;
  const ownWidth = firstInfo.mark?.w;
  const right = box ? box.right : ownWidth ? restX + ownWidth : oldRight;
  const x = (i: number) => (box ? left + (i === 0 ? Math.max(0, indent) : 0) : i === 0 ? firstX : restX);
  const lastY = (matrices[matrices.length - 1] as number[])[5] ?? 0;
  const gap = (lines.length > 1 ? ((first[5] ?? 0) - lastY) / (lines.length - 1) : visual * LINE_HEIGHT) * factor;
  if (!(gap > 0)) throw new ContentError('Zeilenabstand unbekannt');
  // Oberkante bleibt: Grundlinie um die Änderung der Oberlänge verschieben
  const firstY = (first[5] ?? 0) - 0.8 * visual * (factor - 1);

  const font = firstInfo.font ? listing.fonts[firstInfo.font] : undefined;
  const substitute = !style?.font && missingChars(text, font) !== '';
  if (substitute || style?.font) {
    const impossible = missingChars(text, undefined);
    if (impossible) throw new ContentError(impossible, 'content-characters');
  }
  const size = (firstInfo.fontSize ?? 12) * factor;
  const color = style?.color ?? firstInfo.color ?? { r: 0, g: 0, b: 0 };
  const originalFont = m.FPDFTextObj_GetFont(anchors[0] as number);
  const renderMode = m.FPDFTextObj_GetTextRenderMode(anchors[0] as number);
  const standard = style?.font ?? (substitute ? substituteFont(font?.name ?? '', m.FPDFFont_GetWeight(originalFont)) : null);
  // Vorhandene Objekte nur weiterverwenden, wenn Schrift und Größe bleiben
  const reuse = !standard && factor === 1;
  const make = (value: string): number => {
    let object: number;
    if (standard) object = newTextObject(m, doc, standard, size, value, color);
    else {
      object = m.FPDFPageObj_CreateTextObj(doc, originalFont, size);
      if (!object) throw new ContentError('Textobjekt lässt sich nicht anlegen');
      withWString(m, value, (ptr) => m.FPDFText_SetText(object, ptr));
      m.FPDFPageObj_SetFillColor(object, byte(color.r), byte(color.g), byte(color.b), 255);
    }
    m.FPDFTextObj_SetTextRenderMode(object, renderMode);
    return object;
  };
  const place = (object: number, matrix: number[]) => withFloats(m, matrix, (ptr) => m.FPDFPageObj_SetMatrix(object, ptr));
  const matrixFor = (i: number): number[] => {
    // Unverändert: die eigene Lage der Zeile (genau wie vorher)
    const own = matrices[i];
    const indent = out[i]?.indent ?? 0;
    if (own && !box && factor === 1 && indent === 0) return own;
    return [first[0] ?? 1, 0, 0, first[3] ?? 1, x(i) + indent, firstY - i * gap];
  };

  const ruler = make('x');
  let out: WrappedLine[];
  try {
    const widthOf = measureWith(m, ruler, first[0] ?? 1, first[3] ?? 1);
    out = wrapText(text, (line, i, indent) => x(i) + indent + widthOf(line) <= right + 0.5, advanceWith(widthOf));
  } finally {
    m.FPDFPageObj_Destroy(ruler);
  }

  const paragraph = firstInfo.mark?.p ?? newParagraphId();
  const mark = (line: WrappedLine): TextMark => ({ p: paragraph, w: right - left, ...(line.hard ? { h: true } : {}), ...leading(line.text) });
  groups.forEach((group, i) => {
    const line = out[i];
    const keepAnchor = reuse && line !== undefined && line.text !== '';
    group.forEach((object, j) => {
      if (j === 0 && keepAnchor) {
        withWString(m, line.text, (ptr) => m.FPDFText_SetText(object, ptr));
        writeMark(m, doc, object, mark(line));
        place(object, matrixFor(i));
        if (style?.color) m.FPDFPageObj_SetFillColor(object, byte(color.r), byte(color.g), byte(color.b), 255);
      } else removeObject(m, page, object);
    });
  });
  out.forEach((line, i) => {
    if (line.text === '' || (reuse && i < anchors.length)) return;
    const object = make(line.text);
    writeMark(m, doc, object, mark(line));
    place(object, matrixFor(i));
    m.FPDFPage_InsertObject(page, object);
  });
}

// Text mit gemischter Gestaltung setzen (ContentOperation addRichText): Wörter dürfen aus Stücken verschiedener Größe,
// Schrift und Farbe bestehen. Umgebrochen wird Wort für Wort mit den echten Zeichenbreiten jedes Stücks; jede Zeile ist
// so hoch wie ihre größte Schrift, die Grundlinien liegen wie bei einheitlichem Text. Jedes Stück einer Zeile wird ein
// eigenes Textobjekt; alle tragen die Kennzeichnung des Absatzes.
interface Token {
  text: string;
  run: number;
  space: boolean;
}

interface RichLine {
  tokens: Token[];
  // Abstand vom linken Rand: Folgezeilen eines Listeneintrags beginnen hinter seinem Zeichen
  indent: number;
  hard: boolean;
  // Leerzeilen danach
  blank: number;
  size: number;
}

function addRichText(m: Pdfium, doc: number, page: number, listing: PageObjects, operation: Extract<ContentOperation, { type: 'addRichText' }>): void {
  const runs = operation.runs.filter((run) => run.text !== '');
  if (runs.length === 0) throw new ContentError('Text fehlt');
  const infos = new Map(listing.objects.map((info) => [info.index, info]));
  // Erst alles von den bisherigen Objekten lesen: Nach dem Entfernen gelten ihre Positionen nicht mehr
  const replaced = [...new Set(operation.replace ?? [])].map((index) => objectAt(m, page, index));
  const sources = new Map<number, { font: number; mode: number }>();
  for (const run of runs) {
    if (run.font !== undefined || run.source === undefined || sources.has(run.source)) continue;
    const object = objectAt(m, page, run.source);
    if (m.FPDFPageObj_GetType(object) !== OBJECT.text) throw new ContentError(`Objekt ${run.source} ist kein Text`);
    sources.set(run.source, { font: m.FPDFTextObj_GetFont(object), mode: m.FPDFTextObj_GetTextRenderMode(object) });
  }
  // Schrift je Stück: neue Schrift, die Schrift des Quellobjekts oder, wenn diese Zeichen fehlen, eine ähnliche
  // Standardschrift. Die Standardschriften kennen nur den westeuropäischen Zeichensatz.
  const fonts = runs.map((run): { standard: TextFont } | { handle: number; mode: number } => {
    if (run.font !== undefined) {
      if (!isSystemFontKey(run.font)) {
        const impossible = missingChars(run.text, undefined);
        if (impossible) throw new ContentError(impossible, 'content-characters');
      }
      return { standard: run.font };
    }
    const source = run.source !== undefined ? sources.get(run.source) : undefined;
    const info = run.source !== undefined ? infos.get(run.source) : undefined;
    const font = info?.font ? listing.fonts[info.font] : undefined;
    if (source && missingChars(run.text, font) === '') return { handle: source.font, mode: source.mode };
    const impossible = missingChars(run.text, undefined);
    if (impossible) throw new ContentError(impossible, 'content-characters');
    return { standard: substituteFont(font?.name ?? '', source ? m.FPDFFont_GetWeight(source.font) : 400) };
  });
  const make = (run: number, value: string): number => {
    const style = runs[run] as TextRun;
    const font = fonts[run] as (typeof fonts)[number];
    if ('standard' in font) return newTextObject(m, doc, font.standard, style.size, value, style.color);
    const object = m.FPDFPageObj_CreateTextObj(doc, font.handle, style.size);
    if (!object) throw new ContentError('Textobjekt lässt sich nicht anlegen');
    withWString(m, value, (ptr) => m.FPDFText_SetText(object, ptr));
    m.FPDFPageObj_SetFillColor(object, byte(style.color.r), byte(style.color.g), byte(style.color.b), 255);
    m.FPDFTextObj_SetTextRenderMode(object, font.mode);
    return object;
  };

  // Vorschub eines Textes: Breite mit einem folgenden x minus Breite des x allein (zählt auch Leerzeichen am Ende)
  const rulers = runs.map((_, i) => make(i, 'x'));
  const lines: RichLine[] = [];
  try {
    const advances = rulers.map((ruler) => {
      const widthOf = measureWith(m, ruler, 1, 1);
      const x = widthOf('x');
      const cache = new Map<string, number>();
      return (value: string) => {
        if (value === '') return 0;
        let width = cache.get(value);
        if (width === undefined) {
          width = widthOf(`${value}x`) - x;
          cache.set(value, width);
        }
        return width;
      };
    });
    const widthOf = (tokens: Token[]) => tokens.reduce((sum, token) => sum + (advances[token.run] as (value: string) => number)(token.text), 0);
    // Zeichen mit ihrem Stück, getrennt in Blöcke an harten Umbrüchen
    const blocks: Array<{ tokens: Token[]; size: number }> = [{ tokens: [], size: runs[0]?.size ?? 12 }];
    runs.forEach((run, index) => {
      for (const char of run.text) {
        const block = blocks[blocks.length - 1] as { tokens: Token[]; size: number };
        if (char === '\n') {
          // Leere Zeile: so hoch wie die Schrift an dieser Stelle
          if (block.tokens.length === 0) block.size = run.size;
          blocks.push({ tokens: [], size: run.size });
          continue;
        }
        const space = char === ' ' || char === '\t';
        const last = block.tokens[block.tokens.length - 1];
        if (last && last.run === index && last.space === space) last.text += char;
        else block.tokens.push({ text: char, run: index, space });
      }
    });
    for (const block of blocks) {
      // Wörter: zusammenhängende Zeichen ohne Leerraum, auch über Stücke hinweg
      const words: Array<{ spaces: Token[]; word: Token[] }> = [];
      let spaces: Token[] = [];
      let word: Token[] = [];
      for (const token of block.tokens) {
        if (token.space) {
          if (word.length > 0) {
            words.push({ spaces, word });
            spaces = [];
            word = [];
          }
          spaces.push(token);
        } else word.push(token);
      }
      if (word.length > 0) words.push({ spaces, word });
      // Listeneintrag: Breite des Vorspanns (Einzug, Zeichen, Leerzeichen) als hängender Einzug der Folgezeilen
      const prefix = hangingPrefix(block.tokens.map((token) => token.text).join(''));
      let hang = 0;
      if (prefix > 0) {
        const lead: Token[] = [];
        let count = 0;
        for (const token of block.tokens) {
          if (count >= prefix) break;
          lead.push(token);
          count += token.text.length;
        }
        if (count === prefix) hang = widthOf(lead);
      }
      const blockLines: Token[][] = [];
      let current: Token[] = [];
      let currentWidth = 0;
      for (const entry of words) {
        const addition = widthOf(entry.spaces) + widthOf(entry.word);
        const room = (operation.width ?? 0) - (blockLines.length > 0 ? hang : 0);
        if (current.length === 0 || !operation.width || currentWidth + addition <= room + 0.5) {
          // Am Zeilenanfang nach einem Umbruch entfällt der Leerraum davor
          const lead = current.length === 0 && blockLines.length > 0 ? [] : entry.spaces;
          current.push(...lead, ...entry.word);
          currentWidth += widthOf(lead) + widthOf(entry.word);
        } else {
          blockLines.push(current);
          current = [...entry.word];
          currentWidth = widthOf(entry.word);
        }
      }
      blockLines.push(current);
      blockLines.forEach((tokens, i) => {
        const size = tokens.length > 0 ? Math.max(...tokens.map((token) => (runs[token.run] as TextRun).size)) : block.size;
        lines.push({ tokens, hard: i === blockLines.length - 1, blank: 0, size, indent: i > 0 ? hang : 0 });
      });
    }
    // Leere Zeilen am Ende entfallen; Leerzeilen merkt sich die Zeile davor
    while (lines.length > 0 && (lines[lines.length - 1] as RichLine).tokens.length === 0) lines.pop();
    for (let i = 0, owner = -1; i < lines.length; i++) {
      const line = lines[i] as RichLine;
      if (line.tokens.length > 0) owner = i;
      else if (owner >= 0) (lines[owner] as RichLine).blank++;
    }

    const rotation = (m.FPDFPage_GetRotation(page) * 90) % 360;
    const angle = (rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const flow = operation.flow && rotation === 0 ? operation.flow : undefined;
    // Zeilen auf eine Seite setzen, Oberkante der ersten bei top; liefert die Zeilen, die nicht mehr passen
    const place = (target: number, rows: RichLine[], top: number): RichLine[] => {
      const paragraph = newParagraphId();
      let down = 0;
      for (let i = 0; i < rows.length; i++) {
        const line = rows[i] as RichLine;
        const baseline = down + FIRST_BASELINE * line.size;
        const x0 = operation.origin.x + sin * baseline;
        const y0 = top - cos * baseline;
        if (flow && i > 0 && y0 < flow.bottom) return rows.slice(i);
        down += LINE_HEIGHT * line.size;
        // Leerraum am Zeilenende zeichnet nichts
        const tokens = [...line.tokens];
        while (tokens.length > 0 && tokens[tokens.length - 1]?.space) tokens.pop();
        let advance = line.indent;
        let start = 0;
        while (start < tokens.length) {
          // Benachbarte Zeichen desselben Stücks werden ein Objekt
          const run = (tokens[start] as Token).run;
          let end = start;
          let value = '';
          while (end < tokens.length && (tokens[end] as Token).run === run) value += (tokens[end++] as Token).text;
          const object = make(run, value);
          writeMark(m, doc, object, {
            p: paragraph,
            ...(operation.width ? { w: operation.width } : {}),
            ...(line.hard ? { h: true } : {}),
            ...(line.hard && line.blank > 0 ? { b: line.blank } : {}),
            ...(start === 0 ? leading(value) : {}),
          });
          m.FPDFPageObj_Transform(object, cos, sin, -sin, cos, x0 + cos * advance, y0 + sin * advance);
          m.FPDFPage_InsertObject(target, object);
          advance += (advances[run] as (value: string) => number)(value);
          start = end;
        }
      }
      return [];
    };
    let rest = place(page, lines, operation.origin.y);
    // Überlauf: neue Seiten gleicher Größe direkt hinter dieser, oben am Rand weiter
    const size = { width: m.FPDF_GetPageWidthF(page), height: m.FPDF_GetPageHeightF(page) };
    for (let next = operation.pageIndex + 1; rest.length > 0 && flow && next < operation.pageIndex + 200; next++) {
      const added = m.FPDFPage_New(doc, next, size.width, size.height);
      if (!added) throw new ContentError('Neue Seite lässt sich nicht anlegen');
      try {
        // Leerzeilen am Seitenanfang entfallen, wie in einer Textverarbeitung
        while (rest.length > 0 && rest[0]?.tokens.length === 0) rest = rest.slice(1);
        rest = place(added, rest, flow.top);
        if (!m.FPDFPage_GenerateContent(added)) throw new ContentError(`Seite ${next + 1} lässt sich nicht schreiben`);
      } finally {
        m.FPDF_ClosePage(added);
      }
    }
  } finally {
    for (const ruler of rulers) m.FPDFPageObj_Destroy(ruler);
  }
  for (const object of replaced) removeObject(m, page, object);
}

const TEXT_INVISIBLE = 3;

// Erkannte Wörter als unsichtbaren Text über das Seitenbild legen: Jedes Wort wird so gedehnt, dass es genau über dem
// Wort im Bild liegt (Suchen und Markieren treffen die richtige Stelle). Die Umrechnung von Bildpunkten in
// Seitenkoordinaten übernimmt PDFium, auch für gedrehte Seiten.
function addOcrText(m: Pdfium, doc: number, page: number, width: number, height: number, words: OcrWord[]): void {
  const toPage = (x: number, y: number) =>
    withBuffer(m, 16, (ptr) => {
      m.FPDF_DeviceToPage(page, 0, 0, width, height, 0, x, y, ptr, ptr + 8);
      return { x: m.pdfium.getValue(ptr, 'double') as number, y: m.pdfium.getValue(ptr + 8, 'double') as number };
    });
  for (const word of words) {
    const [x0, , x1] = word.box;
    const origin = toPage(x0, word.baseline);
    const end = toPage(x1, word.baseline);
    const top = toPage(x0, word.baseline - word.size);
    const length = Math.hypot(end.x - origin.x, end.y - origin.y);
    const size = Math.hypot(top.x - origin.x, top.y - origin.y);
    if (length < 0.1 || size < 0.5) continue;
    const object = newTextObject(m, doc, 'Helvetica', size, word.text, { r: 0, g: 0, b: 0 });
    const natural = readFloats(m, 4, (ptr) => Boolean(m.FPDFPageObj_GetBounds(object, ptr, ptr + 4, ptr + 8, ptr + 12)));
    const naturalWidth = natural ? (natural[2] ?? 0) - (natural[0] ?? 0) : 0;
    if (naturalWidth <= 0) {
      m.FPDFPageObj_Destroy(object);
      continue;
    }
    // Leserichtung d und Richtung nach oben n (beide Länge 1) in Seitenkoordinaten
    const d = { x: (end.x - origin.x) / length, y: (end.y - origin.y) / length };
    const n = { x: (top.x - origin.x) / size, y: (top.y - origin.y) / size };
    const stretch = length / naturalWidth;
    m.FPDFTextObj_SetTextRenderMode(object, TEXT_INVISIBLE);
    withFloats(m, [d.x * stretch, d.y * stretch, n.x, n.y, origin.x, origin.y], (ptr) => m.FPDFPageObj_SetMatrix(object, ptr));
    m.FPDFPage_InsertObject(page, object);
  }
}
