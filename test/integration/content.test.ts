// Seiteninhalt bearbeiten (Phase 5) mit PDFium: auflisten, Text und Bilder einfügen, verschieben, skalieren, löschen,
// Textzeilen ändern (mit Ersatzschrift, wenn Zeichen fehlen).
import { init } from '@embedpdf/pdfium';
import fontkit from '@cantoo/fontkit';
import { degrees, PDFDict, PDFDocument, PDFName, rgb, StandardFonts } from '@cantoo/pdf-lib';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { editUnits, lineOf, lineText, paragraphText, missingChars, scalingAbout, translation, type ContentOperation } from '../../src/shared/content';
import { PdfiumEngine } from '../../src/workers/pdfium/engine';
import { embeddingAllowed } from '../../src/shared/fonts';
import { fixture, imageFixture } from '../fixtures/expectations';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'legacy/build/pdf.worker.mjs'),
).href;

let engine: PdfiumEngine;
const none = { upserts: [], deletions: [] };

beforeAll(async () => {
  const wasm = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'));
  const m = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  m.PDFiumExt_Init();
  engine = new PdfiumEngine(m);
});

const textPdf = () => new Uint8Array(readFileSync(fixture('text.pdf')));
const run = (bytes: Uint8Array, operations: ContentOperation[]) => engine.process(bytes, null, none, [], { incremental: true }, [], operations);

interface Item {
  str: string;
  transform: number[];
  fontName: string;
}

async function items(bytes: Uint8Array, pageNumber = 1): Promise<Item[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const page = await (await task.promise).getPage(pageNumber);
  const list = (await page.getTextContent()).items.filter((item) => 'str' in item && item.str.trim() !== '') as unknown as Item[];
  await task.destroy();
  return list;
}

describe('Inhalt bearbeiten', () => {
  async function paragraphPdf(): Promise<Uint8Array> {
    // Absatz wie aus einem Textprogramm: nummeriert, Zeilen in Stücken, letzte Zeile kurz; darunter eine Adresse
    // (schmal: bleibt einzelne Zeilen)
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page0 = doc.addPage([400, 400]);
    page0.drawText('1.', { x: 30, y: 300, size: 10, font });
    const lines = [['Dies ist ein Absatz,', 'der über mehrere'], ['Zeilen läuft und', 'am rechten Rand'], ['umbricht.']];
    lines.forEach((pieces, i) => {
      let x = 50;
      for (const piece of pieces) {
        page0.drawText(piece, { x, y: 300 - i * 14, size: 10, font });
        x += font.widthOfTextAtSize(piece, 10) + font.widthOfTextAtSize(' ', 10);
      }
    });
    ['Max Muster', 'Hauptstraße 1', '12345 Ort'].forEach((line, i) => page0.drawText(line, { x: 50, y: 200 - i * 14, size: 10, font }));
    return doc.save({ useObjectStreams: false });
  }

  it('Ligaturen in einem eigenen Schriftteil trennen die Zeile nicht', async () => {
    // Word legt „ft“, „ff“, „fl“ … oft in eine zweite Schrift gleichen Namens
    const doc = await PDFDocument.create();
    const main = await doc.embedFont(StandardFonts.Helvetica);
    const ligatures = await doc.embedFont(StandardFonts.Helvetica);
    const page0 = doc.addPage([400, 200]);
    let x = 20;
    for (const [piece, font] of [['Arbeitsau', main], ['ft', ligatures], ['räge:', main]] as const) {
      page0.drawText(piece, { x, y: 100, size: 20, font });
      x += font.widthOfTextAtSize(piece, 20);
    }
    const listing = engine.listObjects(await doc.save({ useObjectStreams: false }), null, [0])[0];
    expect(new Set(listing?.objects.map((o) => o.font)).size).toBe(2);
    expect(editUnits(listing?.objects ?? [], listing?.fonts).map((unit) => unit.text)).toEqual(['Arbeitsaufträge:']);
  });

  it('erkennt Absätze mit gewollten und automatischen Umbrüchen', async () => {
    const bytes = await paragraphPdf();
    const listing = engine.listObjects(bytes, null, [0])[0];
    const units = editUnits(listing?.objects ?? [], listing?.fonts);
    const texts = units.map((unit) => [unit.text, unit.lines?.length ?? 1]);
    expect(texts).toContainEqual(['Dies ist ein Absatz, der über mehrere Zeilen läuft und am rechten Rand umbricht.', 3]);
    for (const line of ['Max Muster', 'Hauptstraße 1', '12345 Ort']) expect(texts).toContainEqual([line, 1]);
    expect(texts).toContainEqual(['1.', 1]);
    expect(paragraphText([
      { index: 0, kind: 'text', bounds: [0, 20, 100, 30], text: 'Silben-', fontSize: 10 },
      { index: 1, kind: 'text', bounds: [0, 6, 40, 16], text: 'trennung', fontSize: 10 },
    ])).toBe('Silbentrennung');
    // Kurze Zeile mitten im Absatz: gewollter Umbruch
    expect(paragraphText([
      { index: 0, kind: 'text', bounds: [0, 34, 300, 44], text: 'Eine volle Zeile', fontSize: 10 },
      { index: 1, kind: 'text', bounds: [0, 20, 60, 30], text: 'Ende.', fontSize: 10 },
      { index: 2, kind: 'text', bounds: [0, 6, 280, 16], text: 'Neuer Gedanke', fontSize: 10 },
    ])).toBe('Eine volle Zeile Ende.\nNeuer Gedanke');
  });

  it('Breite ändern: schmaler gibt mehr Zeilen, breiter weniger, alle im neuen Rahmen', async () => {
    const bytes = await paragraphPdf();
    const listing = engine.listObjects(bytes, null, [0])[0];
    const paragraph = editUnits(listing?.objects ?? [], listing?.fonts).find((unit) => unit.text?.startsWith('Dies ist'));
    if (!paragraph?.lines) throw new Error('kein Absatz');
    const [left] = paragraph.bounds;
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const linesOf = async (output: Uint8Array) => (await items(output)).filter((item) => (item.transform[5] ?? 0) > 220 && (item.transform[4] ?? 0) > 40);
    const narrow = run(bytes, [{ type: 'editParagraph', pageIndex: 0, lines: paragraph.lines, text: paragraph.text ?? '', box: { left, right: left + 90 } }]);
    const narrowLines = await linesOf(narrow);
    expect(narrowLines.length).toBeGreaterThan(3);
    for (const item of narrowLines) expect((item.transform[4] ?? 0) + font.widthOfTextAtSize(item.str, 10)).toBeLessThanOrEqual(left + 91);
    expect(narrowLines.map((item) => item.str).join(' ')).toBe(paragraph.text);
    const wide = run(bytes, [{ type: 'editParagraph', pageIndex: 0, lines: paragraph.lines, text: paragraph.text ?? '', box: { left: left + 20, right: 380 } }]);
    const wideLines = await linesOf(wide);
    expect(wideLines).toHaveLength(2);
    expect(wideLines.map((item) => Math.round(item.transform[4] ?? 0))).toEqual([70, 70]);
    // Erste Zeile bleibt oben
    expect(Math.round(wideLines[0]?.transform[5] ?? 0)).toBe(300);
  });

  it('Größe, Schrift und Farbe eines Absatzes ändern; die Oberkante bleibt', async () => {
    const bytes = await paragraphPdf();
    const listing = engine.listObjects(bytes, null, [0])[0];
    const paragraph = editUnits(listing?.objects ?? [], listing?.fonts).find((unit) => unit.text?.startsWith('Dies ist'));
    if (!paragraph?.lines) throw new Error('kein Absatz');
    const output = run(bytes, [
      { type: 'editParagraph', pageIndex: 0, lines: paragraph.lines, text: paragraph.text ?? '', style: { size: 14, font: 'TimesRoman', color: { r: 1, g: 0, b: 0 } } },
    ]);
    const after = engine.listObjects(output, null, [0])[0];
    const units = editUnits(after?.objects ?? [], after?.fonts);
    const changed = units.find((unit) => unit.text?.startsWith('Dies ist'));
    expect(changed?.visualSize).toBeCloseTo(14, 1);
    expect(after?.fonts[changed?.font ?? '']?.name).toMatch(/Times/);
    expect(changed?.color).toEqual({ r: 1, g: 0, b: 0 });
    // Oberkante etwa gleich (Toleranz für die Oberlänge der neuen Schrift)
    expect(Math.abs((changed?.bounds[3] ?? 0) - paragraph.bounds[3])).toBeLessThan(2.5);
    expect(units.map((unit) => unit.text)).toContain('1.');
  });

  it('selbst gesetzte Texte bleiben ein Textfeld mit Breite und eigenen Umbrüchen, auch sehr schmal', async () => {
    const text = 'Erster Absatz mit einigen Wörtern zum Umbrechen.\n\nZweiter Absatz nach einer Leerzeile.';
    const added = run(textPdf(), [
      { type: 'addText', pageIndex: 0, origin: { x: 300, y: 200 }, lines: text.split('\n'), font: 'Helvetica', size: 10, color: { r: 0, g: 0, b: 0 }, width: 60 },
    ]);
    const unitOf = (bytes: Uint8Array) => {
      const listing = engine.listObjects(bytes, null, [0])[0];
      return editUnits(listing?.objects ?? [], listing?.fonts).find((unit) => unit.text?.startsWith('Erster'));
    };
    const unit = unitOf(added);
    expect(unit?.text).toBe(text);
    expect(unit?.lines?.length).toBeGreaterThan(5);
    // Das Feld zeigt die gewählte Breite, nicht nur die längste Zeile
    expect((unit?.bounds[2] ?? 0) - (unit?.bounds[0] ?? 0)).toBeGreaterThanOrEqual(59);
    // Breiter ziehen: weniger Zeilen, Text und Umbrüche bleiben
    const wide = run(added, [{ type: 'editParagraph', pageIndex: 0, lines: unit?.lines ?? [], text: unit?.text ?? '', box: { left: 300, right: 560 } }]);
    const widened = unitOf(wide);
    expect(widened?.text).toBe(text);
    expect(widened?.lines).toHaveLength(2);
    // Unverändert gespeichert behält er die Breite (kein Zurückspringen)
    const again = run(wide, [{ type: 'editParagraph', pageIndex: 0, lines: widened?.lines ?? [], text: widened?.text ?? '' }]);
    expect(unitOf(again)?.lines).toHaveLength(2);
  });

  it('neuer Text bricht in der gewählten Breite um', async () => {
    const output = run(textPdf(), [
      { type: 'addText', pageIndex: 0, origin: { x: 100, y: 200 }, lines: ['Ein neuer Text, der in einem schmalen Feld umbrechen soll.'], font: 'Helvetica', size: 12, color: { r: 0, g: 0, b: 0 }, width: 120 },
    ]);
    const list = (await items(output)).filter((item) => Math.round(item.transform[4] ?? 0) === 100 && (item.transform[5] ?? 0) <= 200 && (item.transform[5] ?? 0) > 120);
    expect(list.length).toBeGreaterThan(2);
    expect(list.map((item) => item.str).join(' ')).toBe('Ein neuer Text, der in einem schmalen Feld umbrechen soll.');
  });

  const arial = '/System/Library/Fonts/Supplemental/Arial.ttf';
  it.skipIf(!existsSync(arial))('neuer Text in einer Schrift des Rechners: eingebettet, auch Zeichen außerhalb Westeuropas', async () => {
    const data = readFileSync(arial);
    const output = run(textPdf(), [
      {
        type: 'addText',
        pageIndex: 0,
        origin: { x: 80, y: 120 },
        lines: ['Łódź und Grüße in Arial'],
        font: 'sys:arial:regular',
        size: 14,
        color: { r: 0, g: 0, b: 0 },
        fontData: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      },
    ]);
    const list = await items(output);
    expect(list.map((item) => item.str).join('')).toContain('Łódź und Grüße in Arial');
    const doc = await PDFDocument.load(output);
    const embedded = doc.context.enumerateIndirectObjects().some(([, object]) => object instanceof PDFDict && object.has(PDFName.of('FontFile2')));
    expect(embedded).toBe(true);
    expect(embeddingAllowed(new Uint8Array(data))).toBe(true);
  });

  it('Fließtext läuft auf neue Seiten über, wie in einer Textverarbeitung', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]);
    doc.addPage([400, 300]).drawText('Alte zweite Seite', { x: 50, y: 150, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    const bytes = await doc.save();
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Absatz ${i + 1} mit etwas Text, der in der Breite der Seite umbrechen muss.`);
    const output = run(bytes, [
      { type: 'addText', pageIndex: 0, origin: { x: 50, y: 250 }, lines: paragraphs, font: 'Helvetica', size: 12, color: { r: 0, g: 0, b: 0 }, width: 300, flow: { top: 250, bottom: 50 } },
    ]);
    const task = pdfjs.getDocument({ data: output.slice(), verbosity: 0 });
    const pageCount = (await task.promise).numPages;
    await task.destroy();
    // 12 Absätze à 2 Zeilen = 24 Zeilen, je Seite höchstens 15: eine neue Seite, die alte zweite rückt nach hinten
    expect(pageCount).toBe(3);
    const first = await items(output, 1);
    const second = await items(output, 2);
    expect(first.every((item) => (item.transform[5] ?? 0) >= 49)).toBe(true);
    expect(Math.round(Math.max(...second.map((item) => item.transform[5] ?? 0)))).toBe(250);
    const all = [...first, ...second].map((item) => item.str).join(' ');
    for (const paragraph of paragraphs) expect(all).toContain(paragraph.split(' ')[1] as string);
    expect((await items(output, 3)).map((item) => item.str).join('')).toContain('Alte zweite Seite');
  });

  it('gemischte Größen: jedes Stück behält seine Größe, die Zeile wird so hoch wie die größte Schrift', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const bytes = await doc.save();
    const black = { r: 0, g: 0, b: 0 };
    const red = { r: 1, g: 0, b: 0 };
    const runs = [
      { text: 'Klein und ', size: 12, color: black, font: 'Helvetica' as const },
      { text: 'Groß', size: 24, color: red, font: 'Helvetica' as const },
      { text: ' wieder klein\n\nNeuer Absatz', size: 12, color: black, font: 'Helvetica' as const },
    ];
    const output = run(bytes, [{ type: 'addRichText', pageIndex: 0, origin: { x: 50, y: 350 }, runs }]);
    const list = await items(output);
    const at = (str: string) => list.find((item) => item.str.includes(str));
    // Erste Zeile: Grundlinie nach der größten Schrift (Oberkante 350, 0,86 · 24), alle Stücke auf derselben Grundlinie
    const baseline = 350 - 0.86 * 24;
    for (const str of ['Klein und', 'Groß', 'wieder klein']) expect(at(str)?.transform[5]).toBeCloseTo(baseline, 1);
    expect(at('Groß')?.transform[0]).toBeCloseTo(24, 1);
    expect(at('wieder klein')?.transform[0]).toBeCloseTo(12, 1);
    // Stücke stehen hintereinander, nicht übereinander
    expect(at('Groß')?.transform[4] ?? 0).toBeGreaterThan((at('Klein und')?.transform[4] ?? 0) + 40);
    expect(at('wieder klein')?.transform[4] ?? 0).toBeGreaterThan((at('Groß')?.transform[4] ?? 0) + 40);
    // Zeilen darunter: erste Zeile 1,2 · 24 hoch, die Leerzeile 1,2 · 12
    expect(at('Neuer Absatz')?.transform[5]).toBeCloseTo(350 - 1.2 * 24 - 1.2 * 12 - 0.86 * 12, 1);

    // Wieder gelesen: eine Einheit mit allen Stücken, Text und Gestaltung wie geschrieben
    const listing = engine.listObjects(output, null, [0])[0];
    const units = editUnits(listing?.objects ?? [], listing?.fonts);
    expect(units).toHaveLength(1);
    const [unit] = units;
    expect(unit?.text).toBe('Klein und Groß wieder klein\n\nNeuer Absatz');
    expect(unit?.runs?.map((r) => [r.text, r.size])).toEqual([
      ['Klein und ', 12],
      ['Groß', 24],
      [' wieder klein\n\nNeuer Absatz', 12],
    ]);
    expect(unit?.origin?.x).toBeCloseTo(50, 1);
    expect(unit?.origin?.y).toBeCloseTo(350, 1);

    // Neu setzen an derselben Stelle (Bearbeiten): die Schriften der Stücke bleiben, Lage auch
    const edited = (unit?.runs ?? []).map((r, i) => (i === 2 ? { ...r, text: ' wieder klein\n\nGeänderter Absatz' } : r));
    const again = run(output, [{ type: 'addRichText', pageIndex: 0, origin: unit?.origin ?? { x: 0, y: 0 }, runs: edited, replace: unit?.members ?? [] }]);
    const after = await items(again);
    expect(after.map((item) => item.str).join('|')).not.toContain('Neuer Absatz');
    expect(after.find((item) => item.str.includes('Groß'))?.transform[5]).toBeCloseTo(baseline, 1);
    expect(after.find((item) => item.str.includes('Geänderter'))?.transform[5]).toBeCloseTo(350 - 1.2 * 24 - 1.2 * 12 - 0.86 * 12, 1);
    const relisted = engine.listObjects(again, null, [0])[0];
    expect(editUnits(relisted?.objects ?? [], relisted?.fonts)).toHaveLength(1);
  });

  it('gemischte Größen: Umbruch in der Breite misst jedes Stück in seiner Größe', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const bytes = await doc.save();
    const black = { r: 0, g: 0, b: 0 };
    const runs = [
      { text: 'eins zwei drei ', size: 10, color: black, font: 'Helvetica' as const },
      { text: 'VIER FÜNF SECHS', size: 30, color: black, font: 'Helvetica' as const },
    ];
    const output = run(bytes, [{ type: 'addRichText', pageIndex: 0, origin: { x: 50, y: 350 }, runs, width: 200 }]);
    const list = await items(output);
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    // Jede Zeile passt in die Breite
    const lines = new Map<number, Item[]>();
    for (const item of list) lines.set(Math.round(item.transform[5] ?? 0), [...(lines.get(Math.round(item.transform[5] ?? 0)) ?? []), item]);
    expect(lines.size).toBeGreaterThan(1);
    for (const line of lines.values()) {
      const end = Math.max(...line.map((item) => (item.transform[4] ?? 0) + font.widthOfTextAtSize(item.str, item.transform[0] ?? 0)));
      expect(end).toBeLessThanOrEqual(251);
    }
  });

  it('Listen: Folgezeilen beginnen hinter dem Aufzählungszeichen, Einzug bleibt', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const bytes = await doc.save();
    const black = { r: 0, g: 0, b: 0 };
    const text = '• eins zwei drei vier fünf sechs sieben acht neun zehn\n    1. elf zwölf dreizehn vierzehn fünfzehn sechzehn';
    const runs = [{ text, size: 12, color: black, font: 'Helvetica' as const }];
    const output = run(bytes, [{ type: 'addRichText', pageIndex: 0, origin: { x: 50, y: 350 }, runs, width: 150 }]);
    const list = await items(output);
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const x = (str: string) => list.find((item) => item.str.includes(str))?.transform[4] ?? 0;
    const first = list.find((item) => item.str.includes('eins'));
    // Erste Zeile beginnt am Rand mit dem Zeichen, die Folgezeilen dort, wo der Text nach dem Zeichen beginnt
    expect(first?.str.startsWith('•')).toBe(true);
    expect(x('eins')).toBeCloseTo(50, 0);
    const hang = 50 + font.widthOfTextAtSize('• ', 12);
    const continued = list.filter((item) => (item.transform[5] ?? 0) < (first?.transform[5] ?? 0) - 1 && !item.str.includes('1.') && (item.transform[5] ?? 0) > (list.find((i) => i.str.includes('1.'))?.transform[5] ?? 0));
    expect(continued.length).toBeGreaterThan(0);
    for (const item of continued) expect(item.transform[4] ?? 0).toBeCloseTo(hang, 0);
    // Eingerückter Eintrag: die Leerzeichen davor bleiben, Folgezeilen hinter „1. “
    const numbered = list.find((item) => item.str.includes('1.'));
    // pdf.js lässt die Leerzeichen am Anfang im Text weg; der Eintrag beginnt um ihre Breite eingerückt
    expect(numbered?.transform[4] ?? 0).toBeCloseTo(50 + font.widthOfTextAtSize('    ', 12), 0);
    const after = list.filter((item) => (item.transform[5] ?? 0) < (numbered?.transform[5] ?? 0) - 1);
    expect(after.length).toBeGreaterThan(0);
    // Auf einen Punkt genau (pdf-lib und PDFium runden die Breiten etwas verschieden)
    for (const item of after) expect(Math.abs((item.transform[4] ?? 0) - (50 + font.widthOfTextAtSize('    1. ', 12)))).toBeLessThan(1);
    // Alle Zeilen bleiben in der Breite
    for (const item of list) expect((item.transform[4] ?? 0) + font.widthOfTextAtSize(item.str.trimEnd(), 12)).toBeLessThanOrEqual(201);
    // Wieder gelesen: ein Textblock mit dem Text wie geschrieben (Einzug und Zeichen inklusive)
    const listing = engine.listObjects(output, null, [0])[0];
    const units = editUnits(listing?.objects ?? [], listing?.fonts);
    expect(units).toHaveLength(1);
    expect(units[0]?.text).toBe(text);
    expect(units[0]?.origin?.x).toBeCloseTo(50, 1);
  });

  it('Listen in fremdem Absatz: Einzug und hängender Einzug beim Neusetzen', async () => {
    const bytes = await paragraphPdf();
    const listing = engine.listObjects(bytes, null, [0])[0];
    const paragraph = editUnits(listing?.objects ?? [], listing?.fonts).find((unit) => unit.text?.startsWith('Dies ist'));
    const text = '• Dies ist ein deutlich längerer Eintrag, der nach der Änderung mehrere Zeilen braucht und hinter dem Punkt weiterläuft.';
    const output = run(bytes, [{ type: 'editParagraph', pageIndex: 0, lines: paragraph?.lines ?? [], text }]);
    const list = (await items(output)).filter((item) => (item.transform[4] ?? 0) >= 49 && (item.transform[5] ?? 0) > 220);
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    expect(list.length).toBeGreaterThan(1);
    expect(list[0]?.str.startsWith('• ')).toBe(true);
    expect(list[0]?.transform[4]).toBeCloseTo(50, 0);
    for (const item of list.slice(1)) expect(item.transform[4] ?? 0).toBeCloseTo(50 + font.widthOfTextAtSize('• ', 10), 0);
  });

  it('bricht einen geänderten Absatz in seiner Breite neu um', async () => {
    const bytes = await paragraphPdf();
    const listing = engine.listObjects(bytes, null, [0])[0];
    const paragraph = editUnits(listing?.objects ?? [], listing?.fonts).find((unit) => unit.text?.startsWith('Dies ist'));
    const text = 'Dies ist ein deutlich längerer Absatz, der nach der Änderung mehr Zeilen braucht als vorher und trotzdem links bündig bleibt.\nNeue Zeile.';
    const output = run(bytes, [{ type: 'editParagraph', pageIndex: 0, lines: paragraph?.lines ?? [], text }]);
    const list = (await items(output)).filter((item) => (item.transform[4] ?? 0) >= 49 && (item.transform[5] ?? 0) > 220);
    // Alle Zeilen links bei 50, Abstand 14, keine breiter als der alte Absatz
    const right = Math.max(...(paragraph?.lines ?? []).flat().map((i) => listing?.objects.find((o) => o.index === i)?.bounds[2] ?? 0));
    expect(list.map((item) => Math.round((item.transform[4] ?? 0)))).toEqual(list.map(() => 50));
    expect(list.map((item) => Math.round((item.transform[5] ?? 0)))).toEqual(list.map((_, i) => 300 - i * 14));
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    for (const item of list) expect(50 + font.widthOfTextAtSize(item.str, 10)).toBeLessThanOrEqual(right + 1);
    expect(list.map((item) => item.str).join(' ').replace(' Neue Zeile.', '\nNeue Zeile.')).toBe(text);
    expect(list.at(-1)?.str).toBe('Neue Zeile.');
    expect(list.length).toBeGreaterThan(3);
    // Nummer und Adresse unverändert
    const all = (await items(output)).map((item) => item.str);
    expect(all).toEqual(expect.arrayContaining(['1.', 'Max Muster', 'Hauptstraße 1', '12345 Ort']));

    // Kürzer: überzählige Zeilen verschwinden
    const short = run(bytes, [{ type: 'editParagraph', pageIndex: 0, lines: paragraph?.lines ?? [], text: 'Kurz.' }]);
    const shortList = (await items(short)).filter((item) => (item.transform[5] ?? 0) > 220 && (item.transform[4] ?? 0) >= 49);
    expect(shortList.map((item) => item.str)).toEqual(['Kurz.']);
  });


  it('fasst Textstücke einer Zeile zusammen und ändert sie als Ganzes', async () => {
    // Wie aus Textprogrammen: eine Zeile in mehreren Stücken, dazu ein fettes Wort und eine zweite Spalte
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page0 = doc.addPage([600, 300]);
    let x = 40;
    for (const piece of ['Dies ist', 'ein', 'zerstückelter', 'Satz']) {
      page0.drawText(piece, { x, y: 200, size: 12, font: regular });
      x += regular.widthOfTextAtSize(piece, 12) + 3;
    }
    page0.drawText('fett', { x: x + 1, y: 200, size: 12, font: bold });
    page0.drawText('Spalte', { x: 450, y: 200, size: 12, font: regular });
    page0.drawText('Nächste Zeile', { x: 40, y: 180, size: 12, font: regular });
    const bytes = await doc.save({ useObjectStreams: false });
    const objects = engine.listObjects(bytes, null, [0])[0]?.objects ?? [];
    // PDFium hängt Stücken mit Lücke dahinter ein erzeugtes Leerzeichen an
    const ein = objects.find((o) => o.text?.trim() === 'ein');
    const pieces = lineOf(objects, ein?.index ?? -1);
    expect(pieces.map((o) => o.text?.trim())).toEqual(['Dies ist', 'ein', 'zerstückelter', 'Satz']);
    expect(lineText(pieces)).toBe('Dies ist ein zerstückelter Satz');
    expect(lineOf(objects, objects.find((o) => o.text?.trim() === 'Spalte')?.index ?? -1)).toHaveLength(1);

    expect(editUnits(objects).map((unit) => [unit.text, unit.members.length])).toEqual([
      ['Dies ist ein zerstückelter Satz', 4],
      ['fett', 1],
      ['Spalte', 1],
      ['Nächste Zeile', 1],
    ]);

    const [anchor, ...rest] = pieces;
    const output = run(bytes, [
      { type: 'editText', pageIndex: 0, index: anchor?.index ?? -1, text: 'Ein ganz neuer Satz', merge: rest.map((o) => o.index) },
    ]);
    const list = (await items(output)).map((item) => item.str);
    expect(list).toContain('Ein ganz neuer Satz');
    for (const gone of ['Dies ist', 'ein', 'zerstückelter', 'Satz']) expect(list).not.toContain(gone);
    expect(list).toEqual(expect.arrayContaining(['fett', 'Spalte', 'Nächste Zeile']));
    const edited = (await items(output)).find((item) => item.str === 'Ein ganz neuer Satz');
    expect(edited?.transform.map(Math.round)).toEqual([12, 0, 0, 12, 40, 200]);
  });


  it('liefert die sichtbare Schriftgröße auch bei skalierter Textmatrix', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 800]);
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    const stream = 'BT /F1 1 Tf 12 0 0 12 50 700 Tm (Tm) Tj ET q 2 0 0 2 0 0 cm BT /F1 10 Tf 25 300 Td (cm) Tj ET Q BT /F1 14 Tf 50 500 Td (normal) Tj ET';
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(stream)));
    const [listing] = engine.listObjects(await doc.save(), null, [0]);
    const sizes = Object.fromEntries((listing?.objects ?? []).map((object) => [object.text, Math.round(object.visualSize ?? 0)]));
    expect(sizes).toEqual({ Tm: 12, cm: 20, normal: 14 });
  });


  it('listet Textzeilen mit Schrift, Größe und Lage', () => {
    const [page] = engine.listObjects(textPdf(), null, [0]);
    const heading = page?.objects.find((o) => o.text === 'Testdokument mit Text');
    expect(heading).toMatchObject({ kind: 'text', fontSize: 20 });
    expect(heading?.bounds.map(Math.round)).toEqual([56, 770, 274, 785]);
    expect(page?.fonts[heading?.font ?? '']).toMatchObject({ name: 'Helvetica-Bold', embedded: false, chars: null });
    const [scan] = engine.listObjects(new Uint8Array(readFileSync(fixture('scan.pdf'))), null, [0]);
    expect(scan?.objects.map((o) => o.kind)).toEqual(['image']);
  });

  it('ändert eine Zeile in der vorhandenen Schrift und lässt den übrigen Text unverändert', async () => {
    const original = textPdf();
    const [page] = engine.listObjects(original, null, [0]);
    const heading = page?.objects.find((o) => o.text === 'Testdokument mit Text');
    const output = run(original, [{ type: 'editText', pageIndex: 0, index: heading?.index ?? -1, text: 'Geänderte Überschrift – 100 €' }]);
    expect(Buffer.from(output.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
    const list = await items(output);
    const edited = list.find((item) => item.str === 'Geänderte Überschrift – 100 €');
    expect(edited?.transform.map(Math.round)).toEqual([20, 0, 0, 20, 56, 770]);
    expect(list.map((item) => item.str)).toContain('Inhaltsverzeichnis');
    expect(list.map((item) => item.str)).not.toContain('Testdokument mit Text');
  });

  it('nimmt eine Ersatzschrift, wenn die eingebettete Teilschrift Zeichen nicht hat', async () => {
    // Eingebettete Schrift mit Teilschrift-Namen („ABCDEF+…“), wie sie Textprogramme schreiben
    const doc = await PDFDocument.create();
    const page0 = doc.addPage([300, 200]);
    const ttf = readFileSync(require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
    const context = doc.context;
    const fontFile = context.register(context.flateStream(ttf, { Length1: ttf.length }));
    const descriptor = context.register(
      context.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+LiberationSans', Flags: 32, FontBBox: [-200, -300, 1200, 1000], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80, FontFile2: fontFile }),
    );
    const fontRef = context.register(
      context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+LiberationSans', FirstChar: 32, LastChar: 255, Widths: Array<number>(224).fill(556), Encoding: 'WinAnsiEncoding', FontDescriptor: descriptor }),
    );
    const name = page0.node.newFontDictionary('F', fontRef).asString();
    page0.node.addContentStream(context.register(context.flateStream(`BT ${name} 18 Tf 20 100 Td (Hallo) Tj ET`)));
    const bytes = await doc.save({ useObjectStreams: false });
    const [page] = engine.listObjects(bytes, null, [0]);
    const line = page?.objects.find((o) => o.kind === 'text');
    const fontInfo = page?.fonts[line?.font ?? ''];
    // Die eingebettete Schrift ist vollständig: alle Zeichen da, keine Ersatzschrift nötig
    expect(fontInfo).toMatchObject({ name: 'LiberationSans', embedded: true });
    expect(missingChars('Hallo Welt äöü €', fontInfo)).toBe('');
    expect(missingChars('Łódź', fontInfo)).toContain('Ł');
    const output = run(bytes, [{ type: 'editText', pageIndex: 0, index: line?.index ?? -1, text: 'Hallo Welt' }]);
    const [item] = await items(output);
    expect(item?.str).toBe('Hallo Welt');
    expect(item?.transform.map(Math.round)).toEqual([18, 0, 0, 18, 20, 100]);
  });

  it('Teilschrift: vorhandene Zeichen behalten die Schrift, fehlende führen zur Ersatzschrift', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')), { subset: true });
    doc.addPage([300, 200]).drawText('Hallo', { x: 20, y: 100, size: 18, font });
    const bytes = await doc.save({ useObjectStreams: false });
    const [page] = engine.listObjects(bytes, null, [0]);
    const line = page?.objects.find((o) => o.kind === 'text');
    const fontInfo = page?.fonts[line?.font ?? ''];
    expect(fontInfo?.embedded).toBe(true);
    expect(missingChars('Holla', fontInfo)).toBe('');
    expect(missingChars('Hallo Welt', fontInfo)).toBe('Wet');
    const fontOf = (bytes: Uint8Array) => {
      const [listing] = engine.listObjects(bytes, null, [0]);
      const text = listing?.objects.find((o) => o.kind === 'text');
      return listing?.fonts[text?.font ?? '']?.name;
    };
    const originalFont = fontOf(bytes);

    const same = run(bytes, [{ type: 'editText', pageIndex: 0, index: line?.index ?? -1, text: 'Holla' }]);
    expect((await items(same))[0]?.str).toBe('Holla');
    expect(fontOf(same)).toBe(originalFont);

    const substituted = run(bytes, [{ type: 'editText', pageIndex: 0, index: line?.index ?? -1, text: 'Hallo Welt' }]);
    const [item] = await items(substituted);
    expect(item?.str).toBe('Hallo Welt');
    expect(fontOf(substituted)).toBe('Helvetica');
    expect(item?.transform.map(Math.round)).toEqual([18, 0, 0, 18, 20, 100]);

    expect(() => run(bytes, [{ type: 'editText', pageIndex: 0, index: line?.index ?? -1, text: 'Łódź' }])).toThrow(/Ł/);
  });

  it('fügt mehrzeiligen Text und ein Bild ein', async () => {
    const data = readFileSync(imageFixture('viertel.png'));
    const output = run(textPdf(), [
      { type: 'addText', pageIndex: 0, origin: { x: 300, y: 300 }, lines: ['Erste Zeile', 'Zweite Zeile'], font: 'TimesRoman', size: 12, color: { r: 0, g: 0, b: 1 } },
      {
        type: 'addImage',
        pageIndex: 0,
        rect: [300, 100, 460, 220],
        image: { kind: 'png', data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), width: 320, height: 240, rotation: 0 },
      },
    ]);
    const list = await items(output);
    const first = list.find((item) => item.str === 'Erste Zeile');
    const second = list.find((item) => item.str === 'Zweite Zeile');
    expect(first?.transform.map(Math.round)).toEqual([12, 0, 0, 12, 300, 300]);
    expect(second?.transform.map((v) => Math.round(v * 10) / 10)).toEqual([12, 0, 0, 12, 300, 285.6]);
    const [page] = engine.listObjects(output, null, [0]);
    const image = page?.objects.find((o) => o.kind === 'image');
    expect(image?.bounds.map(Math.round)).toEqual([300, 100, 460, 220]);
  });

  it('Text auf gedrehten Seiten steht aufrecht zur Anzeige', async () => {
    const doc = await PDFDocument.load(textPdf(), { updateMetadata: false });
    doc.getPage(0).setRotation(degrees(90));
    const rotated = await doc.save({ useObjectStreams: false });
    const output = run(rotated, [
      { type: 'addText', pageIndex: 0, origin: { x: 100, y: 100 }, lines: ['A', 'B'], font: 'Helvetica', size: 10, color: { r: 0, g: 0, b: 0 } },
    ]);
    const task = pdfjs.getDocument({ data: output.slice(), verbosity: 0 });
    const page = await (await task.promise).getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const list = (await page.getTextContent()).items as unknown as Item[];
    const view = (item: Item | undefined) => {
      const [a = 0, b = 0, , , e = 0, f = 0] = item?.transform ?? [];
      const start = viewport.convertToViewportPoint(e, f);
      const end = viewport.convertToViewportPoint(e + a, f + b);
      return { start, direction: [(end[0] ?? 0) - (start[0] ?? 0), (end[1] ?? 0) - (start[1] ?? 0)] };
    };
    const a = view(list.find((item) => item.str === 'A'));
    const b = view(list.find((item) => item.str === 'B'));
    await task.destroy();
    // Schreibrichtung in der Ansicht nach rechts, zweite Zeile darunter
    expect(a.direction[0]).toBeGreaterThan(0);
    expect(Math.abs(a.direction[1] ?? 1)).toBeLessThan(0.01);
    expect((b.start[1] ?? 0) - (a.start[1] ?? 0)).toBeCloseTo(12, 1);
  });

  it('verschiebt, skaliert und löscht Objekte', async () => {
    const original = textPdf();
    const [page] = engine.listObjects(original, null, [0]);
    const heading = page?.objects.find((o) => o.text === 'Testdokument mit Text');
    const toc = page?.objects.find((o) => o.text === 'Inhaltsverzeichnis');
    const moved = run(original, [
      { type: 'transform', pageIndex: 0, index: heading?.index ?? -1, matrix: translation(10, -20) },
      { type: 'transform', pageIndex: 0, index: toc?.index ?? -1, matrix: scalingAbout(2, 57, 520) },
    ]);
    const [after] = engine.listObjects(moved, null, [0]);
    expect(after?.objects.find((o) => o.text === 'Testdokument mit Text')?.bounds.map(Math.round)).toEqual([66, 750, 284, 765]);
    const scaled = after?.objects.find((o) => o.text === 'Inhaltsverzeichnis');
    expect(Math.round((scaled?.bounds[2] ?? 0) - (scaled?.bounds[0] ?? 0))).toBe(Math.round(2 * ((toc?.bounds[2] ?? 0) - (toc?.bounds[0] ?? 0))));
    const deleted = run(moved, [{ type: 'delete', pageIndex: 0, indices: [scaled?.index ?? -1] }]);
    expect((await items(deleted)).map((item) => item.str)).not.toContain('Inhaltsverzeichnis');
  });

  it('Zeichen einzeln gesetzt (wie aus dem Browser): Komma und Leerzeichen gehören zur Zeile, Linien sind Objekte', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 400]);
    // jedes Zeichen ein eigenes Textobjekt, Leerzeichen eingeschlossen
    let x = 40;
    for (const char of 'Hallo, Welt') {
      page.drawText(char, { x, y: 300, size: 12, font });
      x += font.widthOfTextAtSize(char, 12);
    }
    // eine kleine Tabelle aus Linien und eine graue Kopfzeile, darunter Text
    page.drawRectangle({ x: 40, y: 200, width: 200, height: 20, color: rgb(0.85, 0.85, 0.85) });
    page.drawLine({ start: { x: 40, y: 180 }, end: { x: 240, y: 180 }, thickness: 0.5 });
    page.drawText('Darunter', { x: 40, y: 150, size: 12, font });
    const bytes = await doc.save({ useObjectStreams: false });
    const listing = engine.listObjects(bytes, null, [0])[0];
    if (!listing) throw new Error('keine Objekte');
    const units = editUnits(listing.objects, listing.fonts);
    const line = units.find((unit) => unit.text?.startsWith('Hallo'));
    expect(line?.text).toBe('Hallo, Welt');
    expect(line?.members).toHaveLength(11);
    // keine übrig gebliebenen Einzelstücke (Komma, Leerzeichen)
    expect(units.filter((unit) => unit.kind === 'text').map((unit) => unit.text)).toEqual(['Hallo, Welt', 'Darunter']);
    const paths = listing.objects.filter((object) => object.kind === 'path');
    expect(paths).toHaveLength(2);
    // Löschen nimmt Text samt Linien und Fläche heraus
    const deleted = run(bytes, [{ type: 'delete', pageIndex: 0, indices: [...(line?.members ?? []), ...paths.map((path) => path.index)] }]);
    const after = engine.listObjects(deleted, null, [0])[0];
    expect(after?.objects.map((object) => object.text ?? object.kind)).toEqual(['Darunter']);
  });

  it('Hintergrund über die ganze Seite wird nicht angeboten', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    page.drawRectangle({ x: 0, y: 0, width: 400, height: 400, color: rgb(1, 1, 0.9) });
    page.drawRectangle({ x: 10, y: 10, width: 50, height: 50, color: rgb(0, 0, 1) });
    const listing = engine.listObjects(await doc.save(), null, [0])[0];
    expect(listing?.objects.map((object) => object.kind)).toEqual(['path']);
  });

  it('meldet fehlende Objekte', () => {
    expect(() => run(textPdf(), [{ type: 'delete', pageIndex: 0, indices: [999] }])).toThrow(/fehlt/);
  });
});
