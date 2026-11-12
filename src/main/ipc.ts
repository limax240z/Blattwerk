import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  IPC,
  type AppInfo,
  type AppSettings,
  type ConvertResult,
  type ExportFolderResult,
  type ExportTextResult,
  type ExportWriteResult,
  type IdFileResult,
  type SaveIdResult,
  type MenuState,
  type OpenResult,
  type PickKind,
  type PickResult,
  type PrintRequest,
  type RecentFile,
  type SaveNewResult,
  type RenameResult,
  type SaveResult,
  type SaveToFolderResult,
  type TabDestination,
  type ThumbnailResult,
  type TabDragHoverState,
  type TabDragMessage,
  type TabTransfer,
  type TabTransferResult,
  PAGE_DRAG_TOKEN,
} from '../shared/ipc';
import { PRODUCT_NAME } from '../shared/product';
import {
  isExportText,
  isFileId,
  isImageBytes,
  isP12Bytes,
  MAX_ID_BYTES,
  isPdfBytes,
  isPickKind,
  isSignatureInput,
  isSafeLocalPath,
  renameTarget,
  sanitizeFileName,
  validateAuthorName,
  validateGlassRegions,
  validateMenuState,
  validateNamedPdfs,
  validateTabDestination,
  validateTabDragHoverState,
  validateTabDragMessage,
  validateTabTransfer,
} from '../shared/validate';
import { atomicWrite } from './files/atomic-write';
import { createBlankDocument, createUntitledDocument, isBlankDocumentPath } from './files/blank-document';
import type { ThumbnailStore } from './files/thumbnails';
import type { TemplateService } from './templates';
import { parseTemplateId, type SaveTemplateResult, type TemplateInfo } from '../shared/templates';
import { listSystemFonts, readSystemFont } from './files/system-fonts';
import { checkForUpdate, scheduleInstall } from './update/updater';
import type { OnlineCheck, UpdateStatus } from '../shared/update';
import { parseSystemFontKey, type SystemFont } from '../shared/fonts';
import { DOCUMENT_EXTENSIONS } from '../shared/convert';
import { ConvertError, MAX_DOCUMENT_BYTES, detectAndConvert } from './convert';
import { htmlToPdf } from './convert/pdf';
import { nativeGlassAvailable, setNativeGlassRegions } from './native-glass';
import type { FileRegistry } from './files/file-registry';
import type { RecentFiles } from './files/recent-files';
import type { SignatureStore } from './files/signatures';
import { t } from './i18n';
import { printWindow } from './print';
import { confirmAndOpenExternal } from './security';

export interface IpcContext {
  files: FileRegistry;
  recent: RecentFiles;
  appVersion: string;
  isTrustedSender: (event: IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean;
  onMenuState: (win: BrowserWindow, state: MenuState) => void;
  onRendererReady: (win: BrowserWindow) => void;
  onRecentChanged: () => void;
  clearRecent: () => Promise<RecentFile[]>;
  // Dokument öffnen: im anfragenden Fenster, wenn es leer ist, sonst in einem eigenen Fenster (ADR 0026)
  openDocument: (win: BrowserWindow, filePath: string, options?: { recent?: boolean }) => Promise<OpenResult>;
  // Nach erfolgreichem Speichern unter neuem Namen (Zuletzt-Liste, Menü)
  onSavedAs: (filePath: string) => Promise<void>;
  getSettings: () => AppSettings;
  setAuthorName: (name: string) => Promise<AppSettings>;
  setReadModeFullscreen: (on: boolean) => AppSettings;
  setCloseGaps: (on: boolean) => AppSettings;
  onCloseConfirmed: (win: BrowserWindow) => void;
  onCloseCancelled: (win: BrowserWindow) => void;
  // Fenster ohne Tabs schließen (sein letzter Tab ist in ein anderes Fenster gewandert)
  onCloseWindow: (win: BrowserWindow) => void;
  transferTab: (win: BrowserWindow, fileId: string, transfer: TabTransfer, destination: TabDestination) => Promise<TabTransferResult>;
  // Tab über die Fenstergrenze ziehen (Vorschau am Zeiger) und Antwort des Fensters darunter
  onTabDrag: (win: BrowserWindow, message: TabDragMessage) => void;
  onTabDragHoverState: (win: BrowserWindow, state: TabDragHoverState) => void;
  // Startseite (ADR 0028): Vorlagen und Vorschaubilder
  templates: TemplateService;
  thumbnails: ThumbnailStore;
  onTemplatesChanged: () => void;
  // Neue Version im Netz suchen und laden; Fortschritt und Ergebnis gehen an alle Fenster
  checkUpdatesOnline: () => Promise<OnlineCheck>;
  // App beenden (alle Fenster fragen bei ungespeicherten Änderungen nach)
  quit: () => void;
  signatures: SignatureStore;
  getLastIdPath: () => string | null;
  setLastIdPath: (filePath: string | null) => void;
}

export async function showOpenDialog(win: BrowserWindow | null): Promise<string[]> {
  const options: Electron.OpenDialogOptions = {
    title: t('dialog.openTitle'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('dialog.filterPdf'), extensions: ['pdf'] }],
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

function pickFilters(kind: PickKind): Electron.FileFilter[] {
  const pdf = { name: t('dialog.filterPdf'), extensions: ['pdf'] };
  const images = { name: t('dialog.filterImages'), extensions: ['jpg', 'jpeg', 'png'] };
  if (kind === 'pdf') return [pdf];
  if (kind === 'images') return [images];
  return [{ name: t('dialog.filterPdfImages'), extensions: ['pdf', 'jpg', 'jpeg', 'png'] }, pdf, images];
}

const withPdfExtension = (filePath: string) => (path.extname(filePath).toLowerCase() === '.pdf' ? filePath : `${filePath}.pdf`);

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Freier Dateiname im Ordner: „Name.pdf“, sonst „Name (2).pdf“, „Name (3).pdf“ …
async function uniquePath(dir: string, fileName: string): Promise<string> {
  const extension = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - extension.length);
  for (let n = 1; n < 10000; n++) {
    const candidate = path.join(dir, n === 1 ? fileName : `${base} (${n})${extension}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('no-free-name');
}

export function registerIpc(ctx: IpcContext): void {
  const windowOf = (event: IpcMainInvokeEvent | Electron.IpcMainEvent) => BrowserWindow.fromWebContents(event.sender);

  // Jeder Handler prüft zuerst, ob die Nachricht aus unserem eigenen Fenster kommt.
  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: A) => Promise<R> | R,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!ctx.isTrustedSender(event)) throw new Error('untrusted-sender');
      return fn(event, ...(args as A));
    });
  };

  handle(IPC.openDialog, async (event): Promise<OpenResult[]> => {
    const win = windowOf(event);
    if (!win) return [];
    const paths = await showOpenDialog(win);
    const results: OpenResult[] = [];
    for (const p of paths) results.push(await ctx.openDocument(win, p));
    return results;
  });

  handle(IPC.openDropped, async (event, filePath: unknown): Promise<OpenResult> => {
    const win = windowOf(event);
    if (!win || !isSafeLocalPath(filePath, process.platform)) {
      return { ok: false, error: 'unreadable' };
    }
    return ctx.openDocument(win, filePath);
  });

  handle(IPC.readRange, (event, fileId: unknown, begin: unknown, end: unknown) => {
    if (!isFileId(fileId)) throw new Error('invalid-file-id');
    return ctx.files.read(fileId, begin, end, event.sender.id);
  });

  handle(IPC.closeFile, async (event, fileId: unknown) => {
    if (isFileId(fileId)) await ctx.files.close(fileId, event.sender.id);
  });

  handle(IPC.recentList, () => ctx.recent.list());

  handle(IPC.recentOpen, async (event, filePath: unknown): Promise<OpenResult> => {
    const win = windowOf(event);
    // Nur Pfade, die wirklich in der Liste stehen, dürfen so geöffnet werden.
    if (!win || typeof filePath !== 'string' || !(await ctx.recent.contains(filePath))) {
      return { ok: false, error: 'not-found' };
    }
    return ctx.openDocument(win, filePath);
  });

  handle(IPC.recentRemove, async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string') return ctx.recent.list();
    const list = await ctx.recent.remove(filePath);
    ctx.onRecentChanged();
    return list;
  });

  handle(IPC.recentClear, () => ctx.clearRecent());

  handle(IPC.recentPin, async (_event, filePath: unknown, pinned: unknown) => {
    if (typeof filePath !== 'string' || typeof pinned !== 'boolean') return ctx.recent.list();
    const list = await ctx.recent.setPinned(filePath, pinned);
    ctx.onRecentChanged();
    return list;
  });

  // Vorlagen (ADR 0028): Liste, öffnen (Kopie als unbenanntes Dokument), PDF für das Vorschaubild, sichern, entfernen
  handle(IPC.templatesList, (): Promise<TemplateInfo[]> => ctx.templates.list());

  handle(IPC.templatesOpen, async (event, id: unknown): Promise<OpenResult> => {
    const win = windowOf(event);
    const template = typeof id === 'string' ? await ctx.templates.document(id).catch(() => null) : null;
    if (!win || !template) return { ok: false, error: 'not-found' };
    return ctx.openDocument(win, await createUntitledDocument(sanitizeFileName(template.name).replace(/\.pdf$/i, ''), template.bytes));
  });

  handle(IPC.templatesPreview, async (_event, id: unknown): Promise<Uint8Array | null> =>
    typeof id === 'string' ? ((await ctx.templates.document(id).catch(() => null))?.bytes ?? null) : null,
  );

  handle(IPC.templatesSave, async (_event, bytes: unknown, name: unknown): Promise<SaveTemplateResult> => {
    if (!isPdfBytes(bytes) || typeof name !== 'string' || name.length > 500) return { ok: false, error: 'invalid-data' };
    const result = await ctx.templates.save(name, bytes);
    if (result.ok) ctx.onTemplatesChanged();
    return result;
  });

  handle(IPC.templatesRemove, async (_event, id: unknown): Promise<TemplateInfo[]> => {
    if (typeof id === 'string' && (await ctx.templates.remove(id))) {
      await ctx.thumbnails.remove(templateThumbnailKey(id, ctx.appVersion));
      ctx.onTemplatesChanged();
    }
    return ctx.templates.list();
  });

  // Vorschaubilder: nur für Dateien der Zuletzt-Liste und für Vorlagen
  handle(IPC.thumbnailsGet, async (_event, request: unknown): Promise<ThumbnailResult> => {
    const result: ThumbnailResult = { recent: {}, templates: {} };
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 200) : []);
    const req = (typeof request === 'object' && request !== null ? request : {}) as { recent?: unknown; templates?: unknown };
    for (const filePath of strings(req.recent)) {
      result.recent[filePath] = (await ctx.recent.contains(filePath)) ? await ctx.thumbnails.get(fileThumbnailKey(filePath)) : null;
    }
    for (const id of strings(req.templates)) {
      result.templates[id] = parseTemplateId(id) ? await ctx.thumbnails.get(templateThumbnailKey(id, ctx.appVersion)) : null;
    }
    return result;
  });

  handle(IPC.thumbnailsSetFile, async (event, fileId: unknown, png: unknown): Promise<boolean> => {
    const filePath = isFileId(fileId) ? ctx.files.pathOf(fileId, event.sender.id) : null;
    if (!filePath || isBlankDocumentPath(filePath) || !(png instanceof Uint8Array)) return false;
    return ctx.thumbnails.set(fileThumbnailKey(filePath), png);
  });

  handle(IPC.thumbnailsSetTemplate, async (_event, id: unknown, png: unknown): Promise<boolean> => {
    if (typeof id !== 'string' || !parseTemplateId(id) || !(png instanceof Uint8Array)) return false;
    return ctx.thumbnails.set(templateThumbnailKey(id, ctx.appVersion), png);
  });

  handle(IPC.appInfo, (): AppInfo => ({
    platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
    version: ctx.appVersion,
    productName: PRODUCT_NAME,
    e2e: !app.isPackaged && Boolean(process.env.BLATTWERK_E2E),
    nativeGlass: nativeGlassAvailable(),
  }));

  handle(IPC.print, async (event, request: unknown) => {
    const win = windowOf(event);
    if (!win) return { ok: false, reason: 'failed' } as const;
    const name =
      typeof request === 'object' && request !== null && typeof (request as PrintRequest).documentName === 'string'
        ? (request as PrintRequest).documentName
        : PRODUCT_NAME;
    return printWindow(win, { documentName: name });
  });

  // Speichern über die vorhandene Datei. Vorher prüfen, ob die Datei inzwischen von außen geändert wurde.
  handle(IPC.saveFile, async (event, fileId: unknown, bytes: unknown, force: unknown): Promise<SaveResult> => {
    if (!isFileId(fileId)) return { ok: false, error: 'unknown-file' };
    if (!isPdfBytes(bytes)) return { ok: false, error: 'invalid-data' };
    const owner = event.sender.id;
    const target = ctx.files.pathOf(fileId, owner);
    if (!target) return { ok: false, error: 'unknown-file' };
    if (force !== true && !(await ctx.files.isUnchangedOnDisk(fileId, owner))) {
      return { ok: false, error: 'changed-externally' };
    }
    try {
      await ctx.files.whileReleased(target, () => atomicWrite(target, bytes));
    } catch (error) {
      return { ok: false, error: 'write-failed', detail: String(error) };
    }
    const reopened = await ctx.files.reopen(fileId, owner);
    return reopened.ok ? { ok: true, file: reopened.file } : { ok: false, error: 'write-failed', detail: reopened.error };
  });

  // Umbenennen im selben Ordner. Ein neues leeres Dokument hat noch keinen festen Ort: erst „Sichern“.
  handle(IPC.renameFile, async (event, fileId: unknown, name: unknown): Promise<RenameResult> => {
    if (!isFileId(fileId)) return { ok: false, error: 'unknown-file' };
    const target = renameTarget(name);
    if (!target) return { ok: false, error: 'invalid-name' };
    const current = ctx.files.pathOf(fileId, event.sender.id);
    if (!current) return { ok: false, error: 'unknown-file' };
    if (isBlankDocumentPath(current)) return { ok: false, error: 'untitled' };
    return ctx.files.rename(fileId, event.sender.id, target);
  });

  handle(IPC.saveFileAs, async (event, fileId: unknown, bytes: unknown): Promise<SaveResult> => {
    const win = windowOf(event);
    if (!win || !isFileId(fileId)) return { ok: false, error: 'unknown-file' };
    if (!isPdfBytes(bytes)) return { ok: false, error: 'invalid-data' };
    const owner = event.sender.id;
    const current = ctx.files.pathOf(fileId, owner);
    if (!current) return { ok: false, error: 'unknown-file' };
    const result = await dialog.showSaveDialog(win, {
      title: t('dialog.saveAsTitle'),
      // Unbenanntes Dokument: im Ordner „Dokumente“ vorschlagen, nicht im temporären Ordner
      defaultPath: isBlankDocumentPath(current) ? path.join(app.getPath('documents'), path.basename(current)) : current,
      filters: [{ name: t('dialog.filterPdf'), extensions: ['pdf'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
    const target = path.extname(result.filePath).toLowerCase() === '.pdf' ? result.filePath : `${result.filePath}.pdf`;
    try {
      // Auch „Sichern unter“ kann eine offene Datei ersetzen (dieselbe oder eine in einem anderen Fenster)
      await ctx.files.whileReleased(target, () => atomicWrite(target, bytes));
    } catch (error) {
      return { ok: false, error: 'write-failed', detail: String(error) };
    }
    const reopened = await ctx.files.reopen(fileId, owner, target);
    if (!reopened.ok) return { ok: false, error: 'write-failed', detail: reopened.error };
    await ctx.onSavedAs(target);
    return { ok: true, file: reopened.file };
  });

  // Quelldateien zum Einfügen oder Zusammenführen wählen (PDFs und/oder JPEG/PNG). Öffnet keinen Tab.
  handle(IPC.pickFiles, async (event, kind: unknown): Promise<PickResult> => {
    const win = windowOf(event);
    if (!win || !isPickKind(kind)) return { files: [], rejected: [] };
    const result = await dialog.showOpenDialog(win, {
      title: t(`dialog.pickTitle.${kind}`),
      properties: ['openFile', 'multiSelections'],
      filters: pickFilters(kind),
    });
    const picked: PickResult = { files: [], rejected: [] };
    if (result.canceled) return picked;
    for (const filePath of result.filePaths) {
      const opened = await ctx.files.open(filePath, event.sender.id, kind);
      if (opened.ok) picked.files.push(opened.file);
      else picked.rejected.push(path.basename(filePath));
    }
    return picked;
  });

  // Per Drag & Drop abgelegte Quelldatei anmelden (Pfad kommt aus dem Preload, nur absolut und lokal)
  handle(IPC.registerDropped, async (event, filePath: unknown): Promise<OpenResult> => {
    if (!isSafeLocalPath(filePath, process.platform)) return { ok: false, error: 'unreadable' };
    return ctx.files.open(filePath, event.sender.id, 'pdf-or-images');
  });

  // Neues Dokument speichern (Zusammenführen, Extrahieren, Bilder → PDF). Den Ort wählt der Nutzer im Dialog.
  handle(
    IPC.saveNewFile,
    async (event, bytes: unknown, suggestedName: unknown, referenceFileId: unknown, openAfter: unknown): Promise<SaveNewResult> => {
      const win = windowOf(event);
      if (!win) return { ok: false, error: 'cancelled' };
      if (!isPdfBytes(bytes)) return { ok: false, error: 'invalid-data' };
      const reference = isFileId(referenceFileId) ? ctx.files.pathOf(referenceFileId, event.sender.id) : null;
      const dir = reference ? path.dirname(reference) : app.getPath('documents');
      const result = await dialog.showSaveDialog(win, {
        title: t('dialog.saveNewTitle'),
        defaultPath: path.join(dir, sanitizeFileName(suggestedName)),
        filters: [{ name: t('dialog.filterPdf'), extensions: ['pdf'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
      const target = withPdfExtension(result.filePath);
      if (ctx.files.isOpenPath(target)) return { ok: false, error: 'target-open' };
      try {
        await atomicWrite(target, bytes);
      } catch (error) {
        return { ok: false, error: 'write-failed', detail: String(error) };
      }
      const open = openAfter === true ? await ctx.openDocument(win, target) : null;
      return { ok: true, name: path.basename(target), open };
    },
  );

  // Mehrere neue Dokumente in einen gewählten Ordner (Teilen, Extrahieren als einzelne Dateien).
  // Vorhandene Dateien werden nie überschrieben; bei gleichem Namen kommt eine Nummer dazu.
  handle(IPC.updateStatus, (): UpdateStatus => checkForUpdate());

  handle(IPC.updateCheckOnline, (): Promise<OnlineCheck> => ctx.checkUpdatesOnline());

  // Update vormerken und die App über den normalen Weg beenden (jedes Fenster fragt bei ungespeicherten Änderungen
  // nach); beim Beenden tauscht ein Hilfsskript die App aus und öffnet sie neu
  handle(IPC.updateInstall, (): boolean => {
    if (!scheduleInstall()) return false;
    ctx.quit();
    return true;
  });

  handle(IPC.fontsList, (): SystemFont[] => listSystemFonts());

  handle(IPC.fontsRead, (_event, key: unknown): Uint8Array | null => {
    const parsed = typeof key === 'string' ? parseSystemFontKey(key) : null;
    return parsed ? readSystemFont(parsed.id, parsed.style) : null;
  });

  handle(IPC.newBlank, async (event): Promise<OpenResult> => {
    const win = windowOf(event);
    if (!win) return { ok: false, error: 'unreadable' };
    // Unbenannte Dokumente erkennt das Öffnen am Ordner (nicht in „Zuletzt geöffnet“, Kennzeichnung untitled)
    return ctx.openDocument(win, await createBlankDocument(t('files.untitled')));
  });

  handle(IPC.saveToFolder, async (event, files: unknown, referenceFileId: unknown): Promise<SaveToFolderResult> => {
    const win = windowOf(event);
    const valid = validateNamedPdfs(files);
    if (!win) return { ok: false, error: 'cancelled' };
    if (!valid) return { ok: false, error: 'invalid-data' };
    const reference = isFileId(referenceFileId) ? ctx.files.pathOf(referenceFileId, event.sender.id) : null;
    const result = await dialog.showOpenDialog(win, {
      title: t('dialog.chooseFolderTitle'),
      buttonLabel: t('dialog.chooseFolderButton'),
      defaultPath: reference ? path.dirname(reference) : app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return { ok: false, error: 'cancelled' };
    const names: string[] = [];
    try {
      for (const file of valid) {
        const target = await uniquePath(folder, sanitizeFileName(file.name));
        await atomicWrite(target, file.bytes);
        names.push(path.basename(target));
      }
    } catch (error) {
      return { ok: false, error: 'write-failed', detail: `${names.length}/${valid.length}: ${String(error)}` };
    }
    return { ok: true, folder: path.basename(folder), names };
  });

  // Export als Bilder (Phase 6): Ordner einmal wählen, dann Seite für Seite schreiben. Der Renderer kennt nur ein
  // Kennzeichen für den Ordner; geschrieben wird nur dorthin, mit sicherem Namen, nie über vorhandene Dateien.
  const exportFolders = new Map<string, { dir: string; senderId: number }>();

  handle(IPC.exportChooseFolder, async (event, referenceFileId: unknown): Promise<ExportFolderResult> => {
    const win = windowOf(event);
    if (!win) return { ok: false, error: 'cancelled' };
    const reference = isFileId(referenceFileId) ? ctx.files.pathOf(referenceFileId, event.sender.id) : null;
    const result = await dialog.showOpenDialog(win, {
      title: t('dialog.exportFolderTitle'),
      buttonLabel: t('dialog.chooseFolderButton'),
      defaultPath: reference ? path.dirname(reference) : app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return { ok: false, error: 'cancelled' };
    const token = randomUUID();
    exportFolders.set(token, { dir: folder, senderId: event.sender.id });
    return { ok: true, token, folder: path.basename(folder) };
  });

  handle(IPC.exportWriteImage, async (event, token: unknown, name: unknown, kind: unknown, bytes: unknown): Promise<ExportWriteResult> => {
    const folder = typeof token === 'string' ? exportFolders.get(token) : undefined;
    if (!folder || folder.senderId !== event.sender.id) return { ok: false, error: 'unknown-folder' };
    if (!isImageBytes(bytes, kind) || typeof name !== 'string' || name.length > 1000) return { ok: false, error: 'invalid-data' };
    try {
      const target = await uniquePath(folder.dir, sanitizeFileName(name, 'Seite', kind === 'png' ? '.png' : '.jpg'));
      await atomicWrite(target, bytes);
      return { ok: true, name: path.basename(target) };
    } catch (error) {
      return { ok: false, error: 'write-failed', detail: String(error) };
    }
  });

  handle(IPC.exportEnd, (_event, token: unknown) => {
    if (typeof token === 'string') exportFolders.delete(token);
  });

  // Export als Text: Sichern-Dialog, UTF-8
  handle(IPC.exportSaveText, async (event, text: unknown, suggestedName: unknown, referenceFileId: unknown): Promise<ExportTextResult> => {
    const win = windowOf(event);
    if (!win) return { ok: false, error: 'cancelled' };
    if (!isExportText(text)) return { ok: false, error: 'invalid-data' };
    const reference = isFileId(referenceFileId) ? ctx.files.pathOf(referenceFileId, event.sender.id) : null;
    const dir = reference ? path.dirname(reference) : app.getPath('documents');
    const result = await dialog.showSaveDialog(win, {
      title: t('dialog.exportTextTitle'),
      defaultPath: path.join(dir, sanitizeFileName(suggestedName, 'Dokument', '.txt')),
      filters: [{ name: t('dialog.filterText'), extensions: ['txt'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
    const target = path.extname(result.filePath).toLowerCase() === '.txt' ? result.filePath : `${result.filePath}.txt`;
    if (ctx.files.isOpenPath(target)) return { ok: false, error: 'target-open' };
    try {
      await atomicWrite(target, new TextEncoder().encode(text));
    } catch (error) {
      return { ok: false, error: 'write-failed', detail: String(error) };
    }
    return { ok: true, name: path.basename(target) };
  });

  // Digitale ID (Phase 7): Datei lesen (höchstens 1 MB, DER), Pfad für das nächste Mal merken
  const readId = async (filePath: string): Promise<IdFileResult> => {
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_ID_BYTES) return { ok: false, error: 'invalid' };
      const bytes = new Uint8Array(await fsp.readFile(filePath));
      return isP12Bytes(bytes) ? { ok: true, name: path.basename(filePath), bytes } : { ok: false, error: 'invalid' };
    } catch {
      return { ok: false, error: 'unreadable' };
    }
  };

  handle(IPC.signingPickId, async (event): Promise<IdFileResult> => {
    const win = windowOf(event);
    if (!win) return { ok: false, error: 'cancelled' };
    const result = await dialog.showOpenDialog(win, {
      title: t('dialog.pickIdTitle'),
      properties: ['openFile'],
      filters: [{ name: t('dialog.filterId'), extensions: ['p12', 'pfx'] }],
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return { ok: false, error: 'cancelled' };
    const read = await readId(filePath);
    if (read.ok) ctx.setLastIdPath(filePath);
    return read;
  });

  // Textdokument → PDF: lesen, umwandeln, Sichern-Dialog im Ordner der Quelle, danach öffnen
  const convertAndSave = async (win: BrowserWindow, source: string): Promise<ConvertResult> => {
    let bytes: Uint8Array;
    try {
      const stat = await fsp.stat(source);
      if (!stat.isFile()) return { ok: false, error: 'unreadable' };
      if (stat.size > MAX_DOCUMENT_BYTES) return { ok: false, error: 'too-large' };
      bytes = new Uint8Array(await fsp.readFile(source));
    } catch (error) {
      return { ok: false, error: 'unreadable', detail: String(error) };
    }
    let pdf: Uint8Array;
    try {
      const converted = detectAndConvert(bytes, path.basename(source));
      pdf = converted.kind === 'pdf' ? converted.bytes : await htmlToPdf(converted.html);
    } catch (error) {
      if (error instanceof ConvertError) return { ok: false, error: error.code, detail: error.message };
      return { ok: false, error: 'failed', detail: String(error) };
    }
    if (!isPdfBytes(pdf)) return { ok: false, error: 'failed' };
    const result = await dialog.showSaveDialog(win, {
      title: t('dialog.saveNewTitle'),
      defaultPath: path.join(path.dirname(source), sanitizeFileName(`${path.basename(source).replace(/\.[^.]+$/, '')}.pdf`)),
      filters: [{ name: t('dialog.filterPdf'), extensions: ['pdf'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
    const target = withPdfExtension(result.filePath);
    if (ctx.files.isOpenPath(target)) return { ok: false, error: 'target-open' };
    try {
      await atomicWrite(target, pdf);
    } catch (error) {
      return { ok: false, error: 'write-failed', detail: String(error) };
    }
    return { ok: true, name: path.basename(target), open: await ctx.openDocument(win, target) };
  };

  handle(IPC.convertPick, async (event): Promise<ConvertResult> => {
    const win = windowOf(event);
    if (!win) return { ok: false, error: 'cancelled' };
    const result = await dialog.showOpenDialog(win, {
      title: t('dialog.convertTitle'),
      properties: ['openFile'],
      filters: [{ name: t('dialog.filterDocuments'), extensions: DOCUMENT_EXTENSIONS }],
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return { ok: false, error: 'cancelled' };
    return convertAndSave(win, filePath);
  });

  handle(IPC.convertDropped, async (event, filePath: unknown): Promise<ConvertResult> => {
    const win = windowOf(event);
    if (!win) return { ok: false, error: 'cancelled' };
    if (!isSafeLocalPath(filePath, process.platform)) return { ok: false, error: 'unreadable' };
    return convertAndSave(win, filePath);
  });

  handle(IPC.signingLastId, async (): Promise<IdFileResult> => {
    const filePath = ctx.getLastIdPath();
    return filePath ? readId(filePath) : { ok: false, error: 'cancelled' };
  });

  handle(IPC.signingSaveId, async (event, bytes: unknown, suggestedName: unknown): Promise<SaveIdResult> => {
    const win = windowOf(event);
    if (!win) return { ok: false, error: 'cancelled' };
    if (!isP12Bytes(bytes)) return { ok: false, error: 'invalid-data' };
    const result = await dialog.showSaveDialog(win, {
      title: t('dialog.saveIdTitle'),
      defaultPath: path.join(app.getPath('documents'), sanitizeFileName(suggestedName, 'Digitale ID', '.p12')),
      filters: [{ name: t('dialog.filterId'), extensions: ['p12'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };
    const target = /\.(p12|pfx)$/i.test(result.filePath) ? result.filePath : `${result.filePath}.p12`;
    try {
      await atomicWrite(target, bytes);
    } catch (error) {
      return { ok: false, error: 'write-failed', detail: String(error) };
    }
    ctx.setLastIdPath(target);
    return { ok: true, name: path.basename(target) };
  });

  handle(IPC.signaturesList, () => ctx.signatures.list());
  handle(IPC.signaturesAdd, async (_event, input: unknown) => {
    if (!isSignatureInput(input)) throw new Error('invalid-signature');
    return ctx.signatures.add(input);
  });
  handle(IPC.signaturesRemove, async (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length > 64) return ctx.signatures.list();
    return ctx.signatures.remove(id);
  });

  handle(IPC.settingsGet, () => ctx.getSettings());

  handle(IPC.settingsSetAuthor, async (_event, name: unknown) => {
    const valid = validateAuthorName(name);
    return valid ? ctx.setAuthorName(valid) : ctx.getSettings();
  });

  handle(IPC.settingsSetReadModeFullscreen, (_event, on: unknown) => (typeof on === 'boolean' ? ctx.setReadModeFullscreen(on) : ctx.getSettings()));
  handle(IPC.settingsSetCloseGaps, (_event, on: unknown) => (typeof on === 'boolean' ? ctx.setCloseGaps(on) : ctx.getSettings()));

  handle(IPC.openExternal, (event, url: unknown) => {
    if (typeof url !== 'string') return false;
    return confirmAndOpenExternal(url, windowOf(event));
  });

  ipcMain.on(IPC.glassRegions, (event, regions: unknown) => {
    if (!ctx.isTrustedSender(event)) return;
    const win = windowOf(event);
    const valid = validateGlassRegions(regions);
    if (win && valid) setNativeGlassRegions(win, valid);
  });

  ipcMain.on(IPC.menuState, (event, state: unknown) => {
    if (!ctx.isTrustedSender(event)) return;
    const win = windowOf(event);
    const valid = validateMenuState(state);
    if (win && valid) ctx.onMenuState(win, valid);
  });

  ipcMain.on(IPC.closeConfirmed, (event) => {
    if (!ctx.isTrustedSender(event)) return;
    const win = windowOf(event);
    if (win) ctx.onCloseConfirmed(win);
  });

  ipcMain.on(IPC.closeCancelled, (event) => {
    if (!ctx.isTrustedSender(event)) return;
    const win = windowOf(event);
    if (win) ctx.onCloseCancelled(win);
  });

  // Tab in ein anderes Fenster geben (herausgezogen oder zusammengeführt)
  handle(IPC.tabTransfer, async (event, fileId: unknown, transfer: unknown, destination: unknown): Promise<TabTransferResult> => {
    const win = windowOf(event);
    const validTransfer = validateTabTransfer(transfer);
    const validDestination = validateTabDestination(destination);
    if (!win || !isFileId(fileId) || !validTransfer || !validDestination) return { ok: false, error: 'invalid-data' };
    return ctx.transferTab(win, fileId, validTransfer, validDestination);
  });

  ipcMain.on(IPC.tabDrag, (event, message: unknown) => {
    if (!ctx.isTrustedSender(event)) return;
    const win = windowOf(event);
    const valid = validateTabDragMessage(message);
    if (win && valid) ctx.onTabDrag(win, valid);
  });

  ipcMain.on(IPC.tabDragHoverState, (event, state: unknown) => {
    if (!ctx.isTrustedSender(event)) return;
    const win = windowOf(event);
    const valid = validateTabDragHoverState(state);
    if (win && valid) ctx.onTabDragHoverState(win, valid);
  });

  // Seiten aus einem anderen Fenster: alle Fenster fragen, der Besitzer der Kennung antwortet (sonst nach 30 s nichts)
  const pageRequests = new Map<number, (bytes: Uint8Array | null) => void>();
  let nextPageRequest = 1;
  handle(IPC.pagesFetch, (event, token: unknown): Promise<Uint8Array | null> => {
    if (typeof token !== 'string' || !PAGE_DRAG_TOKEN.test(token)) return Promise.resolve(null);
    const requestId = nextPageRequest++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pageRequests.delete(requestId);
        resolve(null);
      }, 30_000);
      pageRequests.set(requestId, (bytes) => {
        clearTimeout(timer);
        pageRequests.delete(requestId);
        resolve(bytes);
      });
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.webContents !== event.sender) win.webContents.send(IPC.pagesProvideRequest, { requestId, token });
      }
    });
  });

  ipcMain.on(IPC.pagesProvided, (event, requestId: unknown, bytes: unknown) => {
    if (!ctx.isTrustedSender(event) || typeof requestId !== 'number') return;
    const done = pageRequests.get(requestId);
    if (!done) return;
    // Nur ein PDF bis 1 GB; sonst gilt die Quelle als nicht verfügbar
    const valid = bytes instanceof Uint8Array && bytes.length <= 1024 * 1024 * 1024 && isPdfBytes(bytes) ? bytes : null;
    done(valid);
  });

  // Lesemodus: liefert, ob das Fenster schon im Vollbild war. Verborgene Fenster (Tests) bleiben, wie sie sind.
  handle(IPC.windowFullscreen, (event, on: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof on !== 'boolean') return false;
    const before = win.isFullScreen();
    if (win.isVisible()) win.setFullScreen(on);
    return before;
  });

  ipcMain.on(IPC.closeWindow, (event) => {
    if (!ctx.isTrustedSender(event)) return;
    const win = windowOf(event);
    if (win) ctx.onCloseWindow(win);
  });

  ipcMain.on(IPC.rendererReady, (event) => {
    if (!ctx.isTrustedSender(event)) return;
    const win = windowOf(event);
    if (win) ctx.onRendererReady(win);
  });
}

// Schlüssel der Vorschaubilder: Dateien nach Pfad, mitgelieferte Vorlagen je App-Version (sie können sich ändern)
const fileThumbnailKey = (filePath: string): string => `file:${filePath}`;
const templateThumbnailKey = (id: string, appVersion: string): string => (id.startsWith('builtin:') ? `template:${id}@${appVersion}` : `template:${id}`);
