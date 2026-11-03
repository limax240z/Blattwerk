// Bearbeitungs- und Speicher-Engine auf Basis von PDFium (WASM). Einziger Ort, der PDFium direkt anspricht.
// Läuft im Web Worker der App und in Node (Tests).
import type {
  Annotation,
  AnnotationChanges,
  AnnotationUpsert,
  InkAnnotation,
  Point,
  Quad,
  Rect,
  Reply,
  Rgb,
  SignatureAnnotation,
  StampAnnotation,
  StatusEntry,
} from '../../shared/annotations';
import { dashPattern, stampColor, stampLines, toPdfDate } from '../../shared/annotations';
import type { FormFieldValue } from '../../shared/forms';
import type { ComposePart, PageOperation } from '../../shared/pages';
import type { RedactionArea, TextSearchOptions } from '../../shared/redaction';
import type { ContentOperation, PageObjects } from '../../shared/content';
import { ALL_PERMISSIONS, PERMISSION_BIT, permissionsFromBits, type DocumentSecurity } from '../../shared/security';
import { applyContentOperation, listPageObjects } from './content';
import { DocumentSessions } from './render';
import { applyFormValues } from './forms';
import { applyRedactions } from './redact';
import { findText } from './text-search';
import { copyOut, withBuffer, withFloats, withWString, type Pdfium } from './memory';
import { Allocations, applyPageOperation, composeDocument, inspectDocument } from './pages';

// Werte aus PDFium bzw. @embedpdf/models (siehe docs/entscheidungen/0005-kommentare.md)
const SUBTYPE = {
  text: 1,
  freetext: 3,
  line: 4,
  square: 5,
  circle: 6,
  highlight: 9,
  underline: 10,
  squiggly: 11,
  strikeout: 12,
  stamp: 13,
  ink: 15,
  // Unterschriften sind Stempel mit Bild
  signature: 13,
  // Schwärzungsmarkierung (noch nicht angewendet)
  redact: 28,
} as const;

const COLOR_TYPE = { color: 0, interior: 1 } as const;
const BORDER_SOLID = 1;
const BORDER_DASHED = 2;
const LINE_END = { none: 0, openArrow: 4 } as const;
const REPLY_TYPE_REPLY = 1;
const FONT_HELVETICA = 4;
const NOTE_ICONS: Record<string, number> = {
  Comment: 0,
  Key: 1,
  Note: 2,
  Help: 3,
  NewParagraph: 4,
  Paragraph: 5,
  Insert: 6,
};

// Annotationsflags (PDF 32000, Tabelle 165)
const FLAG = { hidden: 2, print: 4, noZoom: 8, noRotate: 16 } as const;

const SAVE_INCREMENTAL = 1;
const SAVE_FULL = 2;
// Vollständig und ohne Verschlüsselung (Kennwortschutz entfernen)
const SAVE_REMOVE_SECURITY = 3;

export class PdfiumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfiumError';
  }
}

export interface SaveOptions {
  incremental: boolean;
  // Verschlüsselung entfernen (vollständig neu schreiben); nur für „Kennwortschutz“
  removeSecurity?: boolean;
  // Für Datumsfelder; in Tests fest vorgegeben
  now?: Date;
}

function objectNumber(ref: string): number {
  const match = /^(\d+)R$/.exec(ref);
  if (!match) throw new PdfiumError(`Ungültige Objektreferenz: ${ref}`);
  return Number(match[1]);
}

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

export class PdfiumEngine {
  readonly #m: Pdfium;
  // Geöffnete Dokumente zum Zeichnen und Auslesen einzelner Seiten (Export, Texterkennung, Vergleich)
  readonly sessions: DocumentSessions;

  constructor(module: Pdfium) {
    this.#m = module;
    this.sessions = new DocumentSessions(module);
  }

  // Öffnet eine Sitzung mit dem aktuellen Stand: ungespeicherte Kommentare und Formularwerte werden vorher übernommen.
  openSession(bytes: Uint8Array, password: string | null, changes: AnnotationChanges, formValues: FormFieldValue[]): { id: number; pageCount: number } {
    const pending = changes.upserts.length > 0 || changes.deletions.length > 0 || formValues.length > 0;
    const current = pending ? this.process(bytes, password, changes, [], { incremental: true }, formValues) : bytes;
    return this.sessions.open(current, password);
  }

  // Öffnet die Datei, wendet die Änderungen an und liefert die neuen Bytes.
  // Inkrementell: Die ursprünglichen Bytes bleiben unverändert am Anfang der Datei (Signaturen bleiben gültig).
  applyAndSave(bytes: Uint8Array, password: string | null, changes: AnnotationChanges, options: SaveOptions): Uint8Array {
    return this.process(bytes, password, changes, [], options);
  }

  // Wie applyAndSave, danach zusätzlich Seitenoperationen. Kommentaränderungen beziehen sich auf die Seiten
  // vor den Operationen und werden deshalb zuerst angewendet.
  // Ausgefüllte Formularwerte werden nach den Kommentaren und vor den Seitenoperationen übernommen.
  process(
    bytes: Uint8Array,
    password: string | null,
    changes: AnnotationChanges,
    operations: PageOperation[],
    options: SaveOptions,
    formValues: FormFieldValue[] = [],
    contentOperations: ContentOperation[] = [],
  ): Uint8Array {
    const m = this.#m;
    const memory = new Allocations(m);
    try {
      return this.#process(bytes, password, changes, operations, options, memory, formValues, [], contentOperations);
    } finally {
      memory.release();
    }
  }

  // Schwärzen: wie process (Kommentare und Formularwerte zuerst), dann die Bereiche endgültig entfernen und
  // vollständig neu speichern. Reste entfernt danach sanitize.ts (ADR 0008).
  redact(bytes: Uint8Array, password: string | null, changes: AnnotationChanges, formValues: FormFieldValue[], areas: RedactionArea[]): Uint8Array {
    const m = this.#m;
    const memory = new Allocations(m);
    try {
      return this.#process(bytes, password, changes, [], { incremental: false }, memory, formValues, areas);
    } finally {
      memory.release();
    }
  }

  // Neues Dokument aus Teilen (Zusammenführen, Extrahieren, Teilen, Bilder → PDF), vollständig gespeichert.
  compose(parts: ComposePart[]): Uint8Array {
    const m = this.#m;
    const memory = new Allocations(m);
    try {
      const doc = composeDocument(m, parts, memory);
      try {
        return this.#save(doc, SAVE_FULL);
      } finally {
        m.FPDF_CloseDocument(doc);
      }
    } finally {
      memory.release();
    }
  }

  // Seitenobjekte (Text, Bilder, Formular-XObjects) zum Bearbeiten
  listObjects(bytes: Uint8Array, password: string | null, pages: number[]): PageObjects[] {
    return this.#withDocument(bytes, password, (doc) => {
      const count = this.#m.FPDF_GetPageCount(doc);
      return pages.filter((page) => page >= 0 && page < count).map((page) => listPageObjects(this.#m, doc, page));
    });
  }

  #withDocument<T>(bytes: Uint8Array, password: string | null, fn: (doc: number) => T): T {
    const m = this.#m;
    return withBuffer(m, bytes.length, (dataPtr) => {
      m.pdfium.HEAPU8.set(bytes, dataPtr);
      const doc = m.FPDF_LoadMemDocument(dataPtr, bytes.length, password ?? '');
      if (!doc) throw new PdfiumError(`Dokument lässt sich nicht öffnen (Fehler ${m.FPDF_GetLastError()})`);
      try {
        return fn(doc);
      } finally {
        m.FPDF_CloseDocument(doc);
      }
    });
  }

  // Treffer einer Suche mit ihrer genauen Lage (Suchen und schwärzen)
  findText(bytes: Uint8Array, password: string | null, options: TextSearchOptions) {
    return this.#withDocument(bytes, password, (doc) => findText(this.#m, doc, options));
  }

  inspect(bytes: Uint8Array, password: string | null) {
    return inspectDocument(this.#m, bytes, password);
  }

  #process(
    bytes: Uint8Array,
    password: string | null,
    changes: AnnotationChanges,
    operations: PageOperation[],
    options: SaveOptions,
    memory: Allocations,
    formValues: FormFieldValue[],
    areas: RedactionArea[] = [],
    contentOperations: ContentOperation[] = [],
  ): Uint8Array {
    const m = this.#m;
    return withBuffer(m, bytes.length, (dataPtr) => {
      m.pdfium.HEAPU8.set(bytes, dataPtr);
      const doc = m.FPDF_LoadMemDocument(dataPtr, bytes.length, password ?? '');
      if (!doc) throw new PdfiumError(`Dokument lässt sich nicht öffnen (Fehler ${m.FPDF_GetLastError()})`);
      try {
        const pages = new Map<number, number>();
        const page = (index: number) => {
          let ptr = pages.get(index);
          if (!ptr) {
            ptr = m.FPDF_LoadPage(doc, index);
            if (!ptr) throw new PdfiumError(`Seite ${index + 1} lässt sich nicht laden`);
            pages.set(index, ptr);
          }
          return ptr;
        };
        try {
          // Zuerst löschen: Die Referenzen beziehen sich auf den Stand der Datei.
          for (const ref of changes.deletions) this.#deleteByRef(doc, page, ref);
          for (const upsert of changes.upserts) this.#upsert(doc, page(upsert.annotation.pageIndex), upsert, options);
        } finally {
          for (const ptr of pages.values()) m.FPDF_ClosePage(ptr);
        }
        if (formValues.length > 0) applyFormValues(m, doc, formValues);
        if (areas.length > 0) applyRedactions(m, doc, areas);
        for (const operation of contentOperations) applyContentOperation(m, doc, operation, memory);
        for (const operation of operations) applyPageOperation(m, doc, operation, memory);
        return this.#save(doc, options.removeSecurity ? SAVE_REMOVE_SECURITY : options.incremental ? SAVE_INCREMENTAL : SAVE_FULL);
      } finally {
        m.FPDF_CloseDocument(doc);
      }
    });
  }

  // Kennwortschutz des Dokuments, wie es mit diesem Kennwort geöffnet ist
  security(bytes: Uint8Array, password: string | null): DocumentSecurity {
    const m = this.#m;
    return this.#withDocument(bytes, password, (doc) => {
      const encrypted = m.FPDF_GetSecurityHandlerRevision(doc) !== -1;
      const user = m.FPDF_GetDocUserPermissions(doc) >>> 0;
      // Mit dem Berechtigungskennwort geöffnet (oder ohne Einschränkungen): PDFium meldet alle Rechte
      const effective = m.FPDF_GetDocPermissions(doc) >>> 0;
      const permissions = encrypted ? permissionsFromBits(user) : ALL_PERMISSIONS;
      const ownerAccess = !encrypted || Object.values(PERMISSION_BIT).every((bit) => (effective & bit) !== 0);
      return { encrypted, ownerAccess, permissions };
    });
  }

  // Eingebautes Schriftprogramm (CFF) einer der 14 Standardschriften, zum Einbetten für PDF/A
  standardFontProgram(name: string): Uint8Array {
    const m = this.#m;
    const doc = m.FPDF_CreateNewDocument();
    try {
      const font = m.FPDFText_LoadStandardFont(doc, name);
      if (!font) throw new Error(`PDFium: Schrift ${name} fehlt`);
      try {
        const size = withBuffer(m, 4, (out) => {
          m.FPDFFont_GetFontData(font, 0, 0, out);
          return m.pdfium.getValue(out, 'i32') >>> 0;
        });
        if (size === 0) throw new Error(`PDFium: Schrift ${name} leer`);
        return withBuffer(m, size, (data) =>
          withBuffer(m, 4, (out) => {
            if (!m.FPDFFont_GetFontData(font, data, size, out)) throw new Error(`PDFium: Schrift ${name} nicht lesbar`);
            return copyOut(m, data, size);
          }),
        );
      } finally {
        m.FPDFFont_Close(font);
      }
    } finally {
      m.FPDF_CloseDocument(doc);
    }
  }

  // Prüft, ob sich Bytes als PDF öffnen lassen (Kontrolle vor dem Schreiben auf die Platte).
  canOpen(bytes: Uint8Array, password: string | null): boolean {
    const m = this.#m;
    return withBuffer(m, bytes.length, (dataPtr) => {
      m.pdfium.HEAPU8.set(bytes, dataPtr);
      const doc = m.FPDF_LoadMemDocument(dataPtr, bytes.length, password ?? '');
      if (!doc) return false;
      const ok = m.FPDF_GetPageCount(doc) > 0;
      m.FPDF_CloseDocument(doc);
      return ok;
    });
  }

  #save(doc: number, flags: number): Uint8Array {
    const m = this.#m;
    const writer = m.PDFiumExt_OpenFileWriter();
    try {
      if (!m.FPDF_SaveAsCopy(doc, writer, flags)) throw new PdfiumError('Speichern fehlgeschlagen');
      const size = m.PDFiumExt_GetFileWriterSize(writer);
      return withBuffer(m, size, (ptr) => {
        m.PDFiumExt_GetFileWriterData(writer, ptr, size);
        return copyOut(m, ptr, size);
      });
    } finally {
      m.PDFiumExt_CloseFileWriter(writer);
    }
  }

  // Sucht eine Anmerkung über alle Seiten (für Löschungen, deren Seite der Aufrufer nicht kennen muss).
  #deleteByRef(doc: number, page: (index: number) => number, ref: string): void {
    const m = this.#m;
    const number = objectNumber(ref);
    const count = m.FPDF_GetPageCount(doc);
    for (let index = 0; index < count; index++) {
      const pagePtr = page(index);
      const annot = m.EPDFPage_GetAnnotByObjectNumber(pagePtr, number);
      if (!annot) continue;
      // Zugehöriges Popup mit entfernen, sonst bleibt ein verwaistes Objekt in /Annots.
      const popup = m.FPDFAnnot_GetLinkedAnnot(annot, 'Popup');
      const popupNumber = popup ? m.EPDFAnnot_GetObjectNumber(popup) : 0;
      if (popup) m.FPDFPage_CloseAnnot(popup);
      m.FPDFPage_CloseAnnot(annot);
      m.EPDFPage_RemoveAnnotByObjectNumber(pagePtr, number);
      if (popupNumber > 0) m.EPDFPage_RemoveAnnotByObjectNumber(pagePtr, popupNumber);
      return;
    }
  }

  #upsert(doc: number, pagePtr: number, upsert: AnnotationUpsert, options: SaveOptions): void {
    const m = this.#m;
    const a = upsert.annotation;
    const isNew = a.ref === null;
    const annot = isNew
      ? m.EPDFPage_CreateAnnot(pagePtr, SUBTYPE[a.kind === 'arrow' ? 'line' : a.kind === 'note' ? 'text' : a.kind])
      : m.EPDFPage_GetAnnotByObjectNumber(pagePtr, objectNumber(a.ref as string));
    if (!annot) throw new PdfiumError(`Anmerkung ${a.ref ?? a.id} nicht gefunden`);
    try {
      const now = options.now ?? new Date();
      this.#setCommon(annot, a, isNew, now);
      if (isNew || upsert.appearance) {
        this.#setKindSpecific(doc, annot, a, isNew);
        // Stempel und Unterschriften haben ihre eigene Darstellung; Schwärzungsmarkierungen keine (wie in Acrobat)
        if (a.kind !== 'stamp' && a.kind !== 'signature' && a.kind !== 'redact') m.EPDFAnnot_GenerateAppearance(annot);
      }
      for (const reply of a.replies) this.#upsertReply(pagePtr, annot, a, reply, now);
      for (const status of a.statuses) if (status.ref === null) this.#addStatus(pagePtr, annot, a, status, now);
    } finally {
      m.FPDFPage_CloseAnnot(annot);
    }
  }

  #setString(annot: number, key: string, value: string): void {
    const m = this.#m;
    withWString(m, value, (ptr) => m.FPDFAnnot_SetStringValue(annot, key, ptr));
  }

  // Text des Kommentars. Hat die Anmerkung schon formatierten Text (/RC, so legt Acrobat Kommentare an),
  // wird er mit ersetzt; sonst zeigen solche Programme weiter den alten Text. Entfernen kann PDFium den Eintrag nicht.
  #setContents(annot: number, text: string, isNew: boolean): void {
    this.#setString(annot, 'Contents', text);
    if (!isNew && this.#m.FPDFAnnot_HasKey(annot, 'RC')) this.#setString(annot, 'RC', richText(text));
  }

  #setRect(annot: number, rect: Rect): void {
    const m = this.#m;
    const [left, bottom, right, top] = rect;
    // FS_RECTF: left, top, right, bottom
    withFloats(m, [left, top, right, bottom], (ptr) => m.FPDFAnnot_SetRect(annot, ptr));
  }

  #setColor(annot: number, type: number, color: Rgb): void {
    this.#m.EPDFAnnot_SetColor(annot, type, byte(color.r), byte(color.g), byte(color.b));
  }

  #setCommon(annot: number, a: Annotation, isNew: boolean, now: Date): void {
    const m = this.#m;
    this.#setRect(annot, a.rect);
    this.#setContents(annot, a.contents, isNew);
    this.#setString(annot, 'T', a.author);
    this.#setString(annot, 'M', a.modified || toPdfDate(now));
    if (isNew) {
      this.#setString(annot, 'CreationDate', a.created || toPdfDate(now));
      this.#setString(annot, 'NM', a.id);
    }
    if (a.kind !== 'stamp' && a.kind !== 'signature' && a.kind !== 'freetext') this.#setColor(annot, COLOR_TYPE.color, a.color);
    m.EPDFAnnot_SetOpacity(annot, byte(a.opacity));
    // Vorhandene Anmerkungen behalten ihre Merkmale (z. B. gesperrt, nicht drucken).
    if (isNew) m.FPDFAnnot_SetFlags(annot, a.kind === 'note' ? FLAG.print | FLAG.noZoom | FLAG.noRotate : FLAG.print);
  }

  #setKindSpecific(doc: number, annot: number, a: Annotation, isNew: boolean): void {
    const m = this.#m;
    switch (a.kind) {
      case 'highlight':
      case 'underline':
      case 'strikeout':
      case 'squiggly':
        if (isNew) for (const quad of a.quads) this.#appendQuad(annot, quad);
        break;
      case 'note':
        m.EPDFAnnot_SetName(annot, NOTE_ICONS[a.icon] ?? NOTE_ICONS.Comment ?? 0);
        break;
      case 'freetext':
        m.EPDFAnnot_SetDefaultAppearance(annot, FONT_HELVETICA, a.fontSize, byte(a.color.r), byte(a.color.g), byte(a.color.b));
        m.EPDFAnnot_SetBorderStyle(annot, BORDER_SOLID, 0);
        break;
      case 'ink':
        if (!isNew) m.FPDFAnnot_RemoveInkList(annot);
        for (const path of a.paths) this.#addInkStroke(annot, path);
        this.#setInkBorder(annot, a);
        break;
      case 'square':
      case 'circle':
        m.EPDFAnnot_SetBorderStyle(annot, BORDER_SOLID, a.width);
        if (a.fill) this.#setColor(annot, COLOR_TYPE.interior, a.fill);
        else if (a.fill === null) m.EPDFAnnot_ClearColor(annot, COLOR_TYPE.interior);
        break;
      case 'line':
      case 'arrow':
        withFloats(m, [a.start.x, a.start.y, a.end.x, a.end.y], (ptr) => m.EPDFAnnot_SetLine(annot, ptr, ptr + 8));
        m.EPDFAnnot_SetLineEndings(annot, LINE_END.none, a.kind === 'arrow' ? LINE_END.openArrow : LINE_END.none);
        m.EPDFAnnot_SetBorderStyle(annot, BORDER_SOLID, a.width);
        break;
      case 'stamp':
        if (isNew) this.#buildStampAppearance(doc, annot, a);
        break;
      case 'signature':
        if (isNew) this.#buildImageAppearance(doc, annot, a);
        break;
      case 'redact':
        // Umriss rot (/C), Füllung nach dem Anwenden schwarz (/IC)
        this.#setColor(annot, COLOR_TYPE.interior, { r: 0, g: 0, b: 0 });
        if (isNew) {
          for (const quad of a.quads) this.#appendQuad(annot, quad);
        } else if (m.FPDFAnnot_CountAttachmentPoints(annot) === a.quads.length) {
          a.quads.forEach((quad, index) => this.#setQuad(annot, index, quad));
        }
        break;
    }
  }

  #setQuad(annot: number, index: number, quad: Quad): void {
    const m = this.#m;
    withFloats(m, quad.flatMap((p: Point) => [p.x, p.y]), (ptr) => m.FPDFAnnot_SetAttachmentPoints(annot, index, ptr));
  }

  #appendQuad(annot: number, quad: Quad): void {
    const m = this.#m;
    // FS_QUADPOINTSF: x1,y1 (oben links), x2,y2 (oben rechts), x3,y3 (unten links), x4,y4 (unten rechts)
    const values = quad.flatMap((p: Point) => [p.x, p.y]);
    withFloats(m, values, (ptr) => m.FPDFAnnot_AppendAttachmentPoints(annot, ptr));
  }

  // Rahmenstil des Stifts: durchgehend, oder gestrichelt mit Strichmuster (/BS /D)
  #setInkBorder(annot: number, a: InkAnnotation): void {
    const m = this.#m;
    const pattern = dashPattern(a.dash ?? 'solid', a.width);
    if (pattern.length === 0) {
      m.EPDFAnnot_SetBorderStyle(annot, BORDER_SOLID, a.width);
      return;
    }
    m.EPDFAnnot_SetBorderStyle(annot, BORDER_DASHED, a.width);
    withFloats(m, pattern, (ptr) => m.EPDFAnnot_SetBorderDashPattern(annot, ptr, pattern.length));
  }

  #addInkStroke(annot: number, path: Point[]): void {
    const m = this.#m;
    if (path.length === 0) return;
    withFloats(m, path.flatMap((p) => [p.x, p.y]), (ptr) => m.FPDFAnnot_AddInkStroke(annot, ptr, path.length));
  }

  // Stempel: Rahmen und Beschriftung als Seitenobjekte; PDFium erzeugt daraus den Appearance Stream.
  // Darstellung aus einem PNG, das den ganzen Rahmen ausfüllt (Unterschriften)
  #buildImageAppearance(doc: number, annot: number, a: SignatureAnnotation): void {
    const m = this.#m;
    const [left, bottom, right, top] = a.rect;
    const binary = atob(a.image);
    const data = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const image = m.FPDFPageObj_NewImageObj(doc);
    const loaded = withBuffer(m, data.length, (ptr) => {
      m.pdfium.HEAPU8.set(data, ptr);
      return m.EPDFImageObj_SetPng(0, 0, image, ptr, data.length);
    });
    if (!loaded) {
      m.FPDFPageObj_Destroy(image);
      throw new PdfiumError('Bild der Unterschrift lässt sich nicht einbetten');
    }
    m.FPDFImageObj_SetMatrix(image, right - left, 0, 0, top - bottom, left, bottom);
    m.FPDFAnnot_AppendObject(annot, image);
  }

  #buildStampAppearance(doc: number, annot: number, a: StampAnnotation): void {
    const m = this.#m;
    const [left, bottom, right, top] = a.rect;
    const width = right - left;
    const height = top - bottom;
    const color = stampColor(a);
    const border = Math.max(1.5, height * 0.06);

    const frame = m.FPDFPageObj_CreateNewRect(left + border / 2, bottom + border / 2, width - border, height - border);
    m.FPDFPageObj_SetStrokeColor(frame, byte(color.r), byte(color.g), byte(color.b), 255);
    m.FPDFPageObj_SetStrokeWidth(frame, border);
    m.FPDFPath_SetDrawMode(frame, 0, true);
    m.FPDFAnnot_AppendObject(annot, frame);

    // Eine Zeile (vorgegebene Stempel) oder zwei: Text fett, darunter Datum/Name kleiner (wie AnnotationShape)
    const [first = '', second] = stampLines(a.label);
    const lines: Array<{ text: string; font: string; share: number; center: number }> = second
      ? [
          { text: first, font: 'Helvetica-Bold', share: 0.36, center: 0.6 },
          { text: second, font: 'Helvetica', share: 0.22, center: 0.26 },
        ]
      : [{ text: first, font: 'Helvetica-Bold', share: 0.5, center: 0.5 }];
    for (const line of lines) {
      if (line.text === '') continue;
      const font = m.FPDFText_LoadStandardFont(doc, line.font);
      let fontSize = height * line.share;
      const text = m.FPDFPageObj_CreateTextObj(doc, font, fontSize);
      withWString(m, line.text, (ptr) => m.FPDFText_SetText(text, ptr));
      // Textbreite messen und Schriftgröße so anpassen, dass die Zeile in den Rahmen passt.
      const measured = withBuffer(m, 16, (ptr) => {
        m.FPDFPageObj_GetBounds(text, ptr, ptr + 4, ptr + 8, ptr + 12);
        const l = m.pdfium.getValue(ptr, 'float');
        const r = m.pdfium.getValue(ptr + 8, 'float');
        return r - l;
      });
      const available = width - border * 4;
      const scale = measured > available && measured > 0 ? available / measured : 1;
      fontSize *= scale;
      const textWidth = measured * scale;
      const x = left + (width - textWidth) / 2;
      const y = bottom + height * line.center - (fontSize * 0.72) / 2;
      m.FPDFPageObj_Transform(text, scale, 0, 0, scale, x, y);
      m.FPDFPageObj_SetFillColor(text, byte(color.r), byte(color.g), byte(color.b), 255);
      m.FPDFAnnot_AppendObject(annot, text);
      m.FPDFFont_Close(font);
    }
  }

  // Antworten sind Text-Anmerkungen mit /IRT auf den Kommentar (ISO 32000, 12.5.6.4).
  #upsertReply(pagePtr: number, parent: number, a: Annotation, reply: Reply, now: Date): void {
    const m = this.#m;
    const isNew = reply.ref === null;
    const annot = isNew
      ? m.EPDFPage_CreateAnnot(pagePtr, SUBTYPE.text)
      : m.EPDFPage_GetAnnotByObjectNumber(pagePtr, objectNumber(reply.ref as string));
    if (!annot) return;
    try {
      this.#setContents(annot, reply.contents, isNew);
      this.#setString(annot, 'T', reply.author);
      this.#setString(annot, 'M', reply.modified || toPdfDate(now));
      if (isNew) {
        const [left, , , top] = a.rect;
        this.#setRect(annot, [left, top - 20, left + 20, top]);
        this.#setString(annot, 'CreationDate', reply.modified || toPdfDate(now));
        this.#setString(annot, 'NM', reply.id);
        m.EPDFAnnot_SetLinkedAnnot(annot, 'IRT', parent);
        m.EPDFAnnot_SetReplyType(annot, REPLY_TYPE_REPLY);
        m.EPDFAnnot_SetName(annot, NOTE_ICONS.Comment ?? 0);
        // Antworten erscheinen nur in der Kommentarliste, nicht als eigenes Symbol auf der Seite.
        m.FPDFAnnot_SetFlags(annot, FLAG.hidden | FLAG.noZoom | FLAG.noRotate);
      }
    } finally {
      m.FPDFPage_CloseAnnot(annot);
    }
  }

  // Prüfstatus: unsichtbare Text-Anmerkung mit /IRT, /State und /StateModel /Review.
  #addStatus(pagePtr: number, parent: number, a: Annotation, status: StatusEntry, now: Date): void {
    const m = this.#m;
    const annot = m.EPDFPage_CreateAnnot(pagePtr, SUBTYPE.text);
    if (!annot) return;
    try {
      const [left, , , top] = a.rect;
      this.#setRect(annot, [left, top - 20, left + 20, top]);
      this.#setString(annot, 'T', status.author);
      this.#setString(annot, 'M', status.modified || toPdfDate(now));
      this.#setString(annot, 'NM', status.id);
      this.#setString(annot, 'State', status.status);
      this.#setString(annot, 'StateModel', 'Review');
      m.EPDFAnnot_SetLinkedAnnot(annot, 'IRT', parent);
      m.FPDFAnnot_SetFlags(annot, FLAG.hidden | FLAG.noZoom | FLAG.noRotate);
    } finally {
      m.FPDFPage_CloseAnnot(annot);
    }
  }
}

// Formatierter Text (XHTML nach PDF 32000, 12.7.3.4) aus einfachem Text: je Zeile ein Absatz.
export function richText(text: string): string {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = text.split(/\r\n|\r|\n/).map((line) => `<p>${escape(line)}</p>`).join('');
  return (
    '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" ' +
    `xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:spec="2.0.2">${paragraphs}</body>`
  );
}
