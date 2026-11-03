// Live-Text: Text in Bildern (Scans, fotografierte Seiten, Text als Kurven) im Hintergrund erkennen, damit man ihn
// auswählen, kopieren und markieren kann. Anders als „Text erkennen“ (features/ocr) ändert das die Datei nicht; das
// Ergebnis lebt nur im Speicher (je Dokumentstand und Seite). Siehe docs/entscheidungen/0031-live-text.md.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Point, Rect } from '../../../shared/annotations';
import { rgbaToPgm, selectableLines, TEXT_PAGE_MIN_CHARS } from '../../../shared/ocr';
import { startOcr, type OcrEngine } from '../../engine/ocr-client';
import { pdfjs } from '../../engine/pdfjs';
import { imageCoverage, mostlyInside } from './coverage';

export interface LiveWord {
  text: string;
  // Ecken im PDF-Benutzerraum (Leserichtung von topLeft nach topRight)
  topLeft: Point;
  topRight: Point;
  bottomLeft: Point;
}

export interface LiveLine {
  words: LiveWord[];
}

// Seiten, auf denen Bilder mindestens so viel Fläche bedecken, werden auch mit vorhandenem Text erkannt (Mischseiten)
export const IMAGE_COVERAGE = 0.1;
const DPI = 300;
// Größte Kantenlänge des Bildes für die Erkennung (A4 mit gut 250 dpi; Plakate, sehr große Seiten)
const MAX_SIDE = 3000;
// Länger rechnet die Erkennung an einer Seite nicht (Rauschen, Muster): dann ohne Live-Text weiter
const RECOGNIZE_TIMEOUT_MS = 20_000;
// Erkennung beenden, wenn so lange nichts zu tun war (gibt den Speicher der Sprachdaten frei)
const IDLE_MS = 30_000;

let engine: Promise<OcrEngine> | null = null;
let idle = 0;
let queue: Promise<unknown> = Promise.resolve();
const results = new WeakMap<PDFDocumentProxy, Map<number, Promise<LiveLine[] | null>>>();

function acquireEngine(): Promise<OcrEngine> {
  window.clearTimeout(idle);
  engine ??= startOcr(['deu', 'eng']).catch((error: unknown) => {
    engine = null;
    throw error;
  });
  return engine;
}

function releaseLater(): void {
  window.clearTimeout(idle);
  idle = window.setTimeout(() => {
    const current = engine;
    engine = null;
    void current?.then((e) => e.stop()).catch(() => undefined);
  }, IDLE_MS);
}

// Aufträge nacheinander: Die Erkennung ist rechenintensiv, mehrere gleichzeitig wären nicht schneller
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Erkannte Zeilen einer Seite; [] wenn die Seite keinen Live-Text braucht (genug echter Text, keine großen Bilder).
 * null, wenn der Auftrag verworfen wurde, weil die Seite bis zu seinem Start nicht mehr gebraucht wurde (stillWanted).
 */
export function liveText(pdf: PDFDocumentProxy, pageIndex: number, stillWanted: () => boolean): Promise<LiveLine[] | null> {
  let pages = results.get(pdf);
  if (!pages) {
    pages = new Map();
    results.set(pdf, pages);
  }
  const known = pages.get(pageIndex);
  if (known) return known;
  const map = pages;
  const job = enqueue(async () => {
    if (!stillWanted()) {
      map.delete(pageIndex);
      return null;
    }
    try {
      const page = await pdf.getPage(pageIndex + 1);
      const { needed, native } = await analyse(page);
      return needed ? await recognize(page, native) : [];
    } catch (error) {
      // Erkennung nicht möglich (Speicher, defekte Seite): ohne Live-Text weiter, kein erneuter Versuch
      console.warn('Live-Text', pageIndex + 1, error);
      return [];
    } finally {
      releaseLater();
    }
  });
  map.set(pageIndex, job);
  return job;
}

// Braucht die Seite Live-Text? Und wo liegt schon echter Text (dort wird nichts doppelt erkannt)?
async function analyse(page: PDFPageProxy): Promise<{ needed: boolean; native: Rect[] }> {
  const content = await page.getTextContent();
  let chars = 0;
  const native: Rect[] = [];
  for (const item of content.items) {
    if (!('str' in item) || item.str.trim() === '') continue;
    chars += item.str.replace(/\s/g, '').length;
    native.push(itemRect(item.transform as number[], item.width, item.height));
  }
  if (chars < TEXT_PAGE_MIN_CHARS) return { needed: true, native };
  const ops = await page.getOperatorList();
  return { needed: imageCoverage(ops.fnArray, ops.argsArray, pdfjs.OPS, page.view) >= IMAGE_COVERAGE, native };
}

// Umgebendes Rechteck eines Textstücks von pdf.js (auch schräger Text): Breite entlang der Schreibrichtung, Höhe quer dazu
function itemRect([a = 1, b = 0, c = 0, d = 1, e = 0, f = 0]: number[], width: number, height: number): Rect {
  const along = Math.hypot(a, b) || 1;
  const across = Math.hypot(c, d) || 1;
  const ux = (a / along) * width;
  const uy = (b / along) * width;
  const vx = (c / across) * height;
  const vy = (d / across) * height;
  const xs = [e, e + ux, e + vx, e + ux + vx];
  const ys = [f, f + uy, f + vy, f + uy + vy];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

async function recognize(page: PDFPageProxy, native: Rect[]): Promise<LiveLine[]> {
  // In der Lage der Seite (eigene Drehung der Seite, ohne Drehung der Ansicht), so steht der Text meist aufrecht
  const unit = page.getViewport({ scale: 1 });
  const scale = Math.min(DPI / 72, MAX_SIDE / Math.max(unit.width, unit.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  let pgm: Uint8Array;
  try {
    await page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return [];
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    pgm = rgbaToPgm(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), canvas.width, canvas.height);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
  const ocr = await acquireEngine();
  let timer = 0;
  const timeout = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), RECOGNIZE_TIMEOUT_MS);
  });
  const blocks = await Promise.race([ocr.recognize(pgm), timeout]);
  window.clearTimeout(timer);
  if (blocks === null) {
    // Die laufende Erkennung lässt sich nur mit der ganzen Engine beenden
    if (engine) {
      engine = null;
      void ocr.stop().catch(() => undefined);
    }
    return [];
  }
  const toPdf = (x: number, y: number): Point => {
    const [px = 0, py = 0] = viewport.convertToPdfPoint(x, y);
    return { x: px, y: py };
  };
  const lines: LiveLine[] = [];
  for (const line of selectableLines(blocks)) {
    const words = line.words
      .map((word) => ({ text: word.text, topLeft: toPdf(word.left, line.top), topRight: toPdf(word.right, line.top), bottomLeft: toPdf(word.left, line.bottom) }))
      .filter((word) => !native.some((rect) => mostlyInside(word, rect)));
    if (words.length > 0) lines.push({ words });
  }
  return lines;
}
