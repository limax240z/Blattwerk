// Oberflächentests für Fehler, die die Code-Prüfung in Phase 1 gefunden hat.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture, imageFixture, LARGE_PDF, TEXT_PDF } from '../fixtures/expectations';
import { currentPage, expectWindowCount, launchApp, menuClick, menuItemState, mergeAllWindows, removeTempDir, waitForDocument, windowWithTitle } from './app';

const activePane = (page: Page) => page.locator('[data-testid="active-pane"]');

test('mehrere Dateien öffnen: Abbrechen der Kennwortabfrage hält die übrigen nicht auf', async () => {
  const { page, app, close } = await launchApp();
  // Systemdialog ersetzen: Er liefert zwei Dateien, die verschlüsselte zuerst.
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog;
  }, [fixture('verschluesselt.pdf'), fixture('text.pdf')]);
  await page.getByTestId('open-button').click();
  // Die erste Datei öffnet im leeren Fenster, die zweite in einem eigenen (ADR 0026).
  await expectWindowCount(app, 2);
  await expect(page.getByTestId('tab')).toHaveCount(1);
  // text.pdf lädt, obwohl für die erste Datei noch das Kennwort fehlt.
  const second = await windowWithTitle(app, 'text.pdf');
  await waitForDocument(second, TEXT_PDF.pages);
  await expect(page.getByTestId('password-dialog')).toBeVisible();
  await page.getByTestId('password-dialog').getByRole('button', { name: 'Abbrechen' }).click();
  await expect(page.getByTestId('tab')).toHaveCount(0);
  await waitForDocument(second, TEXT_PDF.pages);
  await close();
});

test('Schließen funktioniert auch bei Kennwortabfrage und Ladefehler', async () => {
  const { page, app, close } = await launchApp([fixture('verschluesselt.pdf')]);
  await expect(page.getByTestId('password-dialog')).toBeVisible();
  expect(await menuItemState(app, 'file.close')).toMatchObject({ enabled: true });
  await menuClick(app, 'file.close');
  await expect(page.getByTestId('start-screen')).toBeVisible();
  await close();
});

test('Druck abbrechen durch Schließen des Tabs hängt nicht', async () => {
  test.skip(!existsSync(LARGE_PDF), 'Große Testdatei fehlt');
  const { page, app, close } = await launchApp([LARGE_PDF]);
  await waitForDocument(page, 600);
  await page.getByTestId('print-button').click();
  await expect(page.getByTestId('print-progress')).toBeVisible();
  await menuClick(app, 'file.close');
  await expect(page.getByTestId('print-progress')).toHaveCount(0);
  await expect(page.getByTestId('start-screen')).toBeVisible();
  await close();
});

test('Einzelne Seite: Trackpad und Pfeil runter blättern am Seitenende um', async () => {
  const { page, app, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  await page.getByTestId('view-mode-select').selectOption('single');
  await menuClick(app, 'view.fitPage');
  await expect.poll(() => currentPage(page)).toBe(1);
  // Künstliche Wheel-Ereignisse scrollen nicht von selbst; der Test stellt deshalb vorher den Rand ein,
  // den echtes Scrollen erreichen würde.
  const swipe = (deltaY: number) =>
    page.getByTestId('viewer-container').evaluate((element, dy) => {
      element.scrollTop = dy > 0 ? element.scrollHeight : 0;
      for (let i = 0; i < 6; i++) {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
      }
    }, deltaY);
  await swipe(30);
  await expect.poll(() => currentPage(page)).toBe(2);
  // Kurz warten, bis die Nachlaufsperre vorbei ist, dann zurück.
  await page.waitForTimeout(600);
  await swipe(-30);
  await expect.poll(() => currentPage(page)).toBe(1);
  await page.getByTestId('viewer-container').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.focus();
  });
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => currentPage(page)).toBe(2);
  await close();
});

test('Klick in der Werkzeugleiste nimmt dem Dokument nicht die Tastatur', async () => {
  const { page, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  await page.getByTestId('viewer-container').click({ position: { x: 5, y: 5 } });
  await page.getByRole('button', { name: 'Vergrößern' }).click();
  const before = await page.getByTestId('viewer-container').evaluate((el) => el.scrollTop);
  await page.keyboard.press('PageDown');
  await expect.poll(() => page.getByTestId('viewer-container').evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  await close();
});

test('Suchergebnis anklicken wählt genau diesen Treffer aus', async () => {
  const { page, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  await page.getByTestId('search-button').click();
  await page.getByTestId('search-input').fill(TEXT_PDF.searchTerm);
  await expect(page.getByTestId('search-results').locator('li')).toHaveCount(TEXT_PDF.searchHits);
  await page.getByTestId('search-results').locator('li').nth(4).click();
  await expect(page.getByTestId('search-status')).toHaveText(`5 von ${TEXT_PDF.searchHits} Treffern`);
  await expect.poll(() => currentPage(page)).toBe(9);
  await expect(activePane(page).locator('.textLayer .highlight.selected')).toBeVisible();
  // Weitersuchen geht vom angeklickten Treffer aus.
  await page.getByTestId('search-input').press('Enter');
  await expect(page.getByTestId('search-status')).toHaveText(`6 von ${TEXT_PDF.searchHits} Treffern`);
  await close();
});

test('Suchfeld leeren entfernt die Ergebnisse; Tabwechsel behält die Markierungen', async () => {
  const { app, close } = await launchApp([fixture('text.pdf'), fixture('kaputte-xref.pdf')]);
  await expectWindowCount(app, 2);
  await waitForDocument(await windowWithTitle(app, 'kaputte-xref.pdf'), TEXT_PDF.pages);
  // Beide Dokumente als Tabs in einem Fenster
  const page = await mergeAllWindows(app);
  await expect(page.getByTestId('tab')).toHaveCount(2);
  const textTab = page.getByTestId('tab').filter({ hasText: 'text.pdf' }).filter({ hasNotText: 'kaputte' });
  const otherTab = page.getByTestId('tab').filter({ hasText: 'kaputte-xref.pdf' });
  await textTab.click();
  await waitForDocument(page, TEXT_PDF.pages);
  await page.getByTestId('search-button').click();
  await page.getByTestId('search-input').fill(TEXT_PDF.searchTerm);
  await expect(page.getByTestId('search-results').locator('li')).toHaveCount(TEXT_PDF.searchHits);

  await otherTab.click();
  await waitForDocument(page, TEXT_PDF.pages);
  await textTab.click();
  await expect(activePane(page).locator('.textLayer .highlight').first()).toBeVisible();
  // Der Tabwechsel holt den Fokus nicht ins Suchfeld.
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).not.toBe('search-input');

  await page.getByTestId('search-input').fill('');
  await page.waitForTimeout(400);
  await expect(page.getByTestId('search-results')).toHaveCount(0);
  await expect(page.getByTestId('search-status')).toHaveText('Gib einen Begriff ein und drücke die Eingabetaste.');
  await close();
});

test('„Liste leeren“ auf dem Startbildschirm leert auch die Liste des Systems', async () => {
  // Die Liste des Systems gibt es nur unter macOS (Dock) und Windows (Sprungliste)
  test.skip(process.platform === 'linux', 'keine Systemliste unter Linux');
  const first = await launchApp([fixture('text.pdf')], { keepUserData: true });
  await waitForDocument(first.page, TEXT_PDF.pages);
  await first.app.close();
  const second = await launchApp([], { userData: first.userData });
  await second.app.evaluate(({ app }) => {
    const g = globalThis as unknown as { __cleared: number };
    g.__cleared = 0;
    app.clearRecentDocuments = () => {
      g.__cleared++;
    };
  });
  await second.page.getByRole('button', { name: 'Liste leeren' }).click();
  await expect(second.page.getByTestId('recent-list')).toHaveCount(0);
  expect(await second.app.evaluate(() => (globalThis as unknown as { __cleared: number }).__cleared)).toBe(1);
  await second.close();
});

test('Absturz der Anzeige: Neu laden stellt die App wieder her', async () => {
  const { page, app, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  // Das Dokumentfenster gezielt wählen: Die Startseite öffnet für Vorschaubilder kurzlebige Hilfsfenster
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().includes('/index.html'))
      ?.webContents.forcefullyCrashRenderer(),
  );
  // Nach dem Neuladen zeigt das (einzige) Fenster wieder den Startbildschirm. Abfrage direkt beim Fenster,
  // weil Playwright die Seite nach einem Absturz nicht weiterverfolgt.
  await expect
    .poll(
      () =>
        app.evaluate(async ({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('/index.html'))?.webContents;
          if (!contents || contents.isCrashed() || contents.isLoading()) return false;
          // Während des Neuladens kommt die Antwort unter Linux und Windows nie zurück: höchstens 1 s warten
          const query = contents.executeJavaScript('Boolean(document.querySelector(\'[data-testid="start-screen"]\'))').catch(() => false);
          return Promise.race([query, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000))]);
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  // Kurzlebige Hilfsfenster (Vorschaubilder der Vorlagen auf der Startseite) zählen nicht
  await expectWindowCount(app, 1);
  await close();
});

test('Beschriftung erscheint beim Überfahren unter dem Symbol', async () => {
  const { page, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  const button = page.getByTestId('print-button');
  const tooltip = page.getByTestId('tooltip');
  await button.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(/Drucken/);
  const [buttonBox, tipBox] = [await button.boundingBox(), await tooltip.boundingBox()];
  expect(tipBox && buttonBox && tipBox.y).toBeGreaterThanOrEqual((buttonBox?.y ?? 0) + (buttonBox?.height ?? 0));
  await page.mouse.move(5, 400);
  await expect(tooltip).toBeHidden();
  await close();
});

test('Fenster schließen fragt bei Änderungen nach und beendet dann die App (auch unter macOS)', async () => {
  const { page, app } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  await menuClick(app, 'pages.rotateClockwise');
  await expect(page.getByTestId('tab-dirty')).toHaveCount(1);
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  // Wie ein Klick auf den roten Knopf
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('/index.html'))?.close());
  // Abbrechen: Fenster und App bleiben
  await page.getByTestId('prompt-cancel').click();
  await expect(page.getByTestId('tab')).toHaveCount(1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('/index.html'))?.close());
  // Die App kann sich beenden, bevor Playwright den Klick bestätigt bekommt
  await page.getByTestId('prompt-discard').click().catch(() => undefined);
  await exited;
});

test('Neuer Text beginnt an der Klickstelle, die erste Zeile liegt mittig darauf und springt beim Übernehmen nicht', async () => {
  const { page, app, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  await page.getByTestId('content-edit-button').click();
  for (const zoom of ['view.fitPage', 'view.actualSize'] as const) {
    await menuClick(app, zoom);
    await page.getByTestId('content-tool-text').click();
    const overlay = await page.getByTestId('content-edit-overlay-0').boundingBox();
    if (!overlay) throw new Error('keine Ebene');
    const x = overlay.x + overlay.width * 0.5;
    const y = overlay.y + overlay.height * (zoom === 'view.fitPage' ? 0.8 : 0.25);
    await page.mouse.click(x, y);
    const editor = page.getByTestId('content-text-editor');
    const box = await editor.boundingBox();
    if (!box) throw new Error('keine Eingabe');
    // Text beginnt an der Klickstelle (Rahmen und Innenabstand: 3 px), Zeile mittig
    expect(Math.abs(box.x + 3 - x)).toBeLessThan(1.5);
    expect(Math.abs(box.y + box.height / 2 - y)).toBeLessThan(2);
    await page.keyboard.type(`Klick ${zoom}`);
    await page.keyboard.press('Meta+Enter');
    const placed = page.locator(`[data-testid="content-object"][data-text="Klick ${zoom}"]`);
    await expect(placed).toBeVisible();
    const after = await placed.boundingBox();
    if (!after) throw new Error('kein Text');
    expect(Math.abs(after.x - x)).toBeLessThan(3);
    expect(Math.abs(after.y + after.height / 2 - y)).toBeLessThan(3);
  }
  await close();
});

test('Neuer Text: ein Klick außerhalb der Eingabe übernimmt ihn, auch auf ein anderes Objekt', async () => {
  const { page, app, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  await page.getByTestId('content-edit-button').click();
  await menuClick(app, 'view.fitPage');
  const overlay = await page.getByTestId('content-edit-overlay-0').boundingBox();
  if (!overlay) throw new Error('keine Ebene');
  const editor = page.getByTestId('content-text-editor');
  const outside: Array<[string, () => Promise<void>]> = [
    [
      'Objekt',
      async () => {
        const target = await page.locator('[data-testid="content-object"][data-text="Inhaltsverzeichnis"]').boundingBox();
        await page.mouse.click((target?.x ?? 0) + 5, (target?.y ?? 0) + 3);
      },
    ],
    ['leere Stelle', () => page.mouse.click(overlay.x + 30, overlay.y + overlay.height * 0.95)],
    ['neben der Seite', () => page.mouse.click(overlay.x - 40, overlay.y + 200)],
    ['Seitenleiste', () => page.getByTestId('sidebar-bookmarks').click()],
  ];
  for (const [label, click] of outside) {
    await page.getByTestId('content-tool-text').click();
    await page.mouse.click(overlay.x + overlay.width * 0.5, overlay.y + overlay.height * (0.6 + outside.findIndex(([l]) => l === label) * 0.05));
    await page.keyboard.type(`Text ${label}`);
    await click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator(`[data-testid="content-object"][data-text="Text ${label}"]`)).toBeVisible();
    await page.getByTestId('sidebar-pages').click();
  }
  await close();
});

test.describe('Liquid Glass von macOS', () => {
  test('Glasflächen liegen unter Band, Seitenleiste und Startseite', async () => {
    test.skip(process.platform !== 'darwin', 'nur macOS');
    const handle = await launchApp([]);
    const { page, app } = handle;
    const native = await page.evaluate(() => (window as unknown as { blattwerk: { getAppInfo(): Promise<{ nativeGlass: boolean }> } }).blattwerk.getAppInfo());
    test.skip(!native.nativeGlass, 'macOS ohne Liquid Glass');
    const regions = () => app.evaluate(() => (globalThis as unknown as { __blattwerkGlass: () => Array<{ x: number; y: number; width: number; height: number; windowOpaque: boolean }> }).__blattwerkGlass());
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    // Startseite: ein Glas über das ganze Fenster, Fenster durchsichtig
    await expect.poll(async () => (await regions()).length).toBe(1);
    const [full] = await regions();
    expect(full).toMatchObject({ x: 0, y: 0, width: size.width, height: size.height, windowOpaque: false });
    await expect(page.locator('html')).toHaveAttribute('data-native-glass', 'on');
    await handle.close();

    // Dokument: Band oben bis zur Arbeitsfläche, Seitenleiste mit ihrem Rahmen
    const doc = await launchApp([fixture('text.pdf')]);
    await waitForDocument(doc.page, TEXT_PDF.pages);
    const docRegions = () => doc.app.evaluate(() => (globalThis as unknown as { __blattwerkGlass: () => Array<{ x: number; y: number; width: number; height: number }> }).__blattwerkGlass());
    await expect.poll(async () => (await docRegions()).length).toBe(2);
    const [band, sidebar] = await docRegions();
    const workspaceTop = await doc.page.locator('[data-glass-workspace]').evaluate((el) => el.getBoundingClientRect().top);
    expect(band).toMatchObject({ x: 0, y: 0, height: workspaceTop });
    const box = await doc.page.getByTestId('left-sidebar').boundingBox();
    if (!box || !sidebar) throw new Error('Seitenleiste fehlt');
    expect(Math.abs(sidebar.x - box.x)).toBeLessThan(1);
    expect(Math.abs(sidebar.y - box.y)).toBeLessThan(1);
    expect(Math.abs(sidebar.height - box.height)).toBeLessThan(1);
    // Kommentarleiste macht das Band höher
    await menuClick(doc.app, 'view.toggleCommentTools');
    await expect.poll(async () => (await docRegions())[0]?.height ?? 0).toBeGreaterThan(workspaceTop + 20);
    // Seitenleiste aus: nur noch das Band
    await menuClick(doc.app, 'view.toggleSidebar');
    await expect.poll(async () => (await docRegions()).length).toBe(1);
    await doc.close();
  });

  test('Home-Knopf über einem Dokument: Startseite deckt ab, Glas nur im Band', async () => {
    test.skip(process.platform !== 'darwin', 'nur macOS');
    const { page, app, close } = await launchApp([fixture('text.pdf')]);
    const native = await page.evaluate(() => (window as unknown as { blattwerk: { getAppInfo(): Promise<{ nativeGlass: boolean }> } }).blattwerk.getAppInfo());
    test.skip(!native.nativeGlass, 'macOS ohne Liquid Glass');
    await waitForDocument(page, TEXT_PDF.pages);
    const regions = () => app.evaluate(() => (globalThis as unknown as { __blattwerkGlass: () => Array<{ x: number; y: number; width: number; height: number; windowOpaque: boolean }> }).__blattwerkGlass());
    await menuClick(app, 'app.home');
    const start = page.getByTestId('start-screen');
    await expect(start).toBeVisible();
    // Fehlerbericht: Dokument und Schreibtisch schienen durch die Startseite
    expect(await start.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    const workspaceTop = await page.locator('[data-glass-workspace]').evaluate((el) => el.getBoundingClientRect().top);
    await expect.poll(async () => (await regions()).map((r) => Math.round(r.height))).toEqual([Math.round(workspaceTop)]);
    // Zurück zum Dokument: wieder Band und Seitenleiste
    await page.keyboard.press('Escape');
    await expect(start).toHaveCount(0);
    await expect.poll(async () => (await regions()).length).toBe(2);
    await close();
  });
});

test('schmales Fenster: was nicht in die Leiste passt, steht im Menü „Weitere Werkzeuge“', async () => {
  const { page, app, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  const toolbar = page.getByTestId('toolbar');
  const fits = () => toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
  await expect(page.getByTestId('toolbar-more')).toHaveCount(0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('/index.html'))?.setSize(780, 700));
  await expect(page.getByTestId('toolbar-more')).toBeVisible();
  expect(await fits()).toBe(true);
  await expect(toolbar.getByTestId('zoom-select')).toHaveCount(0);
  await page.getByTestId('toolbar-more').click();
  const panel = page.getByTestId('toolbar-more-panel');
  await expect(panel.getByTestId('zoom-select')).toBeVisible();
  await panel.getByTestId('zoom-select').selectOption('2');
  await expect(panel).toBeVisible();
  // Menü liegt im Fenster unter dem Knopf
  const box = await panel.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 780).toBe(true);
  // Leisten der Arbeitsbereiche brechen um statt abzuschneiden
  await page.getByTestId('content-edit-button').click();
  await expect(panel).toHaveCount(0);
  const bar = page.getByTestId('content-edit-toolbar');
  expect(await bar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const done = await page.getByTestId('content-edit-done').boundingBox();
  expect(done && done.x + done.width).toBeLessThanOrEqual(780);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('/index.html'))?.setSize(1280, 860));
  await expect(page.getByTestId('toolbar-more')).toHaveCount(0);
  await expect(toolbar.getByTestId('zoom-select')).toBeVisible();
  await close();
});

test('Tab schließen, während ein neuer Text noch eingegeben wird: ein Klick auf ✕ reicht', async () => {
  const { page, app, close } = await launchApp([]);
  await menuClick(app, 'file.newBlank');
  await waitForDocument(page, 1);
  await expect(page.getByTestId('content-edit-toolbar')).toBeVisible();
  await page.getByTestId('content-tool-text').click();
  const overlay = await page.getByTestId('content-edit-overlay-0').boundingBox();
  if (!overlay) throw new Error('keine Ebene');
  await page.mouse.click(overlay.x + overlay.width * 0.3, overlay.y + overlay.height * 0.3);
  await page.keyboard.type('Noch offen');
  await page.getByTestId('tab').getByRole('button', { name: 'Tab schließen' }).click();
  await expect(page.getByTestId('prompt-discard')).toBeVisible({ timeout: 3000 });
  await page.getByTestId('prompt-discard').click();
  await expect(page.getByTestId('tab')).toHaveCount(0);

  // Dasselbe über das Menü (⌘W): Die Eingabe hat dabei noch den Fokus
  await menuClick(app, 'file.newBlank');
  await waitForDocument(page, 1);
  await page.getByTestId('content-tool-text').click();
  await page.mouse.click(overlay.x + overlay.width * 0.3, overlay.y + overlay.height * 0.3);
  await page.keyboard.type('Auch offen');
  await menuClick(app, 'file.close');
  await expect(page.getByTestId('prompt-discard')).toBeVisible({ timeout: 3000 });
  await page.getByTestId('prompt-discard').click();
  await expect(page.getByTestId('tab')).toHaveCount(0);
  await close();
});

test('Text unter einem später gezeichneten Bild lässt sich bearbeiten; Doppelklick aufs Bild erklärt sich', async () => {
  // Text zuerst, darüber ein Bild mit durchsichtigen Stellen (der Text scheint durch)
  const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([400, 400]);
  sheet.drawText('Unter dem Bild', { x: 60, y: 250, size: 16, font });
  const png = await doc.embedPng(readFileSync(imageFixture('transparent.png')));
  sheet.drawImage(png, { x: 20, y: 200, width: 360, height: 120 });
  const dir = mkdtempSync(path.join(tmpdir(), 'blattwerk-stapel-'));
  const file = path.join(dir, 'stapel.pdf');
  writeFileSync(file, await doc.save());
  const { page, close } = await launchApp([file], { userData: dir });
  await waitForDocument(page, 1);
  await page.getByTestId('content-edit-button').click();
  for (const text of ['Unter dem Bild']) {
    const target = page.locator(`[data-testid="content-object"][data-text="${text}"]`);
    const box = await target.boundingBox();
    if (!box) throw new Error(`${text} fehlt`);
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId('content-text-editor')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('content-text-editor')).toHaveCount(0);
  }
  // Doppelklick auf das Bild erklärt, warum sein Inhalt nicht als Text bearbeitbar ist
  const image = await page.locator('[data-testid="content-object"][data-kind="image"]').boundingBox();
  if (!image) throw new Error('Bild fehlt');
  await page.mouse.dblclick(image.x + image.width - 10, image.y + 10);
  await expect(page.getByText('Das ist ein Bild.', { exact: false })).toBeVisible();
  await close();
  removeTempDir(dir);
});

test('Stromsparen: Lichtschein ruht, Glas ohne Lichtbrechung, keine Neuberechnung beim Bewegen der Maus', async () => {
  const { page, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  // Wie „Transparenz reduzieren“ in macOS (im Akkubetrieb geschieht dasselbe)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await expect(page.locator('html[data-energy-saving]')).toHaveCount(1);
  const glass = page.locator('.liquid').first();
  await expect(glass).toBeAttached();
  expect(await glass.evaluate((element) => element.style.getPropertyValue('backdrop-filter'))).not.toContain('url(');
  await cdp.send('Performance.enable');
  const styleCount = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'RecalcStyleCount')?.value ?? 0;
  const box = await page.locator('.pdfViewer .page').first().boundingBox();
  if (!box) throw new Error('Seite ohne Größe');
  const before = await styleCount();
  for (let i = 0; i < 60; i++) await page.mouse.move(box.x + 40 + i * 6, box.y + 120);
  await page.waitForTimeout(200);
  expect((await styleCount()) - before).toBeLessThan(15);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--pointer-x'))).toBe('');
  await close();
});

