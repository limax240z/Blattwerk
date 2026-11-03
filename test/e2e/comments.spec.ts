// Phase 2: Kommentieren. Alle Tests arbeiten auf Kopien der Test-PDFs in einem temporären Ordner.
import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { COMMENTS_PDF, fixture, imageFixture, TEXT_PDF } from '../fixtures/expectations';
import { launchApp, menuClick, removeTempDir, waitForDocument, type AppHandle } from './app';
import { inspectWithPdfKit } from './pdfkit';

// Temporäre Ordner mit den Kopien; werden erst am Ende gelöscht, damit gespeicherte Dateien neu geöffnet werden können.
const tempDirs: string[] = [];
test.afterAll(() => {
  for (const dir of tempDirs) removeTempDir(dir);
});

// Startet die App mit einer Kopie des Test-PDFs und blendet Kommentarliste und Werkzeuge ein.
async function openCopy(name: string, pages: number): Promise<AppHandle & { file: string }> {
  const userData = mkdtempSync(path.join(tmpdir(), 'blattwerk-e2e-'));
  tempDirs.push(userData);
  const file = path.join(userData, `kopie-${name}`);
  copyFileSync(fixture(name), file);
  const handle = await launchApp([file], { userData });
  await waitForDocument(handle.page, pages);
  await handle.page.getByTestId('sidebar-comments').click();
  await handle.page.getByTestId('comment-tools-button').click();
  await expect(handle.page.getByTestId('comment-toolbar')).toBeVisible();
  // Ganze Seite sichtbar, damit alle Stellen der Seite im Fenster liegen
  await menuClick(handle.app, 'view.fitPage');
  await expect(handle.page.getByTestId('zoom-select')).toHaveValue('page-fit');
  return { ...handle, file };
}

// Liefert eine Umrechnung von PDF-Punkten (A4, Ursprung oben links wie im Bild) in Fensterkoordinaten.
async function pageSpace(page: Page, pageIndex = 0) {
  const overlay = page.getByTestId(`annotation-overlay-${pageIndex}`);
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  if (!box) throw new Error('Kommentarebene ohne Größe');
  return (x: number, y: number) => ({ x: box.x + (x / 595.28) * box.width, y: box.y + (y / 841.89) * box.height });
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

// Wählt den Text eines Textebenen-Abschnitts mit der Maus aus.
async function selectText(page: Page, text: string) {
  const span = page.locator('[data-page-number="1"] .textLayer span', { hasText: text }).first();
  const box = await span.boundingBox();
  if (!box) throw new Error(`Text „${text}“ nicht gefunden`);
  await drag(page, { x: box.x + 1, y: box.y + box.height / 2 }, { x: box.x + box.width - 1, y: box.y + box.height / 2 });
}

const cards = (page: Page) => page.getByTestId('comment-card');

async function save(page: Page, app: AppHandle['app']) {
  await menuClick(app, 'file.save');
  await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
  await expect(page.getByTestId('comments-panel')).toBeVisible();
}

// Farbe eines Pixels im Seitenbild von pdf.js an einer Stelle in PDF-Punkten (ungedrehte A4-Seite).
async function canvasPixel(page: Page, pageNumber: number, pdfX: number, pdfY: number): Promise<number[]> {
  return page.evaluate(
    ({ pageNumber, pdfX, pdfY }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid="active-pane"] .page[data-page-number="${pageNumber}"] canvas`);
      if (!canvas) return [];
      const x = Math.round((pdfX / 595.28) * canvas.width);
      const y = Math.round(((841.89 - pdfY) / 841.89) * canvas.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      return Array.from(context?.getImageData(x, y, 1, 1).data ?? []);
    },
    { pageNumber, pdfX, pdfY },
  );
}

test.describe('Kommentieren', () => {
  test('zeigt vorhandene Kommentare mit Antworten und Prüfstatus', async () => {
    const { page, close } = await launchApp([fixture(COMMENTS_PDF.file)]);
    await waitForDocument(page, COMMENTS_PDF.pages);
    await page.getByTestId('sidebar-comments').click();
    await expect(cards(page)).toHaveCount(COMMENTS_PDF.comments);
    const note = cards(page).filter({ hasText: COMMENTS_PDF.noteText });
    await expect(note.getByTestId('comment-reply')).toHaveCount(1);
    await expect(note.getByTestId('comment-reply')).toContainText(COMMENTS_PDF.replyText);
    await expect(note.getByTestId('comment-status-badge')).toHaveText(COMMENTS_PDF.status);
    // Klick in der Liste springt zur Seite des Kommentars
    await cards(page).last().click();
    await expect(page.getByTestId('page-input')).toHaveValue('2');
    await close();
  });

  test('legt alle Kommentararten an, speichert inkrementell und öffnet sie wieder', async () => {
    const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
    const { page, app, file } = handle;
    const original = readFileSync(file);
    const at = await pageSpace(page);

    // Textmarkierungen aus der Textauswahl
    await page.getByTestId('tool-highlight').click();
    await selectText(page, 'Testdokument für Blattwerk');
    await page.getByTestId('tool-underline').click();
    await selectText(page, 'Die Umlaute');
    // Erst Text auswählen, dann Werkzeug wählen: markiert sofort
    await page.getByTestId('tool-select').click();
    await selectText(page, 'Ein PDF besteht');
    await page.getByTestId('tool-strikeout').click();
    await expect(cards(page)).toHaveCount(3);

    await page.getByTestId('tool-note').click();
    await page.mouse.click(at(540, 100).x, at(540, 100).y);
    await expect(page.getByTestId('comment-text')).toBeFocused();
    await page.keyboard.type('Meine Notiz mit Umlauten: äöü');
    await page.getByTestId('tool-freetext').click();
    await drag(page, at(60, 480), at(300, 520));
    await expect(page.getByTestId('freetext-editor')).toBeFocused();
    await page.keyboard.type('Hallo Textfeld');
    await page.keyboard.press('Escape');

    await page.getByTestId('tool-ink').click();
    await page.mouse.move(at(60, 560).x, at(60, 560).y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(at(60 + i * 15, 560 + (i % 2) * 20).x, at(60 + i * 15, 560 + (i % 2) * 20).y);
    await page.mouse.up();

    await page.getByTestId('tool-square').click();
    await drag(page, at(330, 480), at(440, 560));
    await page.getByTestId('tool-circle').click();
    await drag(page, at(460, 480), at(560, 560));
    await page.getByTestId('tool-line').click();
    await drag(page, at(60, 620), at(250, 620));
    await page.getByTestId('tool-arrow').click();
    await drag(page, at(280, 660), at(450, 610));
    await page.getByTestId('tool-stamp').click();
    await page.getByTestId('stamp-select').selectOption('final');
    await page.mouse.click(at(450, 720).x, at(450, 720).y);

    await expect(cards(page)).toHaveCount(11);
    await expect(cards(page).filter({ hasText: 'ENDGÜLTIG' })).toHaveCount(1);
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    await save(page, app);
    await expect(cards(page)).toHaveCount(11);

    // Inkrementell gespeichert: Die alte Datei steht unverändert am Anfang der neuen.
    const saved = readFileSync(file);
    expect(saved.length).toBeGreaterThan(original.length);
    expect(saved.subarray(0, original.length).equals(original)).toBe(true);
    await handle.close();

    // Apple PDFKit (Vorschau) erkennt alle Kommentare
    if (process.platform === 'darwin') {
      const result = inspectWithPdfKit(file);
      expect(result.ok).toBe(true);
      const types = (result.pages[0] ?? []).filter((type) => type !== 'Link').sort();
      expect(types).toEqual(
        ['Circle', 'FreeText', 'Highlight', 'Ink', 'Line', 'Line', 'Square', 'Stamp', 'StrikeOut', 'Text', 'Underline'].sort(),
      );
    }

    // Frisch geöffnet: alle Kommentare mit Text und Verfasser
    const again = await launchApp([file]);
    await waitForDocument(again.page, TEXT_PDF.pages);
    await again.page.getByTestId('sidebar-comments').click();
    await expect(cards(again.page)).toHaveCount(11);
    await expect(cards(again.page).filter({ hasText: 'Meine Notiz mit Umlauten: äöü' })).toHaveCount(1);
    await expect(cards(again.page).filter({ hasText: 'Hallo Textfeld' })).toHaveCount(1);
    await expect(cards(again.page).filter({ hasText: 'Stempel' })).toHaveCount(1);
    await again.close();
  });

  test('Widerrufen und Wiederholen', async () => {
    const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
    const { page, app } = handle;
    const at = await pageSpace(page);
    await page.getByTestId('tool-square').click();
    await drag(page, at(80, 600), at(200, 680));
    await expect(cards(page)).toHaveCount(1);
    await menuClick(app, 'edit.undo');
    await expect(cards(page)).toHaveCount(0);
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    await menuClick(app, 'edit.redo');
    await expect(cards(page)).toHaveCount(1);
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    // Löschen per Taste und wieder zurückholen
    await cards(page).first().click();
    await page.getByTestId('viewer-container').focus();
    await page.keyboard.press('Backspace');
    await expect(cards(page)).toHaveCount(0);
    await page.getByTestId('comment-undo').click();
    await expect(cards(page)).toHaveCount(1);
    await handle.close();
  });

  test('Stift: Punkt per Klick, Linienart und Linienstärke, auch nachträglich ändern', async () => {
    const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
    const { page } = handle;
    const at = await pageSpace(page);
    const shapes = page.getByTestId('annotation-overlay-0').locator('g[stroke-linecap="round"]');
    await page.getByTestId('tool-ink').click();

    // Ein Klick ohne Ziehen setzt einen Punkt
    await page.getByTestId('width-select').selectOption('12');
    const spot = at(150, 500);
    await page.mouse.click(spot.x, spot.y);
    await expect(cards(page)).toHaveCount(1);
    await expect(shapes.first()).toHaveAttribute('stroke-width', '12');
    await expect(shapes.first()).not.toHaveAttribute('stroke-dasharray', /.+/);

    // Gepunktete und gestrichelte Linie. Die frisch gezeichnete Zeichnung ist ausgewählt und würde die Einstellung
    // übernehmen; darum vorher die Auswahl aufheben (Auswahlwerkzeug, dann wieder Stift).
    const deselect = async () => {
      await page.getByTestId('tool-select').click();
      await page.getByTestId('tool-ink').click();
    };
    await deselect();
    await page.getByTestId('width-select').selectOption('2');
    await page.getByTestId('dash-select').selectOption('dotted');
    await drag(page, at(100, 600), at(400, 600));
    await expect(cards(page)).toHaveCount(2);
    await expect(shapes.nth(1)).toHaveAttribute('stroke-dasharray', /^0\.001 4$/);
    await deselect();
    await page.getByTestId('dash-select').selectOption('dashed');
    await drag(page, at(100, 650), at(400, 650));
    await expect(cards(page)).toHaveCount(3);
    await expect(shapes.nth(2)).toHaveAttribute('stroke-dasharray', '6 6');

    // Die frisch gezeichnete (ausgewählte) Zeichnung nachträglich umstellen
    await page.getByTestId('dash-select').selectOption('solid');
    await expect(shapes.nth(2)).not.toHaveAttribute('stroke-dasharray', /.+/);
    await handle.close();
  });

  test('Radierer: Strich, Pixel und Textmarker, jeweils ein Schritt zum Widerrufen', async () => {
    const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
    const { page } = handle;
    const at = await pageSpace(page);
    const strokes = page.getByTestId('annotation-overlay-0').locator('polyline');
    // Waagerechter Strich mit dem Stift
    await page.getByTestId('tool-ink').click();
    await drag(page, at(100, 600), at(400, 600));
    await expect(cards(page)).toHaveCount(1);
    const single = await strokes.count();

    // Strich-Radierer: einmal darüber, der ganze Strich ist weg; Widerrufen holt ihn zurück
    await page.getByTestId('tool-eraser').click();
    await page.getByTestId('eraser-stroke').click();
    await drag(page, at(250, 560), at(250, 640));
    await expect(cards(page)).toHaveCount(0);
    await page.getByTestId('comment-undo').click();
    await expect(cards(page)).toHaveCount(1);

    // Pixel-Radierer: quer durch die Mitte teilt den Strich in zwei, der Kommentar bleibt
    await page.getByTestId('eraser-pixel').click();
    await drag(page, at(250, 560), at(250, 640));
    await expect(cards(page)).toHaveCount(1);
    await expect(strokes).toHaveCount(single * 2);
    await page.getByTestId('comment-undo').click();
    await expect(strokes).toHaveCount(single);

    // Textmarker-Radierer lässt deckende Striche stehen
    await page.getByTestId('eraser-highlighter').click();
    await drag(page, at(250, 560), at(250, 640));
    await expect(cards(page)).toHaveCount(1);
    await handle.close();
  });

  test('verschiebt Kommentare und ändert ihre Größe', async () => {
    const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
    const { page } = handle;
    const at = await pageSpace(page);
    await page.getByTestId('tool-square').click();
    await drag(page, at(80, 600), at(200, 680));
    const hit = page.locator('[data-annotation-hit]').first();
    const before = await hit.boundingBox();
    if (!before) throw new Error('Kein Rechteck');
    // Am Rand anfassen (Rahmen ohne Füllung reagiert nur auf den Strich)
    await drag(page, { x: before.x + 2, y: before.y + before.height / 2 }, { x: before.x + 102, y: before.y + before.height / 2 + 50 });
    await expect.poll(async () => (await hit.boundingBox())?.x).toBeCloseTo(before.x + 100, 0);
    const moved = await hit.boundingBox();
    if (!moved) throw new Error('Rechteck verschwunden');
    expect(moved.y).toBeCloseTo(before.y + 50, 0);
    // Größe ändern über den Griff unten rechts
    const handleBox = await page.locator('[data-handle="corner-1"]').boundingBox();
    if (!handleBox) throw new Error('Kein Griff');
    const grip = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
    await drag(page, grip, { x: grip.x + 60, y: grip.y + 40 });
    await expect.poll(async () => (await hit.boundingBox())?.width).toBeCloseTo(moved.width + 60, 0);
    await page.getByTestId('comment-undo').click();
    await expect.poll(async () => (await hit.boundingBox())?.width).toBeCloseTo(moved.width, 0);
    await handle.close();
  });

  test('Textfeld per Doppelklick weiter bearbeiten', async () => {
    const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
    const { page } = handle;
    const at = await pageSpace(page);
    await page.getByTestId('tool-freetext').click();
    await drag(page, at(60, 600), at(300, 640));
    await page.keyboard.type('Erster Teil');
    await page.keyboard.press('Escape');
    await expect(cards(page)).toContainText('Erster Teil');
    await page.mouse.dblclick(at(120, 615).x, at(120, 615).y);
    await expect(page.getByTestId('freetext-editor')).toBeFocused();
    await page.keyboard.type(', zweiter Teil');
    await page.keyboard.press('Escape');
    await expect(cards(page)).toContainText('Erster Teil, zweiter Teil');
    // Ein neues Textfeld ohne Text verschwindet wieder
    await page.getByTestId('tool-freetext').click();
    await drag(page, at(320, 600), at(500, 640));
    await page.keyboard.press('Escape');
    await expect(cards(page)).toHaveCount(1);
    await handle.close();
  });

  test('gesperrte Dokumente: Kommentieren ist nicht möglich', async () => {
    const { page, close } = await launchApp([fixture('eingeschraenkt.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await page.getByTestId('comment-tools-button').click();
    await expect(page.getByTestId('comments-not-allowed')).toBeVisible();
    await expect(page.getByTestId('tool-square')).toBeDisabled();
    await expect(page.getByTestId('tool-select')).toBeEnabled();
    await close();
  });

  test('Antworten, Status und Löschen vorhandener Kommentare werden gespeichert', async () => {
    const handle = await openCopy(COMMENTS_PDF.file, COMMENTS_PDF.pages);
    const { page, app, file } = handle;
    await expect(cards(page)).toHaveCount(COMMENTS_PDF.comments);

    const note = cards(page).filter({ hasText: COMMENTS_PDF.noteText });
    await note.click();
    await note.getByTestId('comment-reply-input').fill('Neue Antwort');
    await note.getByTestId('comment-reply-input').press('Enter');
    await expect(note.getByTestId('comment-reply')).toHaveCount(2);
    await note.getByTestId('comment-status').selectOption('Completed');
    await expect(note.getByTestId('comment-status-badge')).toHaveText('Erledigt');

    // Vorhandenes Rechteck löschen: pdf.js zeichnet es danach nicht mehr.
    const { x, y } = COMMENTS_PDF.squareTopLeft;
    await expect.poll(async () => (await canvasPixel(page, 1, x + 30, y))[1]).toBeLessThan(100);
    const square = cards(page).filter({ hasText: COMMENTS_PDF.squareText });
    await square.click();
    await square.getByTestId('comment-card-delete').click();
    await expect(cards(page)).toHaveCount(COMMENTS_PDF.comments - 1);
    await expect.poll(async () => (await canvasPixel(page, 1, x + 30, y))[1]).toBeGreaterThan(200);

    await save(page, app);
    await handle.close();

    const again = await launchApp([file]);
    await waitForDocument(again.page, COMMENTS_PDF.pages);
    await again.page.getByTestId('sidebar-comments').click();
    await expect(cards(again.page)).toHaveCount(COMMENTS_PDF.comments - 1);
    const reopened = cards(again.page).filter({ hasText: COMMENTS_PDF.noteText });
    await expect(reopened.getByTestId('comment-reply')).toHaveCount(2);
    await expect(reopened.getByTestId('comment-reply').last()).toContainText('Neue Antwort');
    await expect(reopened.getByTestId('comment-status-badge')).toHaveText('Erledigt');
    await expect(cards(again.page).filter({ hasText: COMMENTS_PDF.squareText })).toHaveCount(0);
    await again.close();
  });

  test('fragt beim Schließen nach ungespeicherten Änderungen', async () => {
    const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
    const { page, app, file } = handle;
    const size = statSync(file).size;
    const at = await pageSpace(page);
    await page.getByTestId('tool-circle').click();
    await drag(page, at(80, 600), at(200, 680));

    await menuClick(app, 'file.close');
    await expect(page.getByTestId('prompt-unsaved')).toBeVisible();
    await page.getByTestId('prompt-cancel').click();
    await expect(page.getByTestId('tab')).toHaveCount(1);
    expect(statSync(file).size).toBe(size);

    await menuClick(app, 'file.close');
    await page.getByTestId('prompt-save').click();
    await expect(page.getByTestId('tab')).toHaveCount(0);
    expect(statSync(file).size).toBeGreaterThan(size);
    await handle.close();
  });

  test('fragt nach, wenn die Datei inzwischen von außen geändert wurde', async () => {
    const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
    const { page, app, file } = handle;
    const at = await pageSpace(page);
    await page.getByTestId('tool-square').click();
    await drag(page, at(80, 600), at(200, 680));
    // Ein anderes Programm hängt etwas an die Datei an
    const bytes = readFileSync(file);
    writeFileSync(file, Buffer.concat([bytes, Buffer.from('\n% von außen geändert\n')]));
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('prompt-changed')).toBeVisible();
    await page.getByTestId('prompt-overwrite').click();
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    expect(readFileSync(file).toString('latin1')).toMatch(/\/Subtype\s*\/Square/);
    await handle.close();
  });

  test('Speichern unter legt eine neue Datei an und lässt das Original unverändert', async () => {
    const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
    const { page, app, file } = handle;
    const original = readFileSync(file);
    const target = path.join(path.dirname(file), 'neu');
    // Den Sichern-Dialog des Systems im Hauptprozess ersetzen
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
    }, target);
    const at = await pageSpace(page);
    await page.getByTestId('tool-square').click();
    await drag(page, at(80, 600), at(200, 680));
    await menuClick(app, 'file.saveAs');
    await expect(page.getByTestId('tab')).toContainText('neu.pdf');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    expect(readFileSync(file).equals(original)).toBe(true);
    expect(readFileSync(`${target}.pdf`).toString('latin1')).toMatch(/\/Subtype\s*\/Square/);
    await handle.close();
  });

  test('Drucken mit ungespeicherten Kommentaren ändert die Datei nicht', async () => {
    const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
    const { page, file, printDir } = handle;
    const original = readFileSync(file);
    const at = await pageSpace(page);
    await page.getByTestId('tool-square').click();
    await drag(page, at(80, 600), at(200, 680));
    await page.getByTestId('print-button').click();
    await expect.poll(() => (existsSync(printDir) ? readdirSync(printDir).length : 0), { timeout: 60_000 }).toBe(1);
    await expect(page.getByTestId('print-progress')).toHaveCount(0);
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    expect(readFileSync(file).equals(original)).toBe(true);
    await handle.close();
  });

  test('Name für Kommentare in den Einstellungen', async () => {
    const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
    const { page, app } = handle;
    await menuClick(app, 'app.settings');
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await page.getByTestId('settings-author').fill('Testperson Zwei');
    await page.getByTestId('settings-save').click();
    const at = await pageSpace(page);
    await page.getByTestId('tool-note').click();
    await page.mouse.click(at(400, 600).x, at(400, 600).y);
    await expect(cards(page).first()).toContainText('Testperson Zwei');
    await handle.close();
  });
});

test.describe('Farbauswahl beim Kommentieren', () => {
  test('eigene Favoriten (Markerfarben) und große Auswahl', async () => {
    const handle = await launchApp([fixture('text.pdf')]);
    const { page, app } = handle;
    await waitForDocument(page, TEXT_PDF.pages);
    await menuClick(app, 'view.toggleCommentTools');
    await page.getByTestId('tool-ink').click();
    // Markerfarben als Favoriten, nicht die Textfarben
    await expect(page.getByTestId('color-yellow')).toHaveCount(1);
    await expect(page.getByTestId('color-gray')).toHaveCount(0);
    await page.getByTestId('color-more').click();
    const panel = page.getByTestId('color-panel');
    await expect(panel.getByTestId('color-palette')).toHaveCount(96);
    await panel.getByTestId('color-palette').nth(12 * 3 + 6).click();
    await panel.getByTestId('color-add').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('color-fav-7')).toHaveAttribute('aria-checked', 'true');
    await handle.close();
  });
});

test('Live-Text: Text im Scan auswählen und markieren, ohne die Datei zu ändern', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'blattwerk-e2e-'));
  tempDirs.push(userData);
  const file = path.join(userData, 'kopie-scan.pdf');
  copyFileSync(fixture('scan.pdf'), file);
  const before = readFileSync(file);
  const { page, close } = await launchApp([file], { userData });
  await waitForDocument(page, 1);
  await page.getByTestId('sidebar-comments').click();

  // Die Seite ist nur ein Bild; der erkannte Text erscheint im Hintergrund als eigene Textebene
  const word = page.locator('[data-page-number="1"] .textLayer[data-live-text] span', { hasText: 'Testdokument' }).first();
  await expect(word).toBeAttached({ timeout: 60_000 });

  // Normales Auswählen und Kopieren
  await selectText(page, 'Testdokument');
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Testdokument');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  // Markieren: Hervorhebung genau über dem Wort
  await page.getByTestId('highlight-button').click();
  await expect(page.getByTestId('mark-toolbar')).toBeVisible();
  await selectText(page, 'Testdokument');
  await expect(cards(page)).toHaveCount(1);
  const mark = page.getByTestId('annotation-overlay-0').locator('polygon').first();
  await expect(mark).toBeAttached();
  const wordBox = await word.boundingBox();
  const markBox = await mark.boundingBox();
  if (!wordBox || !markBox) throw new Error('Wort oder Markierung ohne Größe');
  expect(Math.abs(markBox.y - wordBox.y)).toBeLessThan(wordBox.height / 2);
  expect(Math.abs(markBox.x - wordBox.x)).toBeLessThan(wordBox.height);
  // Live-Text ändert die Datei nicht; die Markierung ist bis zum Speichern nur im Speicher
  expect(readFileSync(file).equals(before)).toBe(true);
  await close();
});

test('Hervorheben ohne Text darunter malt wie ein Textmarker', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'blattwerk-e2e-'));
  tempDirs.push(userData);
  const file = path.join(userData, 'kopie-marker.pdf');
  copyFileSync(fixture('text.pdf'), file);
  const { page, app, close } = await launchApp([file], { userData });
  await waitForDocument(page, TEXT_PDF.pages);
  await page.getByTestId('sidebar-comments').click();
  await menuClick(app, 'view.fitPage');
  await page.getByTestId('highlight-button').click();
  await expect(page.getByTestId('mark-toolbar')).toBeVisible();
  // Unten auf der Seite steht kein Text
  const at = await pageSpace(page);
  await drag(page, at(100, 760), at(400, 770));
  await expect(cards(page)).toHaveCount(1);
  const stroke = page.getByTestId('annotation-overlay-0').locator('g[stroke-linecap="round"]').first();
  await expect(stroke).toHaveAttribute('opacity', '0.4');
  await expect(stroke).toHaveAttribute('stroke-width', '12');
  await close();
});

test('Markieren: eigener Modus, Markierung auswählen, Farbe ändern, kürzen und löschen', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'blattwerk-e2e-'));
  tempDirs.push(userData);
  const file = path.join(userData, 'kopie-markieren.pdf');
  copyFileSync(fixture('text.pdf'), file);
  const { page, app, close } = await launchApp([file], { userData });
  await waitForDocument(page, TEXT_PDF.pages);
  await page.getByTestId('sidebar-comments').click();

  // Ohne den Modus bleibt Auswählen ein normales Auswählen
  await selectText(page, 'Testdokument für Blattwerk');
  await page.waitForTimeout(200);
  await expect(cards(page)).toHaveCount(0);

  // Modus „Markieren“: die schon ausgewählte Stelle wird gleich hervorgehoben, jede weitere Auswahl ebenso
  await page.getByTestId('highlight-button').click();
  await expect(page.getByTestId('mark-toolbar')).toBeVisible();
  await expect(page.getByTestId('mark-highlight')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByTestId('annotation-selection')).toHaveCount(0);
  await page.getByTestId('mark-underline').click();
  await selectText(page, 'Die Umlaute');
  await expect(cards(page)).toHaveCount(2);

  // Klick auf die erste Markierung wählt sie aus: andere Farbe, Anfasser an den Enden
  const span = page.locator('[data-page-number="1"] .textLayer span', { hasText: 'Testdokument für Blattwerk' }).first();
  const box = await span.boundingBox();
  if (!box) throw new Error('Text fehlt');
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  const frame = page.getByTestId('annotation-selection');
  await expect(frame).toBeVisible();
  await expect(cards(page)).toHaveCount(2);
  await expect(page.getByTestId('mark-delete')).toBeEnabled();
  await page.getByTestId('mark-color-more').click();
  await page.getByTestId('mark-color-palette').nth(30).click();
  await page.keyboard.press('Escape');
  await expect(cards(page)).toHaveCount(2);
  await expect(frame).toBeVisible();

  // Ende nach links ziehen: Markierung wird kürzer
  const before = await frame.locator('rect').first().boundingBox();
  const end = await page.locator('[data-handle="markup-end"]').boundingBox();
  if (!before || !end) throw new Error('Anfasser fehlt');
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(frame).toBeVisible();
  await expect.poll(async () => (await frame.locator('rect').first().boundingBox())?.width ?? before.width).toBeLessThan(before.width * 0.7);
  await page.waitForTimeout(300);
  await expect(cards(page)).toHaveCount(2);

  // Löschen
  await page.getByTestId('mark-delete').click();
  await expect(cards(page)).toHaveCount(1);
  await expect(frame).toHaveCount(0);

  await page.getByTestId('mark-done').click();
  await expect(page.getByTestId('mark-toolbar')).toHaveCount(0);
  await save(page, app);
  const saved = readFileSync(file).toString('latin1');
  expect((saved.match(/\/Subtype\s*\/Highlight/g) ?? []).length).toBe(0);
  expect((saved.match(/\/Subtype\s*\/Underline/g) ?? []).length).toBe(1);
  await close();
});

test('Rechteck mit Füllfarbe und halber Deckkraft: Leiste, Speichern und Datei', async () => {
  const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
  const { page, app } = handle;
  const at = await pageSpace(page);
  await page.getByTestId('tool-square').click();
  // Füllfarbe und Deckkraft gelten für das nächste Rechteck
  await page.getByTestId('fill-more').click();
  await page.getByTestId('fill-palette').nth(12 * 4 + 2).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('opacity-select').selectOption('0.5');
  await drag(page, at(80, 600), at(220, 690));
  const hit = page.locator('[data-annotation-hit]').first();
  await hit.click({ position: { x: 3, y: 10 } });
  await expect(page.getByTestId('opacity-select')).toHaveValue('0.5');
  await expect(page.getByTestId('fill-none')).toHaveAttribute('aria-pressed', 'false');
  // Am ausgewählten Rechteck: Deckkraft ändern
  await page.getByTestId('opacity-select').selectOption('0.75');
  await save(page, app);
  const { PDFDocument, PDFName, PDFArray, PDFNumber } = await import('@cantoo/pdf-lib');
  type Dict = { get: (name: unknown) => unknown };
  const doc = await PDFDocument.load(readFileSync(handle.file));
  const annots = doc.getPage(0).node.Annots();
  const square = annots
    ?.asArray()
    .map((ref) => doc.context.lookup(ref))
    .find((a) => (a as Partial<Dict>).get?.(PDFName.of('Subtype'))?.toString() === '/Square') as Dict | undefined;
  if (!square) throw new Error('Rechteck nicht gespeichert');
  const opacity = square.get(PDFName.of('CA'));
  const interior = square.get(PDFName.of('IC'));
  expect(opacity instanceof PDFNumber && opacity.asNumber()).toBeCloseTo(0.75, 2);
  expect(interior instanceof PDFArray && interior.size()).toBe(3);
  await handle.close();
});

test('eigener Stempel mit Datum und Name sowie ein Bild als Stempel', async () => {
  const handle = await openCopy(TEXT_PDF.file, TEXT_PDF.pages);
  const { page, app } = handle;
  const at = await pageSpace(page);
  await page.getByTestId('tool-stamp').click();
  await page.getByTestId('stamp-select').selectOption('custom');
  const dialog = page.getByTestId('custom-stamp-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('custom-stamp-ok')).toBeDisabled();
  await page.getByTestId('custom-stamp-text').fill('ERLEDIGT');
  await page.getByTestId('custom-stamp-color-red').click();
  await page.getByTestId('custom-stamp-ok').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('stamp-select')).toHaveValue('custom');
  await page.mouse.click(at(200, 300).x, at(200, 300).y);
  // Zwei Zeilen: Text und darunter Name · Datum
  const lines = page.getByTestId('annotation-overlay-0').locator('text');
  await expect(lines.first()).toHaveText('ERLEDIGT');
  await expect(lines.nth(1)).toContainText(String(new Date().getFullYear()));

  // Bild als Stempel: Datei wählen, dann an die Klickstelle setzen
  await app.evaluate(({ dialog: d }, file) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof d.showOpenDialog;
  }, imageFixture('transparent.png'));
  await page.getByTestId('tool-stamp').click();
  await page.getByTestId('stamp-select').selectOption('image');
  await expect(page.getByTestId('signature-hint')).toBeVisible();
  await page.mouse.click(at(300, 500).x, at(300, 500).y);
  await expect(page.getByTestId('annotation-overlay-0').locator('image')).toHaveCount(1);

  await save(page, app);
  const { PDFDocument, PDFName } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.load(readFileSync(handle.file));
  const subtypes = (doc.getPage(0).node.Annots()?.asArray() ?? []).map((ref) => (doc.context.lookup(ref) as unknown as { get: (n: unknown) => unknown }).get(PDFName.of('Subtype'))?.toString());
  expect(subtypes.filter((s) => s === '/Stamp')).toHaveLength(2);
  await handle.close();
});

test('Kommentarliste filtern, sortieren und als Zusammenfassung sichern', async () => {
  const handle = await openCopy(COMMENTS_PDF.file, COMMENTS_PDF.pages);
  const { page, app } = handle;
  await expect(cards(page)).toHaveCount(COMMENTS_PDF.comments);
  // Nur angenommene: der Kommentar mit Prüfstatus
  await page.getByTestId('comments-filter').selectOption('status:Accepted');
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByTestId('comments-panel')).toContainText(`1 von ${COMMENTS_PDF.comments} Kommentaren`);
  // Filter ohne Treffer
  await page.getByTestId('comments-filter').selectOption('kind:redact');
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByTestId('comments-panel')).toContainText('Kein Kommentar passt zum Filter.');
  await page.getByTestId('comments-filter').selectOption('all');
  await expect(cards(page)).toHaveCount(COMMENTS_PDF.comments);
  // Neueste zuerst: ohne Seitenüberschriften
  await page.getByTestId('comments-sort').selectOption('date');
  await expect(page.getByTestId('comments-panel').locator('h3')).toHaveCount(0);
  await page.getByTestId('comments-sort').selectOption('page');
  await expect(page.getByTestId('comments-panel').locator('h3')).toHaveCount(COMMENTS_PDF.pages);

  const target = path.join(path.dirname(handle.file), 'zusammenfassung.txt');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
  }, target);
  await page.getByTestId('comments-export').click();
  await expect.poll(() => existsSync(target)).toBe(true);
  const text = readFileSync(target, 'utf8');
  expect(text).toContain(`Kommentare in kopie-${COMMENTS_PDF.file}`);
  expect(text).toContain(COMMENTS_PDF.noteText);
  expect(text).toContain(COMMENTS_PDF.replyText);
  expect(text).toContain(COMMENTS_PDF.status);
  await handle.close();
});
