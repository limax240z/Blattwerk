// Menüleiste auf dem iPad (ADR 0029): derselbe Aufbau wie auf dem Mac (buildMenuTemplate mit platform 'ios'), als
// einfache Beschreibung an die Hülle (ios/Blattwerk/MenuBar.swift). Klicks kommen als Ereignis „menu“ mit der Kennung
// zurück und lösen hier die zugehörige Funktion aus.
import type { MenuItemConstructorOptions } from 'electron';
import { buildMenuTemplate, type MenuContext } from '../main/menu-template';
import { parseAccelerator } from './accelerator';
import { call, on } from './native';

// Eintrag für die Hülle. role: Bearbeiten-Befehle des Systems (Ausschneiden, Kopieren, Einsetzen, Alles auswählen)
export interface NativeMenuItem {
  id?: string;
  title?: string;
  separator?: true;
  // window: Einträge in das Fenster-Menü des Systems übernehmen
  system?: 'window';
  role?: 'cut' | 'copy' | 'paste' | 'selectAll';
  enabled?: boolean;
  checked?: boolean;
  // Taste und Umschalter für die Tastatur am iPad, z. B. { input: 's', modifiers: ['command', 'shift'] }
  key?: { input: string; modifiers: string[] };
  children?: NativeMenuItem[];
}

const ROLES = new Set(['cut', 'copy', 'paste', 'selectAll']);

export class IpadMenu {
  #actions = new Map<string, () => void>();

  constructor() {
    on('menu', (payload) => {
      if (typeof payload === 'string') this.#actions.get(payload)?.();
    });
  }

  apply(ctx: Omit<MenuContext, 'platform'>): void {
    this.#actions.clear();
    const menus = buildMenuTemplate({ ...ctx, platform: 'ios' })
      .map((item) => this.#convert(item))
      .filter((item): item is NativeMenuItem => item !== null && (item.children?.length ?? 0) > 0);
    void call('menu.set', { menus }).catch(() => undefined);
  }

  #convert(item: MenuItemConstructorOptions): NativeMenuItem | null {
    if (item.type === 'separator') return { separator: true };
    const title = item.label?.replaceAll('&&', '&');
    if (Array.isArray(item.submenu)) {
      const children = tidy(item.submenu.map((child) => this.#convert(child)).filter((child): child is NativeMenuItem => child !== null));
      return title ? { title, children, enabled: item.enabled !== false, ...(item.id === 'window' ? { system: 'window' as const } : {}) } : null;
    }
    if (item.role) {
      return ROLES.has(item.role) ? { role: item.role as NativeMenuItem['role'], ...(title ? { title } : {}) } : null;
    }
    const click = item.click;
    if (!title || !click) return null;
    const id = `m${this.#actions.size + 1}`;
    // Electron reicht Menüpunkt, Fenster und Ereignis durch; die Funktionen hier nutzen keins davon
    this.#actions.set(id, () => (click as () => void)());
    const key = item.accelerator && item.registerAccelerator !== false ? parseAccelerator(String(item.accelerator)) : null;
    return {
      id,
      title,
      enabled: item.enabled !== false,
      ...(item.type === 'checkbox' || item.type === 'radio' ? { checked: item.checked === true } : {}),
      ...(key ? { key } : {}),
    };
  }
}

// Keine Trennlinien am Anfang, am Ende oder doppelt
function tidy(items: NativeMenuItem[]): NativeMenuItem[] {
  const result: NativeMenuItem[] = [];
  for (const item of items) {
    if (item.separator && (result.length === 0 || result[result.length - 1]?.separator)) continue;
    result.push(item);
  }
  while (result[result.length - 1]?.separator) result.pop();
  return result;
}
