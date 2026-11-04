import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import de from '../../src/locales/de/translation.json';
import { COMMANDS } from '../../src/shared/commands';
import type { OpenErrorCode, ViewMode } from '../../src/shared/ipc';
import { APP_ID, PRODUCT_NAME } from '../../src/shared/product';
import { SHORTCUTS } from '../../src/shared/shortcuts';
import { PERMISSION_FLAGS } from '../../src/renderer/features/properties/properties';

vi.mock('electron', () => ({ Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() } }));

const root = path.resolve(import.meta.dirname, '../..');

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], de);
}

function keyExists(key: string): boolean {
  if (typeof lookup(key) === 'string') return true;
  // i18next-Pluralformen
  return typeof lookup(`${key}_one`) === 'string' && typeof lookup(`${key}_other`) === 'string';
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'public' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('Übersetzungen', () => {
  const files = sourceFiles(path.join(root, 'src'));

  it('jeder im Code verwendete Schlüssel existiert in de/translation.json', () => {
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) {
        const key = match[1] as string;
        if (!keyExists(key)) missing.push(`${path.relative(root, file)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('dynamisch zusammengesetzte Schlüssel sind vollständig', () => {
    const openErrors: OpenErrorCode[] = ['not-found', 'not-a-file', 'not-pdf', 'unreadable', 'cancelled'];
    const viewModes: ViewMode[] = ['single', 'continuous', 'two-page', 'two-page-continuous'];
    const keys = [
      ...openErrors.map((e) => `errors.open.${e}`),
      ...viewModes.map((m) => `viewMode.${m}`),
      ...Object.keys(PERMISSION_FLAGS).map((p) => `properties.permission.${p}`),
      'properties.portrait',
      'properties.landscape',
      'errors.load.invalid',
      'errors.load.generic',
    ];
    expect(keys.filter((key) => !keyExists(key))).toEqual([]);
  });

  it('der Produktname steht nicht hart in den Texten', () => {
    expect(JSON.stringify(de)).not.toContain(PRODUCT_NAME);
  });
});

describe('Menü und Tastenkürzel', () => {
  it('jeder Befehl hat einen Menüeintrag mit Übersetzung', async () => {
    const { buildMenuTemplate } = await import('../../src/main/menu');
    const collectIds = (items: Electron.MenuItemConstructorOptions[]): string[] =>
      items.flatMap((item) => [
        ...(item.id ? [item.id] : []),
        ...(Array.isArray(item.submenu) ? collectIds(item.submenu) : []),
      ]);
    for (const platform of ['darwin', 'win32'] as const) {
      const template = buildMenuTemplate({
        platform,
        state: { hasDocument: true, canPrint: true, viewMode: 'continuous', sidebarVisible: true, readMode: false, rightPanelVisible: false, tabCount: 2, dirtyCount: 0, canUndo: false, canRedo: false, activeDirty: false, commentToolsVisible: false, organizeMode: false, canAssemble: true, canExtract: true, formEditing: false, canEditForms: true, redactToolsVisible: false, hasRedactionMarks: false, contentEditing: false, markToolsVisible: false },
        recent: [],
        devTools: false,
        sendCommand: () => undefined,
        openFileDialog: () => undefined,
        openRecent: () => undefined,
        clearRecent: () => undefined,
        setDefaultApp: () => undefined,
        chooseUpdateFolder: () => undefined,
        mergeWindows: () => undefined,
        showAbout: () => undefined,
        windowCount: 1,
      });
      const ids = collectIds(template);
      expect(COMMANDS.filter((command) => !ids.includes(command))).toEqual([]);
      const labels = JSON.stringify(template);
      expect(labels).not.toMatch(/"label":"menu\./);
    }
  });

  it('Schließen wirkt auf jeden Tab; ohne Tabs schließt Cmd+W unter macOS nur ein weiteres Fenster', async () => {
    const { buildMenuTemplate } = await import('../../src/main/menu');
    const base = {
      recent: [],
      devTools: false,
      sendCommand: () => undefined,
      openFileDialog: () => undefined,
      openRecent: () => undefined,
      clearRecent: () => undefined,
      setDefaultApp: () => undefined,
      chooseUpdateFolder: () => undefined,
      mergeWindows: () => undefined,
      showAbout: () => undefined,
      windowCount: 1,
    };
    const state = { hasDocument: false, canPrint: false, viewMode: null, sidebarVisible: true, readMode: false, rightPanelVisible: false, dirtyCount: 0, canUndo: false, canRedo: false, activeDirty: false, commentToolsVisible: false, organizeMode: false, canAssemble: true, canExtract: true, formEditing: false, canEditForms: false, redactToolsVisible: false, hasRedactionMarks: false, contentEditing: false, markToolsVisible: false };
    const flatten = (items: Electron.MenuItemConstructorOptions[]): Electron.MenuItemConstructorOptions[] =>
      items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);

    const loading = flatten(buildMenuTemplate({ ...base, platform: 'darwin', state: { ...state, tabCount: 1 } }));
    expect(loading.find((i) => i.id === 'file.close')?.enabled).toBe(true);

    // Letztes Fenster ohne Tabs: ⌘W ist ausgegraut, die Startseite bleibt (beendet würde sonst die App)
    const empty = flatten(buildMenuTemplate({ ...base, platform: 'darwin', state: { ...state, tabCount: 0 } }));
    expect(empty.some((i) => i.role === 'close')).toBe(false);
    expect(empty.find((i) => i.id === 'file.close')?.enabled).toBe(false);
    const emptyOfTwo = flatten(buildMenuTemplate({ ...base, windowCount: 2, platform: 'darwin', state: { ...state, tabCount: 0 } }));
    expect(emptyOfTwo.some((i) => i.role === 'close' && i.accelerator === 'CmdOrCtrl+W')).toBe(true);

    // Windows: „Hilfe“ mit „Über“ und den Update-Befehlen, unter macOS stehen sie im App-Menü
    const winMenu = buildMenuTemplate({ ...base, platform: 'win32', state: { ...state, tabCount: 0 } });
    const help = winMenu[winMenu.length - 1];
    expect(help?.id).toBe('help');
    expect(flatten([help as Electron.MenuItemConstructorOptions]).map((i) => i.id)).toEqual(expect.arrayContaining(['help.about', 'app.checkUpdates']));
    expect(empty.some((i) => i.id === 'help.about')).toBe(false);

    const emptyWin = flatten(buildMenuTemplate({ ...base, platform: 'win32', state: { ...state, tabCount: 0 } }));
    expect(emptyWin.find((i) => i.id === 'file.close')?.enabled).toBe(false);

    // „Alle Fenster zusammenführen“ erst ab zwei Fenstern
    expect(empty.find((i) => i.id === 'window.mergeAll')?.enabled).toBe(false);
    const two = flatten(buildMenuTemplate({ ...base, windowCount: 2, platform: 'win32', state: { ...state, tabCount: 1 } }));
    expect(two.find((i) => i.id === 'window.mergeAll')?.enabled).toBe(true);
  });

  it('maskiert & in Dateinamen der Zuletzt-Liste', async () => {
    const { buildMenuTemplate } = await import('../../src/main/menu');
    const template = buildMenuTemplate({
      platform: 'win32',
      state: { hasDocument: false, canPrint: false, viewMode: null, sidebarVisible: true, readMode: false, rightPanelVisible: false, tabCount: 0, dirtyCount: 0, canUndo: false, canRedo: false, activeDirty: false, commentToolsVisible: false, organizeMode: false, canAssemble: true, canExtract: true, formEditing: false, canEditForms: false, redactToolsVisible: false, hasRedactionMarks: false, contentEditing: false, markToolsVisible: false },
      recent: [{ path: 'C:\\A & B\\AGB & Datenschutz.pdf', name: 'AGB & Datenschutz.pdf', dir: 'C:\\A & B', openedAt: 1 }],
      devTools: false,
      sendCommand: () => undefined,
      openFileDialog: () => undefined,
      openRecent: () => undefined,
      clearRecent: () => undefined,
      setDefaultApp: () => undefined,
      chooseUpdateFolder: () => undefined,
      mergeWindows: () => undefined,
      showAbout: () => undefined,
      windowCount: 1,
    });
    const text = JSON.stringify(template);
    expect(text).toContain('AGB && Datenschutz.pdf');
    expect(text).toContain('C:\\\\A && B');
  });

  it('Kürzel sind eindeutig', () => {
    const accelerators = Object.values(SHORTCUTS).map((s) => s?.accelerator);
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });
});

describe('Produktname und App-ID', () => {
  it('stimmen in package.json und electron-builder.yml überein', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { productName: string };
    const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    expect(pkg.productName).toBe(PRODUCT_NAME);
    expect(builder).toContain(`appId: ${APP_ID}`);
    expect(builder).toContain(`productName: ${PRODUCT_NAME}`);
  });
});
