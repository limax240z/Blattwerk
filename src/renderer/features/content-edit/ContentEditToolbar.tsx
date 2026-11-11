import {
  Check,
  ChevronDown,
  ImagePlus,
  MousePointer2,
  Pilcrow,
  Redo2,
  ScanText,
  Trash,
  Type,
  Undo2,
  type LucideIcon,
  FilePenLine as FilePenLineIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { STAMP_FONTS } from '../../../shared/stamping';
import { systemFontKey, type TextFont } from '../../../shared/fonts';
import { fontLabel, registerPreview, useSystemFonts } from './system-fonts';
import { IconButton } from '../../components/IconButton';
import { ColorPicker } from '../../components/ColorPicker';
import { ModeBadge } from '../../components/ModeBadge';
import { GLASS, useLiquidGlass } from '../../components/glass/liquid-glass';
import { executeCommand } from '../../engine/session';
import { focusViewer, getRuntime } from '../../engine/runtime';
import { useTabAnnotations } from '../../state/annotations-store';
import { useContentEdit, type ContentTool } from '../../state/content-edit-store';
import { canRedoState, canUndoState, useTabHistory } from '../../state/dirty';
import { useDocuments, type TabState } from '../../state/documents-store';
import styles from '../annotations/CommentToolbar.module.css';
import { addImage, reflowText, toggleContentEditing } from './actions';
import { makeImageTextEditable } from './scan-text';
import { applyToRichEditor } from './RichTextEditor';
import { ListControls } from '../lists/ListControls';
import type { ParagraphStyle } from '../../../shared/content';

// Größe, Schrift oder Farbe gewählt: gilt für die Texteingabe, sonst für den ausgewählten Text, immer auch für neuen Text
function applyStyle(tab: TabState, patch: ParagraphStyle): void {
  const store = useContentEdit.getState();
  store.setStyle(patch);
  const editing = store.editing?.tabId === tab.id ? store.editing : null;
  if (editing) {
    // Eingabe mit gemischter Gestaltung: ohne Auswahl für das Folgende, mit Auswahl für den ausgewählten Text
    if (applyToRichEditor(patch)) return;
    if (editing.mode === 'edit')
      store.setEditing({ ...editing, style: { ...editing.style, ...patch } });
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="content-text-editor"]')
        ?.focus({ preventScroll: true }),
    );
    return;
  }
  // Läuft noch eine Änderung (z. B. die eben getippte Größe), gilt die Auswahl erst danach wieder: Gestaltung vormerken
  // und dann auf den neu ausgewählten Text anwenden, statt den Klick zu verlieren
  if (isBusy(tab.id)) {
    pendingStyles.set(tab.id, { ...pendingStyles.get(tab.id), ...patch });
    void whenIdle(tab.id).then(() => {
      const pending = pendingStyles.get(tab.id);
      pendingStyles.delete(tab.id);
      if (pending) applyToSelection(tab.id, pending);
    });
    return;
  }
  applyToSelection(tab.id, patch);
}

const pendingStyles = new Map<string, ParagraphStyle>();

function applyToSelection(tabId: string, patch: ParagraphStyle): void {
  const selected = useContentEdit.getState().selected[tabId];
  const unit = selected?.unit;
  if (selected && !selected.group && unit?.kind === 'text')
    void reflowText(tabId, selected.pageIndex, unit, unit.text ?? '', { style: patch });
}

// Eine Änderung läuft, oder der geänderte Text ist noch nicht wieder ausgewählt
function isBusy(tabId: string): boolean {
  const working = useDocuments.getState().tabs.find((candidate) => candidate.id === tabId)?.working === true;
  return working || useContentEdit.getState().reselect?.tabId === tabId;
}

// Wartet, bis der Tab nicht mehr beschäftigt ist (oder geschlossen wurde)
function whenIdle(tabId: string): Promise<void> {
  return new Promise((resolve) => {
    if (!isBusy(tabId)) return resolve();
    const check = () => {
      if (isBusy(tabId)) return;
      offDocuments();
      offContent();
      resolve();
    };
    const offDocuments = useDocuments.subscribe(check);
    const offContent = useContentEdit.subscribe(check);
  });
}

const TOOLS: Array<{ tool: ContentTool; icon: LucideIcon }> = [
  { tool: 'select', icon: MousePointer2 },
  { tool: 'text', icon: Type },
  { tool: 'flow', icon: Pilcrow },
];

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 32, 48];

// Werkzeugleiste im Modus „Inhalt bearbeiten“
export function ContentEditToolbar({ tab }: { tab: TabState }) {
  const { t } = useTranslation();
  const tool = useContentEdit((s) => s.tool);
  const style = useContentEdit((s) => s.style);
  const selected = useContentEdit((s) => s.selected[tab.id] ?? null);
  const editing = useContentEdit((s) => (s.editing?.tabId === tab.id ? s.editing : null));
  const caret = useContentEdit((s) => s.caret);
  // Angezeigt wird die Gestaltung an der Einfügestelle, des bearbeiteten oder ausgewählten Textes, sonst die Vorgabe
  // für neuen Text
  const unit = !editing && !selected?.group && selected?.unit?.kind === 'text' ? selected.unit : null;
  const shown =
    editing && caret
      ? { size: caret.size, font: (caret.font ?? null) as TextFont | null, color: caret.color }
      : editing?.mode === 'edit'
      ? {
          size: editing.style?.size ?? editing.fontSize,
          font: editing.style?.font ?? null,
          color: editing.style?.color ?? editing.color,
        }
      : unit
        ? { size: unit.visualSize ?? unit.fontSize ?? style.size, font: null, color: unit.color }
        : { size: style.size, font: style.font as TextFont | null, color: style.color };
  // Eine Nachkommastelle reicht (z. B. 10,5 pt)
  const shownSize = Math.round(shown.size * 10) / 10;
  const annotations = useTabAnnotations(tab.id);
  const systemFonts = useSystemFonts((s) => s.fonts);
  useEffect(() => useSystemFonts.getState().load(), []);
  const styleNames = { bold: t('contentEdit.fontStyles.bold'), italic: t('contentEdit.fontStyles.italic'), boldItalic: t('contentEdit.fontStyles.boldItalic') };
  const history = useTabHistory(tab.id);

  const chooseTool = (next: ContentTool) => {
    const store = useContentEdit.getState();
    store.setTool(next === tool && next !== 'select' ? 'select' : next);
    store.select(tab.id, null);
    focusViewer(getRuntime(tab.id));
  };

  const glassRef = useLiquidGlass<HTMLDivElement>(GLASS.control);

  return (
    <div
      ref={glassRef}
      className={styles.bar}
      role="toolbar"
      aria-label={t('contentEdit.toolbar')}
      data-testid="content-edit-toolbar"
      data-tone="edit"
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) event.preventDefault();
      }}
    >
      <ModeBadge tone="edit" icon={FilePenLineIcon} label={t('toolbar.editContent')} />
      <div className={styles.group}>
        {TOOLS.map(({ tool: id, icon }) => (
          <IconButton
            key={id}
            icon={icon}
            label={t(`contentEdit.tools.${id}`)}
            pressed={tool === id}
            disabled={tab.working}
            onClick={() => chooseTool(id)}
            data-testid={`content-tool-${id}`}
          />
        ))}
        <IconButton
          icon={ImagePlus}
          label={t('contentEdit.tools.image')}
          disabled={tab.working}
          onClick={() => void addImage(tab)}
          data-testid="content-add-image"
        />
      </div>
      <span className={styles.separator} />
      <select
        className={styles.select}
        value={shown.font ?? ''}
        aria-label={t('contentEdit.font')}
        data-tooltip={t('contentEdit.font')}
        onChange={(event) => {
          const font = event.target.value as TextFont;
          if (!font) return;
          void registerPreview(font);
          applyStyle(tab, { font });
        }}
        data-testid="content-font"
      >
        {shown.font === null && <option value={''}>{t('contentEdit.originalFont')}</option>}
        <optgroup label={t('contentEdit.fontsStandard')}>
          {STAMP_FONTS.map((font) => (
            <option key={font} value={font}>
              {t(`stamp.fonts.${font}`)}
            </option>
          ))}
        </optgroup>
        {systemFonts.length > 0 && (
          <optgroup label={t('contentEdit.fontsSystem')}>
            {systemFonts.flatMap((family) =>
              family.styles.map((variant) => {
                const key = systemFontKey(family.id, variant);
                return (
                  <option key={key} value={key}>
                    {fontLabel(key, systemFonts, styleNames)}
                  </option>
                );
              }),
            )}
          </optgroup>
        )}
      </select>
      <SizeField
        value={shownSize}
        label={t('contentEdit.size')}
        unit={t('contentEdit.points')}
        onChange={(size) => applyStyle(tab, { size })}
      />
      <ColorPicker
        value={shown.color ?? null}
        onChange={(color) => applyStyle(tab, { color })}
        nameOf={(id) => t(`stamp.colors.${id}`)}
        label={t('contentEdit.color')}
        testId="content-color"
        favoriteSet="text"
      />
      <ListControls />
      <span className={styles.separator} />
      {selected && !selected.group && selected.unit?.kind === 'image' && (
        <IconButton
          icon={ScanText}
          label={t('contentEdit.scanText')}
          disabled={tab.working || !tab.canModify}
          onClick={() => selected.unit && void makeImageTextEditable(tab, selected.pageIndex, selected.unit)}
          data-testid="content-scan-text"
        />
      )}
      <IconButton
        icon={Trash}
        label={t('contentEdit.delete')}
        disabled={!selected || tab.working}
        onClick={() => executeCommand('edit.delete')}
        data-testid="content-delete"
      />
      <span className={styles.notice}>
        {tool === 'text' ? t('contentEdit.textHint') : tool === 'flow' ? t('contentEdit.flowHint') : t('contentEdit.selectHint')}
      </span>
      <span className={styles.spacer} />
      <div className={styles.group}>
        <IconButton
          icon={Undo2}
          label={t('comments.undo')}
          disabled={!canUndoState(annotations, history)}
          onClick={() => executeCommand('edit.undo')}
        />
        <IconButton
          icon={Redo2}
          label={t('comments.redo')}
          disabled={!canRedoState(annotations, history)}
          onClick={() => executeCommand('edit.redo')}
        />
        <IconButton
          icon={Check}
          label={t('contentEdit.done')}
          onClick={() => toggleContentEditing(tab)}
          data-testid="content-edit-done"
        />
      </div>
    </div>
  );
}

const MIN_SIZE = 1;
const MAX_SIZE = 500;

// Schriftgröße als Kombifeld: Zahl eintippen (auch Nachkommastellen, übernommen mit der Eingabetaste oder beim
// Verlassen des Feldes) oder über den Pfeil aus den üblichen Größen wählen.
function SizeField({
  value,
  label,
  unit,
  onChange,
}: {
  value: number;
  label: string;
  unit: string;
  onChange: (size: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  // Offene Liste mit ihrer Lage im Fenster (die Leiste scrollt seitlich und würde sie sonst abschneiden)
  const [open, setOpenState] = useState<{ left: number; top: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const setOpen = (next: boolean | ((current: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(open !== null) : next;
    const box = rootRef.current?.getBoundingClientRect();
    setOpenState(value && box ? { left: box.left, top: box.bottom + 2, width: box.width } : null);
  };
  const shown = text ?? String(value).replace('.', ',');

  // Klick außerhalb schließt die Liste
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="content-size-list"]')
      )
        return;
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target))
        setOpenState(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const apply = (raw: string) => {
    setText(null);
    setOpen(false);
    const size = Math.round(Number(raw.replace(',', '.').trim()) * 10) / 10;
    if (!Number.isFinite(size) || size < MIN_SIZE || size > MAX_SIZE || size === value) return;
    onChange(size);
  };

  return (
    <div ref={rootRef} className={styles.sizeField} data-tooltip={label}>
      <input
        className={styles.sizeInput}
        inputMode="decimal"
        value={shown}
        aria-label={label}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            apply(event.currentTarget.value);
          } else if (event.key === 'Escape') {
            setText(null);
            setOpen(false);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        onBlur={(event) => {
          if (text !== null) apply(event.currentTarget.value);
        }}
        data-testid="content-size"
      />
      <span className={styles.sizeUnit}>{unit}</span>
      <button
        type="button"
        className={styles.sizeToggle}
        aria-label={label}
        aria-expanded={open !== null}
        // Fokus bleibt in der Texteingabe auf der Seite
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
        data-testid="content-size-toggle"
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <ul
            className={styles.sizeList}
            style={{ left: open.left, top: open.top, minWidth: open.width }}
            role="listbox"
            aria-label={label}
            data-testid="content-size-list"
          >
            {SIZES.map((size) => (
              <li
                key={size}
                role="option"
                aria-selected={size === value}
                className={size === value ? styles.sizeOptionCurrent : styles.sizeOption}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => apply(String(size))}
                data-size={size}
              >
                {size} {unit}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
