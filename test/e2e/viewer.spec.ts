import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fixture, LARGE_PDF, PASSWORDS, TEXT_PDF } from '../fixtures/expectations';
import { appWindows, currentPage, expectWindowCount, launchApp, menuClick, menuItemState, mergeAllWindows, waitForDocument, windowWithTitle } from './app';

test.describe('Start und Öffnen', () => {
  test('ohne Datei erscheint der Startbildschirm', async () => {
    const { page, app, close } = await launchApp();
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await expect(page).toHaveTitle('Blattwerk');
    expect(await menuItemState(app, 'file.print')).toMatchObject({ enabled: false });
    await close();
  });

  test('öffnet eine Datei über die Kommandozeile und zeigt Seiten, Miniaturen und Titel', async () => {
    const { page, app, close } = await launchApp([fixture('text.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await expect(page).toHaveTitle('text.pdf – Blattwerk');
    await expect(page.getByTestId('tab')).toHaveCount(1);
    await expect(page.locator('[data-testid="thumbnail"][data-loaded="true"]').first()).toBeVisible();
    expect(await menuItemState(app, 'file.print')).toMatchObject({ enabled: true });
    await close();
  });

  test('mehrere Dokumente öffnen je ein eigenes Fenster; zusammengeführt als Tabs wechseln und schließen', async () => {
    const { app, close } = await launchApp([fixture('text.pdf'), fixture('formular.pdf')]);
    await expectWindowCount(app, 2);
    const textWindow = await windowWithTitle(app, 'text.pdf');
    await waitForDocument(textWindow, TEXT_PDF.pages);
    await expect(textWindow.getByTestId('tab')).toHaveCount(1);
    const formWindow = await windowWithTitle(app, 'formular.pdf');
    await waitForDocument(formWindow, 1);
    // Zusammenführen: Das vordere Fenster übernimmt den Tab des anderen
    const page = await mergeAllWindows(app);
    await expect(page.getByTestId('tab')).toHaveCount(2);
    const textTab = page.getByTestId('tab').filter({ hasText: 'text.pdf' });
    const formTab = page.getByTestId('tab').filter({ hasText: 'formular.pdf' });
    await textTab.click();
    await waitForDocument(page, TEXT_PDF.pages);
    await formTab.click();
    await waitForDocument(page, 1);
    await formTab.getByRole('button').click();
    await expect(page.getByTestId('tab')).toHaveCount(1);
    await waitForDocument(page, TEXT_PDF.pages);
    await close();
  });

  test('zuletzt geöffnete Dateien überstehen einen Neustart', async () => {
    const first = await launchApp([fixture('text.pdf')], { keepUserData: true });
    await waitForDocument(first.page, TEXT_PDF.pages);
    await first.app.close();
    const second = await launchApp([], { userData: first.userData });
    const list = second.page.getByTestId('recent-list');
    await expect(list.getByText('text.pdf')).toBeVisible();
    await list.getByText('text.pdf').click();
    await waitForDocument(second.page, TEXT_PDF.pages);
    await second.close();
  });

  test('meldet Dateien, die kein PDF sind', async () => {
    const { page, close } = await launchApp([fixture('kein-pdf.pdf')]);
    await expect(page.getByTestId('notices')).toContainText('kein PDF-Dokument');
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await close();
  });
});

test.describe('Navigation und Ansicht', () => {
  test('Seiten blättern mit Tasten, Eingabefeld und Menü', async () => {
    const { page, app, close } = await launchApp([fixture('text.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await page.getByTestId('viewer-container').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('End');
    await expect.poll(() => currentPage(page)).toBe(TEXT_PDF.pages);
    await page.keyboard.press('Home');
    await expect.poll(() => currentPage(page)).toBe(1);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => currentPage(page)).toBe(2);
    await page.getByTestId('page-input').fill('7');
    await page.getByTestId('page-input').press('Enter');
    await expect.poll(() => currentPage(page)).toBe(7);
    await menuClick(app, 'nav.goToPage');
    await page.getByTestId('goto-input').fill('11');
    await page.getByTestId('goto-input').press('Enter');
    await expect.poll(() => currentPage(page)).toBe(11);
    await close();
  });

  test('Miniaturen, Lesezeichen und Links springen zur richtigen Seite', async () => {
    const { page, close } = await launchApp([fixture('text.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await page.locator('[data-testid="thumbnail"][data-page="4"]').click();
    await expect.poll(() => currentPage(page)).toBe(4);

    await page.getByTestId('sidebar-bookmarks').click();
    const items = page.getByTestId('outline-item');
    await expect(items.filter({ hasText: 'Kapitel 2' })).toBeVisible();
    await items.filter({ hasText: 'Kapitel 2' }).click();
    await expect.poll(() => currentPage(page)).toBe(TEXT_PDF.outlineTargets['Kapitel 2']);
    await items.filter({ hasText: 'Abschnitt 1.2' }).click();
    await expect.poll(() => currentPage(page)).toBe(TEXT_PDF.outlineTargets['Abschnitt 1.2']);

    // Interner Link im Inhaltsverzeichnis auf Seite 1
    await page.getByTestId('page-input').fill('1');
    await page.getByTestId('page-input').press('Enter');
    const tocLink = page.locator('[data-testid="active-pane"] .page[data-page-number="1"] .annotationLayer a').first();
    await expect(tocLink).toBeAttached();
    await tocLink.click();
    await expect.poll(() => currentPage(page)).toBe(TEXT_PDF.tocLinks[0]);
    await close();
  });

  test('externe Links öffnen nur nach Rückfrage', async () => {
    const { page, app, close } = await launchApp([fixture('text.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await app.evaluate(({ dialog, shell }) => {
      const g = globalThis as unknown as { __asked: string[]; __opened: string[] };
      g.__asked = [];
      g.__opened = [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.find((a) => typeof a === 'object' && a !== null && 'detail' in (a as object)) as { detail: string };
        g.__asked.push(options.detail);
        return { response: 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
      shell.openExternal = (async (url: string) => {
        g.__opened.push(url);
      }) as typeof shell.openExternal;
    });
    const external = page.locator(`[data-testid="active-pane"] .annotationLayer a[href="${TEXT_PDF.externalUrl}"]`);
    await expect(external).toBeAttached();
    await external.click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { __asked: string[] }).__asked))
      .toEqual([TEXT_PDF.externalUrl]);
    expect(await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([]);
    // Das Fenster bleibt auf der App, es öffnet sich kein zweites Fenster.
    expect(appWindows(app)).toHaveLength(1);
    await close();
  });

  test('Zoom über Auswahl, Schaltflächen, Menü und Trackpad-Geste', async () => {
    const { page, app, close } = await launchApp([fixture('text.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    const zoom = page.getByTestId('zoom-select');
    await zoom.selectOption('2');
    await expect(zoom).toHaveValue('2');
    await page.getByRole('button', { name: 'Verkleinern' }).click();
    await expect(zoom).not.toHaveValue('2');
    await menuClick(app, 'view.fitWidth');
    await expect(zoom).toHaveValue('page-width');
    await menuClick(app, 'view.actualSize');
    await expect(zoom).toHaveValue('page-actual');

    // Pinch-Geste: Chromium meldet sie als Wheel-Ereignis mit gedrückter Strg-Taste.
    const before = await page.locator('[data-testid="active-pane"] .page').first().boundingBox();
    await page.getByTestId('viewer-container').evaluate((element) => {
      for (let i = 0; i < 20; i++) {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -4, ctrlKey: true, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
      }
    });
    await expect
      .poll(async () => (await page.locator('[data-testid="active-pane"] .page').first().boundingBox())?.width ?? 0)
      .toBeGreaterThan((before?.width ?? 0) * 1.3);
    await close();
  });

  test('Seitenanzeige: einzeln, fortlaufend, zwei Seiten', async () => {
    const { page, app, close } = await launchApp([fixture('text.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    const pages = page.locator('[data-testid="active-pane"] .pdfViewer .page');
    const mode = page.getByTestId('view-mode-select');

    await mode.selectOption('single');
    await expect.poll(() => pages.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).length)).toBe(1);
    expect(await menuItemState(app, 'view.modeSingle')).toMatchObject({ checked: true });

    await mode.selectOption('two-page');
    await expect(page.locator('[data-testid="active-pane"] .pdfViewer .spread').first()).toBeVisible();
    await expect.poll(() => pages.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).length)).toBe(2);

    await menuClick(app, 'view.modeTwoPageContinuous');
    await expect(mode).toHaveValue('two-page-continuous');
    await expect.poll(() => page.locator('[data-testid="active-pane"] .pdfViewer .spread').count()).toBeGreaterThan(2);

    await mode.selectOption('continuous');
    await expect.poll(() => pages.count()).toBe(TEXT_PDF.pages);
    await close();
  });
});

test.describe('Suche, Text und Eigenschaften', () => {
  test('Volltextsuche markiert Treffer und listet sie seitenweise', async () => {
    const { page, close } = await launchApp([fixture('text.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await page.getByTestId('search-button').click();
    await page.getByTestId('search-input').fill(TEXT_PDF.searchTerm);
    await expect(page.getByTestId('search-status')).toHaveText(`1 von ${TEXT_PDF.searchHits} Treffern`);
    await expect(page.getByTestId('search-results').locator('li')).toHaveCount(TEXT_PDF.searchHits);
    // Jede Zeile der Ergebnisliste hebt genau den Suchbegriff hervor.
    await expect(page.getByTestId('search-results').locator('mark')).toHaveCount(TEXT_PDF.searchHits);
    for (const mark of await page.getByTestId('search-results').locator('mark').all()) {
      await expect(mark).toHaveText(TEXT_PDF.searchTerm);
    }
    await expect(page.locator('[data-testid="active-pane"] .textLayer .highlight').first()).toBeVisible();
    await page.getByTestId('search-input').press('Enter');
    await expect(page.getByTestId('search-status')).toHaveText(`2 von ${TEXT_PDF.searchHits} Treffern`);
    await page.getByTestId('search-results').locator('li').last().click();
    await expect.poll(() => currentPage(page)).toBe(9);
    await page.getByTestId('search-input').fill('gibtesnicht');
    await expect(page.getByTestId('search-status')).toHaveText('Keine Treffer');
    await close();
  });

  test('Text auswählen und kopieren', async () => {
    const { page, app, close } = await launchApp([fixture('text.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await app.evaluate(({ clipboard }) => clipboard.clear());
    const span = page.locator('[data-testid="active-pane"] .page[data-page-number="1"] .textLayer span', { hasText: 'Umlaute' }).first();
    await expect(span).toBeAttached();
    await span.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.evaluate(() => document.execCommand('copy'));
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('ä, ö und ü');
    await close();
  });

  test('Dokumenteigenschaften zeigen Metadaten und Seitenformat', async () => {
    const { page, close } = await launchApp([fixture('text.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await page.getByTestId('properties-button').click();
    const dialog = page.getByTestId('properties-dialog');
    await expect(dialog).toContainText(TEXT_PDF.title);
    await expect(dialog).toContainText(TEXT_PDF.author);
    await expect(dialog).toContainText('A4');
    await expect(dialog).toContainText('Kein Schutz');
    await dialog.getByRole('button', { name: 'Schließen' }).click();
    await expect(dialog).toHaveCount(0);
    await close();
  });
});

test.describe('Geschützte und beschädigte Dateien', () => {
  test('kennwortgeschütztes PDF: falsches Kennwort, dann richtiges', async () => {
    const { page, close } = await launchApp([fixture('verschluesselt.pdf')]);
    const dialog = page.getByTestId('password-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('password-input').fill('falsch');
    await page.getByTestId('password-input').press('Enter');
    await expect(page.getByTestId('password-incorrect')).toBeVisible();
    await page.getByTestId('password-input').fill(PASSWORDS.user);
    await page.getByTestId('password-input').press('Enter');
    await waitForDocument(page, TEXT_PDF.pages);
    await page.getByTestId('properties-button').click();
    await expect(page.getByTestId('properties-dialog')).toContainText('Kennwortschutz zum Öffnen');
    await expect(page.getByTestId('properties-dialog')).toContainText('Kopieren');
    await close();
  });

  test('Abbrechen der Kennwortabfrage schließt den Tab', async () => {
    const { page, close } = await launchApp([fixture('verschluesselt.pdf')]);
    await expect(page.getByTestId('password-dialog')).toBeVisible();
    await page.getByTestId('password-dialog').getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await close();
  });

  test('Drucken ist gesperrt, wenn das PDF es verbietet', async () => {
    const { page, app, close } = await launchApp([fixture('eingeschraenkt.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await expect(page.getByTestId('print-button')).toBeDisabled();
    expect(await menuItemState(app, 'file.print')).toMatchObject({ enabled: false });
    await close();
  });

  test('PDF mit kaputter Querverweistabelle wird repariert angezeigt', async () => {
    const { page, close } = await launchApp([fixture('kaputte-xref.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await close();
  });

  test('abgeschnittenes PDF stürzt nicht ab', async () => {
    const { page, close } = await launchApp([fixture('abgeschnitten.pdf')]);
    await expect(page.getByTestId('tab')).toHaveCount(1);
    await expect(page.locator('[data-testid="load-error"], [data-testid="active-pane"] .pdfViewer .page canvas').first()).toBeVisible();
    await close();
  });

  test('Scan ohne Textebene wird angezeigt', async () => {
    const { page, close } = await launchApp([fixture('scan.pdf')]);
    await waitForDocument(page, 1);
    await close();
  });
});

test.describe('Drucken', () => {
  test('druckt alle Seiten', async () => {
    const { page, printDir, close } = await launchApp([fixture('text.pdf')]);
    await waitForDocument(page, TEXT_PDF.pages);
    await page.getByTestId('print-button').click();
    await expect.poll(() => (existsSync(printDir) ? readdirSync(printDir).length : 0), { timeout: 60_000 }).toBe(1);
    const file = path.join(printDir, (readdirSync(printDir)[0] as string));
    const pdf = readFileSync(file, 'latin1');
    const pageCount = (pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBe(TEXT_PDF.pages);
    await expect(page.getByTestId('print-progress')).toHaveCount(0);
    await close();
  });
});

test.describe('Oberfläche', () => {
  test('Dunkelmodus folgt dem System', async () => {
    const { page, app, close } = await launchApp();
    // Hintergrundfarbe der App (der Seitenhintergrund selbst ist unter macOS 26 durchsichtig, darunter liegt Glas)
    const background = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim());
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light';
    });
    const light = await background();
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark';
    });
    await expect.poll(background).not.toBe(light);
    await close();
  });

  test('Sicherheitseinstellungen des Fensters', async () => {
    const { page, app, close } = await launchApp();
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('/index.html'));
      // getLastWebPreferences fehlt in den Typen von Electron 44, ist zur Laufzeit aber vorhanden.
      const p = (win?.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences } | undefined)?.getLastWebPreferences();
      return { contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration, sandbox: p?.sandbox, webSecurity: p?.webSecurity };
    });
    expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
    expect(await page.evaluate(() => typeof (window as unknown as { process?: unknown }).process)).toBe('undefined');
    // Keine Netzwerkzugriffe aus der App, und die CSP gilt auch für Skripte und Worker.
    const fetchResult = await page.evaluate(() =>
      fetch('https://example.com/').then(
        () => 'erreicht',
        () => 'blockiert',
      ),
    );
    expect(fetchResult).toBe('blockiert');
    const scriptCsp = await page.evaluate(async () => {
      const src = (document.querySelector('script[type="module"]') as HTMLScriptElement | null)?.src ?? '';
      return (await fetch(src)).headers.get('content-security-policy');
    });
    expect(scriptCsp).toContain("script-src 'self'");
    // Navigation aus der App heraus wird verhindert.
    await page.evaluate(() => {
      window.location.href = 'https://example.com/';
    });
    await page.waitForTimeout(500);
    expect(page.url()).toMatch(/^app:\/\/bundle\//);
    await close();
  });
});

test.describe('Große Datei', () => {
  test.skip(!existsSync(LARGE_PDF), 'Große Testdatei fehlt (npm run fixtures -- --large)');

  test('600 Seiten mit über 100 MB öffnen und flüssig bedienen', async () => {
    const started = Date.now();
    const { page, close } = await launchApp([LARGE_PDF]);
    await waitForDocument(page, 600);
    const openMs = Date.now() - started;

    // Lange Blockaden des Hauptthreads messen, während durch das Dokument gesprungen wird.
    await page.evaluate(() => {
      const g = window as unknown as { __longTasks: number[] };
      g.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) g.__longTasks.push(entry.duration);
      }).observe({ type: 'longtask' as PerformanceObserverInit['type'], buffered: false });
    });
    await page.getByTestId('viewer-container').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('End');
    await expect.poll(() => currentPage(page)).toBe(600);
    await expect(page.locator('[data-testid="active-pane"] .page[data-page-number="600"] canvas')).toBeVisible();
    for (const target of [300, 150, 450]) {
      await page.getByTestId('page-input').fill(String(target));
      await page.getByTestId('page-input').press('Enter');
      await expect.poll(() => currentPage(page)).toBe(target);
    }
    await page.getByTestId('viewer-container').evaluate(async (element) => {
      for (let i = 0; i < 40; i++) {
        element.scrollTop += 900;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
    const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
    const worst = Math.max(0, ...longTasks);
    console.log(`Öffnen: ${openMs} ms, längste Blockade: ${Math.round(worst)} ms, Blockaden > 50 ms: ${longTasks.length}`);
    expect(openMs).toBeLessThan(15_000);
    expect(worst).toBeLessThan(500);
    await close();
  });
});

test('Zoom: Prozentwert eintippen, Enter übernimmt, Esc verwirft', async () => {
  const { page, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  const input = page.getByTestId('zoom-input');
  await input.click();
  await input.fill('137');
  await input.press('Enter');
  await expect(input).toHaveValue('137 %');
  await expect(page.getByTestId('zoom-select')).toHaveValue('custom');
  // Komma und Prozentzeichen sind erlaubt; Unsinn ändert nichts
  await input.click();
  await input.fill('62,5 %');
  await input.press('Enter');
  await expect(input).toHaveValue(/^6[23] %$/);
  await input.click();
  await input.fill('abc');
  await input.press('Enter');
  await expect(input).toHaveValue(/^6[23] %$/);
  await input.click();
  await input.fill('300');
  await input.press('Escape');
  await expect(input).toHaveValue(/^6[23] %$/);
  // Die Liste wählt weiter feste Stufen
  await page.getByTestId('zoom-select').selectOption('page-fit');
  await expect(page.getByTestId('zoom-select')).toHaveValue('page-fit');
  await close();
});

test('Pinch-Zoom: Vorschau während der Geste, danach ohne Sprung scharf gesetzt', async () => {
  const { page, app, close } = await launchApp([fixture('text.pdf')]);
  await waitForDocument(page, TEXT_PDF.pages);
  await menuClick(app, 'view.fitWidth');
  await expect(page.getByTestId('zoom-select')).toHaveValue('page-width');
  const before = await page.locator('[data-testid="active-pane"] .page').first().boundingBox();
  const scaleBefore = await page.getByTestId('zoom-select').inputValue();
  // Eine Geste: viele kleine Schritte hintereinander, Zeiger fest
  const during = await page.getByTestId('viewer-container').evaluate(async (element) => {
    const box = element.getBoundingClientRect();
    for (let i = 0; i < 30; i++) {
      element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -3, deltaMode: 0, clientX: box.left + 250, clientY: box.top + 200, bubbles: true, cancelable: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const pageBox = element.querySelector('.page')?.getBoundingClientRect();
    return { transform: (element.querySelector('.pdfViewer') as HTMLElement).style.transform, left: pageBox?.left ?? 0, top: pageBox?.top ?? 0, width: pageBox?.width ?? 0 };
  });
  // Während der Geste: nur vergrößertes Bild, pdf.js hat den Maßstab noch nicht übernommen
  expect(during.transform).toContain('scale(');
  expect(during.width).toBeGreaterThan((before?.width ?? 0) * 1.5);
  expect(await page.getByTestId('zoom-select').inputValue()).toBe(scaleBefore);
  // Danach übernimmt pdf.js den Maßstab; die Seite bleibt, wo die Vorschau sie gezeigt hat
  await expect.poll(() => page.locator('[data-testid="active-pane"] .pdfViewer').evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
  await expect(page.getByTestId('zoom-select')).not.toHaveValue(scaleBefore);
  const after = await page.getByTestId('viewer-container').evaluate((element) => {
    const pageBox = element.querySelector('.page')?.getBoundingClientRect();
    return { left: pageBox?.left ?? 0, top: pageBox?.top ?? 0, width: pageBox?.width ?? 0 };
  });
  expect(Math.abs(after.width - during.width)).toBeLessThan(during.width * 0.02);
  expect(Math.abs(after.left - during.left)).toBeLessThan(6);
  expect(Math.abs(after.top - during.top)).toBeLessThan(6);
  await close();
});
