// Startseite wie in Word (ADR 0028): Vorlagen, Home-Knopf, Anheften, Suche, eigene Vorlagen, Vorschaubilder
import { expect, test } from '@playwright/test';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture, TEXT_PDF } from '../fixtures/expectations';
import { expectWindowCount, launchApp, menuClick, mergeAllWindows, removeTempDir, waitForDocument, windowWithTitle } from './app';

const tempDirs: string[] = [];
test.afterAll(() => {
  for (const dir of tempDirs) removeTempDir(dir);
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'blattwerk-start-'));
  tempDirs.push(dir);
  return dir;
}

test('Vorlagen öffnen als unbenanntes Dokument im Bearbeitungsmodus, mit überschreibbarem Text', async () => {
  const { page, close } = await launchApp();
  const cards = page.getByTestId('template-card');
  await expect(cards).toHaveCount(8);
  // Vorschaubilder entstehen beim ersten Anzeigen
  await expect(cards.first().locator('img')).toBeVisible();

  await page.locator('[data-template-id="builtin:letter"] button').first().click();
  await waitForDocument(page, 1);
  await expect(page.getByTestId('tab')).toHaveText(/Brief\.pdf/);
  await expect(page.getByTestId('content-edit-toolbar')).toBeVisible();
  const subject = page.locator('[data-testid="content-object"][data-text^="[Betreff]"]');
  await expect(subject).toHaveCount(1);
  // Platzhalter überschreiben, auch mit Zeichen, die in der eingebetteten Teilschrift fehlen
  await subject.dblclick();
  const editor = page.getByTestId('content-text-editor');
  await expect(editor).toHaveValue('[Betreff]');
  await editor.fill('Kündigung meines Vertrags Nr. 4711 – Bestätigung');
  await page.keyboard.press('Meta+Enter');
  await expect(editor).toHaveCount(0);
  await expect(page.locator('[data-testid="content-object"][data-text^="Kündigung meines Vertrags"]')).toHaveCount(1);
  await close();
});

test('Notizpapier hat drei Seiten; Suche filtert Vorlagen', async () => {
  const { app, page, close } = await launchApp();
  await page.getByTestId('start-search').fill('papier');
  await expect(page.getByTestId('template-card')).toHaveCount(1);
  await expect(page.getByTestId('start-blank')).toHaveCount(0);
  await page.getByTestId('start-search').fill('gibt es nicht');
  await expect(page.getByTestId('template-card')).toHaveCount(0);
  await page.getByTestId('start-search').fill('papier');
  await page.getByTestId('template-card').locator('button').first().click();
  await waitForDocument(page, 3);
  await expectWindowCount(app, 1);
  await close();
});

test('Home-Knopf zeigt die Startseite über dem Dokument; Esc und „Zurück“ kehren zurück', async () => {
  const { app, page, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  await expect(page.getByTestId('start-screen')).toHaveCount(0);

  await page.getByTestId('home-button').click();
  await expect(page.getByTestId('start-screen')).toBeVisible();
  await expect(page.getByTestId('tab')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('start-screen')).toHaveCount(0);

  // Ein einfacher Klick auf den (schon aktiven) Tab führt zum Dokument zurück
  await page.getByTestId('home-button').click();
  await expect(page.getByTestId('start-screen')).toBeVisible();
  await page.getByTestId('tab').first().click();
  await expect(page.getByTestId('start-screen')).toHaveCount(0);

  await menuClick(app, 'app.home');
  await expect(page.getByTestId('start-screen')).toBeVisible();
  await page.getByTestId('start-back').click();
  await expect(page.getByTestId('start-screen')).toHaveCount(0);

  // Eine Vorlage aus der Überlagerung öffnet ein eigenes Fenster; die Überlagerung schließt sich
  await page.getByTestId('home-button').click();
  await page.locator('[data-template-id="builtin:cover"] button').first().click();
  await expectWindowCount(app, 2);
  await waitForDocument(await windowWithTitle(app, 'Deckblatt.pdf'), 1);
  await expect(page.getByTestId('start-screen')).toHaveCount(0);
  await close();
});

test('Startseite über dem Dokument: Klick auf einen anderen Tab zeigt dessen Dokument', async () => {
  const { app, close } = await launchApp([fixture('text.pdf'), fixture('formular.pdf')]);
  await expectWindowCount(app, 2);
  await waitForDocument(await windowWithTitle(app, 'text.pdf'), TEXT_PDF.pages);
  await waitForDocument(await windowWithTitle(app, 'formular.pdf'), 1);
  const page = await mergeAllWindows(app);
  await expect(page.getByTestId('tab')).toHaveCount(2);
  const tabs = page.getByTestId('tab');
  await tabs.nth(0).click();
  await page.getByTestId('home-button').click();
  await expect(page.getByTestId('start-screen')).toBeVisible();
  await tabs.nth(1).click();
  await expect(page.getByTestId('start-screen')).toHaveCount(0);
  await expect(tabs.nth(1)).toHaveClass(/active/);
  await close();
});

test('Anheften: angeheftete Dateien stehen oben und überstehen „Liste leeren“; Vorschaubild der Datei', async () => {
  const dir = tempDir();
  const files = ['text.pdf', 'formular.pdf'].map((name) => {
    const target = path.join(dir, name);
    copyFileSync(fixture(name), target);
    return target;
  });
  const first = await launchApp(files, { userData: dir });
  await expectWindowCount(first.app, 2);
  await waitForDocument(await windowWithTitle(first.app, 'text.pdf'), TEXT_PDF.pages);
  await waitForDocument(await windowWithTitle(first.app, 'formular.pdf'), 1);
  // Vorschaubilder werden nach dem Laden abgelegt
  await first.page.waitForTimeout(1000);
  await first.app.close();

  const { page, close } = await launchApp([], { userData: dir });
  const recent = page.getByTestId('recent-list').getByTestId('recent-item');
  await expect(recent).toHaveCount(2);
  await expect(recent.first().locator('img')).toBeVisible();
  const text = recent.filter({ hasText: 'text.pdf' });
  await text.hover();
  await text.getByTestId('recent-pin').click();
  await expect(page.getByTestId('pinned-list').getByTestId('recent-item')).toHaveText(/text\.pdf/);
  await expect(page.getByTestId('recent-list').getByTestId('recent-item')).toHaveCount(1);

  await page.getByRole('button', { name: 'Liste leeren' }).click();
  await expect(page.getByTestId('recent-list')).toHaveCount(0);
  await expect(page.getByTestId('pinned-list').getByTestId('recent-item')).toHaveCount(1);

  // Suche findet auch Dateien
  await page.getByTestId('start-search').fill('text');
  await expect(page.getByTestId('pinned-list').getByTestId('recent-item')).toHaveCount(1);
  await expect(page.getByTestId('template-card')).toHaveCount(0);
  await close();
});

test('eigene Vorlage sichern, aus ihr ein Dokument erstellen und sie wieder entfernen', async () => {
  const dir = tempDir();
  const { app, page, close } = await launchApp([fixture('text.pdf')], { userData: dir });
  await waitForDocument(page, TEXT_PDF.pages);
  await menuClick(app, 'file.saveAsTemplate');
  const name = page.getByTestId('template-name');
  await expect(name).toHaveValue('text');
  await name.fill('Meine Vorlage');
  await name.press('Enter');
  await expect(page.getByTestId('template-dialog')).toHaveCount(0);

  await page.getByTestId('home-button').click();
  const card = page.locator('[data-template-id="user:Meine Vorlage.pdf"]');
  await expect(card).toBeVisible();
  await card.locator('button').first().click();
  await expectWindowCount(app, 2);
  const created = await windowWithTitle(app, 'Meine Vorlage.pdf');
  await waitForDocument(created, TEXT_PDF.pages);

  // Im Fenster mit der Startseite entfernen (zwei Schritte)
  await created.getByTestId('home-button').click();
  const own = created.locator('[data-template-id="user:Meine Vorlage.pdf"]');
  await own.hover();
  await own.getByTestId('template-remove').click();
  await own.getByTestId('template-remove-confirm').click();
  await expect(own).toHaveCount(0);
  await expect(created.getByTestId('template-card')).toHaveCount(8);
  await close();
});
