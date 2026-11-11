// Steuerung der Kommentare eines Tabs: Einlesen, Anlegen, Ändern, Löschen, Antworten, Status.
// Alle Änderungen laufen als umkehrbare Befehle über den Kommentar-Speicher.
import type {
  Annotation,
  Rect,
  Reply,
  ReviewStatus,
  StatusEntry,
} from '../../../shared/annotations';
import { toPdfDate } from '../../../shared/annotations';
import { getRuntime } from '../../engine/runtime';
import { useAnnotations, tabAnnotations, type Command } from '../../state/annotations-store';
import { useHistory } from '../../state/history-store';
import { useUi } from '../../state/ui-store';
import { hiddenOriginals } from './changes';
import { convertPageAnnotations, type PdfjsAnnotationData } from './from-pdfjs';

// Präfix, unter dem pdf.js Bearbeitungen im Anmerkungsspeicher erwartet (pdfjs-dist 6.4.299,
// AnnotationEditorPrefix). Einträge mit deleted: true blendet pdf.js beim Zeichnen aus.
const PDFJS_EDITOR_PREFIX = 'pdfjs_internal_editor_';
const HIDDEN_KEY = (ref: string) => `${PDFJS_EDITOR_PREFIX}blattwerk_hidden_${ref}`;

const PAGES_PER_BATCH = 10;

function now(): string {
  return toPdfDate(new Date());
}

export function newId(): string {
  return crypto.randomUUID();
}

export function authorName(): string {
  return useUi.getState().authorName;
}

// Liest alle vorhandenen Anmerkungen seitenweise im Hintergrund ein.
export async function loadAnnotations(tabId: string): Promise<void> {
  const runtime = getRuntime(tabId);
  const pdf = runtime?.pdf;
  if (!pdf) return;
  useAnnotations.getState().init(tabId);
  for (let start = 0; start < pdf.numPages; start += PAGES_PER_BATCH) {
    const end = Math.min(start + PAGES_PER_BATCH, pdf.numPages);
    const batch: Annotation[] = [];
    for (let index = start; index < end; index++) {
      if (getRuntime(tabId)?.pdf !== pdf) return;
      try {
        const page = await pdf.getPage(index + 1);
        const data = (await page.getAnnotations({ intent: 'display' })) as unknown as PdfjsAnnotationData[];
        batch.push(...convertPageAnnotations(data, index));
      } catch {
        // Beschädigte Seite: ihre Anmerkungen fehlen in der Liste, pdf.js zeigt sie trotzdem an.
      }
    }
    if (getRuntime(tabId)?.pdf !== pdf) return;
    useAnnotations.getState().addLoaded(tabId, batch, end >= pdf.numPages);
    // Der Oberfläche zwischen den Stapeln Luft lassen
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Gleicht ab, welche vorhandenen Anmerkungen pdf.js nicht mehr zeichnen soll, und zeichnet betroffene Seiten neu.
export function syncHiddenAnnotations(tabId: string): void {
  const runtime = getRuntime(tabId);
  const tab = tabAnnotations(tabId);
  if (!runtime?.pdf || !tab) return;
  const wanted = hiddenOriginals(tab.items, tab.originals);
  const storage = runtime.pdf.annotationStorage;
  const touched = new Set<number>();
  for (const [ref, pageIndex] of runtime.hiddenRefs) {
    if (!wanted.has(ref)) {
      storage.remove(HIDDEN_KEY(ref));
      runtime.hiddenRefs.delete(ref);
      touched.add(pageIndex);
      for (const element of runtime.container?.querySelectorAll<HTMLElement>(domSelector(ref)) ?? []) {
        element.style.display = '';
      }
    }
  }
  for (const [ref, pageIndex] of wanted) {
    if (runtime.hiddenRefs.has(ref)) continue;
    storage.setValue(HIDDEN_KEY(ref), { deleted: true, id: ref, pageIndex, annotationType: 0 });
    runtime.hiddenRefs.set(ref, pageIndex);
    touched.add(pageIndex);
  }
  const viewer = runtime.viewer;
  if (runtime.container) hideDomAnnotations(tabId, runtime.container);
  if (!viewer || touched.size === 0) return;
  // Nur das Seitenbild neu zeichnen; das alte bleibt bis dahin stehen (wie beim Zoomen in pdf.js).
  for (const pageIndex of touched) {
    const view = viewer.getPageView(pageIndex) as { reset?: (options: Record<string, boolean>) => void } | undefined;
    view?.reset?.({ keepAnnotationLayer: true, keepTextLayer: true, keepCanvasWrapper: true, preserveDetailViewState: true });
  }
  viewer.update();
}

const domSelector = (ref: string) => `.annotationLayer [data-annotation-id="${CSS.escape(ref)}"]`;

// pdf.js legt für manche Anmerkungen zusätzlich HTML-Elemente an (z. B. Notizsymbole ohne eigene Darstellung).
// Die Elemente ausgeblendeter Anmerkungen verschwinden ebenfalls.
export function hideDomAnnotations(tabId: string, root: HTMLElement): void {
  const runtime = getRuntime(tabId);
  if (!runtime) return;
  for (const ref of runtime.hiddenRefs.keys()) {
    for (const element of root.querySelectorAll<HTMLElement>(domSelector(ref))) {
      element.style.display = 'none';
    }
  }
}

// Jede neue Kommentaraktion macht das Wiederholen zurückgenommener Seitenoperationen unmöglich.
function newAction(tabId: string): void {
  useHistory.getState().dropRedo(tabId);
}

export function addAnnotation(tabId: string, annotation: Annotation): void {
  newAction(tabId);
  useAnnotations.getState().apply(tabId, { type: 'add', annotation });
  useAnnotations.getState().select(tabId, annotation.id);
}

// Mehrere auf einmal (ein Schritt für Rückgängig), z. B. alle Treffer von „Suchen und schwärzen“
export function addAnnotations(tabId: string, annotations: Annotation[]): void {
  if (annotations.length === 0) return;
  newAction(tabId);
  useAnnotations.getState().apply(tabId, { type: 'addMany', annotations });
}

export function updateAnnotation(tabId: string, before: Annotation, after: Annotation): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  newAction(tabId);
  useAnnotations.getState().apply(tabId, { type: 'update', before, after: { ...after, modified: now() } as Annotation });
}

export function deleteAnnotation(tabId: string, id: string): void {
  const tab = tabAnnotations(tabId);
  const index = tab?.items.findIndex((a) => a.id === id) ?? -1;
  const annotation = index >= 0 ? tab?.items[index] : undefined;
  if (!annotation) return;
  newAction(tabId);
  useAnnotations.getState().apply(tabId, { type: 'remove', annotation, index });
}

// Ergebnis eines Wischs mit dem Radierer als ein Schritt: geänderte Freihandzeichnungen (Teile entfernt) und ganz
// entfernte Kommentare (null). Die Lage in der Liste bleibt beim Rückgängigmachen erhalten.
export function applyErase(tabId: string, changes: Record<string, Annotation | null>): void {
  const tab = tabAnnotations(tabId);
  if (!tab) return;
  const updates: Command[] = [];
  const removals: Command[] = [];
  tab.items.forEach((annotation, index) => {
    if (!(annotation.id in changes)) return;
    const next = changes[annotation.id];
    if (next === null) removals.push({ type: 'remove', annotation, index });
    else if (next) updates.push({ type: 'update', before: annotation, after: { ...next, modified: now() } as Annotation });
  });
  if (updates.length + removals.length === 0) return;
  newAction(tabId);
  useAnnotations.getState().apply(tabId, { type: 'batch', commands: [...updates, ...removals] });
}

function find(tabId: string, id: string): Annotation | undefined {
  return tabAnnotations(tabId)?.items.find((a) => a.id === id);
}

export function setContents(tabId: string, id: string, contents: string): void {
  const before = find(tabId, id);
  if (!before || before.contents === contents) return;
  updateAnnotation(tabId, before, { ...before, contents } as Annotation);
}

// Text und Lage zugleich (Textfeld, das beim Tippen gewachsen ist): ein Schritt zum Rückgängigmachen
export function setContentsAndRect(tabId: string, id: string, contents: string, rect: Rect): void {
  const before = find(tabId, id);
  if (!before) return;
  updateAnnotation(tabId, before, { ...before, contents, rect } as Annotation);
}

export function addReply(tabId: string, id: string, contents: string): void {
  const before = find(tabId, id);
  const text = contents.trim();
  if (!before || !text) return;
  const reply: Reply = { id: newId(), ref: null, author: authorName(), contents: text, modified: now() };
  updateAnnotation(tabId, before, { ...before, replies: [...before.replies, reply] } as Annotation);
}

export function editReply(tabId: string, id: string, replyId: string, contents: string): void {
  const before = find(tabId, id);
  if (!before) return;
  const replies = before.replies.map((r) => (r.id === replyId ? { ...r, contents, modified: now() } : r));
  updateAnnotation(tabId, before, { ...before, replies } as Annotation);
}

export function deleteReply(tabId: string, id: string, replyId: string): void {
  const before = find(tabId, id);
  if (!before) return;
  updateAnnotation(tabId, before, { ...before, replies: before.replies.filter((r) => r.id !== replyId) } as Annotation);
}

export function setStatus(tabId: string, id: string, status: ReviewStatus): void {
  const before = find(tabId, id);
  if (!before) return;
  const entry: StatusEntry = { id: newId(), ref: null, author: authorName(), status, modified: now() };
  updateAnnotation(tabId, before, { ...before, statuses: [...before.statuses, entry] } as Annotation);
}

// Grundwerte für neue Kommentare (Autor, Zeit, Kennung).
export function baseFields(pageIndex: number) {
  const stamp = now();
  return {
    id: newId(),
    ref: null,
    pageIndex,
    author: authorName(),
    created: stamp,
    modified: stamp,
    contents: '',
    opacity: useAnnotations.getState().opacity,
    replies: [],
    statuses: [],
  };
}
