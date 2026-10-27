// Tastenkürzel aus der zentralen Tabelle (src/shared/shortcuts.ts) für die Tastatur am iPad übersetzen.

const KEY_NAMES: Record<string, string> = {
  plus: '+',
  left: 'left',
  right: 'right',
  up: 'up',
  down: 'down',
  home: 'home',
  end: 'end',
  tab: '\t',
  backspace: 'delete',
  delete: 'delete',
  escape: 'escape',
  f4: 'f4',
};

// „Shift+CmdOrCtrl+S“ → { input: 's', modifiers: ['shift', 'command'] }
export function parseAccelerator(accelerator: string): { input: string; modifiers: string[] } | null {
  const parts = accelerator.split('+');
  // Die Taste steht am Ende; „Plus“ steht für +
  const last = parts.pop();
  if (last === undefined) return null;
  const modifiers: string[] = [];
  for (const part of parts) {
    const name = part.toLowerCase();
    if (name === 'cmdorctrl' || name === 'cmd' || name === 'command') modifiers.push('command');
    else if (name === 'ctrl' || name === 'control') modifiers.push('control');
    else if (name === 'shift') modifiers.push('shift');
    else if (name === 'alt' || name === 'option') modifiers.push('alternate');
    else if (name !== '') return null;
  }
  const lower = last.toLowerCase();
  const input = KEY_NAMES[lower] ?? (last.length === 1 ? lower : null);
  return input === null ? null : { input, modifiers };
}
