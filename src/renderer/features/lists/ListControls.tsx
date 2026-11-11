// Knöpfe für Aufzählung, Nummerierung und Einzug. Erscheinen nur, solange eine Texteingabe offen ist; der Fokus bleibt
// dabei in der Eingabe (kein Klick nimmt ihn ihr weg).
import { ChevronDown, IndentDecrease, IndentIncrease, List, ListOrdered, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BULLET_KINDS, marker, NUMBER_KINDS, type ListKind } from '../../../shared/lists';
import { IconButton } from '../../components/IconButton';
import styles from '../annotations/CommentToolbar.module.css';
import { applyListAction, useListTarget } from './list-bridge';

// Kennzeichnung der Listenmenüs (Klicks darin beenden keine Texteingabe)
export const LIST_MENU_ATTRIBUTE = 'data-list-menu';

export function ListControls({ separator = true }: { separator?: boolean }) {
  const { t } = useTranslation();
  const active = useListTarget((s) => s.target !== null);
  if (!active) return null;
  return (
    <>
      {separator && <span className={styles.separator} />}
      <div className={styles.group} data-testid="list-controls">
        <ListMenu icon={List} label={t('lists.bullets')} kinds={BULLET_KINDS} testId="list-bullets" />
        <ListMenu icon={ListOrdered} label={t('lists.numbering')} kinds={NUMBER_KINDS} testId="list-numbers" />
        <IconButton
          icon={IndentDecrease}
          label={t('lists.outdent')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => applyListAction({ type: 'indent', delta: -1 })}
          data-testid="list-outdent"
        />
        <IconButton
          icon={IndentIncrease}
          label={t('lists.indent')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => applyListAction({ type: 'indent', delta: 1 })}
          data-testid="list-indent"
        />
      </div>
    </>
  );
}

// Knopf wendet die erste Art an; der Pfeil daneben öffnet die Auswahl aller Arten (mit Vorschau der Zeichen)
function ListMenu({ icon, label, kinds, testId }: { icon: LucideIcon; label: string; kinds: readonly ListKind[]; testId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<{ left: number; top: number } | null>(null);
  const [kind, setKind] = useState<ListKind>(kinds[0] as ListKind);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Element && (event.target.closest(`[${LIST_MENU_ATTRIBUTE}]`) || rootRef.current?.contains(event.target))) return;
      setOpen(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const choose = (next: ListKind) => {
    setKind(next);
    setOpen(null);
    applyListAction({ type: 'toggle', kind: next });
  };

  const sample = (value: ListKind) => [1, 2, 3].map((n) => `${marker(value, n)} ${t('lists.sample')}`).join('\n');

  return (
    <span ref={rootRef} className={styles.splitButton}>
      <IconButton
        icon={icon}
        label={`${label}: ${t(`lists.kinds.${kind}`)}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => applyListAction({ type: 'toggle', kind })}
        data-testid={testId}
      />
      <button
        type="button"
        className={styles.splitToggle}
        aria-label={t('lists.choose', { list: label })}
        aria-expanded={open !== null}
        data-tooltip={t('lists.choose', { list: label })}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const box = rootRef.current?.getBoundingClientRect();
          setOpen(open || !box ? null : { left: box.left, top: box.bottom + 2 });
        }}
        data-testid={`${testId}-menu`}
      >
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <ul className={styles.listMenu} style={{ left: open.left, top: open.top }} role="menu" aria-label={label} {...{ [LIST_MENU_ATTRIBUTE]: '' }}>
            {kinds.map((value) => (
              <li
                key={value}
                role="menuitem"
                className={value === kind ? styles.listOptionCurrent : styles.listOption}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(value)}
                data-list-kind={value}
              >
                <span className={styles.listSample}>{sample(value)}</span>
                <span>{t(`lists.kinds.${value}`)}</span>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </span>
  );
}
