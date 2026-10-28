// Alle Befehle als Liste (Kompaktansicht, ADR 0030): Das iPhone hat keine Menüleiste. Inhalt aus demselben Aufbau wie
// die Menüs von Mac und iPad (buildMenuTemplate), damit kein Befehl fehlt.
import type { MenuItemConstructorOptions } from 'electron';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildMenuTemplate } from '../../main/menu-template';
import { api } from '../api';
import { Dialog, DialogButton } from '../components/Dialog';
import { executeCommand, handleOpenResult } from '../engine/session';
import { useUi } from '../state/ui-store';
import { computeMenuState } from './hooks';
import styles from './CommandSheet.module.css';

// Bearbeiten-Befehle des Systems (Ausschneiden, Kopieren …) bietet iOS am Text selbst an
const isListed = (item: MenuItemConstructorOptions) => item.type === 'separator' || Array.isArray(item.submenu) || typeof item.click === 'function';

export function CommandSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const recent = useUi((s) => s.recent);
  const menus = useMemo(
    () =>
      buildMenuTemplate({
        platform: 'ios',
        state: computeMenuState(),
        windowCount: 1,
        recent,
        devTools: false,
        sendCommand: executeCommand,
        openFileDialog: () => executeCommand('file.open'),
        openRecent: (path) => void api.recent.open(path).then(handleOpenResult),
        clearRecent: () => void api.recent.clear(),
        setDefaultApp: () => undefined,
        chooseUpdateFolder: () => undefined,
        mergeWindows: () => undefined,
        // „Über“ zeigt die Hülle; hier nicht nötig
        showAbout: () => undefined,
      }),
    [recent],
  );

  const run = (item: MenuItemConstructorOptions) => {
    onClose();
    // Electron reicht Menüpunkt, Fenster und Ereignis durch; die Funktionen des Aufbaus nutzen keins davon
    (item.click as () => void)();
  };

  return (
    <Dialog title={t('commands.title')} onClose={onClose} width={480} testId="command-sheet" actions={<DialogButton onClick={onClose}>{t('commands.close')}</DialogButton>}>
      {menus.map((menu, index) =>
        Array.isArray(menu.submenu) ? (
          <section key={index} className={styles.section}>
            <h3 className={styles.heading}>{menu.label}</h3>
            <Items items={menu.submenu} run={run} />
          </section>
        ) : null,
      )}
    </Dialog>
  );
}

function Items({ items, run }: { items: MenuItemConstructorOptions[]; run: (item: MenuItemConstructorOptions) => void }) {
  const visible = items.filter((item) => isListed(item) && item.id !== 'help.about');
  return (
    <ul className={styles.list}>
      {visible.map((item, index) =>
        item.type === 'separator' ? (
          index > 0 && index < visible.length - 1 && visible[index - 1]?.type !== 'separator' ? <li key={index} className={styles.separator} role="separator" /> : null
        ) : Array.isArray(item.submenu) ? (
          <Submenu key={index} item={item} items={item.submenu} run={run} />
        ) : (
          <li key={index}>
            <button type="button" className={styles.row} disabled={item.enabled === false} onClick={() => run(item)} data-command={item.id}>
              <span className={styles.label}>{item.label?.replaceAll('&&', '&')}</span>
              {(item.type === 'checkbox' || item.type === 'radio') && item.checked && <Check size={16} aria-hidden />}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

function Submenu({ item, items, run }: { item: MenuItemConstructorOptions; items: MenuItemConstructorOptions[]; run: (item: MenuItemConstructorOptions) => void }) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <li>
      <button type="button" className={styles.row} disabled={item.enabled === false} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={styles.label}>{item.label?.replaceAll('&&', '&')}</span>
        <Icon size={16} aria-hidden />
      </button>
      {open && (
        <div className={styles.nested}>
          <Items items={items} run={run} />
        </div>
      )}
    </li>
  );
}
