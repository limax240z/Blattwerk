import { READ_MODE_COMMANDS, type CommandId } from '../../shared/commands';
import type { FileInfo, OpenResult, TabDestination, TabReceived, TabTransfer, ViewMode } from '../../shared/ipc';
import { api } from '../api';
import { computeChanges, hasChanges } from '../features/annotations/changes';
import { deleteAnnotation, loadAnnotations } from '../features/annotations/controller';
import { deleteSelectedObject, toggleContentEditing } from '../features/content-edit/actions';
import { deleteSelectedField, toggleFormEditing } from '../features/form-edit/actions';
import { openRedactApply, openRedactFind, toggleRedactTools } from '../features/redaction/actions';
import { toggleMarkTools } from '../features/annotations/mark-actions';
import { enterReadMode, exitReadMode } from '../features/read-mode/read-mode';
import { openStampDialog, removeArtifacts } from '../features/stamping/actions';
import { currentBytes, deletePages, targetPages } from '../features/pages/actions';
import { runPageCommand } from '../features/pages/commands';
import { printDocument } from '../features/print/print-service';
import { layoutForMode } from '../features/viewer/view-modes';
import { t } from '../i18n';
import { tabAnnotations, useAnnotations, type TabAnnotations } from '../state/annotations-store';
import { isTabDirty } from '../state/dirty';
import { currentFormChanges, syncFormChanges } from '../features/forms/form-sync';
import { useContentEdit } from '../state/content-edit-store';
import { useFormEdit } from '../state/form-edit-store';
import { useForms } from '../state/forms-store';
import type { SecuritySettings } from '../../shared/security';
import type { SignRequestInput } from '../../shared/signing';
import type { AccessibilityFix } from '../../shared/accessibility';
import type { CompressionLevel } from '../../shared/compress';
import type { CleanFindings, CleanOptions } from '../../shared/clean';
import { historyDirty, tabHistory, useHistory, type DocState, type Leaving } from '../state/history-store';
import type { AnnotationChanges } from '../../shared/annotations';
import { exportText } from '../features/export/actions';
import { compareWithFile } from '../features/compare/actions';
import { openPdfACheck } from '../features/pdfa/actions';
import { useAccessibility } from '../features/accessibility/accessibility-store';
import { useUpdate } from '../features/update/update-store';
import { storeFileThumbnail } from '../features/start/thumbnails';
import { useCertify } from '../features/certify/certify-store';
import { isRunning as isProgressRunning } from '../features/progress/progress';
import type { FieldOperation, FormFieldValue } from '../../shared/forms';
import type { RedactionOptions } from '../../shared/redaction';
import type { StampOperation } from '../../shared/stamping';
import type { ContentOperation } from '../../shared/content';
import { planRedaction } from '../features/redaction/plan';
import type { PageOperation } from '../../shared/pages';
import { EMPTY_SEARCH, getActiveTab, useDocuments, type TabState } from '../state/documents-store';
import { useUi, type PromptAnswer } from '../state/ui-store';
import { openTemporary, startLoading } from './document-loader';
import { checkSignatures, cleanDocument, compressDocument, findCleanable, fixAccessibility, PdfiumClientError, processDocument, protectDocument, readSecurity, redactDocument, signWithCertificate } from './pdfium-client';
import { pdfjs } from './pdfjs';
import { createRuntime, destroyRuntime, dispatchFind, getRuntime, rememberScroll, setRuntimeDocument } from './runtime';

// Warteschlange für Kennwortabfragen je Tab (pdf.js ruft den Rückruf, bevor das Dokument geöffnet ist).
const passwordCallbacks = new Map<string, (password: string) => void>();
// Zuletzt eingegebenes Kennwort je Tab, bis das Dokument geöffnet ist (danach in der Laufzeit des Tabs)
const enteredPasswords = new Map<string, string>();
let printAbort: AbortController | null = null;

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Übersetzungsschlüssel für einen Ladefehler. Fehler aus IPC tragen ein Präfix von Electron,
// deshalb wird auf enthaltenen Text geprüft.
function loadErrorKey(error: unknown): string {
  if (errorMessage(error).includes('file-changed')) return 'errors.load.changed';
  if (errorName(error) === 'InvalidPDFException') return 'errors.load.invalid';
  return 'errors.load.generic';
}

const tabExists = (tabId: string) => useDocuments.getState().tabs.some((tab) => tab.id === tabId);
const findTab = (tabId: string) => useDocuments.getState().tabs.find((tab) => tab.id === tabId);

interface LoadOptions {
  // Stand aus dem Arbeitsspeicher statt der Datei
  data?: Uint8Array;
  // Gesicherter Kommentarzustand dieses Stands (sonst aus dem Dokument einlesen)
  annotations?: TabAnnotations | null;
}

// Lädt eine Datei in einen (neuen oder vorhandenen) Tab. Mit bekanntem Kennwort entfällt die Abfrage.
async function loadIntoTab(tabId: string, file: FileInfo, knownPassword: string | null, options: LoadOptions = {}): Promise<void> {
  try {
    const handle = await startLoading(file, {
      data: options.data,
      password: knownPassword,
      onPassword: (reason, submit) => {
        passwordCallbacks.set(tabId, submit);
        useDocuments.getState().updateTab(tabId, {
          status: 'password',
          passwordIncorrect: reason === 'incorrect',
          openedWithPassword: true,
        });
      },
      onRangeError: (error) => {
        if (!tabExists(tabId)) return;
        useDocuments.getState().updateTab(tabId, {
          status: 'error',
          errorKey: loadErrorKey(error),
          errorDetail: errorMessage(error),
        });
      },
    });
    if (!tabExists(tabId)) {
      handle.terminate();
      return;
    }
    const runtime = createRuntime(tabId, file, handle.terminate);
    const pdf = await handle.promise;
    if (getRuntime(tabId) !== runtime) return;
    runtime.password = enteredPasswords.get(tabId) ?? knownPassword;
    setRuntimeDocument(runtime, pdf);
    const [metadata, permissions] = await Promise.all([
      pdf.getMetadata().catch(() => null),
      pdf.getPermissions().catch(() => null),
    ]);
    // pdf.js meldet die Einschränkungen auch, wenn das Dokument mit dem Berechtigungskennwort geöffnet wurde. Dann
    // gelten sie nicht (PDFium unterscheidet das).
    const security = permissions === null ? null : await readSecurity(await pdf.getData(), runtime.password).catch(() => null);
    if (getRuntime(tabId) !== runtime) return;
    const full = permissions === null || security?.ownerAccess === true;
    const info = (metadata?.info ?? {}) as Record<string, unknown>;
    const title = typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : null;
    useDocuments.getState().updateTab(tabId, {
      status: 'ready',
      pageCount: pdf.numPages,
      title,
      canPrint: full || permissions.has(pdfjs.PermissionFlag.PRINT),
      canAnnotate: full || permissions.has(pdfjs.PermissionFlag.MODIFY_ANNOTATIONS),
      // Seiten zusammenstellen erlaubt „Ändern“ oder (ab 128 Bit) das eigene Recht „Zusammenstellen“
      canAssemble:
        full ||
        permissions.has(pdfjs.PermissionFlag.MODIFY_CONTENTS) ||
        permissions.has(pdfjs.PermissionFlag.ASSEMBLE),
      canExtract: full || permissions.has(pdfjs.PermissionFlag.COPY),
      // pdf.js liefert Berechtigungen nur für verschlüsselte Dokumente; dort sind Feldänderungen nicht möglich.
      canEditForms: permissions === null,
      encrypted: permissions !== null,
      // Inhalt ändern erlaubt (Berechtigung „Ändern“)
      canModify: full || permissions.has(pdfjs.PermissionFlag.MODIFY_CONTENTS),
      ownerAccess: full,
    });
    if (options.annotations) useAnnotations.getState().restore(tabId, options.annotations);
    else void loadAnnotations(tabId);
    void refreshSignatures(tabId);
    // Vorschaubild für „Zuletzt geöffnet“ (nur die Datei selbst, keine ungespeicherten Stände und keine unbenannten)
    if (!file.untitled && !options.data) void storeFileThumbnail(file.fileId, pdf);
  } catch (error) {
    if (!tabExists(tabId)) return;
    useDocuments.getState().updateTab(tabId, {
      status: 'error',
      errorKey: loadErrorKey(error),
      errorDetail: errorMessage(error),
    });
  } finally {
    passwordCallbacks.delete(tabId);
    enteredPasswords.delete(tabId);
  }
}

export async function handleOpenResult(result: OpenResult): Promise<void> {
  if (!result.ok) {
    // elsewhere: Die Datei öffnet sich in einem anderen Fenster (ADR 0026)
    if (result.error !== 'cancelled' && result.error !== 'elsewhere') {
      useUi.getState().notify(t(`errors.open.${result.error}`, { name: result.name ?? '' }));
    }
    return;
  }
  const { file } = result;
  const documents = useDocuments.getState();

  // Dieselbe Datei ist schon offen: zum Tab wechseln statt doppelt öffnen.
  const existing = documents.tabs.find((tab) => tab.name === file.name && tab.dir === file.dir && tab.size === file.size);
  if (existing) {
    documents.setActive(existing.id);
    void api.closeFile(file.fileId);
    return;
  }

  const tabId = crypto.randomUUID();
  documents.addTab({ id: tabId, fileId: file.fileId, name: file.name, dir: file.dir, size: file.size, untitled: file.untitled === true });
  useAnnotations.getState().init(tabId);
  useHistory.getState().reset(tabId);
  await loadIntoTab(tabId, file, null);
  // Neues leeres Dokument: sofort im Modus „Text und Bilder bearbeiten“ (auch wenn es in einem neuen Fenster öffnet)
  const tab = findTab(tabId);
  if (file.untitled && tab?.status === 'ready' && tab.canModify && !tab.contentEditing && getActiveTab()?.id === tabId) toggleContentEditing(tab);
}

// Neues leeres Dokument: eine A4-Seite. Im Fenster mit Dokumenten öffnet es sich in einem neuen Fenster.
export async function createBlankDocument(): Promise<void> {
  await handleOpenResult(await api.newBlankDocument());
}

// Stand eines Tabs für die Übergabe an ein anderes Fenster. Ungespeicherte Kommentare, Formularwerte und
// Dokumentänderungen wandern als ein neuer Stand mit; der Rückgängig-Verlauf bleibt zurück.
async function transferState(tab: TabState): Promise<TabTransfer> {
  const runtime = getRuntime(tab.id);
  const history = tabHistory(tab.id);
  const password = runtime?.password ?? null;
  // Kennwort der Datei: das des gespeicherten Stands, wenn gerade ein anderer angezeigt wird (Kennwortschutz geändert)
  const saved = history && history.savedCursor >= 0 && history.savedCursor !== history.cursor ? history.states[history.savedCursor] : undefined;
  const filePassword = saved?.password !== undefined ? saved.password : password;
  const page = Math.max(1, tab.currentPage);
  if (tab.status !== 'ready' || !runtime?.pdf || !isTabDirty(tab.id)) return { bytes: null, password, filePassword, page };
  const { bytes } = await currentBytes(tab);
  return { bytes, password, filePassword, page };
}

// Gibt einen Tab an ein anderes Fenster (herausgezogen, Menü oder „Alle Fenster zusammenführen“, ADR 0026).
// Liefert true, wenn der Tab dieses Fenster verlassen hat. Ohne Tabs schließt sich das Fenster danach.
export async function transferTab(tabId: string, destination: TabDestination): Promise<boolean> {
  commitPendingEdits();
  await syncFormChanges(tabId);
  await settled(tabId);
  const tab = findTab(tabId);
  if (!tab || tab.saving || tab.working) return false;
  try {
    const result = await api.transferTab(tab.fileId, await transferState(tab), destination);
    if (!result.ok) {
      if (result.error !== 'nothing-to-do') useUi.getState().notify(t('tabs.transferFailed'), result.error);
      return false;
    }
  } catch (error) {
    useUi.getState().notify(t('tabs.transferFailed'), errorMessage(error));
    return false;
  }
  closeTabNow(tabId);
  if (useDocuments.getState().tabs.length === 0) api.closeWindow();
  return true;
}

// „Nach Updates suchen“: erst der Update-Ordner (ADR 0025), dann das Netz (ADR 0027). Eine neue Version erscheint als
// Leiste „Jetzt aktualisieren“; sonst sagt eine Meldung, warum nicht.
async function checkForUpdates(): Promise<void> {
  const update = useUpdate.getState();
  const ui = useUi.getState();
  const local = await update.check();
  useUpdate.setState({ dismissed: null });
  if (!local) return;
  if (local.state === 'available') return;
  if (local.state === 'unsupported') {
    ui.notify(t('update.unsupported'), t(`update.reasons.${local.reason}`));
    return;
  }
  const result = await update.searchOnline();
  if (!result || result.state === 'downloaded') return;
  if (result.state === 'current') ui.confirm(t('update.upToDate', { version: result.current }));
  else if (result.state === 'unsupported') ui.notify(t('update.unsupported'), t(`update.reasons.${result.reason}`));
  else ui.notify(t('update.failed.title'), t(`update.failed.${result.reason}`));
}

// „Alle Fenster zusammenführen“: alle Tabs nacheinander an das vordere Fenster abgeben
export async function giveAllTabs(): Promise<void> {
  for (const tab of [...useDocuments.getState().tabs]) {
    if (!(await transferTab(tab.id, { kind: 'merge' }))) return;
  }
}

// Übernimmt einen Tab aus einem anderen Fenster. Mit Änderungen liegt der übergebene Stand als neuer Stand über der
// Datei (wie nach einer Seitenoperation): Der Tab gilt als ungespeichert, Speichern schreibt in die Originaldatei.
export async function receiveTab({ file, transfer, index }: TabReceived): Promise<void> {
  const tabId = crypto.randomUUID();
  useDocuments.getState().addTab({ id: tabId, fileId: file.fileId, name: file.name, dir: file.dir, size: file.size, untitled: file.untitled === true });
  // Auf die Tableiste gezogen: an die Stelle, an der die Leiste beim Schweben Platz gemacht hat
  if (index !== undefined) useDocuments.getState().moveTab(tabId, index);
  useAnnotations.getState().init(tabId);
  useHistory.getState().reset(tabId);
  useDocuments.getState().updateTab(tabId, { currentPage: transfer.page });
  if (transfer.bytes) {
    const next: DocState = { bytes: transfer.bytes, annotations: null, page: transfer.page, selection: [], password: transfer.password };
    useHistory.getState().push(tabId, { annotations: null, page: transfer.page, selection: [], password: transfer.filePassword }, next);
  }
  await loadIntoTab(tabId, file, transfer.password, { data: transfer.bytes ?? undefined });
}

export function submitPassword(tabId: string, password: string): void {
  const submit = passwordCallbacks.get(tabId);
  if (!submit) return;
  enteredPasswords.set(tabId, password);
  useDocuments.getState().updateTab(tabId, { status: 'loading' });
  submit(password);
}

export async function openWithDialog(): Promise<void> {
  const results = await api.openFileDialog();
  // Nicht auf das Laden warten: Eine Kennwortabfrage soll die übrigen Dateien nicht aufhalten.
  // Die Tab-Reihenfolge bleibt erhalten, weil handleOpenResult den Tab vor dem ersten await anlegt.
  for (const result of results) void handleOpenResult(result);
}

// Rückfrage an den Nutzer (ungespeicherte Änderungen, von außen geänderte Datei).
function ask(kind: 'unsaved' | 'changed-externally', tab: TabState): Promise<PromptAnswer> {
  return new Promise((resolve) => {
    useUi.getState().setPrompt({
      kind,
      tabId: tab.id,
      name: tab.name,
      resolve: (answer) => {
        useUi.getState().setPrompt(null);
        resolve(answer);
      },
    });
  });
}

// Schließt einen Tab sofort, ohne Rückfrage.
function closeTabNow(tabId: string): void {
  const tab = findTab(tabId);
  if (!tab) return;
  passwordCallbacks.delete(tabId);
  enteredPasswords.delete(tabId);
  const ui = useUi.getState();
  // Ein laufender Druck dieses Dokuments wird abgebrochen, bevor seine pdf.js-Instanz verschwindet.
  if (ui.print?.tabId === tabId) printAbort?.abort();
  destroyRuntime(tabId);
  void api.closeFile(tab.fileId);
  useDocuments.getState().removeTab(tabId);
  useAnnotations.getState().drop(tabId);
  useHistory.getState().drop(tabId);
  useForms.getState().drop(tabId);
  useFormEdit.getState().drop(tabId);
  useContentEdit.getState().drop(tabId);
  if (ui.propertiesTabId === tabId) ui.openProperties(null);
  // „Gehe zu Seite“ gilt immer dem aktiven Tab; nach dem Schließen ist das ein anderer.
  ui.setGoToPageOpen(false);
}

// Schließt einen Tab. Bei ungespeicherten Änderungen wird vorher gefragt. Liefert false bei Abbruch.
export async function closeTab(tabId: string): Promise<boolean> {
  commitPendingEdits();
  await syncFormChanges(tabId);
  await settled(tabId);
  const tab = findTab(tabId);
  if (!tab) return true;
  if (isTabDirty(tabId)) {
    useDocuments.getState().setActive(tabId);
    const answer = await ask('unsaved', tab);
    if (answer === 'cancel') return false;
    if (answer === 'save' && !(await saveTab(tabId, 'save'))) return false;
  }
  closeTabNow(tabId);
  return true;
}

// Fenster schließen oder App beenden: alle Tabs mit Änderungen nacheinander abfragen.
export async function handleCloseRequest(): Promise<void> {
  commitPendingEdits();
  await Promise.all(useDocuments.getState().tabs.map((tab) => syncFormChanges(tab.id)));
  await Promise.all(useDocuments.getState().tabs.map((tab) => settled(tab.id)));
  const dirtyTabs = useDocuments.getState().tabs.filter((tab) => isTabDirty(tab.id));
  for (const tab of dirtyTabs) {
    useDocuments.getState().setActive(tab.id);
    const answer = await ask('unsaved', tab);
    if (answer === 'cancel' || (answer === 'save' && !(await saveTab(tab.id, 'save')))) {
      api.cancelClose();
      return;
    }
    if (answer === 'discard') closeTabNow(tab.id);
  }
  api.confirmClose();
}

// Lädt einen Tab nach dem Speichern aus der neuen Datei; Seite, Zoom und Ansicht bleiben erhalten.
async function reloadTab(tabId: string, file: FileInfo): Promise<void> {
  const password = getRuntime(tabId)?.password ?? null;
  destroyRuntime(tabId);
  useAnnotations.getState().init(tabId);
  useHistory.getState().reset(tabId);
  useForms.getState().drop(tabId);
  useDocuments.getState().updateTab(tabId, {
    fileId: file.fileId,
    name: file.name,
    dir: file.dir,
    size: file.size,
    untitled: file.untitled === true,
    status: 'loading',
    search: EMPTY_SEARCH,
  });
  await loadIntoTab(tabId, file, password);
}

// Speichert die Kommentare. „save“ überschreibt die Datei (inkrementell), „saveAs“ fragt nach einem neuen Namen.
export async function saveTab(tabId: string, mode: 'save' | 'saveAs'): Promise<boolean> {
  commitPendingEdits();
  await settled(tabId);
  const tab = findTab(tabId);
  const runtime = getRuntime(tabId);
  const annotations = tabAnnotations(tabId);
  if (!tab || tab.status !== 'ready' || !runtime?.pdf || !annotations || tab.saving || tab.working) return false;
  // Unbenanntes neues Dokument: Sichern fragt immer nach Ort und Namen
  if (tab.untitled) mode = 'saveAs';
  const changes = computeChanges(annotations.items, annotations.originals);
  const forms = await currentFormChanges(tabId);
  // Nichts zu schreiben: keine Kommentar- oder Formularänderungen und der angezeigte Stand ist die Datei
  if (mode === 'save' && !hasChanges(changes) && forms.length === 0 && !historyDirty(tabHistory(tabId))) {
    useAnnotations.getState().markSaved(tabId);
    return true;
  }
  useDocuments.getState().updateTab(tabId, { saving: true });
  try {
    // Die Originalbytes hält pdf.js bereits im Speicher; große Dateien liest es bei Bedarf nach.
    const original = await runtime.pdf.getData();
    const bytes =
      hasChanges(changes) || forms.length > 0
        ? await processDocument(original, runtime.password, { changes, formValues: forms })
        : original;
    let result = mode === 'save' ? await api.saveFile(tab.fileId, bytes) : await api.saveFileAs(tab.fileId, bytes);
    if (!result.ok && result.error === 'changed-externally') {
      const answer = await ask('changed-externally', tab);
      if (answer === 'overwrite') result = await api.saveFile(tab.fileId, bytes, true);
      else if (answer === 'saveAs') result = await api.saveFileAs(tab.fileId, bytes);
      else return false;
    }
    if (!result.ok) {
      if (result.error !== 'cancelled') useUi.getState().notify(t('errors.save.failed'), result.detail ?? result.error);
      return false;
    }
    await reloadTab(tabId, result.file);
    return true;
  } catch (error) {
    useUi.getState().notify(t('errors.save.failed'), errorMessage(error));
    return false;
  } finally {
    if (tabExists(tabId)) useDocuments.getState().updateTab(tabId, { saving: false });
  }
}

const fileOf = (tab: TabState): FileInfo => ({ fileId: tab.fileId, name: tab.name, dir: tab.dir, size: tab.size });

// Zeigt einen Dokumentstand an: lädt ihn (Datei oder Arbeitsspeicher) neu in den Tab.
async function showState(tabId: string, state: DocState): Promise<void> {
  const tab = findTab(tabId);
  if (!tab) return;
  const password = state.password !== undefined ? state.password : (getRuntime(tabId)?.password ?? null);
  destroyRuntime(tabId);
  useAnnotations.getState().init(tabId);
  useForms.getState().drop(tabId);
  useDocuments.getState().updateTab(tabId, {
    status: 'loading',
    search: EMPTY_SEARCH,
    currentPage: state.page,
    pageSelection: state.selection,
  });
  await loadIntoTab(tabId, fileOf(tab), password, { data: state.bytes ?? undefined, annotations: state.annotations });
}

// Kommentarzustand beim Verlassen eines Stands: ohne offenen Editor und ohne Auswahl
function leavingAnnotations(tabId: string, keepRedo: boolean): TabAnnotations | null {
  const annotations = tabAnnotations(tabId);
  if (!annotations) return null;
  return { ...annotations, redo: keepRedo ? annotations.redo : [], editingId: null, selectedId: null };
}

// Was beim Verlassen eines Stands mitgesichert wird (Kommentare, Seite, Auswahl, Kennwort)
function leavingState(tabId: string, tab: TabState, keepRedo: boolean): Leaving {
  return { annotations: leavingAnnotations(tabId, keepRedo), page: tab.currentPage, selection: tab.pageSelection, password: getRuntime(tabId)?.password ?? null };
}

function operationErrorMessage(error: unknown, fallbackKey: string): string {
  const code = error instanceof PdfiumClientError ? error.code : 'failed';
  // Die Meldung des Workers (z. B. nicht darstellbare Zeichen) steht als {{detail}} zur Verfügung.
  return code === 'failed' ? t(fallbackKey) : t(`errors.pages.${code}`, { detail: errorMessage(error) });
}

export interface AfterOperation {
  // Seite, die danach angezeigt wird (1-basiert)
  page?: number;
  // Auswahl im Raster danach (0-basiert)
  selection?: number[];
  // Scrollposition beibehalten (Seiten und Zoom bleiben gleich, z. B. beim Bearbeiten von Formularfeldern)
  keepScroll?: boolean;
}

// Je Tab laufen Seitenoperationen, Rückgängig und Wiederholen nacheinander. Rückgängig/Wiederholen
// warten auf eine laufende Operation statt verloren zu gehen (z. B. zweimal schnell Cmd+Z).
const tabQueues = new Map<string, Promise<unknown>>();

// Solange die Warteschlange eines Tabs nicht leer ist, gilt er als „wird bearbeitet“ (Oberfläche gesperrt).
function enqueue<T>(tabId: string, task: () => Promise<T>): Promise<T> {
  const previous = tabQueues.get(tabId) ?? Promise.resolve();
  useDocuments.getState().updateTab(tabId, { working: true });
  const next = previous.catch(() => undefined).then(task);
  tabQueues.set(tabId, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (tabQueues.get(tabId) !== next) return;
      tabQueues.delete(tabId);
      if (tabExists(tabId)) useDocuments.getState().updateTab(tabId, { working: false });
    });
  return next;
}

// Wartet, bis laufende Seitenoperationen eines Tabs fertig sind (z. B. vor dem Speichern).
// Arbeit, die erst nach einer Vorbereitung in die Warteschlange kommt (z. B. übernommener Text: Schriftdaten laden).
// Schließen und Übergeben warten auch darauf, sonst gilt der Tab noch als unverändert und der Text ginge verloren.
const pendingWork = new Map<string, Set<Promise<unknown>>>();

export function trackPending<T>(tabId: string, work: Promise<T>): Promise<T> {
  const set = pendingWork.get(tabId) ?? new Set<Promise<unknown>>();
  pendingWork.set(tabId, set);
  set.add(work);
  const forget = () => {
    set.delete(work);
    if (set.size === 0 && pendingWork.get(tabId) === set) pendingWork.delete(tabId);
  };
  work.then(forget, forget);
  return work;
}

async function settled(tabId: string): Promise<void> {
  for (;;) {
    const queue = tabQueues.get(tabId);
    const pending = pendingWork.get(tabId);
    if (!queue && !pending) return;
    await Promise.allSettled([queue ?? Promise.resolve(), ...(pending ?? [])]);
  }
}

// Führt Seitenoperationen aus. Ungespeicherte Kommentare werden dabei ins Dokument übernommen.
// Das Ergebnis ist ein neuer Stand im Arbeitsspeicher; die Datei ändert sich erst beim Speichern.
export function applyPageOperations(tabId: string, operations: PageOperation[], after: AfterOperation = {}): Promise<boolean> {
  return applyDocumentOperations(tabId, { operations }, after);
}

// Formularfelder anlegen, ändern oder löschen. Wie bei Seitenoperationen entsteht ein neuer Stand im Arbeitsspeicher.
export function applyFieldOperations(tabId: string, fieldOperations: FieldOperation[], after: AfterOperation = {}): Promise<boolean> {
  return applyDocumentOperations(tabId, { fieldOperations }, after);
}

// Wasserzeichen, Kopf- und Fußzeilen hinzufügen oder entfernen (Phase 5); ebenfalls ein neuer Stand.
export function applyStampOperations(tabId: string, stampOperations: StampOperation[], after: AfterOperation = {}): Promise<boolean> {
  return applyDocumentOperations(tabId, { stampOperations }, after);
}

// Seiteninhalt bearbeiten (Phase 5): Text und Bilder einfügen, verschieben, skalieren, löschen, Zeilen ändern.
export function applyContentOperations(tabId: string, contentOperations: ContentOperation[], after: AfterOperation = {}): Promise<boolean> {
  return applyDocumentOperations(tabId, { contentOperations }, after);
}

interface DocumentOperations {
  operations?: PageOperation[];
  fieldOperations?: FieldOperation[];
  stampOperations?: StampOperation[];
  contentOperations?: ContentOperation[];
}

function applyDocumentOperations(tabId: string, input: DocumentOperations, after: AfterOperation): Promise<boolean> {
  commitPendingEdits();
  // Während einer laufenden Operation ist die Oberfläche gesperrt; weitere Operationen entfallen.
  if (findTab(tabId)?.working) return Promise.resolve(false);
  return enqueue(tabId, () => runDocumentOperations(tabId, input, after));
}

async function runDocumentOperations(tabId: string, input: DocumentOperations, after: AfterOperation): Promise<boolean> {
  const tab = findTab(tabId);
  const runtime = getRuntime(tabId);
  const operations = input.operations ?? [];
  const fieldOperations = input.fieldOperations ?? [];
  const stampOperations = input.stampOperations ?? [];
  const contentOperations = input.contentOperations ?? [];
  const count = operations.length + fieldOperations.length + stampOperations.length + contentOperations.length;
  if (!tab || tab.status !== 'ready' || tab.saving || !runtime?.pdf || count === 0) return false;
  if (contentOperations.length > 0 && !tab.canModify) {
    useUi.getState().notify(t('contentEdit.notAllowed'));
    return false;
  }
  if (stampOperations.length > 0 && tab.encrypted) {
    useUi.getState().notify(t('errors.pages.stamp-encrypted'));
    return false;
  }
  if (operations.length > 0 && !tab.canAssemble) {
    useUi.getState().notify(t('errors.pages.notAllowed'));
    return false;
  }
  if (fieldOperations.length > 0 && !tab.canEditForms) {
    useUi.getState().notify(t('formEdit.notAllowed'));
    return false;
  }
  const pdf = runtime.pdf;
  try {
    const annotations = tabAnnotations(tabId);
    const changes = annotations ? computeChanges(annotations.items, annotations.originals) : { upserts: [], deletions: [] };
    const forms = await currentFormChanges(tabId);
    const bytes = await processDocument(await pdf.getData(), runtime.password, {
      changes,
      operations,
      fieldOperations,
      stampOperations,
      contentOperations,
      formValues: forms,
    });
    if (getRuntime(tabId)?.pdf !== pdf) return false;
    const page = Math.max(1, after.page ?? tab.currentPage);
    const next = { bytes, annotations: null, page, selection: after.selection ?? [], password: runtime.password };
    const leaving = leavingState(tabId, tab, false);
    useHistory.getState().push(tabId, leaving, next);
    if (after.keepScroll) rememberScroll(tabId);
    await showState(tabId, next);
    return true;
  } catch (error) {
    const fallback =
      fieldOperations.length > 0 ? 'formEdit.failed' : stampOperations.length > 0 ? 'stamp.failed' : contentOperations.length > 0 ? 'contentEdit.failed' : 'errors.pages.failed';
    useUi.getState().notify(operationErrorMessage(error, fallback), errorMessage(error));
    return false;
  }
}

// Schwärzen (Phase 5, ADR 0008): markierte Bereiche endgültig entfernen. Das Ergebnis ist ein vollständig neu
// geschriebenes Dokument als neuer Stand im Arbeitsspeicher; die Datei ändert sich erst beim Speichern.
export function applyRedactionMarks(tabId: string, options: RedactionOptions): Promise<boolean> {
  commitPendingEdits();
  if (findTab(tabId)?.working) return Promise.resolve(false);
  return enqueue(tabId, () => runRedaction(tabId, options));
}

async function runRedaction(tabId: string, options: RedactionOptions): Promise<boolean> {
  const tab = findTab(tabId);
  const runtime = getRuntime(tabId);
  const annotations = tabAnnotations(tabId);
  if (!tab || tab.status !== 'ready' || tab.saving || !runtime?.pdf || !annotations) return false;
  const plan = planRedaction(annotations.items, annotations.originals);
  if (plan.areas.length === 0) return false;
  const pdf = runtime.pdf;
  try {
    const forms = await currentFormChanges(tabId);
    const bytes = await redactDocument(await pdf.getData(), runtime.password, { changes: plan.changes, formValues: forms, areas: plan.areas, options });
    if (getRuntime(tabId)?.pdf !== pdf) return false;
    const next = { bytes, annotations: null, page: tab.currentPage, selection: [], password: runtime.password };
    const leaving = leavingState(tabId, tab, false);
    useHistory.getState().push(tabId, leaving, next);
    rememberScroll(tabId);
    await showState(tabId, next);
    useUi.getState().confirm(t('redaction.applied', { count: plan.markCount }));
    return true;
  } catch (error) {
    useUi.getState().notify(operationErrorMessage(error, 'redaction.failed'), errorMessage(error));
    return false;
  }
}

// Ungespeicherte Kommentare und Formularwerte eines Tabs (für Aufgaben, die den aktuellen Stand brauchen)
export async function pendingChanges(tabId: string): Promise<{ changes: AnnotationChanges; formValues: FormFieldValue[] }> {
  const annotations = tabAnnotations(tabId);
  const changes = annotations ? computeChanges(annotations.items, annotations.originals) : { upserts: [], deletions: [] };
  return { changes, formValues: await currentFormChanges(tabId) };
}

// Kennwortschutz setzen, ändern oder entfernen (Phase 6, ADR 0011). ownerPassword: Berechtigungskennwort, falls das
// Dokument nur mit dem Kennwort zum Öffnen geöffnet wurde. Das Ergebnis ist ein neuer, vollständig neu geschriebener
// Stand; die Datei ändert sich erst beim Speichern.
export function applyProtection(tabId: string, settings: SecuritySettings | null, ownerPassword: string | null): Promise<boolean> {
  commitPendingEdits();
  if (findTab(tabId)?.working) return Promise.resolve(false);
  return enqueue(tabId, () => runProtection(tabId, settings, ownerPassword));
}

// PDF verkleinern (Phase 6, ADR 0013): neuer, vollständig neu geschriebener Stand, nur wenn er kleiner ist
// Dokument bereinigen: neuer Stand ohne die gewählten Inhalte, vollständig neu geschrieben
export function applyCleaning(tabId: string, options: CleanOptions): Promise<boolean> {
  commitPendingEdits();
  if (findTab(tabId)?.working) return Promise.resolve(false);
  return enqueue(tabId, async () => {
    const tab = findTab(tabId);
    const runtime = getRuntime(tabId);
    if (!tab || tab.status !== 'ready' || tab.saving || !runtime?.pdf) return false;
    const pdf = runtime.pdf;
    const ui = useUi.getState();
    ui.setBusy('clean.busy');
    try {
      const pending = await pendingChanges(tabId);
      const bytes = await cleanDocument(await pdf.getData(), runtime.password, { ...pending, options });
      if (getRuntime(tabId)?.pdf !== pdf) return false;
      const next = { bytes, annotations: null, page: tab.currentPage, selection: [], password: runtime.password };
      useHistory.getState().push(tabId, leavingState(tabId, tab, false), next);
      rememberScroll(tabId);
      await showState(tabId, next);
      ui.confirm(t('clean.done'));
      return true;
    } catch (error) {
      ui.notify(operationErrorMessage(error, 'clean.failed'), errorMessage(error));
      return false;
    } finally {
      ui.setBusy(null);
    }
  });
}

// Was das Dokument an Bereinigbarem enthält (Dialog)
export async function cleanableOf(tabId: string): Promise<CleanFindings | null> {
  const pdf = getRuntime(tabId)?.pdf;
  if (!pdf) return null;
  try {
    return await findCleanable(await pdf.getData());
  } catch {
    return null;
  }
}

export function applyCompression(tabId: string, level: CompressionLevel): Promise<boolean> {
  commitPendingEdits();
  if (findTab(tabId)?.working) return Promise.resolve(false);
  return enqueue(tabId, () => runCompression(tabId, level));
}

async function runCompression(tabId: string, level: CompressionLevel): Promise<boolean> {
  const tab = findTab(tabId);
  const runtime = getRuntime(tabId);
  if (!tab || tab.status !== 'ready' || tab.saving || !runtime?.pdf) return false;
  if (tab.encrypted) {
    useUi.getState().notify(t('errors.pages.compress-encrypted'));
    return false;
  }
  const pdf = runtime.pdf;
  const ui = useUi.getState();
  ui.setBusy('compress.busy');
  try {
    const pending = await pendingChanges(tabId);
    const before = await pdf.getData();
    const size = before.length;
    const bytes = await compressDocument(before, runtime.password, { ...pending, level });
    if (getRuntime(tabId)?.pdf !== pdf) return false;
    if (bytes.length >= size * 0.98) {
      ui.confirm(t('compress.notSmaller'));
      return false;
    }
    const next = { bytes, annotations: null, page: tab.currentPage, selection: [], password: runtime.password };
    useHistory.getState().push(tabId, leavingState(tabId, tab, false), next);
    rememberScroll(tabId);
    await showState(tabId, next);
    ui.confirm(t('compress.done', { before: formatSize(size), after: formatSize(bytes.length), percent: Math.round((1 - bytes.length / size) * 100) }));
    return true;
  } catch (error) {
    ui.notify(operationErrorMessage(error, 'compress.failed'), errorMessage(error));
    return false;
  } finally {
    ui.setBusy(null);
  }
}

// Barrierefreiheit (Phase 7, ADR 0018): Sprache, Titel und Tab-Reihenfolge setzen, als neuer Stand
export function applyAccessibilityFix(tabId: string, fix: AccessibilityFix): Promise<boolean> {
  commitPendingEdits();
  if (findTab(tabId)?.working) return Promise.resolve(false);
  return enqueue(tabId, () => runAccessibilityFix(tabId, fix));
}

async function runAccessibilityFix(tabId: string, fix: AccessibilityFix): Promise<boolean> {
  const tab = findTab(tabId);
  const runtime = getRuntime(tabId);
  if (!tab || tab.status !== 'ready' || tab.saving || tab.encrypted || !runtime?.pdf) return false;
  const pdf = runtime.pdf;
  const ui = useUi.getState();
  ui.setBusy('accessibility.busy');
  try {
    const pending = await pendingChanges(tabId);
    const bytes = await fixAccessibility(await pdf.getData(), runtime.password, { ...pending, fix });
    if (getRuntime(tabId)?.pdf !== pdf) return false;
    const next = { bytes, annotations: null, page: tab.currentPage, selection: [], password: runtime.password };
    useHistory.getState().push(tabId, leavingState(tabId, tab, false), next);
    rememberScroll(tabId);
    await showState(tabId, next);
    return true;
  } catch (error) {
    ui.notify(operationErrorMessage(error, 'accessibility.fixFailed'), errorMessage(error));
    return false;
  } finally {
    ui.setBusy(null);
  }
}

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// Digitale Signaturen prüfen (Phase 7, ADR 0016), sobald ein Dokument mit Signaturfeldern geladen ist
export async function refreshSignatures(tabId: string): Promise<void> {
  const runtime = getRuntime(tabId);
  const pdf = runtime?.pdf;
  if (!pdf) return;
  try {
    const fields = (await pdf.getFieldObjects()) as unknown as Map<string, Array<{ type?: string }>> | null;
    const signed = [...(fields?.values() ?? [])].some((list) => list.some((field) => field.type === 'signature'));
    const checks = signed ? await checkSignatures(await pdf.getData()) : [];
    if (getRuntime(tabId)?.pdf !== pdf) return;
    useDocuments.getState().updateTab(tabId, { signatures: checks.length > 0 ? checks : null });
  } catch {
    if (getRuntime(tabId)?.pdf === pdf) useDocuments.getState().updateTab(tabId, { signatures: null });
  }
}

// Mit Zertifikat unterschreiben: neuer Stand, danach gleich speichern (Sichern unter), damit nichts Ungespeichertes die
// Signatur nachträglich „ändert“
export async function applyDigitalSignature(tabId: string, input: SignRequestInput): Promise<boolean> {
  commitPendingEdits();
  if (findTab(tabId)?.working) return false;
  const done = await enqueue(tabId, () => runDigitalSignature(tabId, input));
  if (done) await saveTab(tabId, 'saveAs');
  return done;
}

async function runDigitalSignature(tabId: string, input: SignRequestInput): Promise<boolean> {
  const tab = findTab(tabId);
  const runtime = getRuntime(tabId);
  if (!tab || tab.status !== 'ready' || tab.saving || !runtime?.pdf) return false;
  if (tab.encrypted) {
    useUi.getState().notify(t('errors.pages.sign-encrypted'));
    return false;
  }
  const pdf = runtime.pdf;
  const ui = useUi.getState();
  ui.setBusy('certify.busy');
  try {
    const pending = await pendingChanges(tabId);
    const bytes = await signWithCertificate(await pdf.getData(), runtime.password, { ...pending, sign: input });
    if (getRuntime(tabId)?.pdf !== pdf) return false;
    const next = { bytes, annotations: null, page: tab.currentPage, selection: [], password: runtime.password };
    useHistory.getState().push(tabId, leavingState(tabId, tab, false), next);
    rememberScroll(tabId);
    await showState(tabId, next);
    return true;
  } catch (error) {
    ui.notify(operationErrorMessage(error, 'certify.failed'), errorMessage(error));
    return false;
  } finally {
    ui.setBusy(null);
  }
}

// Prüft das Berechtigungskennwort eines geöffneten Dokuments
export async function checkOwnerPassword(tabId: string, password: string): Promise<boolean> {
  const pdf = getRuntime(tabId)?.pdf;
  if (!pdf) return false;
  const security = await readSecurity(await pdf.getData(), password).catch(() => null);
  return security?.ownerAccess === true;
}

async function runProtection(tabId: string, settings: SecuritySettings | null, ownerPassword: string | null): Promise<boolean> {
  const tab = findTab(tabId);
  const runtime = getRuntime(tabId);
  if (!tab || tab.status !== 'ready' || tab.saving || !runtime?.pdf) return false;
  const pdf = runtime.pdf;
  try {
    const annotations = tabAnnotations(tabId);
    const changes = annotations ? computeChanges(annotations.items, annotations.originals) : { upserts: [], deletions: [] };
    const forms = await currentFormChanges(tabId);
    const bytes = await protectDocument(await pdf.getData(), ownerPassword ?? runtime.password, { changes, formValues: forms, settings });
    if (getRuntime(tabId)?.pdf !== pdf) return false;
    // In dieser Sitzung mit vollen Rechten weiterarbeiten: Das Berechtigungskennwort öffnet das Dokument ebenfalls.
    const password = settings ? (settings.permissionsPassword ?? settings.openPassword) : null;
    const next = { bytes, annotations: null, page: tab.currentPage, selection: [], password };
    useHistory.getState().push(tabId, leavingState(tabId, tab, false), next);
    rememberScroll(tabId);
    await showState(tabId, next);
    useUi.getState().confirm(t(settings ? 'security.applied' : 'security.removed'));
    return true;
  } catch (error) {
    useUi.getState().notify(operationErrorMessage(error, 'security.failed'), errorMessage(error));
    return false;
  }
}

// Wechselt zu einem anderen Stand im Verlauf (Rückgängig/Wiederholen von Seitenoperationen).
async function goToState(tabId: string, index: number): Promise<void> {
  const tab = findTab(tabId);
  if (!tab || tab.status !== 'ready' || tab.saving) return;
  const leaving = leavingState(tabId, tab, true);
  const state = useHistory.getState().moveTo(tabId, index, leaving);
  if (!state) return;
  // Im Modus „Formular bearbeiten“ bleibt die Ansicht beim Rückgängigmachen an ihrer Stelle.
  if (tab.formEditing && tab.mode === 'view') rememberScroll(tabId);
  await showState(tabId, state);
}

// Rückgängig: zuerst Kommentarbefehle des aktuellen Stands, dann den vorherigen Dokumentstand.
// Entschieden wird erst, wenn eine laufende Operation fertig ist.
export function undoTab(tabId: string): void {
  // Ohne laufende Operation wirkt Rückgängig für Kommentare sofort (ohne Sperre der Oberfläche).
  if (!tabQueues.has(tabId) && tabAnnotations(tabId)?.undo.length) {
    useAnnotations.getState().undo(tabId);
    return;
  }
  void enqueue(tabId, async () => {
    if (tabAnnotations(tabId)?.undo.length) {
      useAnnotations.getState().undo(tabId);
      return;
    }
    const history = tabHistory(tabId);
    if (history && history.cursor > 0) await goToState(tabId, history.cursor - 1);
  });
}

export function redoTab(tabId: string): void {
  if (!tabQueues.has(tabId) && tabAnnotations(tabId)?.redo.length) {
    useAnnotations.getState().redo(tabId);
    return;
  }
  void enqueue(tabId, async () => {
    if (tabAnnotations(tabId)?.redo.length) {
      useAnnotations.getState().redo(tabId);
      return;
    }
    const history = tabHistory(tabId);
    if (history && history.cursor < history.states.length - 1) await goToState(tabId, history.cursor + 1);
  });
}

// Unterschreiben: gespeicherte Unterschrift wählen oder, wenn es noch keine gibt, gleich eine anlegen.
export function startSigning(): void {
  const tab = getActiveTab();
  if (!tab || tab.status !== 'ready' || tab.mode !== 'view' || tab.formEditing || tab.contentEditing) return;
  if (!tab.canAnnotate) {
    useUi.getState().notify(t('signatures.notAllowed'));
    return;
  }
  void api.signatures.list().then((list) => useUi.getState().setSignatureDialog(list.length > 0 ? 'choose' : 'create'));
}

// Offene Texteingaben (Kommentartext, Textfeld auf der Seite) übernehmen, bevor das Dokument weiterverarbeitet,
// gespeichert, gedruckt oder geschlossen wird. Die Felder übernehmen ihren Text beim Verlassen.
export function commitPendingEdits(): void {
  const element = document.activeElement;
  // Textfelder der Kommentare und alle Eingaben in Formularfeldern (pdf.js übernimmt manche Werte erst beim Verlassen)
  if (element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && (element.isContentEditable || element.closest('.annotationLayer')))) {
    element.blur();
  }
}

function isEditableFocus(): boolean {
  const element = document.activeElement;
  return element instanceof HTMLElement && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
}

export function setViewMode(tab: TabState, mode: ViewMode): void {
  useDocuments.getState().updateTab(tab.id, { viewMode: mode });
  const viewer = getRuntime(tab.id)?.viewer;
  if (!viewer) return;
  const page = viewer.currentPageNumber;
  const layout = layoutForMode(mode);
  viewer.scrollMode = layout.scrollMode;
  viewer.spreadMode = layout.spreadMode;
  viewer.currentPageNumber = page;
}

export function setScaleValue(tab: TabState, value: string): void {
  const viewer = getRuntime(tab.id)?.viewer;
  if (!viewer) return;
  viewer.currentScaleValue = value;
  // pdf.js meldet keine Änderung, wenn sich nur die Art (z. B. Automatisch → 125 %) ändert, nicht der Maßstab.
  useDocuments.getState().updateTab(tab.id, { scaleValue: viewer.currentScaleValue || value, scale: viewer.currentScale });
}

export function goToPage(tab: TabState, pageNumber: number): void {
  const viewer = getRuntime(tab.id)?.viewer;
  if (!viewer || tab.pageCount === 0) return;
  viewer.currentPageNumber = Math.min(tab.pageCount, Math.max(1, Math.round(pageNumber)));
}

export async function printTab(tab: TabState): Promise<void> {
  commitPendingEdits();
  const runtime = getRuntime(tab.id);
  const ui = useUi.getState();
  if (!runtime?.pdf || ui.print) return;
  if (!tab.canPrint) {
    ui.notify(t('print.notAllowed'));
    return;
  }
  printAbort = new AbortController();
  ui.setPrint({ tabId: tab.id, current: 0, total: runtime.pdf.numPages });
  // Ungespeicherte Kommentare werden mitgedruckt: Den aktuellen Stand im Speicher erzeugen, die Datei bleibt unverändert.
  let temporary: Awaited<ReturnType<typeof openTemporary>> | null = null;
  const annotations = tabAnnotations(tab.id);
  const changes = annotations ? computeChanges(annotations.items, annotations.originals) : null;
  if (changes && hasChanges(changes)) {
    try {
      const forms = await currentFormChanges(tab.id);
      const bytes = await processDocument(await runtime.pdf.getData(), runtime.password, { changes, formValues: forms });
      temporary = await openTemporary(bytes, runtime.password);
    } catch (error) {
      printAbort = null;
      useUi.getState().setPrint(null);
      useUi.getState().notify(t('errors.print.failed'), errorMessage(error));
      return;
    }
  }
  const result = await printDocument(
    temporary?.pdf ?? runtime.pdf,
    {
      onProgress: (current, total) => useUi.getState().setPrint({ tabId: tab.id, current, total }),
      print: () => api.print({ documentName: tab.title ?? tab.name }),
    },
    printAbort.signal,
  );
  printAbort = null;
  useUi.getState().setPrint(null);
  await temporary?.destroy();
  if (!result.ok && result.reason === 'failed') {
    useUi.getState().notify(t('errors.print.failed'), result.detail);
  }
}

export function cancelPrint(): void {
  printAbort?.abort();
}

const VIEW_MODE_BY_COMMAND: Partial<Record<CommandId, ViewMode>> = {
  'view.modeSingle': 'single',
  'view.modeContinuous': 'continuous',
  'view.modeTwoPage': 'two-page',
  'view.modeTwoPageContinuous': 'two-page-continuous',
};

function switchTab(offset: number): void {
  const { tabs, activeId, setActive } = useDocuments.getState();
  if (tabs.length < 2) return;
  const index = tabs.findIndex((tab) => tab.id === activeId);
  const next = tabs[(index + offset + tabs.length) % tabs.length];
  if (next) setActive(next.id);
}

export function executeCommand(command: CommandId): void {
  const ui = useUi.getState();
  if (ui.readMode && !READ_MODE_COMMANDS.includes(command)) return;
  if (command === 'view.readMode') {
    const active = getActiveTab();
    if (ui.readMode) exitReadMode();
    else if (active) enterReadMode(active);
    return;
  }
  if (command === 'file.open') {
    void openWithDialog();
    return;
  }
  if (command === 'app.checkUpdates') {
    void checkForUpdates();
    return;
  }
  if (command === 'app.home') {
    // Ohne Dokument ist die Startseite ohnehin zu sehen
    if (useDocuments.getState().tabs.length > 0) ui.setHomeOpen(!ui.homeOpen);
    return;
  }
  if (command === 'file.saveAsTemplate') {
    const active = getActiveTab();
    if (active?.status !== 'ready') return;
    commitPendingEdits();
    ui.setTemplateDialogTab(active.id);
    return;
  }
  if (command === 'app.settings') {
    ui.setSettingsOpen(true);
    return;
  }
  if (command === 'window.nextTab') return switchTab(1);
  if (command === 'window.previousTab') return switchTab(-1);
  if (command === 'window.moveTabToNewWindow') {
    const active = getActiveTab();
    if (active && useDocuments.getState().tabs.length > 1) void transferTab(active.id, { kind: 'new' });
    return;
  }
  if (runPageCommand(command, getActiveTab())) return;
  if (command === 'file.exportImages' || command === 'file.exportText') {
    const active = getActiveTab();
    if (active?.status !== 'ready' || active.working || isProgressRunning()) return;
    if (command === 'file.exportImages') ui.setExportImagesOpen(true);
    else void exportText(active);
    return;
  }
  if (command === 'tools.certify' || command === 'tools.signatures') {
    const active = getActiveTab();
    if (active?.status !== 'ready' || active.working) return;
    if (command === 'tools.signatures') {
      if (active.signatures?.length) useCertify.getState().setDetailsOpen(true);
      else ui.confirm(t('certify.noSignatures'));
    } else if (active.encrypted) ui.notify(t('errors.pages.sign-encrypted'));
    else useCertify.getState().setDialogOpen(true);
    return;
  }
  if (command === 'tools.ocr') {
    const active = getActiveTab();
    if (active?.status !== 'ready' || active.working || isProgressRunning()) return;
    if (!active.canModify) ui.notify(t('contentEdit.notAllowed'));
    else ui.setOcrOpen(true);
    return;
  }
  if (command === 'tools.accessibility') {
    const active = getActiveTab();
    if (active?.status === 'ready') useAccessibility.getState().setOpen(true);
    return;
  }
  if (command === 'tools.pdfa') {
    const active = getActiveTab();
    if (active?.status === 'ready' && !active.working) void openPdfACheck(active);
    return;
  }
  if (command === 'tools.compare') {
    const active = getActiveTab();
    if (active?.status === 'ready' && !active.working) void compareWithFile(active);
    return;
  }
  if (command === 'tools.clean') {
    const active = getActiveTab();
    if (active?.status !== 'ready' || active.working) return;
    if (active.encrypted) ui.notify(t('errors.pages.clean-encrypted'));
    else if (!active.canModify) ui.notify(t('contentEdit.notAllowed'));
    else ui.setCleanOpen(true);
    return;
  }
  if (command === 'tools.compress') {
    const active = getActiveTab();
    if (active?.status !== 'ready' || active.working) return;
    if (active.encrypted) ui.notify(t('errors.pages.compress-encrypted'));
    else ui.setCompressOpen(true);
    return;
  }
  if (command === 'tools.security') {
    const active = getActiveTab();
    if (active?.status === 'ready' && !active.working) ui.setSecurityDialogOpen(true);
    return;
  }
  if (command === 'tools.sign') {
    startSigning();
    return;
  }
  if (command === 'tools.highlight') {
    const active = getActiveTab();
    if (active) toggleMarkTools(active);
    return;
  }
  if (command === 'forms.edit') {
    const active = getActiveTab();
    if (active) toggleFormEditing(active);
    return;
  }
  if (command === 'file.newBlank') {
    void createBlankDocument();
    return;
  }
  if (command === 'content.edit') {
    const active = getActiveTab();
    if (active) toggleContentEditing(active);
    return;
  }
  if (command.startsWith('stamp.')) {
    const active = getActiveTab();
    if (!active) return;
    if (command === 'stamp.watermark') openStampDialog(active, 'watermark');
    else if (command === 'stamp.headerFooter') openStampDialog(active, 'headerFooter');
    else if (command === 'stamp.pageNumbers') openStampDialog(active, 'pageNumbers');
    else removeArtifacts(active, command === 'stamp.removeWatermark' ? 'watermark' : 'headerFooter');
    return;
  }
  if (command === 'redact.tools' || command === 'redact.find' || command === 'redact.apply') {
    const active = getActiveTab();
    if (!active) return;
    if (command === 'redact.tools') toggleRedactTools(active);
    else if (command === 'redact.find') openRedactFind(active);
    else openRedactApply(active);
    return;
  }

  const tab = getActiveTab();
  if (!tab) return;
  const runtime = getRuntime(tab.id);
  const viewer = runtime?.viewer ?? null;

  const mode = VIEW_MODE_BY_COMMAND[command];
  if (mode) {
    setViewMode(tab, mode);
    return;
  }

  switch (command) {
    case 'file.close':
      void closeTab(tab.id);
      return;
    case 'file.save':
      void saveTab(tab.id, 'save');
      return;
    case 'file.saveAs':
      void saveTab(tab.id, 'saveAs');
      return;
    case 'file.rename':
      // Ein neues leeres Dokument hat noch keinen Ort: erst sichern
      if (tab.untitled) useUi.getState().notify(t('rename.errors.untitled'));
      else useUi.getState().setRenameTab(tab.id);
      return;
    case 'edit.undo':
    case 'edit.redo':
      // In Eingabefeldern wirkt Rückgängig auf den Text, sonst auf die Kommentare.
      if (isEditableFocus()) document.execCommand(command === 'edit.undo' ? 'undo' : 'redo');
      else if (command === 'edit.undo') undoTab(tab.id);
      else redoTab(tab.id);
      return;
    case 'edit.delete': {
      // Im Raster „Seiten organisieren“ löscht Entfernen die ausgewählten Seiten.
      if (tab.mode === 'organize') {
        if (tab.canAssemble && tab.pageSelection.length > 0 && !tab.working && !isEditableFocus()) {
          void deletePages(tab, targetPages(tab));
        }
        return;
      }
      // Im Modus „Inhalt bearbeiten“ löscht Entfernen das ausgewählte Objekt.
      if (tab.contentEditing) {
        if (!tab.working && !isEditableFocus()) deleteSelectedObject(tab);
        return;
      }
      // Im Modus „Formular bearbeiten“ löscht Entfernen das ausgewählte Feld.
      if (tab.formEditing) {
        if (!tab.working && !isEditableFocus()) deleteSelectedField(tab);
        return;
      }
      const selected = tabAnnotations(tab.id)?.selectedId;
      if (selected && tab.canAnnotate && !isEditableFocus()) deleteAnnotation(tab.id, selected);
      return;
    }
    case 'view.toggleCommentTools':
      // Kommentieren beendet „Formular bearbeiten“ und „Inhalt bearbeiten“.
      if (tab.contentEditing) toggleContentEditing(tab);
      if (tab.formEditing) {
        toggleFormEditing(tab);
        ui.setCommentToolsVisible(true);
        useAnnotations.getState().setTool('select');
        return;
      }
      ui.setCommentToolsVisible(!ui.commentToolsVisible);
      // Werkzeuge der Leiste „Schwärzen“ gehören nicht zu den Kommentarwerkzeugen.
      useAnnotations.getState().setTool('select');
      return;
    case 'file.print':
      void printTab(tab);
      return;
    case 'file.properties':
      if (tab.status === 'ready') ui.openProperties(tab.id);
      return;
    case 'edit.find':
      ui.requestSearchFocus();
      return;
    case 'edit.findNext':
    case 'edit.findPrevious':
      if (runtime && tab.search.query) {
        ui.setRightPanelVisible(true);
        dispatchFind(runtime, tab.search, 'again', command === 'edit.findPrevious');
      } else {
        ui.requestSearchFocus();
      }
      return;
    case 'view.toggleSidebar':
      ui.setSidebarVisible(!ui.sidebarVisible);
      return;
    case 'view.toggleRightPanel':
      ui.setRightPanelVisible(!ui.rightPanelVisible);
      return;
    case 'nav.goToPage':
      if (tab.status === 'ready') ui.setGoToPageOpen(true);
      return;
    default:
      break;
  }

  if (!viewer) return;
  switch (command) {
    case 'view.zoomIn':
      viewer.increaseScale();
      return;
    case 'view.zoomOut':
      viewer.decreaseScale();
      return;
    case 'view.fitPage':
      viewer.currentScaleValue = 'page-fit';
      return;
    case 'view.actualSize':
      viewer.currentScaleValue = 'page-actual';
      return;
    case 'view.fitWidth':
      viewer.currentScaleValue = 'page-width';
      return;
    case 'view.rotateClockwise':
      viewer.pagesRotation = (viewer.pagesRotation + 90) % 360;
      return;
    case 'view.rotateCounterClockwise':
      viewer.pagesRotation = (viewer.pagesRotation + 270) % 360;
      return;
    case 'nav.firstPage':
      viewer.currentPageNumber = 1;
      return;
    case 'nav.previousPage':
      viewer.previousPage();
      return;
    case 'nav.nextPage':
      viewer.nextPage();
      return;
    case 'nav.lastPage':
      viewer.currentPageNumber = viewer.pagesCount;
      return;
    default:
      return;
  }
}
