import { useEffect, useRef } from 'react';
import { isDocumentFileName } from '../../shared/convert';
import type { MenuState } from '../../shared/ipc';
import { matchRendererShortcut } from '../../shared/shortcuts';
import { api } from '../api';
import { getRuntime } from '../engine/runtime';
import { executeCommand, handleOpenResult } from '../engine/session';
import { isPagedMode } from '../features/viewer/view-modes';
import { convertDocument } from '../features/convert/actions';
import { syncHiddenAnnotations } from '../features/annotations/controller';
import { useAnnotations } from '../state/annotations-store';
import { canRedoState, canUndoState, isDirtyState } from '../state/dirty';
import { useForms } from '../state/forms-store';
import { useHistory } from '../state/history-store';
import { getActiveTab, useDocuments } from '../state/documents-store';
import { useUi } from '../state/ui-store';

export function computeMenuState(): MenuState {
  const { tabs, activeId } = useDocuments.getState();
  const ui = useUi.getState();
  const active = tabs.find((tab) => tab.id === activeId);
  const ready = active?.status === 'ready';
  const annotations = useAnnotations.getState().tabs;
  const histories = useHistory.getState().tabs;
  const forms = useForms.getState().tabs;
  const activeAnnotations = active ? annotations[active.id] : undefined;
  const activeHistory = active ? histories[active.id] : undefined;
  return {
    hasDocument: ready,
    canPrint: ready && active.canPrint,
    viewMode: ready ? active.viewMode : null,
    sidebarVisible: ui.sidebarVisible,
    rightPanelVisible: ui.rightPanelVisible,
    tabCount: tabs.length,
    dirtyCount: tabs.filter((tab) => isDirtyState(annotations[tab.id], histories[tab.id], forms[tab.id])).length,
    canUndo: canUndoState(activeAnnotations, activeHistory),
    canRedo: canRedoState(activeAnnotations, activeHistory),
    activeDirty: ready && isDirtyState(activeAnnotations, activeHistory, active ? forms[active.id] : undefined),
    commentToolsVisible: ui.commentToolsVisible,
    organizeMode: ready && active.mode === 'organize',
    canAssemble: ready && active.canAssemble,
    canExtract: ready && active.canExtract,
    formEditing: ready && active.mode === 'view' && active.formEditing,
    canEditForms: ready && active.canEditForms,
    redactToolsVisible: ui.redactToolsVisible,
    hasRedactionMarks: ready && (activeAnnotations?.items.some((a) => a.kind === 'redact') ?? false),
    contentEditing: ready && active.mode === 'view' && active.contentEditing,
    markToolsVisible: ui.markToolsVisible,
  };
}

// Hält Häkchen und aktivierte Menüpunkte im nativen Menü passend zum Zustand.
export function useMenuStateSync(): void {
  const last = useRef('');
  useEffect(() => {
    const push = () => {
      const state = computeMenuState();
      const serialized = JSON.stringify(state);
      if (serialized !== last.current) {
        last.current = serialized;
        api.setMenuState(state);
      }
    };
    push();
    const offDocs = useDocuments.subscribe(push);
    const offUi = useUi.subscribe(push);
    const offAnnotations = useAnnotations.subscribe(push);
    const offHistory = useHistory.subscribe(push);
    const offForms = useForms.subscribe(push);
    return () => {
      offDocs();
      offUi();
      offAnnotations();
      offHistory();
      offForms();
    };
  }, []);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

// Tasten, die nicht über Menü-Kürzel laufen (Pfeile, Pos1, Ende, Bild auf/ab in Seitenansicht).
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      if (document.querySelector('dialog[open]')) return;
      const tab = getActiveTab();
      if (!tab || tab.status !== 'ready') return;
      // Entfernen (Windows) löscht wie die Rückschritttaste den ausgewählten Kommentar.
      const command = event.key === 'Delete' ? 'edit.delete' : matchRendererShortcut(event);
      if (command) {
        event.preventDefault();
        executeCommand(command);
        return;
      }
      if (isPagedMode(tab.viewMode)) {
        if (event.key === 'PageDown' || event.key === 'PageUp') {
          event.preventDefault();
          executeCommand(event.key === 'PageDown' ? 'nav.nextPage' : 'nav.previousPage');
          return;
        }
        // Pfeil runter/Leertaste am Seitenende blättert weiter, Pfeil hoch/Umschalt+Leertaste am Anfang zurück.
        const container = getRuntime(tab.id)?.container;
        if (!container) return;
        const forward = event.key === 'ArrowDown' || (event.key === ' ' && !event.shiftKey);
        const backward = event.key === 'ArrowUp' || (event.key === ' ' && event.shiftKey);
        const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 1;
        const atTop = container.scrollTop <= 0;
        if ((forward && atBottom) || (backward && atTop)) {
          event.preventDefault();
          executeCommand(forward ? 'nav.nextPage' : 'nav.previousPage');
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

// Drops, die schon ein Bereich der Oberfläche verarbeitet hat (z. B. Dateien ins Seitenraster einfügen).
// Das Fenster setzt dann nur seinen Zustand zurück und öffnet die Dateien nicht zusätzlich als Tabs.
const handledDrops = new WeakSet<Event>();

export function markDropHandled(event: Event): void {
  handledDrops.add(event);
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

// PDFs per Drag & Drop irgendwo ins Fenster ziehen.
export function useFileDrop(): void {
  useEffect(() => {
    let depth = 0;
    const setDragging = useUi.getState().setDraggingFiles;
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      useUi.getState().setFileDropInsert(false);
      if (handledDrops.has(event)) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      // Nacheinander beim Hauptprozess anmelden (Reihenfolge der Tabs), aber nicht auf das Laden warten:
      // Eine Kennwortabfrage soll die übrigen Dateien nicht aufhalten.
      void (async () => {
        for (const file of files) {
          if (isDocumentFileName(file.name)) await convertDocument(file);
          else void handleOpenResult(await api.openDroppedFile(file));
        }
      })();
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}

// Geänderte oder gelöschte vorhandene Kommentare in der pdf.js-Anzeige ausblenden.
export function useAnnotationSync(): void {
  useEffect(() => {
    return useAnnotations.subscribe((state, previous) => {
      for (const [tabId, tab] of Object.entries(state.tabs)) {
        const before = previous.tabs[tabId];
        if (before && before.items === tab.items && before.originals === tab.originals) continue;
        syncHiddenAnnotations(tabId);
      }
    });
  }, []);
}
