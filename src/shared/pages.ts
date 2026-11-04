// Seitenoperationen (Phase 3). Gemeinsam für Oberfläche und PDFium-Worker. Seiten sind 0-basiert.

// Bild für eine neue Seite: Originaldaten (JPEG wird unverändert eingebettet, PNG von PDFium übernommen).
export interface ImageSource {
  kind: 'jpeg' | 'png';
  data: ArrayBuffer;
  // Maße in Pixeln, so wie sie gespeichert sind (vor einer EXIF-Drehung)
  width: number;
  height: number;
  // Drehung im Uhrzeigersinn laut EXIF (nur JPEG), damit Handyfotos aufrecht erscheinen
  rotation: 0 | 90 | 180 | 270;
}

// PDF als Quelle für eingefügte oder zusammengeführte Seiten
export interface PdfSource {
  data: ArrayBuffer;
  password: string | null;
  // null = alle Seiten; sonst in genau dieser Reihenfolge
  pages: number[] | null;
}

export type PageOperation =
  | { type: 'rotate'; pages: number[]; delta: 90 | 180 | 270 }
  | { type: 'delete'; pages: number[] }
  // Verschiebt die Seiten (in ihrer Reihenfolge im Dokument) so, dass die erste danach an Position `to` steht.
  | { type: 'move'; pages: number[]; to: number }
  | { type: 'insertBlank'; at: number; width: number; height: number; count: number }
  | { type: 'insertPdf'; at: number; source: PdfSource }
  | { type: 'insertImages'; at: number; images: ImageSource[] }
  // Zuschneiden: Ränder in Punkt, so wie die Seite angezeigt wird (oben = oberer Rand der gedrehten Seite)
  | { type: 'crop'; pages: number[]; margins: Margins };

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// Kleinste Seite nach dem Zuschneiden (1/2 Zoll)
export const MIN_CROPPED_SIZE = 36;

// Ränder der angezeigten Seite auf die Kanten im PDF-Benutzerraum (ungedrehte Seite) umrechnen. Drehung im
// Uhrzeigersinn: bei 90° liegt die linke Kante des Benutzerraums oben.
export function marginsToUser(margins: Margins, rotation: 0 | 90 | 180 | 270): Margins {
  const { top, right, bottom, left } = margins;
  switch (rotation) {
    case 90:
      return { left: top, top: right, right: bottom, bottom: left };
    case 180:
      return { left: right, top: bottom, right: left, bottom: top };
    case 270:
      return { left: bottom, top: left, right: top, bottom: right };
    default:
      return { ...margins };
  }
}

// Teil eines neu zusammengesetzten Dokuments (Zusammenführen, Extrahieren, Teilen, Bilder → PDF)
export type ComposePart = { type: 'pdf'; source: PdfSource } | { type: 'image'; image: ImageSource };

// Größte Seite für Bilder (A4 in Punkt); kleinere Bilder werden nicht vergrößert.
export const A4 = { width: 595.28, height: 841.89 };

// Liest Seitenangaben wie „1-3, 5, 8-“ (1-basiert, wie angezeigt). Liefert sortierte, eindeutige
// 0-basierte Seiten oder null bei ungültiger Eingabe. „8-“ heißt bis zum Ende, „-3“ ab der ersten Seite.
export function parsePageRanges(text: string, pageCount: number): number[] | null {
  const parts = text
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const pages = new Set<number>();
  for (const part of parts) {
    const match = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part) ?? /^(\d+)()$/.exec(part);
    if (!match) return null;
    const [, startText = '', endText] = match;
    const isRange = /[-–]/.test(part);
    const start = startText === '' ? 1 : Number(startText);
    const end = isRange ? (endText === '' ? pageCount : Number(endText)) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > pageCount || start > end) return null;
    for (let page = start; page <= end; page++) pages.add(page - 1);
  }
  return [...pages].sort((a, b) => a - b);
}

// Seitenauswahl beim Zusammenführen: leer heißt alle Seiten (null wie bei PdfSource.pages), ungültig liefert false.
export function pageSelection(text: string, pageCount: number): number[] | null | false {
  if (text.trim() === '') return null;
  return parsePageRanges(text, pageCount) ?? false;
}

// Kurzform für die Anzeige: [0,1,2,4] → „1-3, 5“
export function formatPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i] as number;
    let end = start;
    while (sorted[i + 1] === end + 1) {
      end++;
      i++;
    }
    parts.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`);
  }
  return parts.join(', ');
}

// Neue Reihenfolge nach einem Verschieben (zum Prüfen und für die Anzeige): Seiten in `pages` wandern
// geschlossen an die Stelle `to` (Index in der Liste ohne die verschobenen Seiten).
export function orderAfterMove(pageCount: number, pages: number[], to: number): number[] {
  const moving = [...new Set(pages)].sort((a, b) => a - b);
  const rest = Array.from({ length: pageCount }, (_, i) => i).filter((i) => !moving.includes(i));
  const target = Math.max(0, Math.min(to, rest.length));
  return [...rest.slice(0, target), ...moving, ...rest.slice(target)];
}

// Zielposition für FPDF_MovePages aus einer Einfügestelle „vor Seite X“ in der aktuellen Reihenfolge.
// `before` ist der Index der Seite, vor der eingefügt wird (pageCount = ans Ende).
export function moveTarget(pages: number[], before: number): number {
  return before - pages.filter((page) => page < before).length;
}

// Teilt ein Dokument in Stücke zu je `size` Seiten.
export function chunkPages(pageCount: number, size: number): number[][] {
  const chunks: number[][] = [];
  for (let start = 0; start < pageCount; start += size) {
    chunks.push(Array.from({ length: Math.min(size, pageCount - start) }, (_, i) => start + i));
  }
  return chunks;
}

// Teilt an Startseiten (z. B. der obersten Lesezeichen). Seiten vor der ersten Startseite bilden ein eigenes Stück.
export function splitAtPages(pageCount: number, starts: number[]): number[][] {
  const unique = [...new Set(starts.filter((p) => p > 0 && p < pageCount))].sort((a, b) => a - b);
  const bounds = [0, ...unique, pageCount];
  const chunks: number[][] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const from = bounds[i] as number;
    const to = bounds[i + 1] as number;
    chunks.push(Array.from({ length: to - from }, (_, k) => from + k));
  }
  return chunks;
}
