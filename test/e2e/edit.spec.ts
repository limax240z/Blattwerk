// Phase 5: Bearbeiten (Schwärzen). Arbeitet auf Kopien bzw. im Test erzeugten PDFs.
import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePDFRawStream, PDFDocument, PDFRawStream, rgb, StandardFonts } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Rect } from '../../src/shared/annotations';
import { fixture, imageFixture, TEXT_PDF } from '../fixtures/expectations';
import { AREAS, buildRedactionPdf, containsSecret, PUBLIC, SECRETS } from '../fixtures/redaction';
import { launchApp, menuClick, menuItemState, removeTempDir, waitForDocument } from './app';
import { inspectWithPdfKit } from './pdfkit';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'legacy/build/pdf.worker.mjs'),
).href;

const tempDirs: string[] = [];
test.afterAll(() => {
  for (const dir of tempDirs) removeTempDir(dir);
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blattwerk-e2e-'));
  tempDirs.push(dir);
  return dir;
}

async function pageTexts(file: string): Promise<string[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 });
  const pdf = await task.promise;
  const texts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    texts.push((await (await pdf.getPage(i)).getTextContent()).items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  await task.destroy();
  return texts;
}

async function decodedFile(file: string): Promise<string> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(file)), { updateMetadata: false });
  const parts: string[] = [readFileSync(file).toString('latin1')];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) parts.push(Buffer.from(decodePDFRawStream(object).decode()).toString('latin1'));
  }
  return parts.join('\n');
}

// Position der Kommentarebene von Seite 1, sobald sie sich nicht mehr bewegt
async function stableOverlayBox(page: Page) {
  const overlay = page.getByTestId('annotation-overlay-0');
  let last = '';
  for (let i = 0; i < 50; i++) {
    const box = await overlay.boundingBox();
    const key = JSON.stringify(box);
    if (box && key === last) return box;
    last = key;
    await page.waitForTimeout(100);
  }
  throw new Error('Seite kommt nicht zur Ruhe');
}

// Rechteck in PDF-Punkten auf Seite 1 (A4, ungedreht) aufziehen
async function dragPdfRect(page: Page, rect: Rect): Promise<void> {
  const box = await stableOverlayBox(page);
  const toScreen = (x: number, y: number) => [box.x + (x / 595.28) * box.width, box.y + (1 - y / 841.89) * box.height] as const;
  const [l, b, r, t] = rect;
  const [x1, y1] = toScreen(l, t);
  const [x2, y2] = toScreen(r, b);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
  await page.mouse.move(x2, y2, { steps: 4 });
  await page.mouse.up();
}

test.describe('Schwärzen', () => {
  test('Bereiche markieren, anwenden und speichern: Inhalte sind aus der Datei verschwunden', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'bericht.pdf');
    writeFileSync(file, await buildRedactionPdf());
    const { page, app, close } = await launchApp([file], { userData: dir });
    await waitForDocument(page, 2);
    expect(await menuItemState(app, 'redact.apply')).toMatchObject({ enabled: false });

    await page.getByTestId('redact-tools-button').click();
    await expect(page.getByTestId('redact-toolbar')).toBeVisible();
    await expect(page.getByTestId('redact-tool-redact')).toHaveAttribute('aria-pressed', 'true');
    await menuClick(app, 'view.fitPage');
    await expect(page.getByTestId('zoom-select')).toHaveValue('page-fit');
    for (const area of AREAS) await dragPdfRect(page, area);
    await expect(page.getByTestId('redaction-mark')).toHaveCount(2);
    await expect(page.getByTestId('redact-apply')).toHaveText(/2 Schwärzungen anwenden/);
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);

    await page.getByTestId('redact-apply').click();
    await expect(page.getByTestId('redact-apply-dialog')).toBeVisible();
    await expect(page.getByTestId('redact-metadata')).toBeChecked();
    await page.getByTestId('redact-apply-confirm').click();
    await expect(page.getByTestId('redaction-mark')).toHaveCount(0);
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);

    // Rückgängig bringt den Inhalt zurück (nur im Arbeitsspeicher), Wiederholen schwärzt wieder
    await menuClick(app, 'edit.undo');
    await expect(page.getByTestId('redaction-mark')).toHaveCount(2);
    await menuClick(app, 'edit.redo');
    await expect(page.getByTestId('redaction-mark')).toHaveCount(0);

    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    const contents = await decodedFile(file);
    for (const secret of Object.values(SECRETS)) expect(containsSecret(contents, secret), secret).toBe(false);
    const texts = await pageTexts(file);
    expect(texts[0]).toContain(PUBLIC.line);
    expect(texts[1]).toContain(PUBLIC.page2);
    if (process.platform === 'darwin') {
      const kit = inspectWithPdfKit(file);
      expect(kit.ok).toBe(true);
      expect(kit.pages).toHaveLength(2);
    }
    await close();
  });

  test('Text suchen und alle Treffer schwärzen', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'text.pdf');
    copyFileSync(fixture('text.pdf'), file);
    const { page, app, close } = await launchApp([file], { userData: dir });
    await waitForDocument(page, TEXT_PDF.pages);
    await menuClick(app, 'redact.find');
    await expect(page.getByTestId('redact-find-dialog')).toBeVisible();
    await page.getByTestId('redact-find-query').fill(TEXT_PDF.searchTerm);
    await page.getByTestId('redact-find-search').click();
    await expect(page.getByTestId('redact-find-result')).toContainText(`${TEXT_PDF.searchHits} Treffer auf 3 Seite`);
    await page.getByTestId('redact-find-mark').click();
    await expect(page.getByTestId('redact-apply')).toHaveText(new RegExp(`${TEXT_PDF.searchHits} Schwärzungen anwenden`));
    // Ein Schritt für Rückgängig
    await menuClick(app, 'edit.undo');
    await expect(page.getByTestId('redact-apply')).toBeDisabled();
    await menuClick(app, 'edit.redo');
    await expect(page.getByTestId('redact-apply')).toBeEnabled();
    await menuClick(app, 'redact.apply');
    await page.getByTestId('redact-apply-confirm').click();
    await expect(page.getByTestId('redact-apply')).toBeDisabled();
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    const texts = await pageTexts(file);
    expect(texts.join(' ')).not.toContain(TEXT_PDF.searchTerm);
    expect(texts).toHaveLength(TEXT_PDF.pages);
    expect(containsSecret(await decodedFile(file), TEXT_PDF.searchTerm)).toBe(false);
    await close();
  });

  test('Markierungen ohne Anwenden speichern und beim nächsten Öffnen anwenden', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'bericht.pdf');
    writeFileSync(file, await buildRedactionPdf());
    const first = await launchApp([file], { userData: dir });
    await waitForDocument(first.page, 2);
    await first.page.getByTestId('redact-tools-button').click();
    await menuClick(first.app, 'view.fitPage');
    await expect(first.page.getByTestId('zoom-select')).toHaveValue('page-fit');
    await dragPdfRect(first.page, AREAS[0] as Rect);
    await menuClick(first.app, 'file.save');
    await expect(first.page.getByTestId('tab-dirty')).toHaveCount(0);
    // Gespeichert ist nur die Markierung; der Inhalt steht noch in der Datei.
    expect((await pageTexts(file))[0]).toContain(SECRETS.text);
    await first.close();

    const second = await launchApp([file], { userData: dir });
    await waitForDocument(second.page, 2);
    await second.page.getByTestId('redact-tools-button').click();
    await expect(second.page.getByTestId('redaction-mark')).toHaveCount(1);
    await second.page.getByTestId('redact-apply').click();
    await second.page.getByTestId('redact-metadata').uncheck();
    await second.page.getByTestId('redact-apply-confirm').click();
    await expect(second.page.getByTestId('redaction-mark')).toHaveCount(0);
    await menuClick(second.app, 'file.save');
    await expect(second.page.getByTestId('tab-dirty')).toHaveCount(0);
    const texts = await pageTexts(file);
    expect(texts[0]).not.toContain(SECRETS.text);
    expect(texts[0]).toContain(PUBLIC.line);
    await second.close();
  });
});

test.describe('Wasserzeichen, Kopf- und Fußzeilen, Seitenzahlen', () => {
  async function openText() {
    const dir = tempDir();
    const file = path.join(dir, 'bericht.pdf');
    copyFileSync(fixture('text.pdf'), file);
    const handle = await launchApp([file], { userData: dir });
    await waitForDocument(handle.page, TEXT_PDF.pages);
    return { ...handle, file };
  }

  test('Wasserzeichen hinzufügen, speichern und wieder entfernen', async () => {
    const { page, app, file, close } = await openText();
    await menuClick(app, 'stamp.watermark');
    await expect(page.getByTestId('watermark-dialog')).toBeVisible();
    await page.getByTestId('watermark-text').fill('VERTRAULICH');
    await page.getByTestId('stamp-ok').click();
    await expect(page.getByTestId('watermark-dialog')).toHaveCount(0);
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    let texts = await pageTexts(file);
    for (const text of texts) expect(text).toContain('VERTRAULICH');
    if (process.platform === 'darwin') expect(inspectWithPdfKit(file).ok).toBe(true);
    await waitForDocument(page, TEXT_PDF.pages);

    await menuClick(app, 'stamp.removeWatermark');
    await expect(page.getByTestId('notices')).toContainText('Wasserzeichen entfernt');
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    texts = await pageTexts(file);
    for (const text of texts) expect(text).not.toContain('VERTRAULICH');
    // Nichts mehr da: verständliche Meldung statt eines neuen Stands
    await waitForDocument(page, TEXT_PDF.pages);
    await menuClick(app, 'stamp.removeWatermark');
    await expect(page.getByTestId('notices')).toContainText('enthält nichts davon');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    await close();
  });

  test('Seitenzahlen „Seite x von n“ ab der zweiten Seite', async () => {
    const { page, app, file, close } = await openText();
    await menuClick(app, 'stamp.pageNumbers');
    await expect(page.getByTestId('page-numbers-dialog')).toBeVisible();
    await page.getByTestId('stamp-pages-range').check();
    await page.getByTestId('stamp-pages').fill(`2-${TEXT_PDF.pages}`);
    await page.getByTestId('stamp-ok').click();
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    // Rückgängig und Wiederholen (vor dem Speichern; danach beginnt der Verlauf neu)
    await menuClick(app, 'edit.undo');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    await menuClick(app, 'edit.redo');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    const texts = await pageTexts(file);
    expect(texts[0]).not.toContain('Seite 1 von');
    expect(texts[1]).toContain(`Seite 1 von ${TEXT_PDF.pages - 1}`);
    expect(texts[TEXT_PDF.pages - 1]).toContain(`Seite ${TEXT_PDF.pages - 1} von ${TEXT_PDF.pages - 1}`);
    await close();
  });

  test('Kopfzeile mit Dateiname per Platzhalter', async () => {
    const { page, app, file, close } = await openText();
    await menuClick(app, 'stamp.headerFooter');
    await expect(page.getByTestId('header-footer-dialog')).toBeVisible();
    await page.getByTestId('hf-headerLeft').click();
    await page.getByTestId('hf-token-file').click();
    await expect(page.getByTestId('hf-headerLeft')).toHaveValue('{Datei}');
    await page.getByTestId('hf-footerRight').fill('Stand {Datum}');
    await page.getByTestId('stamp-ok').click();
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    const texts = await pageTexts(file);
    expect(texts[0]).toContain('bericht.pdf');
    expect(texts[0]).toMatch(/Stand \d{2}\.\d{2}\.\d{4}/);
    await close();
  });

  test('in verschlüsselten Dokumenten mit verständlicher Meldung abgelehnt', async () => {
    const { page, app, close } = await launchApp([fixture('eingeschraenkt.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await menuClick(app, 'stamp.watermark');
    await expect(page.getByTestId('watermark-dialog')).toHaveCount(0);
    await expect(page.getByTestId('notices')).toContainText('Kennwortschutz');
    await close();
  });
});

test.describe('Inhalt bearbeiten', () => {
  async function openText() {
    const dir = tempDir();
    const file = path.join(dir, 'bericht.pdf');
    copyFileSync(fixture('text.pdf'), file);
    const handle = await launchApp([file], { userData: dir });
    await waitForDocument(handle.page, TEXT_PDF.pages);
    await handle.page.getByTestId('content-edit-button').click();
    await expect(handle.page.getByTestId('content-edit-toolbar')).toBeVisible();
    await menuClick(handle.app, 'view.fitPage');
    await expect(handle.page.getByTestId('zoom-select')).toHaveValue('page-fit');
    return { ...handle, file, dir };
  }

  const line = (page: Page, text: string) => page.locator(`[data-testid="content-object"][data-text="${text}"]`).first();

  test('Absatz bearbeiten: der Text bricht in der Breite des Absatzes neu um', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'absatz.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pdfPage = doc.addPage([595, 842]);
    ['Dies ist der erste Absatz eines Briefes. Er ist so', 'lang, dass er über drei Zeilen läuft und am Ende', 'kurz aufhört.'].forEach((text, i) =>
      pdfPage.drawText(text, { x: 60, y: 700 - i * 16, size: 12, font }),
    );
    writeFileSync(file, await doc.save());
    const { page, app, close } = await launchApp([file], { userData: dir });
    await waitForDocument(page, 1);
    await page.getByTestId('content-edit-button').click();
    await menuClick(app, 'view.fitPage');
    const texts = page.locator('[data-testid="content-object"][data-kind="text"]');
    await expect(texts).toHaveCount(1);
    await texts.first().dblclick();
    const editor = page.getByTestId('content-text-editor');
    await expect(editor).toHaveValue('Dies ist der erste Absatz eines Briefes. Er ist so lang, dass er über drei Zeilen läuft und am Ende kurz aufhört.');
    await editor.fill('Dies ist der erste Absatz eines Briefes. Er ist jetzt deutlich länger geworden, weil ein ganzer Satz dazugekommen ist, und braucht deshalb mehr Zeilen.');
    // Eingabe allein beginnt eine neue Zeile, Cmd+Eingabe übernimmt
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Gruß');
    await page.keyboard.press('Meta+Enter');
    await expect(editor).toHaveCount(0);
    await expect(texts.first()).toHaveAttribute('data-text', /^Dies ist der erste Absatz eines Briefes\. Er ist jetzt deutlich länger.*Zeilen\.\nGruß$/s);
    await close();
  });

  test('Doppelklick bearbeitet die ganze Zeile, auch wenn das PDF sie in Stücken speichert', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'stuecke.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pdfPage = doc.addPage([595, 842]);
    let x = 60;
    for (const piece of ['Dieser', 'Satz', 'besteht', 'aus', 'Stücken']) {
      pdfPage.drawText(piece, { x, y: 700, size: 16, font });
      x += font.widthOfTextAtSize(piece, 16) + 4;
    }
    writeFileSync(file, await doc.save());
    const { page, app, close } = await launchApp([file], { userData: dir });
    await waitForDocument(page, 1);
    await page.getByTestId('content-edit-button').click();
    await menuClick(app, 'view.fitPage');
    // Die Zeile erscheint als ein Objekt; Verschieben bewegt alle Stücke
    const whole = page.locator('[data-testid="content-object"][data-text="Dieser Satz besteht aus Stücken"]');
    await expect(page.locator('[data-testid="content-object"][data-kind="text"]')).toHaveCount(1);
    const before = await whole.boundingBox();
    if (!before) throw new Error('Zeile fehlt');
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2 + 30, { steps: 4 });
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2 + 60, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await whole.boundingBox())?.y ?? 0).toBeGreaterThan(before.y + 40);
    // Breite bleibt gleich (bis auf Rundung an Bildpunktgrenzen)
    await expect.poll(async () => Math.abs(((await whole.boundingBox())?.width ?? 0) - before.width)).toBeLessThan(1);
    await whole.dblclick();
    const editor = page.getByTestId('content-text-editor');
    await expect(editor).toHaveValue('Dieser Satz besteht aus Stücken');
    await editor.fill('Jetzt ist es ein ganzer Satz');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="content-object"][data-kind="text"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="content-object"][data-text^="Jetzt ist es ein ganzer Satz"]')).toBeVisible();
    await close();
  });

  test('Textzeile ändern, neuen Text einfügen, verschieben und löschen', async () => {
    const { page, app, file, close } = await openText();
    await expect(line(page, 'Testdokument mit Text')).toBeVisible();

    // Zeile ändern (Doppelklick, Eingabe übernimmt)
    await line(page, 'Testdokument mit Text').dblclick();
    const editor = page.getByTestId('content-text-editor');
    await expect(editor).toHaveValue('Testdokument mit Text');
    await editor.fill('Geänderter Titel – Größe 1 €');
    await page.keyboard.press('Enter');
    await expect(line(page, 'Geänderter Titel – Größe 1 €')).toBeVisible();

    // Nicht darstellbare Zeichen: Hinweis, nichts übernommen
    await line(page, 'Inhaltsverzeichnis').dblclick();
    await editor.fill('Łódź');
    await expect(page.getByTestId('content-font-warning')).toContainText('Nicht darstellbar');
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);

    // Neuer Text an einer Stelle
    await page.getByTestId('content-tool-text').click();
    const overlay = await page.getByTestId('content-edit-overlay-0').boundingBox();
    if (!overlay) throw new Error('keine Ebene');
    await page.mouse.click(overlay.x + overlay.width * 0.5, overlay.y + overlay.height * 0.85);
    await expect(editor).toBeVisible();
    await page.keyboard.type('Hallo aus Blattwerk');
    await page.keyboard.press('Meta+Enter');
    await expect(line(page, 'Hallo aus Blattwerk')).toBeVisible();

    // Verschieben: Inhaltsverzeichnis 100 Pixel nach rechts
    const before = await line(page, 'Inhaltsverzeichnis').boundingBox();
    if (!before) throw new Error('Zeile fehlt');
    await page.mouse.move(before.x + 5, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 55, before.y + before.height / 2, { steps: 4 });
    await page.mouse.move(before.x + 105, before.y + before.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await line(page, 'Inhaltsverzeichnis').boundingBox())?.x ?? 0).toBeGreaterThan(before.x + 80);

    // Löschen: Zeile auswählen, Entfernen
    await line(page, 'Externer Link: https://example.com').click();
    await expect(page.getByTestId('content-selection')).toHaveCount(1);
    await page.keyboard.press('Backspace');
    await expect(line(page, 'Externer Link: https://example.com')).toHaveCount(0);

    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    const [first] = await pageTexts(file);
    expect(first).toContain('Geänderter Titel – Größe 1 €');
    expect(first).toContain('Hallo aus Blattwerk');
    expect(first).toContain('Inhaltsverzeichnis');
    expect(first).not.toContain('Testdokument mit Text');
    expect(first).not.toContain('Externer Link');
    if (process.platform === 'darwin') expect(inspectWithPdfKit(file).ok).toBe(true);
    await close();
  });

  test('Bild einfügen und mit Rückgängig wieder entfernen', async () => {
    const { page, app, close } = await openText();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
    }, imageFixture('viertel.png'));
    await page.getByTestId('content-add-image').click();
    await expect(page.locator('[data-testid="content-object"][data-kind="image"]')).toHaveCount(1);
    await menuClick(app, 'edit.undo');
    await expect(page.locator('[data-testid="content-object"][data-kind="image"]')).toHaveCount(0);
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    await close();
  });
});

test.describe('Textfelder: Breite, Größe, Schrift, Farbe', () => {
  async function openActualSize() {
    const dir = tempDir();
    const file = path.join(dir, 'felder.pdf');
    copyFileSync(fixture('text.pdf'), file);
    const handle = await launchApp([file], { userData: dir });
    await waitForDocument(handle.page, TEXT_PDF.pages);
    await handle.page.getByTestId('content-edit-button').click();
    await menuClick(handle.app, 'view.actualSize');
    return handle;
  }
  const textObject = (page: Page, start: string) => page.locator(`[data-testid="content-object"][data-text^="${start}"]`).first();

  test('vorhandenen Text schmaler ziehen und Größe und Farbe ändern', async () => {
    const { page, close } = await openActualSize();
    const line = textObject(page, 'Ein PDF besteht aus Objekten');
    const before = await line.boundingBox();
    if (!before) throw new Error('Zeile fehlt');
    await line.click();
    const handle = page.getByTestId('content-width-right');
    const box = await handle.boundingBox();
    if (!box) throw new Error('kein Anfasser');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - before.width * 0.3, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x - before.width * 0.55, box.y + box.height / 2, { steps: 5 });
    // Live-Vorschau während des Ziehens: schon umbrochen
    await expect(page.getByTestId('content-width-preview')).toBeVisible();
    expect((await page.getByTestId('content-width-preview').boundingBox())?.height ?? 0).toBeGreaterThan(before.height * 1.8);
    await page.mouse.up();
    // Neu umbrochen: schmaler und höher, der ganze Text bleibt, er ist weiter ausgewählt
    await expect.poll(async () => (await line.boundingBox())?.height ?? 0).toBeGreaterThan(before.height * 1.8);
    const after = await line.boundingBox();
    expect(after?.width ?? 0).toBeLessThan(before.width * 0.5);
    await expect(line).toHaveAttribute('data-text', 'Ein PDF besteht aus Objekten, die über eine Querverweistabelle gefunden werden.');
    await expect(page.getByTestId('content-selection')).toHaveCount(1);

    // Größe: der ausgewählte Text wird größer, die Leiste zeigt die neue Größe
    // Größe aus der Liste wählen
    await page.getByTestId('content-size-toggle').click();
    await page.getByTestId('content-size-list').locator('[data-size="24"]').click();
    await expect.poll(async () => (await line.boundingBox())?.height ?? 0).toBeGreaterThan((after?.height ?? 0) * 1.5);
    await expect(page.getByTestId('content-size')).toHaveValue('24');
    // Größe eintippen (mit Komma)
    await page.getByTestId('content-size').fill('13,5');
    await page.getByTestId('content-size').press('Enter');
    await expect(page.getByTestId('content-size')).toHaveValue('13,5');
    await page.getByTestId('content-color-red').click();
    await expect(page.getByTestId('content-color-red')).toHaveAttribute('aria-checked', 'true');
    await close();
  });

  test('neuer Text: alles auswählen, Größe ändern und Breite des Feldes ziehen', async () => {
    const { page, close } = await openActualSize();
    await page.getByTestId('content-tool-text').click();
    const overlay = await page.getByTestId('content-edit-overlay-0').boundingBox();
    if (!overlay) throw new Error('keine Ebene');
    // Freie Stelle im sichtbaren Bereich (unterhalb der Überschrift)
    await page.mouse.click(overlay.x + 100, overlay.y + 420);
    const editor = page.getByTestId('content-text-editor');
    await page.keyboard.type('Ein neuer Absatz, der in einem schmalen Feld mehrere Zeilen bekommt.');
    // Alles ausgewählt: die Größe in der Leiste gilt für den ganzen Text, die Eingabe bleibt offen
    await page.keyboard.press('ControlOrMeta+A');
    await page.getByTestId('content-size').fill('18');
    await page.getByTestId('content-size').press('Enter');
    await expect(editor).toHaveCount(1);
    await expect(editor.locator('span')).toHaveCount(1);
    await expect(editor.locator('span')).toHaveCSS('font-size', '24px');
    // Der größere Text reicht über den Rand: Die Eingabe bricht gleich danach dort um, der Anfasser springt an die
    // Seitenkante. Erst greifen, wenn er ruhig steht.
    const rightHandle = page.getByTestId('content-editor-width-right');
    let handle = await rightHandle.boundingBox();
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(100);
      const next = await rightHandle.boundingBox();
      if (JSON.stringify(next) === JSON.stringify(handle)) break;
      handle = next;
    }
    if (!handle) throw new Error('kein Anfasser');
    await page.mouse.move(handle.x + 3, handle.y + 9);
    await page.mouse.down();
    await page.mouse.move(overlay.x + 300, handle.y + 9, { steps: 6 });
    await page.mouse.up();
    await expect(editor).toHaveCount(1);
    await page.keyboard.press('Meta+Enter');
    await expect(editor).toHaveCount(0);
    const placed = textObject(page, 'Ein neuer Absatz');
    await expect(placed).toBeVisible();
    const box = await placed.boundingBox();
    // Mehrere Zeilen in Größe 18 (Zeilenhöhe bei 100 %: 18 pt · 4/3 · 1,2 ≈ 29 px)
    expect(box?.height ?? 0).toBeGreaterThan(60);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThan(overlay.x + 310);
    await close();
  });

  test('neuer Text am rechten Rand bricht dort um, statt über die Seite hinauszulaufen', async () => {
    const { page, close } = await openActualSize();
    await page.getByTestId('content-tool-text').click();
    const overlay = await page.getByTestId('content-edit-overlay-0').boundingBox();
    if (!overlay) throw new Error('keine Ebene');
    await page.mouse.click(overlay.x + overlay.width * 0.6, overlay.y + 420);
    const editor = page.getByTestId('content-text-editor');
    await page.keyboard.type('Dieser Satz ist so lang, dass er auf keinen Fall in eine einzige Zeile bis zum rechten Rand der Seite passt.');
    // Schon in der Eingabe umbrochen
    const typing = await editor.boundingBox();
    expect((typing?.x ?? 0) + (typing?.width ?? 0)).toBeLessThanOrEqual(overlay.x + overlay.width + 1);
    await page.keyboard.press('Meta+Enter');
    await expect(editor).toHaveCount(0);
    const placed = textObject(page, 'Dieser Satz');
    await expect(placed).toBeVisible();
    const box = await placed.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(overlay.x + overlay.width);
    expect(box?.height ?? 0).toBeGreaterThan(40);
    await close();
  });

  test('neuer und vorhandener Text: Nummerierung, Aufzählung und Einzug', async () => {
    const { page, close } = await openActualSize();
    // Ausgegraut, bis eine Eingabe offen ist
    await expect(page.getByTestId('list-bullets')).toBeDisabled();
    await page.getByTestId('content-tool-text').click();
    const overlay = await page.getByTestId('content-edit-overlay-0').boundingBox();
    if (!overlay) throw new Error('keine Ebene');
    await page.mouse.click(overlay.x + 100, overlay.y + 420);
    const editor = page.getByTestId('content-text-editor');
    await page.getByTestId('list-numbers').click();
    await expect(editor).toBeFocused();
    await page.keyboard.type('Erstens');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Unterpunkt');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('Zweitens');
    await expect(editor).toHaveText('1. Erstens\n    1. Unterpunkt\n2. Zweitens');
    await page.keyboard.press('Meta+Enter');
    await expect(editor).toHaveCount(0);
    const placed = textObject(page, '1. Erstens');
    await expect(placed).toHaveAttribute('data-text', '1. Erstens\n    1. Unterpunkt\n2. Zweitens');

    // Wieder bearbeiten: als Aufzählung mit Strichen
    await placed.dblclick();
    await expect(editor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+A');
    await page.getByTestId('list-bullets-menu').click();
    await page.locator('[data-list-kind="dash"]').click();
    await expect(editor).toHaveText('– Erstens\n    – Unterpunkt\n– Zweitens');
    await page.keyboard.press('Meta+Enter');
    await expect(textObject(page, '– Erstens')).toHaveAttribute('data-text', '– Erstens\n    – Unterpunkt\n– Zweitens');

    // Text aus dem PDF: Zeile bekommt einen Punkt davor
    const line = textObject(page, 'Ein PDF besteht aus Objekten');
    await line.dblclick();
    await expect(editor).toBeFocused();
    await page.getByTestId('list-bullets').click();
    await expect(editor).toHaveValue(/^• Ein PDF besteht aus Objekten/);
    await page.keyboard.press('Enter');
    await expect(textObject(page, '• Ein PDF besteht')).toBeVisible();
    await close();
  });

  test('Fließtext: neue Größe ohne Auswahl gilt nur für das danach Geschriebene, wie in Word', async () => {
    const { page, close } = await openActualSize();
    await page.getByTestId('content-tool-flow').click();
    const overlay = await page.getByTestId('content-edit-overlay-0').boundingBox();
    if (!overlay) throw new Error('keine Ebene');
    await page.mouse.click(overlay.x + 200, overlay.y + 420);
    const editor = page.getByTestId('content-text-editor');
    await page.keyboard.type('Kleiner Anfang');
    // Größe ohne Auswahl: die Leiste zeigt sie, der geschriebene Text bleibt klein
    await page.getByTestId('content-size').fill('24');
    await page.getByTestId('content-size').press('Enter');
    await expect(page.getByTestId('content-size')).toHaveValue('24');
    await expect(editor.locator('span')).toHaveCount(1);
    await expect(editor.locator('span').first()).toHaveCSS('font-size', '16px');
    await page.keyboard.type(' und großes Ende');
    await expect(editor.locator('span')).toHaveCount(2);
    await expect(editor.locator('span').nth(1)).toHaveText(' und großes Ende');
    await expect(editor.locator('span').nth(1)).toHaveCSS('font-size', '32px');
    await page.keyboard.press('Meta+Enter');
    await expect(editor).toHaveCount(0);

    // Im Dokument: ein Text mit zwei Größen; beim erneuten Bearbeiten sind sie wieder da
    const placed = textObject(page, 'Kleiner Anfang und großes Ende');
    await expect(placed).toBeVisible();
    await placed.dblclick();
    await expect(editor.locator('span')).toHaveCount(2);
    await expect(editor.locator('span').first()).toHaveText('Kleiner Anfang');
    await expect(editor.locator('span').first()).toHaveCSS('font-size', '16px');
    await expect(editor.locator('span').nth(1)).toHaveCSS('font-size', '32px');
    // Ein Wort auswählen und rot färben: nur dieses ändert sich
    // Zeilenanfang: unter macOS Cmd+Pfeil links (Pos1 blättert dort nur)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home');
    await page.keyboard.down('Shift');
    for (let i = 0; i < 'Kleiner'.length; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');
    await page.getByTestId('content-color-red').click();
    await expect(editor.locator('span')).toHaveCount(3);
    await expect(editor.locator('span').first()).toHaveText('Kleiner');
    await expect(editor.locator('span').first()).not.toHaveCSS('color', 'rgb(0, 0, 0)');
    await page.keyboard.press('Meta+Enter');
    await expect(editor).toHaveCount(0);
    await textObject(page, 'Kleiner Anfang').dblclick();
    await expect(editor.locator('span')).toHaveCount(3);
    await expect(editor.locator('span').nth(2)).toHaveCSS('font-size', '32px');
    await page.keyboard.press('Escape');
    await close();
  });
});

test.describe('Mehrfachauswahl', () => {
  test('Umschalt-Klick und Auswahlrechteck: gemeinsam verschieben und löschen', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'mehrere.pdf');
    copyFileSync(fixture('text.pdf'), file);
    const { page, app, close } = await launchApp([file], { userData: dir });
    await waitForDocument(page, TEXT_PDF.pages);
    await page.getByTestId('content-edit-button').click();
    await menuClick(app, 'view.fitPage');
    const object = (text: string) => page.locator(`[data-testid="content-object"][data-text^="${text}"]`).first();
    const selectedCount = () => page.locator('[data-testid="content-object"][data-selected]').count();

    // Zwei Zeilen: Klick, dann Umschalt-Klick
    await object('Inhaltsverzeichnis').click();
    await object('Externer Link').click({ modifiers: ['Shift'] });
    expect(await selectedCount()).toBe(2);
    // Mehrfachauswahl ohne Anfasser
    await expect(page.locator('[data-handle]')).toHaveCount(0);
    const before = [await object('Inhaltsverzeichnis').boundingBox(), await object('Externer Link').boundingBox()];
    const start = before[0];
    if (!start || !before[1]) throw new Error('Zeilen fehlen');
    await page.mouse.move(start.x + 5, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + 45, start.y + start.height / 2, { steps: 4 });
    await page.mouse.move(start.x + 85, start.y + start.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await object('Inhaltsverzeichnis').boundingBox())?.x ?? 0).toBeGreaterThan(start.x + 60);
    await expect.poll(async () => (await object('Externer Link').boundingBox())?.x ?? 0).toBeGreaterThan((before[1]?.x ?? 0) + 60);
    // Umschalt-Klick nimmt eine heraus
    await object('Externer Link').click({ modifiers: ['Shift'] });
    expect(await selectedCount()).toBe(1);

    // Auswahlrechteck über Überschrift und Kapitelblock (ein Absatz), dann beide löschen
    await page.keyboard.press('Escape');
    const heading = await object('Inhaltsverzeichnis').boundingBox();
    const chapters = await object('Kapitel 1').boundingBox();
    if (!heading || !chapters) throw new Error('Inhaltsverzeichnis fehlt');
    const left = Math.min(heading.x, chapters.x) - 8;
    await page.mouse.move(left, heading.y - 4);
    await page.mouse.down();
    await page.mouse.move(left + 20, chapters.y, { steps: 4 });
    await expect(page.getByTestId('content-marquee')).toBeVisible();
    // Wie in anderen Programmen: durchscheinend, nicht schwarz gefüllt
    await expect(page.getByTestId('content-marquee')).not.toHaveCSS('fill', 'rgb(0, 0, 0)');
    if (process.env.BLATTWERK_SHOT) {
      await page.mouse.move(Math.max(heading.x, chapters.x) + 120, chapters.y + chapters.height / 2, { steps: 2 });
      await page.screenshot({ path: path.resolve('.tools/shots/auswahlrechteck.png') });
    }
    await page.mouse.move(Math.max(heading.x, chapters.x) + 20, chapters.y + chapters.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(selectedCount).toBe(2);
    await page.keyboard.press('Backspace');
    await expect(object('Kapitel 1')).toHaveCount(0);
    await expect(object('Inhaltsverzeichnis')).toHaveCount(0);
    await expect(object('Externer Link')).toBeVisible();
    await close();
  });
});

test.describe('Leeres Dokument', () => {
  test('auf der Startseite anlegen, beschreiben, Sichern fragt nach Ort und Namen', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'Notiz.pdf');
    const { page, app, close } = await launchApp([], { userData: dir });
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
    }, target);
    await page.getByTestId('start-blank').click();
    await waitForDocument(page, 1);
    await expect(page.getByTestId('tab')).toContainText('Unbenannt');
    // Gleich im Modus „Text und Bilder bearbeiten“
    await expect(page.getByTestId('content-edit-toolbar')).toBeVisible();
    await page.getByTestId('content-tool-text').click();
    const overlay = await page.getByTestId('content-edit-overlay-0').boundingBox();
    if (!overlay) throw new Error('keine Ebene');
    await page.mouse.click(overlay.x + overlay.width * 0.3, overlay.y + 120);
    await expect(page.getByTestId('content-text-editor')).toBeVisible();
    await page.keyboard.type('Erste Zeile im neuen Dokument');
    await page.keyboard.press('Meta+Enter');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    // Sichern (nicht „Sichern unter“): fragt trotzdem nach dem Ort
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    await expect(page.getByTestId('tab')).toContainText('Notiz.pdf');
    const [text] = await pageTexts(target);
    expect(text).toContain('Erste Zeile im neuen Dokument');
    if (process.platform === 'darwin') expect(inspectWithPdfKit(target).ok).toBe(true);
    // Danach normales Dokument: Sichern schreibt ohne Rückfrage in dieselbe Datei
    await waitForDocument(page, 1);
    await close();
  });
});

test.describe('Fließtext', () => {
  test('wie in einer Textverarbeitung schreiben: Umbruch am Rand, Absätze, Überlauf auf eine neue Seite', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'Brief.pdf');
    const { page, app, close } = await launchApp([], { userData: dir });
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
    }, target);
    await page.getByTestId('start-blank').click();
    await waitForDocument(page, 1);
    await page.getByTestId('content-tool-flow').click();
    const overlay = await page.getByTestId('content-edit-overlay-0').boundingBox();
    if (!overlay) throw new Error('keine Ebene');
    // Klick mitten in die Seite: die Eingabe beginnt trotzdem am linken Rand und reicht bis zum rechten
    await page.mouse.click(overlay.x + overlay.width * 0.6, overlay.y + 140);
    const editor = page.getByTestId('content-text-editor');
    await expect(editor).toBeVisible();
    const box = await editor.boundingBox();
    if (!box) throw new Error('keine Eingabe');
    expect(box.x - overlay.x).toBeLessThan(overlay.width * 0.15);
    expect(box.width).toBeGreaterThan(overlay.width * 0.7);
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Absatz ${i + 1}: Dieser Text ist lang genug, damit er am rechten Seitenrand von selbst in die nächste Zeile umbricht.`);
    await editor.fill(paragraphs.join('\n'));
    // Klick daneben übernimmt den Text
    await page.mouse.click(overlay.x + 10, overlay.y + 10);
    await waitForDocument(page, 2);
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    const texts = await pageTexts(target);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('Absatz 1:');
    expect(texts[1]).toContain('Absatz 30:');
    if (process.platform === 'darwin') expect(inspectWithPdfKit(target).ok).toBe(true);
    await waitForDocument(page, 2);
    await close();
  });
});

test.describe('Schriften des Rechners', () => {
  test('Arial aus der Liste wählen, schreiben, eingebettet speichern', async () => {
    test.skip(process.platform !== 'darwin' || !existsSync('/System/Library/Fonts/Supplemental/Arial.ttf'), 'Arial fehlt');
    const dir = tempDir();
    const target = path.join(dir, 'Arial.pdf');
    const { page, app, close } = await launchApp([], { userData: dir });
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
    }, target);
    await page.getByTestId('start-blank').click();
    await waitForDocument(page, 1);
    const select = page.getByTestId('content-font');
    await expect(select.locator('option[value="sys:arial:regular"]')).toHaveCount(1);
    await expect(select.locator('option[value="sys:times-new-roman:bold"]')).toHaveText('Times New Roman Fett');
    await select.selectOption('sys:arial:regular');
    await page.getByTestId('content-tool-text').click();
    const overlay = await page.getByTestId('content-edit-overlay-0').boundingBox();
    if (!overlay) throw new Error('keine Ebene');
    await page.mouse.click(overlay.x + overlay.width * 0.2, overlay.y + 120);
    await expect(page.getByTestId('content-text-editor')).toHaveCSS('font-family', /Blattwerk sys:arial:regular/);
    await page.keyboard.type('Grüße in Arial – Łódź');
    await expect(page.getByTestId('content-font-warning')).toHaveCount(0);
    await page.keyboard.press('Meta+Enter');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    const [text] = await pageTexts(target);
    expect(text).toContain('Grüße in Arial – Łódź');
    expect(readFileSync(target).toString('latin1')).toMatch(/\/BaseFont\s*\/[A-Z]*\+?Arial/);
    if (process.platform === 'darwin') expect(inspectWithPdfKit(target).ok).toBe(true);
    await waitForDocument(page, 1);
    await close();
  });
});

test.describe('Verschieben mit Live-Vorschau', () => {
  test('beim Ziehen wandert das Abbild mit, die alte Stelle ist abgedeckt', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'ziehen.pdf');
    copyFileSync(fixture('text.pdf'), file);
    const { page, close } = await launchApp([file], { userData: dir });
    await waitForDocument(page, TEXT_PDF.pages);
    await page.getByTestId('content-edit-button').click();
    const heading = page.locator('[data-testid="content-object"][data-text="Inhaltsverzeichnis"]').first();
    const before = await heading.boundingBox();
    if (!before) throw new Error('Zeile fehlt');
    await page.mouse.move(before.x + 10, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 60, before.y + before.height / 2 + 20, { steps: 4 });
    await page.mouse.move(before.x + 110, before.y + before.height / 2 + 40, { steps: 4 });
    // Noch nicht losgelassen: das Abbild steht schon an der neuen Stelle
    const ghost = page.getByTestId('content-ghost');
    await expect(ghost).toHaveCount(1);
    const moved = await ghost.boundingBox();
    expect((moved?.x ?? 0) - before.x).toBeGreaterThan(90);
    expect((moved?.y ?? 0) - before.y).toBeGreaterThan(30);
    expect(await ghost.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    if (process.env.BLATTWERK_SHOT) await page.screenshot({ path: path.resolve('.tools/shots/verschieben-live.png') });
    await page.mouse.up();
    // Nach dem Loslassen steht die Zeile dort, wo das Abbild war
    await expect.poll(async () => ((await heading.boundingBox())?.x ?? 0) - before.x).toBeGreaterThan(90);
    await close();
  });
});

test.describe('Farbauswahl', () => {
  test('Palette, Farbcode, Favoriten hinzufügen und entfernen, Favoriten bleiben nach Neustart', async () => {
    const dir = tempDir();
    const first = await launchApp([], { userData: dir, keepUserData: true });
    await first.page.getByTestId('start-blank').click();
    await waitForDocument(first.page, 1);
    const panel = first.page.getByTestId('content-color-panel');
    await first.page.getByTestId('content-color-more').click();
    await expect(panel).toBeVisible();
    // 12 Graustufen + 7 · 12 Farben
    await expect(panel.getByTestId('content-color-palette')).toHaveCount(96);
    await panel.getByTestId('content-color-palette').nth(12 * 4 + 8).click();
    await expect(panel.getByTestId('content-color-palette').nth(12 * 4 + 8)).toHaveAttribute('aria-checked', 'true');
    // Farbcode eintippen
    await panel.getByTestId('content-color-hex').fill('#1f6b4e');
    await panel.getByTestId('content-color-hex').press('Enter');
    await expect(panel.getByTestId('content-color-hex')).toHaveValue('#1F6B4E');
    await panel.getByTestId('content-color-add').click();
    await expect(panel.getByTestId('content-color-add')).toBeDisabled();
    await first.page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    // Neuer Favorit steht in der Leiste und ist gewählt
    const favorite = first.page.getByTestId('content-color-fav-4');
    await expect(favorite).toHaveAttribute('aria-checked', 'true');
    await first.close();

    const second = await launchApp([], { userData: dir });
    await second.page.getByTestId('start-blank').click();
    await waitForDocument(second.page, 1);
    await expect(second.page.getByTestId('content-color-fav-4')).toHaveAttribute('aria-label', '#1F6B4E');
    // Entfernen im Feld
    await second.page.getByTestId('content-color-more').click();
    await second.page.getByTestId('content-color-remove').nth(4).click({ force: true });
    await expect(second.page.getByTestId('content-color-fav-4')).toHaveCount(0);
    if (process.env.BLATTWERK_SHOT) {
      await second.page.getByTestId('content-color-panel').getByTestId('content-color-palette').nth(12 * 2 + 3).hover();
      await second.page.waitForTimeout(400);
      await second.page.screenshot({ path: path.resolve('.tools/shots/farbauswahl.png') });
    }
    await second.close();
  });
});

test('Auswahlrahmen beginnt neben der Seite und wählt die berührten Objekte', async () => {
  const { page, app, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  await page.getByTestId('content-edit-button').click();
  await menuClick(app, 'view.fitPage');
  const overlay = page.getByTestId('content-edit-overlay-0');
  await expect(overlay).toBeVisible();
  const heading = page.locator('[data-testid="content-edit-overlay-0"] [data-testid="content-object"][data-text="Inhaltsverzeichnis"]').first();
  const box = await heading.boundingBox();
  const sheet = await overlay.boundingBox();
  if (!box || !sheet) throw new Error('Zeile fehlt');
  // Start links neben der Seite, auf Höhe knapp über der Zeile, bis über ihre Mitte
  const start = { x: sheet.x - 15, y: box.y - 4 };
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.page')), start)).toBe(false);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 4, { steps: 6 });
  await expect(page.getByTestId('content-marquee-outside')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('content-marquee-outside')).toHaveCount(0);
  await expect(heading).toHaveAttribute('data-selected', 'true');
  // Ein einfacher Klick neben die Seite hebt die Auswahl wieder auf
  await page.mouse.click(start.x, start.y);
  await expect(heading).not.toHaveAttribute('data-selected', 'true');
  await close();
});

test.describe('Löschen im Modus „Inhalt bearbeiten“', () => {
  // Wie aus dem Browser gedruckt: jedes Zeichen ein eigenes Textobjekt, Leerzeichen eingeschlossen; dazu eine Tabelle
  async function browserLikePdf(file: string): Promise<void> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 500]);
    const chars = (text: string, y: number) => {
      let x = 40;
      for (const char of text) {
        page.drawText(char, { x, y, size: 12, font });
        x += font.widthOfTextAtSize(char, 12);
      }
    };
    chars('Erste Zeile, mit Komma', 440);
    chars('Zweite Zeile, auch so', 422);
    page.drawRectangle({ x: 40, y: 380, width: 200, height: 18, color: rgb(0.85, 0.85, 0.85) });
    page.drawLine({ start: { x: 40, y: 360 }, end: { x: 240, y: 360 }, thickness: 0.5 });
    page.drawText('Bleibt stehen', { x: 40, y: 330, size: 12, font });
    writeFileSync(file, await doc.save());
  }

  test('Auswahlrechteck löscht Text samt Kommas, Leerzeichen und Tabellenlinien; Darunterstehendes rückt nach', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'browser.pdf');
    await browserLikePdf(file);
    const { page, app, close } = await launchApp([file], { userData: dir });
    await waitForDocument(page, 1);
    await page.getByTestId('content-edit-button').click();
    await menuClick(app, 'view.fitPage');
    const overlay = '[data-testid="content-edit-overlay-0"]';
    const objects = page.locator(`${overlay} [data-testid="content-object"]`);
    const below = page.locator(`${overlay} [data-testid="content-object"][data-text="Bleibt stehen"]`);
    // Kommas und Leerzeichen gehören zur Zeile (beide Zeilen bilden einen Absatz); Linien und Flächen sind eigene Objekte
    await expect(page.locator(`${overlay} [data-testid="content-object"][data-text="Erste Zeile, mit Komma Zweite Zeile, auch so"]`)).toHaveCount(1);
    await expect(page.locator(`${overlay} [data-testid="content-object"][data-kind="path"]`)).toHaveCount(2);
    await expect(objects).toHaveCount(4);

    const first = await page.locator(`${overlay} [data-testid="content-object"][data-text^="Erste"]`).boundingBox();
    const line = await page.locator(`${overlay} [data-testid="content-object"][data-kind="path"]`).last().boundingBox();
    const before = await below.boundingBox();
    if (!first || !line || !before) throw new Error('Objekte fehlen');
    // Rahmen um beide Zeilen und die Tabelle (umschließt die Linien ganz)
    await page.mouse.move(first.x - 6, first.y - 6);
    await page.mouse.down();
    await page.mouse.move(line.x + line.width + 6, line.y + line.height + 4, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator(`${overlay} [data-testid="content-object"][data-selected]`)).toHaveCount(3);
    await page.keyboard.press('Backspace');
    await waitForDocument(page, 1);
    // Nichts bleibt zurück, die Zeile darunter steht jetzt oben, wo die erste Zeile begann
    await expect(objects).toHaveCount(1);
    await expect.poll(async () => Math.round(((await below.boundingBox())?.y ?? 0) - first.y)).toBeLessThan(4);
    expect((await below.boundingBox())?.y ?? 0).toBeLessThan(before.y - 50);

    // Ohne Nachrücken (Einstellung aus) bleibt sie an ihrem Platz
    await menuClick(app, 'edit.undo');
    await waitForDocument(page, 1);
    await expect(objects).toHaveCount(4);
    await menuClick(app, 'app.settings');
    await page.getByTestId('settings-close-gaps').uncheck();
    await page.getByTestId('settings-save').click();
    await page.mouse.move(first.x - 6, first.y - 6);
    await page.mouse.down();
    await page.mouse.move(line.x + line.width + 6, line.y + line.height + 4, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.press('Backspace');
    await waitForDocument(page, 1);
    await expect(objects).toHaveCount(1);
    expect(Math.abs(((await below.boundingBox())?.y ?? 0) - before.y)).toBeLessThan(2);
    await close();
  });
});
