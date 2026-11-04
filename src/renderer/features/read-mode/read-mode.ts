// Lesemodus: Das Dokument füllt den Bildschirm, ohne Leisten, und ändern lässt sich nichts. Erlaubt sind nur die Befehle
// aus READ_MODE_COMMANDS (executeCommand); Kommentare sind schreibgeschützt (AnnotationLayer), Formularfelder gesperrt
// (ReadModeBar). Beim Beenden kommen Zoom und Fensterzustand wieder wie vorher.
import { api } from '../../api';
import { getRuntime } from '../../engine/runtime';
import { commitPendingEdits } from '../../engine/session';
import { useAnnotations } from '../../state/annotations-store';
import { useDocuments, type TabState } from '../../state/documents-store';
import { useUi } from '../../state/ui-store';
import { toggleFormEditing } from '../form-edit/actions';
import { toggleOrganize } from '../pages/commands';

let saved: { tabId: string; scaleValue: string; wasFullscreen: boolean } | null = null;

const VIEWER_TRIES = 40;

function enterWhenViewing(tabId: string, tries: number): void {
  const tab = useDocuments.getState().tabs.find((candidate) => candidate.id === tabId);
  if (!tab || tab.mode !== 'view' || tries === 0) return;
  if (getRuntime(tabId)?.viewer?.pagesCount) enterReadMode(tab);
  else window.setTimeout(() => enterWhenViewing(tabId, tries - 1), 25);
}

// Geht aus jedem Arbeitsbereich: Offene Änderungen werden übernommen, Bearbeitungsmodi und Leisten beendet
export function enterReadMode(tab: TabState): void {
  const ui = useUi.getState();
  if (ui.readMode || tab.status !== 'ready') return;
  ui.setHomeOpen(false);
  // Beim Seitenorganisieren gibt es keine Dokumentansicht; sie entsteht erst beim Verlassen
  if (tab.mode === 'organize') {
    toggleOrganize(tab);
    enterWhenViewing(tab.id, VIEWER_TRIES);
    return;
  }
  const viewer = getRuntime(tab.id)?.viewer;
  if (!viewer) return;
  commitPendingEdits();
  if (tab.formEditing) toggleFormEditing(tab);
  if (tab.contentEditing) useDocuments.getState().updateTab(tab.id, { contentEditing: false });
  ui.setCommentToolsVisible(false);
  ui.setMarkToolsVisible(false);
  ui.setRedactToolsVisible(false);
  const annotations = useAnnotations.getState();
  annotations.setTool('select');
  annotations.select(tab.id, null);
  window.getSelection()?.removeAllRanges();
  const entry = { tabId: tab.id, scaleValue: String(viewer.currentScaleValue), wasFullscreen: false };
  saved = entry;
  ui.setReadMode(true);
  viewer.currentScaleValue = 'page-fit';
  void api.setFullscreen(true).then((was) => {
    entry.wasFullscreen = was;
  });
}

export function exitReadMode(): void {
  const ui = useUi.getState();
  if (!ui.readMode) return;
  ui.setReadMode(false);
  const entry = saved;
  saved = null;
  if (!entry) return;
  const viewer = getRuntime(entry.tabId)?.viewer;
  if (viewer) viewer.currentScaleValue = entry.scaleValue;
  if (!entry.wasFullscreen) void api.setFullscreen(false);
}
