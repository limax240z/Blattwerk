import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { FileInfo } from '../../shared/ipc';
import { useDocuments, type SearchState, type SearchStatus } from '../state/documents-store';
import { joinTextItems, type PageText } from '../features/search/snippet';
import { ThumbnailCache } from '../features/thumbnails/thumbnail-cache';
import { layoutForMode } from '../features/viewer/view-modes';
import { pdfjs, PDFJS_ASSETS } from './pdfjs';
import {
  EventBus,
  FindState,
  GenericL10n,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from './pdfjs-viewer';

// Alles, was zu einem geöffneten Dokument gehört und nicht in den Zustand (zustand) passt:
// pdf.js-Objekte, Worker, Caches. Schlüssel ist die Tab-ID.
export interface DocumentRuntime {
  tabId: string;
  file: FileInfo;
  eventBus: EventBus;
  linkService: PDFLinkService;
  findController: PDFFindController;
  pdf: PDFDocumentProxy | null;
  viewer: PDFViewer | null;
  thumbnails: ThumbnailCache;
  pageTexts: Map<number, Promise<PageText>>;
  // Container der Seitenansicht, um den Tastaturfokus dorthin zurückzugeben
  container: HTMLDivElement | null;
  // Vorhandene Anmerkungen, die pdf.js gerade nicht zeichnet (geändert oder gelöscht): ref → Seite
  hiddenRefs: Map<string, number>;
  // Kennwort, mit dem das Dokument geöffnet wurde (nur im Speicher, für Speichern und Neuladen)
  password: string | null;
  // true, solange die Suche geschlossen ist. pdf.js meldet beim Schließen noch einmal den alten
  // Trefferstand; der darf den Zustand nicht überschreiben.
  findClosed: boolean;
  // Übernimmt eine laufende Pinch-Vorschau sofort in pdf.js (ViewerHost); vor jedem anderen Zoom- oder Ansichtswechsel
  flushZoom: (() => void) | null;
  terminate: () => void;
}

const runtimes = new Map<string, DocumentRuntime>();
// Scrollposition, die nach dem nächsten Laden eines Tabs wiederhergestellt wird (Formularfelder bearbeiten)
const pendingScroll = new Map<string, { top: number; left: number }>();

// Merkt sich die Scrollposition eines Tabs für das nächste Neuladen (gleiche Seiten, gleicher Zoom).
export function rememberScroll(tabId: string): void {
  const container = runtimes.get(tabId)?.container;
  if (container) pendingScroll.set(tabId, { top: container.scrollTop, left: container.scrollLeft });
}
let sharedL10n: GenericL10n | null = null;

function l10n(): GenericL10n {
  sharedL10n ??= new GenericL10n('de');
  return sharedL10n;
}

export function getRuntime(tabId: string): DocumentRuntime | undefined {
  return runtimes.get(tabId);
}

export function createRuntime(tabId: string, file: FileInfo, terminate: () => void): DocumentRuntime {
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: LinkTarget.BLANK,
    externalLinkRel: 'noopener noreferrer nofollow',
  });
  const findController = new PDFFindController({ eventBus, linkService, updateMatchesCountOnProgress: true });
  const runtime: DocumentRuntime = {
    tabId,
    file,
    eventBus,
    linkService,
    findController,
    pdf: null,
    viewer: null,
    thumbnails: new ThumbnailCache(),
    pageTexts: new Map(),
    container: null,
    findClosed: true,
    hiddenRefs: new Map(),
    flushZoom: null,
    password: null,
    terminate,
  };
  runtimes.set(tabId, runtime);
  wireEvents(runtime);
  return runtime;
}

export function destroyRuntime(tabId: string): void {
  const runtime = runtimes.get(tabId);
  if (!runtime) return;
  runtimes.delete(tabId);
  runtime.thumbnails.clear();
  runtime.pageTexts.clear();
  try {
    runtime.viewer?.setDocument(null as unknown as PDFDocumentProxy);
  } catch {
    // Der Viewer kann bereits abgebaut sein.
  }
  runtime.viewer = null;
  runtime.pdf = null;
  runtime.terminate();
}

// pdf.js kennt zwei Arten, Anmerkungen anzuzeigen: mit bedienbaren Formularfeldern (ENABLE_FORMS) oder unter
// Berücksichtigung des Anmerkungsspeichers beim Zeichnen (ENABLE_STORAGE; damit blenden wir geänderte Kommentare aus).
// Blattwerk braucht beides. Der Zeichner im Worker wertet den mitgeschickten Speicher unabhängig vom Modus aus;
// nur das Kennzeichen „Formulare“ entscheidet, ob Felder als HTML statt auf dem Seitenbild erscheinen. Deshalb
// liefert die Anzeige für ENABLE_FORMS die Angaben von ENABLE_STORAGE plus das Formular-Kennzeichen.
// Betrifft die internen Teile von pdfjs-dist 6.4.299 (_transport.getRenderingIntent, RenderingIntentFlag);
// geprüft durch die Oberflächentests für Kommentare und Formulare.
const RENDERING_INTENT_FORMS = 0x10;

interface RenderingIntentArgs {
  renderingIntent: number;
  cacheKey: string;
}

export function combineFormsWithStorage(pdf: PDFDocumentProxy): void {
  const transport = (pdf as unknown as { _transport?: { getRenderingIntent?: (...args: unknown[]) => RenderingIntentArgs } })._transport;
  const original = transport?.getRenderingIntent?.bind(transport);
  if (!transport || !original) return;
  transport.getRenderingIntent = (intent: unknown, annotationMode: unknown, ...rest: unknown[]) => {
    if (intent !== 'display' || annotationMode !== pdfjs.AnnotationMode.ENABLE_FORMS) return original(intent, annotationMode, ...rest);
    const args = original(intent, pdfjs.AnnotationMode.ENABLE_STORAGE, ...rest);
    const renderingIntent = args.renderingIntent | RENDERING_INTENT_FORMS;
    return { ...args, renderingIntent, cacheKey: args.cacheKey.replace(/^\d+/, String(renderingIntent)) };
  };
}

export function setRuntimeDocument(runtime: DocumentRuntime, pdf: PDFDocumentProxy): void {
  combineFormsWithStorage(pdf);
  runtime.pdf = pdf;
  runtime.linkService.setDocument(pdf, null);
  runtime.findController.setDocument(pdf);
}

// Erstellt die Seitenansicht von pdf.js im übergebenen Container.
export function attachViewer(runtime: DocumentRuntime, container: HTMLDivElement, viewerElement: HTMLDivElement): () => void {
  if (!runtime.pdf) return () => undefined;
  const tab = useDocuments.getState().tabs.find((t) => t.id === runtime.tabId);
  const viewer = new PDFViewer({
    container,
    viewer: viewerElement,
    eventBus: runtime.eventBus,
    linkService: runtime.linkService,
    findController: runtime.findController,
    l10n: l10n(),
    textLayerMode: 1,
    // Bedienbare Formularfelder; den Anmerkungsspeicher berücksichtigt das Zeichnen trotzdem (combineFormsWithStorage).
    annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
    annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
    imageResourcesPath: PDFJS_ASSETS.imageResourcesPath,
    enablePermissions: true,
    enableAutoLinking: true,
  });
  runtime.viewer = viewer;
  runtime.container = container;
  runtime.linkService.setViewer(viewer);

  const onPagesInit = () => {
    const current = useDocuments.getState().tabs.find((t) => t.id === runtime.tabId);
    const layout = layoutForMode(current?.viewMode ?? 'continuous');
    viewer.scrollMode = layout.scrollMode;
    viewer.spreadMode = layout.spreadMode;
    viewer.currentScaleValue = current?.scaleValue ?? 'auto';
    // Nach dem Neuladen (Speichern) an derselben Stelle weitermachen
    if (current && current.currentPage > 1) viewer.currentPageNumber = Math.min(current.currentPage, viewer.pagesCount);
    const scroll = pendingScroll.get(runtime.tabId);
    if (scroll) {
      pendingScroll.delete(runtime.tabId);
      container.scrollTop = scroll.top;
      container.scrollLeft = scroll.left;
    }
  };
  runtime.eventBus.on('pagesinit', onPagesInit);
  viewer.setDocument(runtime.pdf);
  if (tab?.rotation) viewer.pagesRotation = tab.rotation;

  return () => {
    runtime.eventBus.off('pagesinit', onPagesInit);
    if (runtime.container === container) runtime.container = null;
    if (runtime.viewer === viewer) {
      runtime.viewer = null;
      try {
        viewer.setDocument(null as unknown as PDFDocumentProxy);
      } catch {
        // ignorieren
      }
    }
  };
}

function findStatus(state: number, previous: boolean): SearchStatus {
  switch (state) {
    case FindState.FOUND:
      return 'found';
    case FindState.NOT_FOUND:
      return 'not-found';
    case FindState.WRAPPED:
      return previous ? 'wrapped-bottom' : 'wrapped-top';
    case FindState.PENDING:
      return 'pending';
    default:
      return 'idle';
  }
}

function pagesWithMatches(controller: PDFFindController): SearchState['pages'] {
  const pages: SearchState['pages'] = [];
  const matches = controller.pageMatches ?? [];
  matches.forEach((pageMatches, pageIndex) => {
    const count = Array.isArray(pageMatches) ? pageMatches.length : 0;
    if (count > 0) pages.push({ pageIndex, count });
  });
  return pages;
}

function wireEvents(runtime: DocumentRuntime): void {
  const { eventBus, tabId } = runtime;
  const update = useDocuments.getState().updateTab;
  const updateSearch = useDocuments.getState().updateSearch;

  eventBus.on('pagechanging', (evt: { pageNumber: number }) => update(tabId, { currentPage: evt.pageNumber }));
  eventBus.on('scalechanging', (evt: { scale: number; presetValue?: string }) =>
    update(tabId, { scale: evt.scale, scaleValue: evt.presetValue ?? String(evt.scale) }),
  );
  eventBus.on('rotationchanging', (evt: { pagesRotation: number }) => update(tabId, { rotation: evt.pagesRotation }));

  let pagesTimer: ReturnType<typeof setTimeout> | null = null;
  const schedulePages = () => {
    if (pagesTimer) return;
    pagesTimer = setTimeout(() => {
      pagesTimer = null;
      updateSearch(tabId, { pages: pagesWithMatches(runtime.findController) });
    }, 150);
  };

  // Meldungen der Suche nur übernehmen, wenn sie offen ist und einen Suchbegriff hat.
  const searchActive = () =>
    !runtime.findClosed && Boolean(useDocuments.getState().tabs.find((t) => t.id === tabId)?.search.query);

  eventBus.on('updatefindmatchescount', (evt: { matchesCount: { current: number; total: number } }) => {
    if (!searchActive()) return;
    updateSearch(tabId, { current: evt.matchesCount.current, total: evt.matchesCount.total });
    schedulePages();
  });
  eventBus.on(
    'updatefindcontrolstate',
    (evt: { state: number; previous: boolean; matchesCount: { current: number; total: number } }) => {
      if (!searchActive()) return;
      updateSearch(tabId, {
        status: findStatus(evt.state, evt.previous),
        current: evt.matchesCount.current,
        total: evt.matchesCount.total,
      });
      schedulePages();
    },
  );

  // Seiten, die der Viewer ohnehin gerendert hat, liefern billige Miniaturen.
  eventBus.on(
    'pagerendered',
    (evt: {
      pageNumber: number;
      source?: { canvas?: HTMLCanvasElement | null };
      cssTransform?: boolean;
      isDetailView?: boolean;
      error?: unknown;
    }) => {
    // Nur vollständige, frisch gerenderte Seiten: Bei CSS-Drehung ist das Canvas noch alt,
    // eine Detailansicht zeigt nur einen Ausschnitt.
    if (evt.cssTransform || evt.isDetailView || evt.error) return;
    const canvas = evt.source?.canvas;
    const rotation = runtime.viewer?.pagesRotation ?? 0;
    if (canvas) runtime.thumbnails.offerRenderedPage(evt.pageNumber, canvas, rotation);
    },
  );
}

export type FindType =
  | ''
  | 'again'
  | 'casesensitivitychange'
  | 'entirewordchange'
  | 'diacriticmatchingchange'
  | 'highlightallchange';

export function dispatchFind(runtime: DocumentRuntime, search: SearchState, type: FindType, findPrevious = false): void {
  runtime.findClosed = false;
  runtime.eventBus.dispatch('find', {
    source: null,
    type,
    query: search.query,
    caseSensitive: search.caseSensitive,
    entireWord: search.entireWord,
    matchDiacritics: search.matchDiacritics,
    highlightAll: true,
    findPrevious,
  });
}

export function closeFind(runtime: DocumentRuntime): void {
  runtime.findClosed = true;
  runtime.eventBus.dispatch('findbarclose', { source: null });
}

// Wählt einen bestimmten Treffer aus (wie „Weitersuchen“ bis zu genau diesem Treffer).
// pdf.js hat dafür keine öffentliche Schnittstelle; _selected und _offset gibt es in pdfjs-dist 6.4.299
// als Felder von PDFFindController. Fehlen sie, springt die Funktion nur zur Seite.
export function selectMatch(runtime: DocumentRuntime, search: SearchState, pageIndex: number, matchIndex: number): void {
  const controller = runtime.findController as unknown as {
    _selected?: { pageIdx: number; matchIdx: number };
    _offset?: { pageIdx: number | null; matchIdx: number | null; wrapped: boolean };
  };
  if (!controller._selected || !controller._offset) {
    if (runtime.viewer) runtime.viewer.currentPageNumber = pageIndex + 1;
    return;
  }
  const previousPage = controller._selected.pageIdx;
  // Erst zur Seite wechseln, sonst beginnt pdf.js die Suche von der aktuellen Seite neu.
  runtime.linkService.page = pageIndex + 1;
  controller._selected = { pageIdx: pageIndex, matchIdx: -1 };
  controller._offset = { pageIdx: pageIndex, matchIdx: matchIndex > 0 ? matchIndex - 1 : null, wrapped: false };
  if (previousPage !== -1 && previousPage !== pageIndex) {
    runtime.eventBus.dispatch('updatetextlayermatches', { source: runtime.findController, pageIndex: previousPage });
  }
  dispatchFind(runtime, search, 'again', false);
}

// Gibt den Tastaturfokus an die Seitenansicht zurück (z. B. nach Klicks in der Werkzeugleiste),
// damit Pfeiltasten, Bild auf/ab und Leertaste weiter das Dokument bewegen.
export function focusViewer(runtime: DocumentRuntime | undefined): void {
  runtime?.container?.focus({ preventScroll: true });
}

// Position eines Treffers im unveränderten Seitentext (so wie pdf.js ihn für die Markierung nutzt).
export function matchPosition(
  runtime: DocumentRuntime,
  pageIndex: number,
  matchIndex: number,
): { start: number; length: number } | null {
  const controller = runtime.findController as unknown as { pageMatchesLength?: number[][] };
  const start = runtime.findController.pageMatches?.[pageIndex]?.[matchIndex] as number | undefined;
  const length = controller.pageMatchesLength?.[pageIndex]?.[matchIndex];
  return start === undefined || length === undefined ? null : { start, length };
}

// Seitentext in der Zählweise der pdf.js-Treffer (siehe snippet.ts). Wird pro Seite einmal geladen.
export function originalPageText(runtime: DocumentRuntime, pageIndex: number): Promise<PageText> {
  let cached = runtime.pageTexts.get(pageIndex);
  if (!cached) {
    const pdf = runtime.pdf;
    cached = pdf
      ? pdf
          .getPage(pageIndex + 1)
          .then((page) => page.getTextContent({ disableNormalization: true }))
          .then((content) => joinTextItems(content.items as Array<{ str?: string; hasEOL?: boolean }>))
      : Promise.resolve({ text: '', breaks: [] });
    runtime.pageTexts.set(pageIndex, cached);
  }
  return cached;
}
