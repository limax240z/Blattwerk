// Stift: Linienart (durchgehend, gepunktet, gestrichelt) und einzelne Punkte überstehen das Speichern.
import { PDFDict, PDFDocument, PDFName, type PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { init } from '@embedpdf/pdfium';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { InkAnnotation, LineStyle } from '../../src/shared/annotations';
import { lineStyleOf } from '../../src/shared/annotations';
import { convertPageAnnotations, type PdfjsAnnotationData } from '../../src/renderer/features/annotations/from-pdfjs';
import { createInk, dotPath, type Base } from '../../src/renderer/features/annotations/create';
import { PdfiumEngine } from '../../src/workers/pdfium/engine';
import { fixture } from '../fixtures/expectations';

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(pdfjsRoot, 'legacy/build/pdf.worker.mjs')).href;

let engine: PdfiumEngine;

beforeAll(async () => {
  const wasmBinary = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'));
  const m = await init({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) });
  m.PDFiumExt_Init();
  engine = new PdfiumEngine(m);
});

const DATE = "D:20261012120000+02'00'";
const base = (id: string): Base => ({ id, ref: null, pageIndex: 0, opacity: 1, author: 'Prüferin', created: DATE, modified: DATE, contents: '', replies: [], statuses: [] });
const blue = { r: 0, g: 0, b: 1 };

function ink(id: string, dash: LineStyle, path: InkAnnotation['paths'][number], width = 4): InkAnnotation {
  return createInk(base(id), [path], blue, width, dash);
}

function save(annotations: InkAnnotation[]): Uint8Array {
  const original = new Uint8Array(readFileSync(fixture('text.pdf')));
  const changes = { upserts: annotations.map((annotation) => ({ annotation, appearance: true })), deletions: [] };
  return engine.applyAndSave(original, null, changes, { incremental: true, now: new Date(Date.UTC(2026, 9, 12, 10, 0, 0)) });
}

// Darstellung (Appearance Stream) der gespeicherten Zeichnungen, nach Namen (/NM)
async function appearances(bytes: Uint8Array): Promise<Record<string, string>> {
  const doc = await PDFDocument.load(bytes);
  const result: Record<string, string> = {};
  for (const ref of doc.getPage(0).node.Annots()?.asArray() ?? []) {
    const dict = doc.context.lookup(ref, PDFDict);
    if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Ink') continue;
    const stream = dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
    result[String(dict.lookup(PDFName.of('NM'))?.toString()).replace(/[()]/g, '')] = Buffer.from(decodePDFRawStream(stream).decode()).toString();
  }
  return result;
}

describe('Stift: Linienart und Punkte', () => {
  it('schreibt Strichmuster in die Darstellung und liest die Linienart wieder ein', async () => {
    const line = [{ x: 100, y: 500 }, { x: 200, y: 500 }];
    const saved = save([ink('dotted', 'dotted', line), ink('dashed', 'dashed', line.map((p) => ({ ...p, y: 520 }))), ink('solid', 'solid', line.map((p) => ({ ...p, y: 540 })))]);

    const streams = await appearances(saved);
    expect(streams.dotted).toMatch(/\[\s*0?\.00100*\d*\s+8\s*\]\s*0 d/);
    expect(streams.dashed).toMatch(/\[\s*12\s+12\s*\]\s*0 d/);
    expect(streams.solid).not.toMatch(/ d\b/);

    // Zurück ins Modell, wie die App beim Öffnen
    const task = pdfjs.getDocument({ data: saved.slice(), verbosity: 0 });
    const page = await (await task.promise).getPage(1);
    const converted = convertPageAnnotations((await page.getAnnotations()) as PdfjsAnnotationData[], 0);
    await task.destroy();
    const styles = converted.filter((a) => a.kind === 'ink').map((a) => (a.kind === 'ink' ? a.dash : undefined));
    expect(styles.sort()).toEqual(['dashed', 'dotted', 'solid']);
  });

  it('ein Klick ohne Ziehen wird als sichtbarer Punkt gespeichert', async () => {
    const saved = save([ink('dot', 'solid', dotPath({ x: 150, y: 560 }))]);
    const streams = await appearances(saved);
    // Anfangs- und Endpunkt vorhanden und gezeichnet; runde Enden (1 J) machen daraus einen Punkt
    expect(streams.dot).toMatch(/150 560 m 150\.01 560 l S/);
    expect(streams.dot).toContain('1 J');
  });
});

describe('Linienart erkennen', () => {
  it('ordnet Strichmuster der nächsten Linienart zu', () => {
    expect(lineStyleOf(undefined, 2)).toBe('solid');
    expect(lineStyleOf([], 2)).toBe('solid');
    expect(lineStyleOf([0.001, 4], 2)).toBe('dotted');
    expect(lineStyleOf([1, 3], 2)).toBe('dotted');
    expect(lineStyleOf([6, 6], 2)).toBe('dashed');
    expect(lineStyleOf([3], 1)).toBe('dashed');
  });
});
