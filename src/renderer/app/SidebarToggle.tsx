import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { executeCommand } from '../engine/session';
import { useUi } from '../state/ui-store';
import styles from './Sidebars.module.css';

// Lasche am linken Rand des Dokuments: blendet die Seitenleiste ein und aus und bleibt dafür immer an derselben Stelle
export function SidebarToggle() {
  const { t } = useTranslation();
  const visible = useUi((s) => s.sidebarVisible);
  const Icon = visible ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      className={styles.edgeToggle}
      aria-label={t('toolbar.sidebar')}
      aria-pressed={visible}
      data-tooltip={t('toolbar.sidebar')}
      onClick={() => executeCommand('view.toggleSidebar')}
      data-testid="sidebar-toggle"
    >
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
