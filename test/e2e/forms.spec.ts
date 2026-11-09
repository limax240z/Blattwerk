// Phase 4: Formulare und Unterschrift. Arbeitet auf Kopien der Test-PDFs.
import { expect, test, type Page } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fixture } from '../fixtures/expectations';
import type { ElectronApplication } from '@playwright/test';
import { launchApp, menuClick, menuItemState, removeTempDir, waitForDocument, type AppHandle } from './app';
import { inspectWithPdfKit } from './pdfkit';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'legacy/build/pdf.worker.mjs'),
).href;

const tempDirs: string[] = [];
test.afterAll(() => {
  for (const dir of tempDirs) removeTempDir(dir);
});

async function openCopy(name: string, pages: number): Promise<AppHandle & { file: string; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'blattwerk-e2e-'));
  tempDirs.push(dir);
  const file = path.join(dir, `kopie-${name}`);
  copyFileSync(fixture(name), file);
  const handle = await launchApp([file], { userData: dir });
  await waitForDocument(handle.page, pages);
  return { ...handle, file, dir };
}

// Feld der pdf.js-Formularebene über die Objektnummer des Widgets
const field = (page: Page, ref: string) => page.locator(`[data-testid="active-pane"] .annotationLayer [data-element-id="${ref}"]`);

// Position der Kommentarebene von Seite 1, sobald sie sich nicht mehr bewegt (nach Zoom und Neuanordnung)
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

async function stampCount(file: string): Promise<number> {
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 });
  const pdf = await task.promise;
  let count = 0;
  for (let i = 1; i <= pdf.numPages; i++) count += (await (await pdf.getPage(i)).getAnnotations()).filter((a) => a.subtype === 'Stamp').length;
  await task.destroy();
  return count;
}

async function fieldValues(file: string): Promise<Record<string, unknown>> {
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 });
  const pdf = await task.promise;
  const map = (await pdf.getFieldObjects()) as unknown as Map<string, Array<{ value: unknown; page: number }>> | null;
  const result: Record<string, unknown> = {};
  for (const [name, list] of map ?? []) result[name] = list.find((f) => f.page >= 0)?.value;
  await task.destroy();
  return result;
}

test.describe('Formulare', () => {
  test('Formular ausfüllen, speichern und wieder öffnen', async () => {
    const handle = await openCopy('formular.pdf', 1);
    const { page, app, file } = handle;
    await field(page, '9R').fill('Erika Müller');
    await field(page, '13R').check();
    await field(page, '24R').check();
    await field(page, '35R').selectOption('Schweiz');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    expect(await fieldValues(file)).toMatchObject({ name: 'Erika Müller', einverstanden: 'Yes', farbe: 'gruen', land: 'Schweiz' });
    // Nach dem Neuladen zeigt die Ansicht die gespeicherten Werte
    await expect(field(page, '9R')).toHaveValue('Erika Müller');
    await expect(field(page, '13R')).toBeChecked();
    await handle.close();
  });

  test('ungespeicherte Formulareingaben lösen die Nachfrage beim Schließen aus', async () => {
    const handle = await openCopy('formular.pdf', 1);
    const { page, app } = handle;
    await field(page, '9R').fill('Nur getippt');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    await menuClick(app, 'file.close');
    await expect(page.getByTestId('prompt-unsaved')).toBeVisible();
    await page.getByTestId('prompt-cancel').click();
    // Zurücksetzen auf den alten Wert zählt nicht mehr als Änderung
    await field(page, '9R').fill('');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    await handle.close();
  });
});

// Kleines PNG: weißer Hintergrund mit schwarzem Balken (wie eine eingescannte Unterschrift)
function scannedSignaturePng(): Buffer {
  const width = 200;
  const height = 80;
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 30; y < 50; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 20; x < 180; x++) raw.fill(0, y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3);
  }
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function stubOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
  }, filePath);
}

test.describe('Unterschrift', () => {
  test('aus einem Bild: heller Hintergrund wird durchsichtig', async () => {
    const handle = await openCopy('text.pdf', 12);
    const { page, app, file, dir } = handle;
    const image = path.join(dir, 'unterschrift.png');
    writeFileSync(image, scannedSignaturePng());
    await stubOpenDialog(app, image);
    await page.getByTestId('sign-button').click();
    await page.getByTestId('signature-mode-image').click();
    await page.getByTestId('signature-image-pick').click();
    const preview = page.getByTestId('signature-image-preview');
    await expect(preview).toBeVisible();
    const naturalWidth = () => preview.evaluate((img: HTMLImageElement) => img.naturalWidth);
    // Mit Entfernen des Hintergrunds bleibt nur der Balken (plus Rand), ohne das ganze Bild
    await expect.poll(naturalWidth).toBeLessThan(200);
    await page.getByTestId('signature-remove-background').uncheck();
    await expect.poll(naturalWidth).toBe(200);
    await page.getByTestId('signature-remove-background').check();
    await expect.poll(naturalWidth).toBeLessThan(200);
    await page.getByTestId('signature-keep').uncheck();
    await page.getByTestId('signature-use').click();
    await menuClick(app, 'view.fitPage');
    await expect(page.getByTestId('zoom-select')).toHaveValue('page-fit');
    const box = await stableOverlayBox(page);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.7);
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    expect(await stampCount(file)).toBe(1);
    await handle.close();
  });

  test('zeichnen, für später speichern, setzen und speichern', async () => {
    const handle = await openCopy('text.pdf', 12);
    const { page, app, file, dir } = handle;
    await page.getByTestId('sign-button').click();
    // Noch keine gespeicherte Unterschrift: Der Dialog zum Anlegen öffnet sich direkt.
    await expect(page.getByTestId('signature-create-dialog')).toBeVisible();
    await expect(page.getByTestId('signature-use')).toBeDisabled();
    const pad = await page.getByTestId('signature-pad').boundingBox();
    if (!pad) throw new Error('kein Zeichenfeld');
    await page.mouse.move(pad.x + 40, pad.y + 120);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(pad.x + 40 + i * 20, pad.y + 120 - Math.sin(i / 2) * 40);
    await page.mouse.up();
    await page.getByTestId('signature-use').click();
    await expect(page.getByTestId('signature-hint')).toBeVisible();
    await menuClick(app, 'view.fitPage');
    await expect(page.getByTestId('zoom-select')).toHaveValue('page-fit');
    const box = await stableOverlayBox(page);
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.8);
    await expect(page.getByTestId('signature-hint')).toHaveCount(0);
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    expect(await stampCount(file)).toBe(1);
    if (process.platform === 'darwin') expect(inspectWithPdfKit(file).pages[0]).toContain('Stamp');
    await handle.close();

    // Beim nächsten Start steht die gespeicherte Unterschrift zur Auswahl.
    const second = await launchApp([file], { userData: dir });
    await waitForDocument(second.page, 12);
    await second.page.getByTestId('sign-button').click();
    await expect(second.page.getByTestId('signature-choose-dialog')).toBeVisible();
    await expect(second.page.getByTestId('signature-saved')).toHaveCount(1);
    await second.page.getByTestId('signature-saved').click();
    await expect(second.page.getByTestId('signature-hint')).toBeVisible();
    await second.page.keyboard.press('Escape');
    await expect(second.page.getByTestId('signature-hint')).toHaveCount(0);
    await second.close();
  });

  test('getippte Unterschrift ohne Speichern', async () => {
    const handle = await openCopy('text.pdf', 12);
    const { page, app } = handle;
    await page.getByTestId('sign-button').click();
    await page.getByTestId('signature-mode-type').click();
    await page.getByTestId('signature-name').fill('Erika Mustermann');
    await page.getByTestId('signature-keep').uncheck();
    await page.getByTestId('signature-use').click();
    await menuClick(app, 'view.fitPage');
    await expect(page.getByTestId('zoom-select')).toHaveValue('page-fit');
    const box = await stableOverlayBox(page);
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.85);
    await page.getByTestId('sidebar-comments').click();
    await expect(page.getByTestId('comment-card').filter({ hasText: 'Unterschrift' })).toHaveCount(1);
    // Nicht gespeichert: beim nächsten Klick öffnet sich wieder der Dialog zum Anlegen
    await page.getByTestId('sign-button').click();
    await expect(page.getByTestId('signature-create-dialog')).toBeVisible();
    await handle.close();
  });
});

interface SavedWidget {
  id: string;
  fieldName: string;
  rect: number[];
  required: boolean;
  buttonValue?: string;
  options?: Array<{ exportValue: string }>;
}

async function savedWidgets(file: string): Promise<SavedWidget[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 });
  const pdf = await task.promise;
  const annotations = await (await pdf.getPage(1)).getAnnotations();
  await task.destroy();
  return (annotations as unknown as Array<SavedWidget & { subtype: string }>).filter((a) => a.subtype === 'Widget');
}

const formField = (page: Page, name: string) => page.locator(`[data-testid="form-field"][data-field-name="${name}"]`);

// Position der Bearbeitungsebene von Seite 1, sobald sie sich nicht mehr bewegt
async function stableFormOverlay(page: Page) {
  const overlay = page.getByTestId('form-edit-overlay-0');
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

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(to[0], to[1], { steps: 4 });
  await page.mouse.up();
}

test.describe('Formular bearbeiten', () => {
  test('Felder anlegen, verschieben, löschen, rückgängig machen und danach ausfüllen', async () => {
    const handle = await openCopy('text.pdf', 12);
    const { page, app, file } = handle;
    await page.getByTestId('form-edit-button').click();
    await expect(page.getByTestId('form-edit-toolbar')).toBeVisible();
    expect(await menuItemState(app, 'forms.edit')).toMatchObject({ checked: true });
    await menuClick(app, 'view.fitPage');
    await expect(page.getByTestId('zoom-select')).toHaveValue('page-fit');
    let box = await stableFormOverlay(page);
    const at = (x: number, y: number): [number, number] => [box.x + box.width * x, box.y + box.height * y];

    // Textfeld aufziehen, Name und Pflichtfeld im Dialog
    await page.getByTestId('field-tool-text').click();
    await drag(page, at(0.2, 0.3), at(0.6, 0.34));
    await expect(page.getByTestId('field-dialog')).toBeVisible();
    await expect(page.getByTestId('field-name')).toHaveValue('Textfeld 1');
    await page.getByTestId('field-name').fill('Vorname');
    await page.getByTestId('field-required').check();
    await page.getByTestId('field-dialog-ok').click();
    await expect(formField(page, 'Vorname')).toHaveCount(1);
    await expect(page.getByTestId('form-field-selection')).toHaveCount(1);
    await expect(page.getByTestId('tab-dirty')).toHaveCount(1);

    // Dropdown per Klick (Standardgröße); ohne Einträge meldet der Dialog einen Fehler
    box = await stableFormOverlay(page);
    await page.getByTestId('field-tool-dropdown').click();
    await page.mouse.click(...at(0.2, 0.45));
    await expect(page.getByTestId('field-dialog')).toBeVisible();
    await page.getByTestId('field-dialog-ok').click();
    await expect(page.getByTestId('field-problem')).toBeVisible();
    await page.getByTestId('field-options').fill('Rot\nGrün\nBlau');
    await page.getByTestId('field-dialog-ok').click();
    await expect(formField(page, 'Dropdown 1')).toHaveCount(1);

    // Zwei Optionsfelder: Der zweite Knopf schlägt dieselbe Gruppe und den nächsten Wert vor.
    for (const [x, value] of [
      [0.2, 'Auswahl 1'],
      [0.3, 'Auswahl 2'],
    ] as const) {
      box = await stableFormOverlay(page);
      await page.getByTestId('field-tool-radio').click();
      await page.mouse.click(...at(x, 0.55));
      await expect(page.getByTestId('field-name')).toHaveValue('Optionsgruppe 1');
      await expect(page.getByTestId('field-value')).toHaveValue(value);
      await page.getByTestId('field-dialog-ok').click();
    }
    await expect(formField(page, 'Optionsgruppe 1')).toHaveCount(2);

    // Textfeld nach rechts verschieben
    box = await stableFormOverlay(page);
    const before = await formField(page, 'Vorname').boundingBox();
    if (!before) throw new Error('Feld fehlt');
    await drag(page, [before.x + 20, before.y + before.height / 2], [before.x + 120, before.y + before.height / 2]);
    await expect.poll(async () => (await formField(page, 'Vorname').boundingBox())?.x ?? 0).toBeGreaterThan(before.x + 80);

    // Dropdown löschen, dann rückgängig machen
    await formField(page, 'Dropdown 1').click();
    await page.keyboard.press('Backspace');
    await expect(formField(page, 'Dropdown 1')).toHaveCount(0);
    await menuClick(app, 'edit.undo');
    await expect(formField(page, 'Dropdown 1')).toHaveCount(1);

    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    const saved = await savedWidgets(file);
    const vorname = saved.find((w) => w.fieldName === 'Vorname');
    expect(vorname?.required).toBe(true);
    expect(saved.filter((w) => w.fieldName === 'Optionsgruppe 1').map((w) => w.buttonValue)).toEqual(['Auswahl 1', 'Auswahl 2']);
    expect(saved.find((w) => w.fieldName === 'Dropdown 1')?.options?.map((o) => o.exportValue)).toEqual(['Rot', 'Grün', 'Blau']);
    if (process.platform === 'darwin') expect(inspectWithPdfKit(file).pages[0]).toContain('Widget');

    // Modus beenden und das neue Feld ausfüllen
    await page.getByTestId('form-edit-done').click();
    await expect(page.getByTestId('form-edit-toolbar')).toHaveCount(0);
    await field(page, vorname?.id ?? '').fill('Max');
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    expect(await fieldValues(file)).toMatchObject({ Vorname: 'Max' });
    await handle.close();
  });

  test('Eigenschaften eines vorhandenen Feldes per Doppelklick ändern', async () => {
    const handle = await openCopy('formular.pdf', 1);
    const { page, app, file } = handle;
    await menuClick(app, 'forms.edit');
    await formField(page, 'name').dblclick();
    await expect(page.getByTestId('field-dialog')).toBeVisible();
    await page.getByTestId('field-name').fill('vorname');
    await page.getByTestId('field-tooltip').fill('Ihr Vorname');
    await page.getByTestId('field-dialog-ok').click();
    await expect(formField(page, 'vorname')).toHaveCount(1);
    // Doppelter Name wird abgelehnt
    await formField(page, 'land').dblclick();
    await page.getByTestId('field-name').fill('vorname');
    await page.getByTestId('field-dialog-ok').click();
    await expect(page.getByTestId('field-problem')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('field-dialog')).toHaveCount(0);
    await menuClick(app, 'file.save');
    await expect(page.getByTestId('tab-dirty')).toHaveCount(0);
    expect(Object.keys(await fieldValues(file))).toEqual(expect.arrayContaining(['vorname', 'land']));
    await handle.close();
  });

  test('in Dokumenten mit Kennwortschutz nicht verfügbar', async () => {
    const handle = await openCopy('eingeschraenkt.pdf', 12);
    await expect(handle.page.getByTestId('form-edit-button')).toBeDisabled();
    expect(await menuItemState(handle.app, 'forms.edit')).toMatchObject({ enabled: false });
    await handle.close();
  });
});

test('Lesemodus: nur das Dokument, nichts lässt sich ändern, Esc stellt alles wieder her', async () => {
  const { page, app, close } = await launchApp([fixture('formular.pdf')]);
  await waitForDocument(page, 1);
  await menuClick(app, 'view.actualSize');
  await expect(page.getByTestId('zoom-select')).toHaveValue('page-actual');
  const firstField = page.locator('.annotationLayer input[type="text"]').first();
  await expect(firstField).toBeAttached();

  await page.getByTestId('read-mode-button').click();
  await expect(page.getByTestId('read-mode-exit')).toBeVisible();
  await expect(page.getByTestId('open-button')).toBeHidden();
  await expect(page.getByTestId('left-sidebar')).toHaveCount(0);

  // Formularfeld: weder Klick noch Tippen noch direkter Fokus (die Seite wird für den Lesemodus neu aufgebaut)
  await expect(firstField).toBeVisible();
  const box = await firstField.boundingBox();
  if (!box) throw new Error('Feld nicht sichtbar');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type('Max');
  await firstField.focus().catch(() => undefined);
  await page.keyboard.type('Max');
  expect(await firstField.inputValue()).toBe('');

  // Befehle, die ändern würden, bleiben wirkungslos; Menüpunkte sind erreichbar, tun aber nichts
  await menuClick(app, 'view.toggleCommentTools');
  await expect(page.getByTestId('comment-toolbar')).toHaveCount(0);
  await menuClick(app, 'content.edit');
  await expect(page.getByTestId('tab-dirty')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('read-mode-exit')).toHaveCount(0);
  await expect(page.getByTestId('open-button')).toBeVisible();
  await expect(page.getByTestId('left-sidebar')).toBeVisible();
  await expect(page.getByTestId('zoom-select')).toHaveValue('page-actual');
  await firstField.click();
  await page.keyboard.type('Max');
  expect(await firstField.inputValue()).toBe('Max');
  await close();
});

test('Lesemodus lässt sich aus jedem Arbeitsbereich starten', async () => {
  const { page, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, 12);
  for (const mode of ['organize-button', 'content-edit-button', 'form-edit-button', 'comment-tools-button', 'highlight-button', 'redact-tools-button']) {
    await page.getByTestId(mode).click();
    await page.getByTestId('read-mode-button').click();
    await expect(page.getByTestId('read-mode-exit')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('read-mode-exit')).toHaveCount(0);
    await expect(page.getByTestId('organize-button')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('form-edit-toolbar')).toHaveCount(0);
  }
  await close();
});


test('Lesemodus: Vollbild lässt sich in den Einstellungen abschalten', async () => {
  const { page, app, userData, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, 12);
  // Wünsche nach Vollbild zählen (verborgene Fenster schalten ohnehin nicht um)
  await app.evaluate(({ ipcMain }) => {
    const calls: boolean[] = [];
    (globalThis as unknown as { __fullscreen: boolean[] }).__fullscreen = calls;
    ipcMain.removeHandler('window:fullscreen');
    ipcMain.handle('window:fullscreen', (_event, on: boolean) => {
      calls.push(on);
      return false;
    });
  });
  const requests = () => app.evaluate(() => (globalThis as unknown as { __fullscreen: boolean[] }).__fullscreen.slice());

  // Vorgabe: mit Vollbild
  await page.getByTestId('read-mode-button').click();
  await expect(page.getByTestId('read-mode-exit')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('read-mode-exit')).toHaveCount(0);
  expect(await requests()).toEqual([true, false]);

  await menuClick(app, 'app.settings');
  const box = page.getByTestId('settings-read-fullscreen');
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
  const stored = () => {
    try {
      return (JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')) as { readModeFullscreen?: boolean }).readModeFullscreen;
    } catch {
      return undefined;
    }
  };
  await expect.poll(stored).toBe(false);

  // Ohne Vollbild: Leisten weg wie gewohnt, das Fenster bleibt, wie es ist
  await page.getByTestId('read-mode-button').click();
  await expect(page.getByTestId('read-mode-exit')).toBeVisible();
  await expect(page.getByTestId('open-button')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('read-mode-exit')).toHaveCount(0);
  expect(await requests()).toEqual([true, false]);

  await menuClick(app, 'app.settings');
  await expect(page.getByTestId('settings-read-fullscreen')).not.toBeChecked();
  await close();
});
