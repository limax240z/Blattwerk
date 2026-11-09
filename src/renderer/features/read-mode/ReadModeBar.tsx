import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { exitReadMode } from './read-mode';
import styles from './ReadModeBar.module.css';

// So lange bleibt der Knopf nach der letzten Mausbewegung zu sehen
const VISIBLE_MS = 2500;

// Im Lesemodus das Einzige neben dem Dokument: Knopf zum Beenden, der nach kurzer Zeit verschwindet. Dazu Esc und die
// Sperren für Eingaben, die nicht über Befehle laufen (Formularfelder von pdf.js).
export function ReadModeBar() {
  const { t } = useTranslation();
  const [shown, setShown] = useState(true);

  useEffect(() => {
    let timer = window.setTimeout(() => setShown(false), VISIBLE_MS);
    const onMove = () => {
      setShown(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setShown(false), VISIBLE_MS);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      event.stopPropagation();
      exitReadMode();
    };
    const block = (event: Event) => event.preventDefault();
    // Tab-Taste: Formularfelder dürfen den Fokus nicht bekommen
    const onFocus = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.annotationLayer') && target.matches('input, textarea, select, [contenteditable]')) target.blur();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('beforeinput', block, true);
    window.addEventListener('focusin', onFocus, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('beforeinput', block, true);
      window.removeEventListener('focusin', onFocus, true);
    };
  }, []);

  return (
    <>
      {/* macOS ohne Vollbild: Die Werkzeugleiste (zugleich Titelleiste) ist weg, oben bleibt ein Streifen zum Verschieben */}
      <div className={styles.dragStrip} data-drag-region aria-hidden="true" />
      <button type="button" className={[styles.exit, shown ? '' : styles.hidden].join(' ')} onClick={exitReadMode} data-testid="read-mode-exit">
        <X size={14} strokeWidth={2} aria-hidden="true" />
        {t('readMode.exit')}
      </button>
    </>
  );
}
