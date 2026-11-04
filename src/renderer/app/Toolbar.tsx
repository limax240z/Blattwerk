import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  ClipboardPen,
  EyeOff,
  FilePenLine,
  FolderOpen,
  Highlighter,
  Ellipsis,
  Info,
  LayoutGrid,
  Menu,
  MessageSquare,
  PanelLeft,
  Printer,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Signature,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CommandSheet } from './CommandSheet';
import { useCompact } from './compact';
import type { ViewMode } from '../../shared/ipc';
import { IconButton } from '../components/IconButton';
import { GLASS, useLiquidGlass } from '../components/glass/liquid-glass';
import { focusViewer, getRuntime } from '../engine/runtime';
import { executeCommand, goToPage, openWithDialog, printTab, setScaleValue, setViewMode } from '../engine/session';
import { useTabDirty } from '../state/dirty';
import { VIEW_MODES } from '../features/viewer/view-modes';
import { isPresetScaleValue, parsePercentInput, scaleToPercent, ZOOM_MENU_PERCENTS } from '../features/viewer/zoom';
import { useActiveTab, type TabState } from '../state/documents-store';
import { useUi } from '../state/ui-store';
import styles from './Toolbar.module.css';

// Knopfgruppe als Liquid-Glass-Kapsel
function GlassGroup({ children }: { children: ReactNode }) {
  const ref = useLiquidGlass<HTMLDivElement>(GLASS.control);
  return (
    <div ref={ref} className={styles.group}>
      {children}
    </div>
  );
}

function PageInput({ tab }: { tab: TabState }) {
  const { t } = useTranslation();
  // Während der Eingabe zeigt das Feld den Entwurf, sonst die aktuelle Seite.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(tab.currentPage);

  const commit = () => {
    if (draft !== null) {
      const page = Number.parseInt(draft, 10);
      if (Number.isFinite(page)) goToPage(tab, page);
    }
    setDraft(null);
  };

  const done = (input: HTMLInputElement) => {
    input.blur();
    focusViewer(getRuntime(tab.id));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      commit();
      done(event.currentTarget);
    } else if (event.key === 'Escape') {
      setDraft(null);
      done(event.currentTarget);
    }
  };

  return (
    <span className={styles.pageGroup}>
      <input
        className={styles.pageInput}
        aria-label={t('toolbar.pageNumber')}
        data-testid="page-input"
        inputMode="numeric"
        value={value}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        onFocus={(event) => event.currentTarget.select()}
      />
      <span className={styles.pageCount} data-testid="page-count">
        {t('toolbar.pageOf', { count: tab.pageCount })}
      </span>
    </span>
  );
}

function ZoomSelect({ tab }: { tab: TabState }) {
  const { t } = useTranslation();
  const percent = scaleToPercent(tab.scale);
  const presetLabels: Record<string, string> = {
    auto: t('toolbar.zoom.auto'),
    'page-width': t('toolbar.zoom.pageWidth'),
    'page-fit': t('toolbar.zoom.pageFit'),
    'page-actual': t('toolbar.zoom.pageActual'),
  };
  const isPreset = isPresetScaleValue(tab.scaleValue);
  const matchingPercent = ZOOM_MENU_PERCENTS.find((p) => Math.abs(p / 100 - tab.scale) < 0.001);
  const selectValue = isPreset ? tab.scaleValue : matchingPercent ? String(matchingPercent / 100) : 'custom';
  // Eintippen eines Prozentwerts (z. B. „137“ oder „137 %“); Enter übernimmt, Esc und Verlassen verwerfen
  const shown = t('toolbar.zoom.percent', { value: percent });
  const [draft, setDraft] = useState<string | null>(null);
  const apply = () => {
    const scale = draft === null ? null : parsePercentInput(draft);
    setDraft(null);
    if (scale !== null) setScaleValue(tab, String(scale));
    focusViewer(getRuntime(tab.id));
  };

  return (
    <span className={styles.zoomField}>
      <input
        className={styles.zoomInput}
        type="text"
        inputMode="decimal"
        aria-label={t('toolbar.zoomInput')}
        data-tooltip={t('toolbar.zoomInput')}
        data-testid="zoom-input"
        value={draft ?? shown}
        onFocus={(event) => {
          setDraft(String(percent));
          requestAnimationFrame(() => event.target.select());
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') apply();
          else if (event.key === 'Escape') {
            setDraft(null);
            focusViewer(getRuntime(tab.id));
          }
        }}
        onBlur={() => setDraft(null)}
      />
    <select
      className={[styles.select, styles.zoomPresets].join(' ')}
      aria-label={t('toolbar.zoomSelect')}
      data-tooltip={t('toolbar.zoomSelect')}
      data-testid="zoom-select"
      value={selectValue}
      onChange={(event) => {
        setScaleValue(tab, event.target.value);
        focusViewer(getRuntime(tab.id));
      }}
    >
      {Object.entries(presetLabels).map(([value, label]) => (
        <option key={value} value={value}>
          {value === tab.scaleValue ? `${label} (${t('toolbar.zoom.percent', { value: percent })})` : label}
        </option>
      ))}
      <option disabled>──────</option>
      {ZOOM_MENU_PERCENTS.map((p) => (
        <option key={p} value={String(p / 100)}>
          {t('toolbar.zoom.percent', { value: p })}
        </option>
      ))}
      {selectValue === 'custom' && (
        <option value="custom" hidden>
          {t('toolbar.zoom.percent', { value: percent })}
        </option>
      )}
    </select>
      <ChevronDown className={styles.zoomChevron} size={14} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

function ViewModeSelect({ tab }: { tab: TabState }) {
  const { t } = useTranslation();
  return (
    <select
      className={styles.select}
      aria-label={t('toolbar.viewMode')}
      data-tooltip={t('toolbar.viewMode')}
      data-testid="view-mode-select"
      value={tab.viewMode}
      onChange={(event) => {
        setViewMode(tab, event.target.value as ViewMode);
        focusViewer(getRuntime(tab.id));
      }}
    >
      {VIEW_MODES.map((mode) => (
        <option key={mode} value={mode}>
          {t(`viewMode.${mode}`)}
        </option>
      ))}
    </select>
  );
}

// Reihenfolge, in der Gruppen bei schmalem Fenster in das Menü „Weitere Werkzeuge“ wandern (unwichtigste zuerst)
type GroupId = 'view' | 'zoom' | 'pages' | 'info' | 'modes';
const COLLAPSE_ORDER: GroupId[] = ['view', 'zoom', 'pages', 'info', 'modes'];

// Wie viele Gruppen ins Menü wandern müssen, damit die Leiste ohne Abschneiden passt. Gemessen wird nach jedem
// Zeichnen; zurückgeholt wird eine Gruppe erst, wenn das Fenster wieder so breit ist wie beim Einklappen nötig.
function useCollapseLevel(ref: RefObject<HTMLElement | null>): number {
  const [level, setLevel] = useState(0);
  const needed = useRef<number[]>([]);
  // Nur zum Neuzeichnen, wenn sich die Fensterbreite ändert
  const [, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  // Ohne Abhängigkeiten gewollt: auch geänderte Inhalte (Zoomtext, Seitenzahl, Modus) können die Breite ändern. Endet
  // stets, weil jeder Schritt die Stufe nur in eine Richtung verschiebt, bis die Leiste passt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const available = element.clientWidth;
    if (element.scrollWidth > available + 1 && level < COLLAPSE_ORDER.length) {
      needed.current[level] = element.scrollWidth;
      setLevel(level + 1);
    } else if (level > 0 && available >= (needed.current[level - 1] ?? Number.POSITIVE_INFINITY)) {
      setLevel(level - 1);
    }
  });
  return level;
}

// Aufklappmenü mit den Gruppen, die nicht mehr in die Leiste passen
function MorePanel({ anchor, onClose, children }: { anchor: HTMLElement; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const glass = useLiquidGlass<HTMLDivElement>(GLASS.panel);
  const rect = anchor.getBoundingClientRect();

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={(element) => {
        panelRef.current = element;
        glass(element);
      }}
      className={styles.morePanel}
      style={{ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) }}
      data-testid="toolbar-more-panel"
      // Ein Moduswechsel schließt das Menü; Blättern und Zoomen lassen es offen
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest('button');
        if (button && !button.closest('[data-keep-open]')) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function Toolbar() {
  const { t } = useTranslation();
  const tab = useActiveTab();
  const sidebarVisible = useUi((s) => s.sidebarVisible);
  const rightPanelVisible = useUi((s) => s.rightPanelVisible);
  const commentToolsVisible = useUi((s) => s.commentToolsVisible);
  const redactToolsVisible = useUi((s) => s.redactToolsVisible);
  const markToolsVisible = useUi((s) => s.markToolsVisible);
  const tabDirty = useTabDirty(tab?.id);
  const headerRef = useRef<HTMLElement | null>(null);
  const level = useCollapseLevel(headerRef);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // Kompaktansicht (iPhone): alle Befehle als Liste, es gibt keine Menüleiste (ADR 0030)
  const compact = useCompact();
  const [commandsOpen, setCommandsOpen] = useState(false);
  const ready = tab?.status === 'ready';
  const dirty = ready && tabDirty;
  // Im Raster „Seiten organisieren“ gibt es keine Hauptansicht: Zoom, Blättern, Suche und Kommentare entfallen.
  const viewing = ready && tab.mode === 'view';

  const collapsed = new Set(COLLAPSE_ORDER.slice(0, level));
  const groups: Partial<Record<GroupId, ReactNode>> = {};
  if (viewing) {
    groups.pages = (
      <GlassGroup>
        <IconButton
          icon={ChevronUp}
          label={t('toolbar.previousPage')}
          disabled={tab.currentPage <= 1}
          onClick={() => executeCommand('nav.previousPage')}
        />
        <IconButton
          icon={ChevronDown}
          label={t('toolbar.nextPage')}
          disabled={tab.currentPage >= tab.pageCount}
          onClick={() => executeCommand('nav.nextPage')}
        />
        <PageInput key={tab.id} tab={tab} />
      </GlassGroup>
    );
    groups.zoom = (
      <GlassGroup>
        <IconButton icon={ZoomOut} label={t('toolbar.zoomOut')} onClick={() => executeCommand('view.zoomOut')} />
        <ZoomSelect tab={tab} />
        <IconButton icon={ZoomIn} label={t('toolbar.zoomIn')} onClick={() => executeCommand('view.zoomIn')} />
      </GlassGroup>
    );
    groups.view = (
      <GlassGroup>
        <ViewModeSelect tab={tab} />
        <IconButton
          icon={RotateCcw}
          label={t('toolbar.rotateCounterClockwise')}
          onClick={() => executeCommand('view.rotateCounterClockwise')}
        />
        <IconButton
          icon={RotateCw}
          label={t('toolbar.rotateClockwise')}
          onClick={() => executeCommand('view.rotateClockwise')}
        />
      </GlassGroup>
    );
  }
  if (ready) {
    groups.modes = (
      <GlassGroup>
        <IconButton
          icon={Signature}
          tone="sign"
          label={t('toolbar.sign')}
          disabled={!viewing || !tab.canAnnotate || tab.formEditing}
          onClick={() => executeCommand('tools.sign')}
          data-testid="sign-button"
        />
        <IconButton
          icon={EyeOff}
          tone="redact"
          label={t('toolbar.redact')}
          pressed={redactToolsVisible && viewing && !tab.formEditing && !tab.contentEditing}
          disabled={!viewing}
          onClick={() => executeCommand('redact.tools')}
          data-testid="redact-tools-button"
        />
        <IconButton
          icon={FilePenLine}
          tone="edit"
          label={t('toolbar.editContent')}
          pressed={viewing && tab.contentEditing}
          disabled={!viewing || !tab.canModify}
          onClick={() => executeCommand('content.edit')}
          data-testid="content-edit-button"
        />
        <IconButton
          icon={ClipboardPen}
          tone="forms"
          label={t('toolbar.editForm')}
          pressed={viewing && tab.formEditing}
          disabled={!viewing || !tab.canEditForms}
          onClick={() => executeCommand('forms.edit')}
          data-testid="form-edit-button"
        />
        <IconButton
          icon={LayoutGrid}
          tone="pages"
          label={t('toolbar.organize')}
          pressed={tab.mode === 'organize'}
          onClick={() => executeCommand('pages.organize')}
          data-testid="organize-button"
        />
        <IconButton
          icon={Highlighter}
          tone="comment"
          label={t('toolbar.highlight')}
          pressed={markToolsVisible && viewing && !tab.formEditing && !tab.contentEditing}
          disabled={!viewing || !tab.canAnnotate}
          onClick={() => executeCommand('tools.highlight')}
          data-testid="highlight-button"
        />
        <IconButton
          icon={MessageSquare}
          tone="comment"
          label={t('toolbar.comment')}
          pressed={commentToolsVisible && viewing && !tab.formEditing && !tab.contentEditing}
          disabled={!viewing}
          onClick={() => executeCommand('view.toggleCommentTools')}
          data-testid="comment-tools-button"
        />
        <IconButton icon={BookOpen} tone="tools" label={t('toolbar.readMode')} onClick={() => executeCommand('view.readMode')} data-testid="read-mode-button" />
      </GlassGroup>
    );
    groups.info = (
      <GlassGroup>
        <IconButton
          icon={Info}
          label={t('toolbar.properties')}
          onClick={() => executeCommand('file.properties')}
          data-testid="properties-button"
        />
        <IconButton
          icon={Search}
          label={t('toolbar.search')}
          pressed={rightPanelVisible && viewing}
          disabled={!viewing}
          onClick={() => (rightPanelVisible ? executeCommand('view.toggleRightPanel') : executeCommand('edit.find'))}
          data-testid="search-button"
        />
      </GlassGroup>
    );
  }
  const shown = (id: GroupId) => (collapsed.has(id) ? null : groups[id]);
  // Im Menü in der Reihenfolge der Leiste
  const hidden = (['pages', 'zoom', 'view', 'modes', 'info'] as GroupId[]).filter((id) => collapsed.has(id) && groups[id]);
  const menuOpen = moreOpen && moreAnchor !== null && hidden.length > 0;

  return (
    <header
      ref={headerRef}
      className={styles.toolbar}
      data-testid="toolbar"
      data-drag-region
      // Klicks auf Schaltflächen nehmen dem Dokument nicht den Tastaturfokus (Pfeile, Bild auf/ab scrollen weiter).
      // Per Tab-Taste bleiben die Schaltflächen erreichbar.
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) event.preventDefault();
      }}
    >
      <GlassGroup>
        {ready && (
          <IconButton
            icon={PanelLeft}
            label={t('toolbar.sidebar')}
            pressed={sidebarVisible && viewing}
            disabled={!viewing}
            onClick={() => executeCommand('view.toggleSidebar')}
          />
        )}
        <IconButton icon={FolderOpen} label={t('toolbar.open')} onClick={() => void openWithDialog()} data-testid="open-button" />
        {ready && (
          <IconButton
            icon={Save}
            label={t('toolbar.save')}
            disabled={!dirty || tab.saving}
            onClick={() => executeCommand('file.save')}
            data-testid="save-button"
          />
        )}
        {ready && (
          <IconButton
            icon={Printer}
            label={t('toolbar.print')}
            disabled={!tab.canPrint}
            onClick={() => void printTab(tab)}
            data-testid="print-button"
          />
        )}
      </GlassGroup>

      {viewing && (
        <div className={styles.center}>
          {shown('pages')}
          {shown('zoom')}
          {shown('view')}
        </div>
      )}

      {(ready || compact) && (
        <div className={styles.end}>
          {shown('modes')}
          {shown('info')}
          {hidden.length > 0 && (
            <GlassGroup>
              <span ref={setMoreAnchor} className={styles.moreAnchor}>
                <IconButton
                  icon={Ellipsis}
                  label={t('toolbar.more')}
                  pressed={menuOpen}
                  onClick={() => setMoreOpen((open) => !open)}
                  data-testid="toolbar-more"
                />
              </span>
            </GlassGroup>
          )}
          {compact && (
            <GlassGroup>
              <IconButton icon={Menu} label={t('toolbar.commands')} pressed={commandsOpen} onClick={() => setCommandsOpen(true)} data-testid="commands-button" />
            </GlassGroup>
          )}
        </div>
      )}
      {menuOpen && (
        <MorePanel anchor={moreAnchor} onClose={() => setMoreOpen(false)}>
          {hidden.map((id) => (
            <div key={id} className={styles.moreRow} data-keep-open={id === 'modes' ? undefined : ''}>
              {groups[id]}
            </div>
          ))}
        </MorePanel>
      )}
      {commandsOpen && <CommandSheet onClose={() => setCommandsOpen(false)} />}
    </header>
  );
}
