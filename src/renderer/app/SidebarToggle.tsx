import { ChevronLeft, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { executeCommand } from '../engine/session';
import { useUi } from '../state/ui-store';
import styles from './Sidebars.module.css';

// Am linken Rand des Dokuments: bei offener Seitenleiste eine schmale Lasche zum Einklappen, bei eingeklappter ein gut
// sichtbarer Knopf zum Ausklappen (die Lasche allein war auf dem dunklen Hintergrund kaum zu finden)
export function SidebarToggle() {
  const { t } = useTranslation();
  const visible = useUi((s) => s.sidebarVisible);
  const Icon = visible ? ChevronLeft : PanelLeftOpen;
  return (
    <button
      type="button"
      className={visible ? styles.edgeToggle : styles.openSidebar}
      aria-label={t('toolbar.sidebar')}
      aria-pressed={visible}
      data-tooltip={t('toolbar.sidebar')}
      onClick={() => executeCommand('view.toggleSidebar')}
      data-testid="sidebar-toggle"
    >
      <Icon size={visible ? 14 : 18} strokeWidth={visible ? 2 : 1.75} aria-hidden="true" />
    </button>
  );
}
