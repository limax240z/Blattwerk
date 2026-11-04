import type { CommandId } from './commands';

// Zentrale Tabelle aller Tastenkürzel. Menü und Renderer lesen nur von hier.
// Schreibweise wie Electron-Accelerators; "CmdOrCtrl" wird auf dem Mac zu Cmd, unter Windows zu Strg.
//
// rendererHandled: true heißt, das Kürzel wird im Renderer ausgewertet und im Menü nur angezeigt.
// Das gilt für Tasten wie Pfeile oder Pos1, die in Eingabefeldern ihre normale Bedeutung behalten müssen.
export interface Shortcut {
  accelerator: string;
  rendererHandled?: boolean;
}

export const SHORTCUTS: Partial<Record<CommandId, Shortcut>> = {
  'file.open': { accelerator: 'CmdOrCtrl+O' },
  'file.newBlank': { accelerator: 'CmdOrCtrl+N' },
  'app.home': { accelerator: 'Shift+CmdOrCtrl+H' },
  'file.close': { accelerator: 'CmdOrCtrl+W' },
  'file.save': { accelerator: 'CmdOrCtrl+S' },
  'file.saveAs': { accelerator: 'Shift+CmdOrCtrl+S' },
  'file.print': { accelerator: 'CmdOrCtrl+P' },
  'file.properties': { accelerator: 'CmdOrCtrl+D' },
  'app.settings': { accelerator: 'CmdOrCtrl+,' },
  'edit.undo': { accelerator: 'CmdOrCtrl+Z' },
  'edit.redo': { accelerator: 'Shift+CmdOrCtrl+Z' },
  // Entfernen löscht den ausgewählten Kommentar; in Eingabefeldern bleibt die Taste unberührt.
  'edit.delete': { accelerator: 'Backspace', rendererHandled: true },
  'edit.find': { accelerator: 'CmdOrCtrl+F' },
  'edit.findNext': { accelerator: 'CmdOrCtrl+G' },
  'edit.findPrevious': { accelerator: 'Shift+CmdOrCtrl+G' },
  'view.zoomIn': { accelerator: 'CmdOrCtrl+Plus' },
  'view.zoomOut': { accelerator: 'CmdOrCtrl+-' },
  'view.fitPage': { accelerator: 'CmdOrCtrl+0' },
  'view.actualSize': { accelerator: 'CmdOrCtrl+1' },
  'view.fitWidth': { accelerator: 'CmdOrCtrl+2' },
  'view.rotateClockwise': { accelerator: 'Shift+CmdOrCtrl+Plus' },
  'view.rotateCounterClockwise': { accelerator: 'Shift+CmdOrCtrl+-' },
  'view.toggleSidebar': { accelerator: 'F4' },
  'view.readMode': { accelerator: 'Shift+CmdOrCtrl+L' },
  'nav.firstPage': { accelerator: 'Home', rendererHandled: true },
  'nav.previousPage': { accelerator: 'Left', rendererHandled: true },
  'nav.nextPage': { accelerator: 'Right', rendererHandled: true },
  'nav.lastPage': { accelerator: 'End', rendererHandled: true },
  'nav.goToPage': { accelerator: 'Shift+CmdOrCtrl+N' },
  // Seiten: dieselben Kürzel wie in Acrobat
  'pages.rotateClockwise': { accelerator: 'Shift+CmdOrCtrl+R' },
  'pages.delete': { accelerator: 'Shift+CmdOrCtrl+D' },
  'pages.insertFromFile': { accelerator: 'Shift+CmdOrCtrl+I' },
  'window.nextTab': { accelerator: 'Ctrl+Tab' },
  'window.previousTab': { accelerator: 'Ctrl+Shift+Tab' },
};

const KEY_ALIASES: Record<string, string> = {
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Plus: '+',
};

// Prüft, ob ein Tastendruck im Renderer zu einem rendererHandled-Kürzel passt.
// Nur für einfache Kürzel ohne Modifier gedacht (Pfeile, Pos1, Ende).
export function matchRendererShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): CommandId | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return null;
  }
  for (const [command, shortcut] of Object.entries(SHORTCUTS)) {
    if (!shortcut?.rendererHandled) continue;
    const key = KEY_ALIASES[shortcut.accelerator] ?? shortcut.accelerator;
    if (key === event.key) {
      return command as CommandId;
    }
  }
  return null;
}
