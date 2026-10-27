import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { parseAccelerator } from '../../src/ios/accelerator';
import { buildMenuTemplate } from '../../src/main/menu-template';
import { COMMANDS } from '../../src/shared/commands';
import { SHORTCUTS } from '../../src/shared/shortcuts';
import { blankPdf } from '../../src/shared/blank-pdf';

const state = {
  hasDocument: true,
  canPrint: true,
  viewMode: 'continuous' as const,
  sidebarVisible: true,
  rightPanelVisible: false,
  tabCount: 2,
  dirtyCount: 0,
  canUndo: false,
  canRedo: false,
  activeDirty: false,
  commentToolsVisible: false,
  organizeMode: false,
  canAssemble: true,
  canExtract: true,
  formEditing: false,
  canEditForms: true,
  redactToolsVisible: false,
  hasRedactionMarks: false,
  contentEditing: false,
  markToolsVisible: false,
};

const noop = () => undefined;
const flatten = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);

describe('iPad-App (ADR 0029)', () => {
  it('übersetzt alle Tastenkürzel der zentralen Tabelle', () => {
    expect(parseAccelerator('Shift+CmdOrCtrl+S')).toEqual({ input: 's', modifiers: ['shift', 'command'] });
    expect(parseAccelerator('CmdOrCtrl+Plus')).toEqual({ input: '+', modifiers: ['command'] });
    expect(parseAccelerator('CmdOrCtrl+-')).toEqual({ input: '-', modifiers: ['command'] });
    expect(parseAccelerator('Ctrl+Shift+Tab')).toEqual({ input: '\t', modifiers: ['control', 'shift'] });
    for (const shortcut of Object.values(SHORTCUTS)) {
      if (shortcut) expect(parseAccelerator(shortcut.accelerator), shortcut.accelerator).not.toBeNull();
    }
  });

  it('Menü ohne Mac-Einträge, aber mit allen Befehlen, die es auf dem iPad gibt', () => {
    const template = buildMenuTemplate({
      platform: 'ios',
      state,
      windowCount: 1,
      recent: [],
      devTools: false,
      sendCommand: noop,
      openFileDialog: noop,
      openRecent: noop,
      clearRecent: noop,
      setDefaultApp: noop,
      chooseUpdateFolder: noop,
      mergeWindows: noop,
      showAbout: noop,
    });
    const items = flatten(template);
    const ids = items.map((item) => item.id);
    // Updates (SideStore) und Tabs in neue Fenster gibt es auf dem iPad nicht
    const missing = COMMANDS.filter((command) => !ids.includes(command));
    expect(missing).toEqual(['app.checkUpdates', 'window.moveTabToNewWindow']);
    const roles = items.map((item) => item.role).filter(Boolean);
    expect(roles.every((role) => ['cut', 'copy', 'paste', 'selectAll'].includes(role as string))).toBe(true);
    expect(ids).toContain('help.about');
    expect(ids).not.toContain('window.mergeAll');
  });

  it('leeres Dokument ohne Node (Querverweise stimmen)', () => {
    const bytes = blankPdf(new Date(Date.UTC(2026, 9, 27)));
    const text = new TextDecoder('latin1').decode(bytes);
    const xref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...text.matchAll(/(\d{10}) 00000 n/g)].map((match) => Number(match[1]));
    offsets.forEach((offset, i) => expect(text.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });
});
