// Abläufe für „Seiten organisieren“ (Phase 3): Quelldateien laden, Seiten drehen, löschen, verschieben, einfügen,
// extrahieren, teilen, Dateien zusammenführen und Bilder in PDF umwandeln.
import type { FileInfo, SaveNewResult, SaveToFolderResult } from '../../../shared/ipc';
import type { ComposePart, ImageSource, Margins, PageOperation } from '../../../shared/pages';
import { formatPageRanges, moveTarget, pageSelection } from '../../../shared/pages';
import { readImageInfo } from '../../../shared/image-info';
import { api } from '../../api';
import { readChunked } from '../../engine/file-reader';
import { composeDocument, inspectDocument, PdfiumClientError, processDocument } from '../../engine/pdfium-client';
import { getRuntime } from '../../engine/runtime';
import { applyPageOperations, commitPendingEdits, handleOpenResult } from '../../engine/session';
import { t } from '../../i18n';
import { tabAnnotations } from '../../state/annotations-store';
import { currentFormChanges } from '../forms/form-sync';
import { useDocuments, type TabState } from '../../state/documents-store';
import { useUi, type SourceFile } from '../../state/ui-store';
import { computeChanges, hasChanges } from '../annotations/changes';

// Größte Bildfläche, die eingebettet wird (Schutz vor riesigen Bildern, die den Speicher sprengen)
export const MAX_IMAGE_PIXELS = 100_000_000;

const baseName = (name: string) => name.replace(/\.pdf$/i, '');

function notify(message: string, detail?: string): void {
  useUi.getState().notify(message, detail);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: unknown): void {
  const code = error instanceof PdfiumClientError ? error.code : 'failed';
  notify(t(`errors.pages.${code}`), errorDetail(error));
}

// Fragt nach dem Kennwort einer Quelldatei. null = abgebrochen.
export function askPassword(name: string, incorrect: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    useUi.getState().setPasswordRequest({
      name,
      incorrect,
      resolve: (password) => {
        useUi.getState().setPasswordRequest(null);
        resolve(password);
      },
    });
  });
}

// Führt eine längere Aufgabe mit Hinweis „… läuft“ aus.
export async function busy<T>(messageKey: string, task: () => Promise<T>): Promise<T> {
  useUi.getState().setBusy(messageKey);
  try {
    return await task();
  } finally {
    useUi.getState().setBusy(null);
  }
}

// Liest die gewählten Dateien ein, prüft PDFs (Kennwort) und Bilder. null = vom Nutzer abgebrochen.
export async function loadSources(files: FileInfo[]): Promise<SourceFile[] | null> {
  const sources: SourceFile[] = [];
  try {
    for (const file of files) {
      const bytes = await readChunked((begin, end) => api.readRange(file.fileId, begin, end), 0, file.size);
      if (file.kind === 'pdf') {
        let password: string | null = null;
        for (;;) {
          const result = await inspectDocument(bytes, password);
          if (result.ok) {
            sources.push({ name: file.name, kind: 'pdf', bytes, password, pageCount: result.pageCount, image: null });
            break;
          }
          if (result.reason === 'invalid') {
            notify(t('pages.errors.invalidFile', { name: file.name }));
            break;
          }
          const entered = await askPassword(file.name, password !== null);
          if (entered === null) return null;
          password = entered;
        }
        continue;
      }
      const image = readImageInfo(bytes);
      if (!image || image.width * image.height > MAX_IMAGE_PIXELS) {
        notify(t('pages.errors.invalidImage', { name: file.name }));
        continue;
      }
      sources.push({ name: file.name, kind: image.kind, bytes, password: null, pageCount: 1, image });
    }
    return sources;
  } finally {
    for (const file of files) void api.closeFile(file.fileId);
  }
}

// Dateien über den Dialog wählen und einlesen. null = nichts gewählt oder abgebrochen.
export async function pickSources(kind: 'pdf' | 'images' | 'pdf-or-images'): Promise<SourceFile[] | null> {
  const picked = await api.pickFiles(kind);
  if (picked.rejected.length > 0) notify(t('pages.errors.rejected', { names: picked.rejected.join(', ') }));
  if (picked.files.length === 0) return null;
  const sources = await busy('pages.busy.reading', () => loadSources(picked.files));
  return sources && sources.length > 0 ? sources : null;
}

export const imageSource = (source: SourceFile): ImageSource => {
  const image = source.image;
  if (!image) throw new Error('kein Bild');
  return { kind: image.kind, data: source.bytes.slice().buffer as ArrayBuffer, width: image.width, height: image.height, rotation: image.rotation };
};

function composePart(source: SourceFile, pages: number[] | null = null): ComposePart {
  return source.kind === 'pdf'
    ? { type: 'pdf', source: { data: source.bytes.slice().buffer as ArrayBuffer, password: source.password, pages } }
    : { type: 'image', image: imageSource(source) };
}

// Seiten, auf die sich ein Befehl bezieht: im Raster die Auswahl, sonst die aktuelle Seite.
export function targetPages(tab: TabState): number[] {
  if (tab.mode === 'organize' && tab.pageSelection.length > 0) return [...tab.pageSelection].sort((a, b) => a - b);
  return [Math.max(0, tab.currentPage - 1)];
}

export function rotatePages(tab: TabState, pages: number[], delta: 90 | 180 | 270): Promise<boolean> {
  return applyPageOperations(tab.id, [{ type: 'rotate', pages, delta }], { selection: pages });
}

export function deletePages(tab: TabState, pages: number[]): Promise<boolean> {
  if (pages.length >= tab.pageCount) {
    notify(t('errors.pages.all-pages'));
    return Promise.resolve(false);
  }
  const first = Math.min(...pages);
  const remaining = tab.pageCount - pages.length;
  return applyPageOperations(tab.id, [{ type: 'delete', pages }], { page: Math.min(first + 1, remaining), selection: [] });
}

// Verschiebt Seiten vor die Seite mit Index `before` (pageCount = ans Ende).
export function movePages(tab: TabState, pages: number[], before: number): Promise<boolean> {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const to = moveTarget(sorted, before);
  // Nichts zu tun, wenn die Seiten schon dort stehen
  if (sorted.every((page, i) => page === to + i)) return Promise.resolve(false);
  const selection = sorted.map((_, i) => to + i);
  return applyPageOperations(tab.id, [{ type: 'move', pages: sorted, to }], { page: to + 1, selection });
}

// Leere Seiten in der Größe der Nachbarseite einfügen
export async function insertBlankPages(tab: TabState, at: number, count: number): Promise<boolean> {
  const pdf = getRuntime(tab.id)?.pdf;
  if (!pdf) return false;
  const reference = await pdf.getPage(Math.min(Math.max(at, 1), tab.pageCount));
  const [x1 = 0, y1 = 0, x2 = 595.28, y2 = 841.89] = reference.view;
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  const selection = Array.from({ length: count }, (_, i) => at + i);
  return applyPageOperations(tab.id, [{ type: 'insertBlank', at, width, height, count }], { page: at + 1, selection });
}

// Fügt Quelldateien (PDFs und Bilder, in dieser Reihenfolge) vor dem Seitenindex `at` ein.
export function insertSources(tab: TabState, sources: SourceFile[], at: number): Promise<boolean> {
  const operations: PageOperation[] = [];
  let position = at;
  let images: SourceFile[] = [];
  const flushImages = () => {
    if (images.length === 0) return;
    operations.push({ type: 'insertImages', at: position, images: images.map(imageSource) });
    position += images.length;
    images = [];
  };
  for (const source of sources) {
    if (source.kind !== 'pdf') {
      images.push(source);
      continue;
    }
    flushImages();
    operations.push({
      type: 'insertPdf',
      at: position,
      source: { data: source.bytes.slice().buffer as ArrayBuffer, password: source.password, pages: null },
    });
    position += source.pageCount;
  }
  flushImages();
  const selection = Array.from({ length: position - at }, (_, i) => at + i);
  return applyPageOperations(tab.id, operations, { page: at + 1, selection });
}

// Ersetzt die Seiten targets (0-basiert) der Reihe nach durch die Seiten sourcePages der Quelle (gleich viele).
// Von hinten: jede neue Seite kommt hinter ihre alte, dann wird die alte gelöscht (Nummern davor bleiben gleich).
export function replacePages(tab: TabState, targets: number[], source: SourceFile, sourcePages: number[]): Promise<boolean> {
  const operations: PageOperation[] = [];
  for (let k = targets.length - 1; k >= 0; k--) {
    const target = targets[k] as number;
    operations.push(
      { type: 'insertPdf', at: target + 1, source: { data: source.bytes.slice().buffer as ArrayBuffer, password: source.password, pages: [sourcePages[k] as number] } },
      { type: 'delete', pages: [target] },
    );
  }
  return applyPageOperations(tab.id, operations, { page: (targets[0] ?? 0) + 1, selection: targets });
}

export function cropPages(tab: TabState, pages: number[], margins: Margins): Promise<boolean> {
  return applyPageOperations(tab.id, [{ type: 'crop', pages, margins }], { page: (pages[0] ?? 0) + 1, selection: pages });
}

// Aktueller Stand des Dokuments als Bytes, inklusive ungespeicherter Kommentare.
export async function currentBytes(tab: TabState): Promise<{ bytes: Uint8Array; password: string | null }> {
  commitPendingEdits();
  const runtime = getRuntime(tab.id);
  if (!runtime?.pdf) throw new Error('kein Dokument');
  const annotations = tabAnnotations(tab.id);
  const changes = annotations ? computeChanges(annotations.items, annotations.originals) : null;
  const data = await runtime.pdf.getData();
  const forms = await currentFormChanges(tab.id);
  const bytes =
    (changes && hasChanges(changes)) || forms.length > 0
      ? await processDocument(data, runtime.password, { changes: changes ?? undefined, formValues: forms })
      : data;
  return { bytes, password: runtime.password };
}

export function reportSaveNew(result: SaveNewResult): boolean {
  if (result.ok) {
    if (result.open) void handleOpenResult(result.open);
    return true;
  }
  if (result.error !== 'cancelled') notify(t(`pages.errors.save.${result.error}`), result.detail);
  return false;
}

function reportFolder(result: SaveToFolderResult): boolean {
  if (result.ok) {
    useUi.getState().confirm(t('pages.savedToFolder', { count: result.names.length, folder: result.folder }));
    return true;
  }
  if (result.error !== 'cancelled') notify(t(`pages.errors.save.${result.error}`), result.detail);
  return false;
}

export interface ExtractOptions {
  separate: boolean;
  deleteAfter: boolean;
}

// Seiten als neues Dokument (oder je Seite eine Datei) speichern, auf Wunsch danach löschen.
export async function extractPages(tab: TabState, pages: number[], options: ExtractOptions): Promise<boolean> {
  try {
    const saved = await busy('pages.busy.extracting', async () => {
      const { bytes, password } = await currentBytes(tab);
      const part = (list: number[]): ComposePart => ({
        type: 'pdf',
        source: { data: bytes.slice().buffer as ArrayBuffer, password, pages: list },
      });
      const base = baseName(tab.name);
      if (!options.separate) {
        const output = await composeDocument([part(pages)]);
        const name = t('pages.names.extract', { name: base, pages: formatPageRanges(pages) });
        return reportSaveNew(await api.saveNewFile(output, name, tab.fileId, true));
      }
      const files = [];
      for (const page of pages) {
        files.push({ name: t('pages.names.page', { name: base, page: page + 1 }), bytes: await composeDocument([part([page])]) });
      }
      return reportFolder(await api.saveFilesToFolder(files, tab.fileId));
    });
    if (saved && options.deleteAfter) {
      const current = useDocuments.getState().tabs.find((t) => t.id === tab.id);
      if (current) await deletePages(current, pages);
    }
    return saved;
  } catch (error) {
    failure(error);
    return false;
  }
}

// Teilt das Dokument in mehrere Dateien (eine je Stück) und speichert sie in einen Ordner.
export async function splitDocument(tab: TabState, chunks: number[][]): Promise<boolean> {
  try {
    return await busy('pages.busy.splitting', async () => {
      const { bytes, password } = await currentBytes(tab);
      const base = baseName(tab.name);
      const digits = String(chunks.length).length;
      const files = [];
      for (const [i, chunk] of chunks.entries()) {
        const output = await composeDocument([
          { type: 'pdf', source: { data: bytes.slice().buffer as ArrayBuffer, password, pages: chunk } },
        ]);
        files.push({ name: t('pages.names.part', { name: base, part: String(i + 1).padStart(digits, '0') }), bytes: output });
      }
      return reportFolder(await api.saveFilesToFolder(files, tab.fileId));
    });
  } catch (error) {
    failure(error);
    return false;
  }
}

// Mehrere PDFs und Bilder zu einem neuen Dokument zusammenführen, speichern und öffnen.
export async function combineSources(sources: SourceFile[], name: string): Promise<boolean> {
  try {
    return await busy('pages.busy.combining', async () => {
      const output = await composeDocument(sources.map((source) => composePart(source, pageSelection(source.selection ?? '', source.pageCount) || null)));
      return reportSaveNew(await api.saveNewFile(output, name, null, true));
    });
  } catch (error) {
    failure(error);
    return false;
  }
}

// Bilder wählen und daraus ein PDF machen (eine Seite je Bild).
export async function createPdfFromImages(): Promise<boolean> {
  const sources = await pickSources('images');
  if (!sources) return false;
  const first = sources[0]?.name.replace(/\.(jpe?g|png)$/i, '') ?? t('pages.names.images');
  return combineSources(sources, sources.length === 1 ? first : t('pages.names.images'));
}
