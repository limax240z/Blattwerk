// window.blattwerk auf dem iPad (ADR 0029). Dieselbe Schnittstelle wie der Preload der Mac-App, umgesetzt auf die
// Bausteine der iPad-Hülle (native.ts). Was auf dem Mac der Hauptprozess an Logik hat (Vorlagen, Umwandeln,
// Zuletzt-Liste, Prüfungen), läuft hier in der WebView; nur Dateien, Drucken und Menü macht die Hülle.
import type { BlattwerkApi } from '../preload/api-types';
import { blankPdf } from '../shared/blank-pdf';
import { DOCUMENT_EXTENSIONS } from '../shared/convert';
import { embeddingAllowed, parseSystemFontKey, type SystemFont } from '../shared/fonts';
import {
  MAX_SIGNATURES,
  type AppSettings,
  type ConvertResult,
  type FileInfo,
  type FileKind,
  type MenuState,
  type OpenResult,
  type PickKind,
  type PickResult,
  type RecentFile,
  type SavedSignature,
  type SaveNewResult,
  type SaveResult,
  type ThumbnailResult,
} from '../shared/ipc';
import { PRODUCT_NAME } from '../shared/product';
import { BUILTIN_TEMPLATES, parseTemplateId, type SaveTemplateResult, type TemplateInfo } from '../shared/templates';
import type { OnlineCheck, UpdateStatus } from '../shared/update';
import {
  isExportText,
  isAllowedExternalUrl,
  isImageBytes,
  isP12Bytes,
  isPdfBytes,
  isSignatureInput,
  looksLikePdf,
  MAX_ID_BYTES,
  sanitizeFileName,
  validateAuthorName,
  validateNamedPdfs,
} from '../shared/validate';
import { ConvertError, detectAndConvert, MAX_DOCUMENT_BYTES } from '../main/convert';
import type { PageSetup } from '../main/convert/model';
import { templateHtml } from '../main/templates/builtin';
import { t } from '../renderer/i18n';
import { IpadMenu } from './menu';
import { base64ToBytes, bytesToBase64, call, fetchBytes, on, sendBytes } from './native';
import { IPAD_FONTS } from './fonts';

// Datei, wie die Hülle sie meldet. bookmark: dauerhafter Zugriff (Lesezeichen mit Sicherheitsbereich, Base64)
interface NativeFile {
  fileId: string;
  name: string;
  dir: string;
  size: number;
  bookmark?: string;
  untitled?: boolean;
}

type NativeSave = { ok: true; file: NativeFile } | { ok: false; error: string; detail?: string };
type NativeExport = { ok: true; files: NativeFile[] } | { ok: false; error: string; detail?: string };

// Dateiarten für die Auswahl in der Dateien-App (Uniform Type Identifiers)
const UTI = {
  pdf: 'com.adobe.pdf',
  jpeg: 'public.jpeg',
  png: 'public.png',
  p12: 'com.rsa.pkcs-12',
} as const;

const DOCUMENT_UTIS = [
  'org.openxmlformats.wordprocessingml.document',
  'org.oasis-open.opendocument.text',
  'public.rtf',
  'public.plain-text',
  'net.daringfireball.markdown',
  'com.apple.iwork.pages.sffpages',
  'com.apple.iwork.pages.pages',
];

const pickTypes = (kind: PickKind): string[] =>
  kind === 'pdf' ? [UTI.pdf] : kind === 'images' ? [UTI.jpeg, UTI.png] : [UTI.pdf, UTI.jpeg, UTI.png];

function detectKind(head: Uint8Array): FileKind | null {
  if (looksLikePdf(head)) return 'pdf';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  return null;
}

const accepts = (accept: PickKind | 'pdf-only', kind: FileKind): boolean =>
  accept === 'pdf-only' || accept === 'pdf' ? kind === 'pdf' : accept === 'images' ? kind !== 'pdf' : true;

const readRange = (fileId: string, begin: number, end: number): Promise<Uint8Array> =>
  fetchBytes(`file/${encodeURIComponent(fileId)}?begin=${begin}&end=${end}`).then((bytes) => bytes ?? new Uint8Array());

const readAll = async (file: NativeFile): Promise<Uint8Array> => readRange(file.fileId, 0, file.size);

const toInfo = (file: NativeFile, kind?: FileKind): FileInfo => ({
  fileId: file.fileId,
  name: file.name,
  dir: file.dir,
  size: file.size,
  ...(kind && kind !== 'pdf' ? { kind } : {}),
  ...(file.untitled ? { untitled: true } : {}),
});

// Ablage im App-Ordner (Application Support der App)
const store = {
  async json<T>(name: string, fallback: T): Promise<T> {
    try {
      const bytes = await fetchBytes(`store/${name}`);
      return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  writeJson: (name: string, value: unknown) => sendBytes(`store/${name}`, new TextEncoder().encode(JSON.stringify(value))),
  read: (name: string) => fetchBytes(`store/${encodePath(name)}`).catch(() => null),
  write: (name: string, bytes: Uint8Array) => sendBytes(`store/${encodePath(name)}`, bytes),
  remove: (name: string) => call('store.remove', { path: name }),
  list: (dir: string) => call<{ name: string; modified: number }[]>('store.list', { dir }).catch(() => []),
};

const encodePath = (name: string) => name.split('/').map(encodeURIComponent).join('/');

// Zuletzt geöffnet: path ist eine eigene Kennung, die Hülle öffnet über das gemerkte Lesezeichen
interface RecentEntry extends RecentFile {
  bookmark: string;
}
const RECENT_FILE = 'recent.json';
const MAX_RECENT = 15;
const MAX_PINNED = 15;

interface Settings {
  authorName: string | null;
  closeGaps?: boolean;
  lastId: { name: string; bookmark: string } | null;
}
const SETTINGS_FILE = 'settings.json';
const SIGNATURES_FILE = 'signatures.json';
const TEMPLATES_DIR = 'Vorlagen';
const THUMBNAILS_DIR = 'Vorschaubilder';
const MAX_USER_TEMPLATES = 100;

export function createIosApi(): BlattwerkApi {
  const menu = new IpadMenu();
  const openedListeners = new Set<(result: OpenResult) => void>();
  const commandListeners = new Set<(command: Parameters<Parameters<BlattwerkApi['onMenuCommand']>[0]>[0]) => void>();
  const recentListeners = new Set<() => void>();
  const templateListeners = new Set<() => void>();
  // Kennung der Zuletzt-Liste je offener Datei (für Vorschaubilder)
  const recentKeyOf = new Map<string, string>();
  let appVersion = '';
  let menuState: MenuState | null = null;
  let recentCache: RecentEntry[] | null = null;
  const untitledCount = new Map<string, number>();

  const emitOpened = (result: OpenResult) => {
    for (const listener of openedListeners) listener(result);
  };

  // --- Zuletzt geöffnet ---
  const recentList = async (): Promise<RecentEntry[]> => {
    recentCache ??= (await store.json<RecentEntry[]>(RECENT_FILE, [])).filter(
      (entry) => typeof entry?.path === 'string' && typeof entry.bookmark === 'string' && typeof entry.openedAt === 'number',
    );
    return recentCache;
  };
  const publicRecent = (list: RecentEntry[]): RecentFile[] =>
    list.map(({ path, name, dir, openedAt, pinned }) => ({ path, name, dir, openedAt, ...(pinned ? { pinned: true } : {}) }));
  const saveRecent = async (list: RecentEntry[]) => {
    const pinned = list.filter((entry) => entry.pinned).slice(0, MAX_PINNED);
    const others = list.filter((entry) => !entry.pinned).slice(0, MAX_RECENT);
    recentCache = [...pinned, ...others];
    await store.writeJson(RECENT_FILE, recentCache).catch(() => undefined);
    for (const listener of recentListeners) listener();
    refreshMenu();
    return publicRecent(recentCache);
  };
  // Neu geöffnete Datei vorn einreihen; dieselbe Datei erkennt man an Ordner und Name
  const rememberRecent = async (file: NativeFile): Promise<void> => {
    if (!file.bookmark || file.untitled) return;
    const list = await recentList();
    const previous = list.find((entry) => entry.name === file.name && entry.dir === file.dir);
    const path = previous?.path ?? `recent:${crypto.randomUUID()}`;
    recentKeyOf.set(file.fileId, path);
    const entry: RecentEntry = { path, name: file.name, dir: file.dir, openedAt: Date.now(), bookmark: file.bookmark, ...(previous?.pinned ? { pinned: true } : {}) };
    await saveRecent([entry, ...list.filter((item) => item.path !== path)]);
  };

  // Gewählte oder übergebene Datei prüfen (Art am Inhalt) und als Tab-Ergebnis melden
  const accept = async (file: NativeFile, kind: PickKind | 'pdf-only' = 'pdf-only'): Promise<{ ok: true; info: FileInfo } | { ok: false; error: 'not-pdf' | 'unreadable' }> => {
    let head: Uint8Array;
    try {
      head = await readRange(file.fileId, 0, Math.min(1024, file.size));
    } catch {
      void call('files.close', { fileId: file.fileId });
      return { ok: false, error: 'unreadable' };
    }
    const detected = detectKind(head);
    if (!detected || !accepts(kind, detected)) {
      void call('files.close', { fileId: file.fileId });
      return { ok: false, error: 'not-pdf' };
    }
    return { ok: true, info: toInfo(file, detected) };
  };

  const openNative = async (file: NativeFile): Promise<OpenResult> => {
    const checked = await accept(file);
    if (!checked.ok) return { ok: false, error: checked.error, name: file.name };
    await rememberRecent(file);
    return { ok: true, file: checked.info };
  };

  const pick = (types: string[], multiple: boolean) => call<NativeFile[]>('files.pick', { types, multiple }).catch(() => [] as NativeFile[]);

  // Unbenanntes Dokument: Bytes als temporäre Datei der Hülle; „Sichern“ wird zu „Sichern unter“
  const openUntitled = async (baseName: string, bytes: Uint8Array): Promise<OpenResult> => {
    const count = (untitledCount.get(baseName) ?? 0) + 1;
    untitledCount.set(baseName, count);
    const name = `${baseName}${count > 1 ? ` ${count}` : ''}.pdf`;
    const file = await sendBytes<NativeFile>(`stage?name=${encodeURIComponent(name)}&open=1`, bytes).catch(() => null);
    return file ? { ok: true, file: toInfo({ ...file, untitled: true }) } : { ok: false, error: 'unreadable' };
  };

  // Neue Datei(en) über den Sichern-Dialog der Dateien-App (der Nutzer wählt den Ort). register: danach geöffnet halten
  const exportFiles = async (files: { name: string; bytes: Uint8Array }[], options: { register?: boolean; replaceFileId?: string } = {}): Promise<NativeExport> => {
    try {
      const stageIds: string[] = [];
      for (const file of files) stageIds.push((await sendBytes<{ stageId: string }>(`stage?name=${encodeURIComponent(file.name)}`, file.bytes)).stageId);
      return await call<NativeExport>('files.export', { stageIds, register: options.register === true, replaceFileId: options.replaceFileId ?? null });
    } catch (error) {
      return { ok: false, error: 'write-failed', detail: String(error) };
    }
  };

  const saveNew = async (bytes: Uint8Array, suggestedName: string, openAfter: boolean): Promise<SaveNewResult> => {
    if (!isPdfBytes(bytes)) return { ok: false, error: 'invalid-data' };
    const result = await exportFiles([{ name: sanitizeFileName(suggestedName), bytes }], { register: openAfter });
    if (!result.ok) return { ok: false, error: result.error === 'cancelled' ? 'cancelled' : 'write-failed', ...(result.detail ? { detail: result.detail } : {}) };
    const file = result.files[0];
    if (!file) return { ok: false, error: 'write-failed' };
    return { ok: true, name: file.name, open: openAfter ? await openNative(file) : null };
  };

  // --- Einstellungen, Vorlagen ---
  const settings = () => store.json<Settings>(SETTINGS_FILE, { authorName: null, lastId: null });
  const updateSettings = async (change: Partial<Settings>) => {
    const next = { ...(await settings()), ...change };
    await store.writeJson(SETTINGS_FILE, next);
    return next;
  };
  const authorName = async () => (await settings()).authorName ?? '';
  const appSettings = async (): Promise<AppSettings> => {
    const current = await settings();
    return { authorName: current.authorName ?? '', readModeFullscreen: false, closeGaps: current.closeGaps !== false };
  };

  const templateCache = new Map<string, Promise<Uint8Array>>();
  // Seitengröße und Ränder in Punkt: Der Druck von WebKit beachtet @page nicht, die Hülle setzt sie selbst. Ohne Angabe A4
  // ohne Rand (Vorlagen setzen ihre Ränder im HTML).
  const htmlToPdf = async (html: string, page?: PageSetup): Promise<Uint8Array> =>
    base64ToBytes(await call<string>('htmlToPdf', { html, page: page ?? { width: 595.28, height: 841.89, margins: { top: 0, right: 0, bottom: 0, left: 0 } } }));

  const templateDocument = async (id: string): Promise<{ name: string; bytes: Uint8Array } | null> => {
    const parsed = parseTemplateId(id);
    if (!parsed) return null;
    if (parsed.kind === 'user') {
      const bytes = await store.read(`${TEMPLATES_DIR}/${parsed.file}`);
      return bytes ? { name: parsed.file.replace(/\.pdf$/i, ''), bytes } : null;
    }
    const author = await authorName();
    const date = new Date();
    const key = `${parsed.name}|${author}|${date.toDateString()}`;
    let pending = templateCache.get(key);
    if (!pending) {
      pending = htmlToPdf(templateHtml(parsed.name, { t: (k, o) => t(k, o), author, date }));
      templateCache.set(key, pending);
      pending.catch(() => templateCache.delete(key));
    }
    return { name: t(`templates.names.${parsed.name}`), bytes: await pending };
  };

  const listTemplates = async (): Promise<TemplateInfo[]> => {
    const builtin = BUILTIN_TEMPLATES.map((name) => ({ id: `builtin:${name}`, name: t(`templates.names.${name}`), builtin: true }));
    const user = (await store.list(TEMPLATES_DIR))
      .filter((file) => /\.pdf$/i.test(file.name) && !file.name.startsWith('.'))
      .sort((a, b) => b.modified - a.modified)
      .map((file) => ({ id: `user:${file.name}`, name: file.name.replace(/\.pdf$/i, ''), builtin: false }));
    return [...builtin, ...user];
  };

  const templateThumbnailKey = (id: string) => (id.startsWith('builtin:') ? `template-${id}@${appVersion}` : `template-${id}`);
  const thumbnailPath = (key: string) => `${THUMBNAILS_DIR}/${encodeURIComponent(key).replace(/%/g, '_')}.png`;
  const thumbnail = async (key: string): Promise<string | null> => {
    const png = await store.read(thumbnailPath(key));
    return png ? `data:image/png;base64,${bytesToBase64(png)}` : null;
  };

  // --- Menü ---
  let refreshScheduled = false;
  function refreshMenu() {
    if (refreshScheduled || !menuState) return;
    refreshScheduled = true;
    queueMicrotask(async () => {
      refreshScheduled = false;
      if (!menuState) return;
      menu.apply({
        state: menuState,
        windowCount: 1,
        recent: publicRecent(await recentList()),
        devTools: false,
        sendCommand: (command) => {
          for (const listener of commandListeners) listener(command);
        },
        openFileDialog: () => void api.openFileDialog().then((results) => results.forEach(emitOpened)),
        openRecent: (path) => void api.recent.open(path).then(emitOpened),
        clearRecent: () => void api.recent.clear(),
        setDefaultApp: () => undefined,
        chooseUpdateFolder: () => undefined,
        mergeWindows: () => undefined,
        showAbout: () => void call('about', { version: appVersion, name: PRODUCT_NAME }),
      });
    });
  }

  // --- Digitale ID ---
  const readId = async (file: NativeFile): Promise<{ ok: true; name: string; bytes: Uint8Array } | { ok: false; error: 'unreadable' | 'invalid' }> => {
    try {
      if (file.size > MAX_ID_BYTES) return { ok: false, error: 'invalid' };
      const bytes = await readAll(file);
      return isP12Bytes(bytes) ? { ok: true, name: file.name, bytes } : { ok: false, error: 'invalid' };
    } catch {
      return { ok: false, error: 'unreadable' };
    } finally {
      void call('files.close', { fileId: file.fileId });
    }
  };

  // --- Textdokumente umwandeln ---
  const convertAndSave = async (file: NativeFile): Promise<ConvertResult> => {
    let bytes: Uint8Array;
    try {
      if (file.size > MAX_DOCUMENT_BYTES) return { ok: false, error: 'too-large' };
      bytes = await readAll(file);
    } catch (error) {
      return { ok: false, error: 'unreadable', detail: String(error) };
    } finally {
      void call('files.close', { fileId: file.fileId });
    }
    let pdf: Uint8Array;
    try {
      const converted = detectAndConvert(bytes, file.name);
      pdf = converted.kind === 'pdf' ? converted.bytes : await htmlToPdf(converted.html, converted.model.page);
    } catch (error) {
      if (error instanceof ConvertError) return { ok: false, error: error.code, detail: error.message };
      return { ok: false, error: 'failed', detail: String(error) };
    }
    if (!isPdfBytes(pdf)) return { ok: false, error: 'failed' };
    return saveNew(pdf, `${file.name.replace(/\.[^.]+$/, '')}.pdf`, true);
  };

  // Ordner für Bilder-Export bzw. mehrere neue Dokumente
  const pickFolder = () => call<{ ok: true; folderId: string; name: string } | { ok: false }>('files.pickFolder').catch(() => ({ ok: false }) as const);
  const writeToFolder = (folderId: string, name: string, bytes: Uint8Array) =>
    sendBytes<{ ok: true; name: string } | { ok: false; error: string }>(`folder/${encodeURIComponent(folderId)}?name=${encodeURIComponent(name)}`, bytes);

  // Dateien, die iPadOS übergibt („Öffnen mit“, Teilen, Dateien-App)
  on('fileOpened', (payload) => {
    const file = payload as NativeFile;
    void openNative(file).then(emitOpened);
  });

  const api: BlattwerkApi = {
    getAppInfo: async () => {
      const info = await call<{ version: string }>('appInfo');
      appVersion = info.version;
      return { platform: 'ios', version: info.version, productName: PRODUCT_NAME, e2e: false, nativeGlass: false };
    },
    openFileDialog: async () => {
      const files = await pick([UTI.pdf], true);
      const results: OpenResult[] = [];
      for (const file of files) results.push(await openNative(file));
      return results;
    },
    // Ablegen per Drag & Drop (aus der Dateien-App neben Blattwerk): Bytes liegen im Browser, die Hülle legt eine
    // unbenannte Kopie an. Speichern fragt deshalb nach dem Ort.
    openDroppedFile: async (file) => {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return { ok: false, error: 'not-pdf', name: file.name };
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!looksLikePdf(bytes.subarray(0, 1024))) return { ok: false, error: 'not-pdf', name: file.name };
      return openUntitled(file.name.replace(/\.pdf$/i, ''), bytes);
    },
    readRange,
    closeFile: async (fileId) => {
      recentKeyOf.delete(fileId);
      await call('files.close', { fileId }).catch(() => undefined);
    },
    recent: {
      list: async () => publicRecent(await recentList()),
      open: async (path) => {
        const entry = (await recentList()).find((item) => item.path === path);
        if (!entry) return { ok: false, error: 'not-found' };
        const file = await call<NativeFile | null>('files.openBookmark', { bookmark: entry.bookmark }).catch(() => null);
        if (!file) return { ok: false, error: 'not-found', name: entry.name };
        return openNative(file);
      },
      remove: async (path) => saveRecent((await recentList()).filter((entry) => entry.path !== path)),
      clear: async () => saveRecent((await recentList()).filter((entry) => entry.pinned)),
      pin: async (path, pinned) =>
        saveRecent((await recentList()).map((entry) => (entry.path === path ? { ...entry, pinned: pinned || undefined } : entry)) as RecentEntry[]),
    },
    templates: {
      list: listTemplates,
      open: async (id) => {
        const template = await templateDocument(id).catch(() => null);
        if (!template) return { ok: false, error: 'not-found' };
        return openUntitled(sanitizeFileName(template.name).replace(/\.pdf$/i, ''), template.bytes);
      },
      preview: async (id) => (await templateDocument(id).catch(() => null))?.bytes ?? null,
      save: async (bytes, name): Promise<SaveTemplateResult> => {
        if (!isPdfBytes(bytes) || name.length > 500) return { ok: false, error: 'invalid-data' };
        const existing = (await store.list(TEMPLATES_DIR)).map((file) => file.name);
        if (existing.filter((file) => /\.pdf$/i.test(file)).length >= MAX_USER_TEMPLATES) return { ok: false, error: 'too-many' };
        const base = sanitizeFileName(name, t('templates.defaultName')).replace(/\.pdf$/i, '');
        const taken = new Set(existing.map((file) => file.toLowerCase()));
        let file = `${base}.pdf`;
        for (let n = 2; taken.has(file.toLowerCase()); n++) file = `${base} ${n}.pdf`;
        try {
          await store.write(`${TEMPLATES_DIR}/${file}`, bytes);
        } catch {
          return { ok: false, error: 'write-failed' };
        }
        for (const listener of templateListeners) listener();
        return { ok: true, template: { id: `user:${file}`, name: file.replace(/\.pdf$/i, ''), builtin: false } };
      },
      remove: async (id) => {
        const parsed = parseTemplateId(id);
        if (parsed?.kind === 'user') {
          await store.remove(`${TEMPLATES_DIR}/${parsed.file}`).catch(() => undefined);
          await store.remove(thumbnailPath(templateThumbnailKey(id))).catch(() => undefined);
          for (const listener of templateListeners) listener();
        }
        return listTemplates();
      },
      onChanged: (listener) => {
        templateListeners.add(listener);
        return () => templateListeners.delete(listener);
      },
    },
    thumbnails: {
      get: async (request) => {
        const result: ThumbnailResult = { recent: {}, templates: {} };
        const known = new Set((await recentList()).map((entry) => entry.path));
        for (const path of request.recent.slice(0, 200)) result.recent[path] = known.has(path) ? await thumbnail(`file-${path}`) : null;
        for (const id of request.templates.slice(0, 200)) result.templates[id] = parseTemplateId(id) ? await thumbnail(templateThumbnailKey(id)) : null;
        return result;
      },
      setFile: async (fileId, png) => {
        const path = recentKeyOf.get(fileId);
        if (!path) return false;
        return store.write(thumbnailPath(`file-${path}`), png).then(() => true, () => false);
      },
      setTemplate: async (id, png) => (parseTemplateId(id) ? store.write(thumbnailPath(templateThumbnailKey(id)), png).then(() => true, () => false) : false),
    },
    print: async (request) => {
      const result = await call<{ ok: boolean; reason?: 'cancelled' | 'failed' }>('print', { name: request.documentName || PRODUCT_NAME }).catch(() => ({ ok: false, reason: 'failed' as const }));
      return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? 'failed' };
    },
    saveFile: async (fileId, bytes, force) => {
      if (!isPdfBytes(bytes)) return { ok: false, error: 'invalid-data' };
      try {
        const result = await sendBytes<NativeSave>(`save/${encodeURIComponent(fileId)}?force=${force === true ? 1 : 0}`, bytes);
        return result.ok ? { ok: true, file: toInfo(result.file) } : ({ ok: false, error: result.error, ...(result.detail ? { detail: result.detail } : {}) } as SaveResult);
      } catch (error) {
        return { ok: false, error: 'write-failed', detail: String(error) };
      }
    },
    saveFileAs: async (fileId, bytes) => {
      if (!isPdfBytes(bytes)) return { ok: false, error: 'invalid-data' };
      const current = await call<NativeFile | null>('files.info', { fileId }).catch(() => null);
      if (!current) return { ok: false, error: 'unknown-file' };
      const result = await exportFiles([{ name: current.name, bytes }], { register: true, replaceFileId: fileId });
      if (!result.ok) return { ok: false, error: result.error === 'cancelled' ? 'cancelled' : 'write-failed', ...(result.detail ? { detail: result.detail } : {}) };
      const file = result.files[0];
      if (!file) return { ok: false, error: 'write-failed' };
      await rememberRecent(file);
      return { ok: true, file: toInfo(file) };
    },
    pickFiles: async (kind) => {
      const picked: PickResult = { files: [], rejected: [] };
      for (const file of await pick(pickTypes(kind), true)) {
        const checked = await accept(file, kind);
        if (checked.ok) picked.files.push(checked.info);
        else picked.rejected.push(file.name);
      }
      return picked;
    },
    // Abgelegte Quelldatei (Einfügen, Zusammenführen): Kopie bei der Hülle anmelden
    registerDroppedFile: async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = detectKind(bytes.subarray(0, 1024));
      if (!kind) return { ok: false, error: 'not-pdf', name: file.name };
      const staged = await sendBytes<NativeFile>(`stage?name=${encodeURIComponent(file.name)}&open=1`, bytes).catch(() => null);
      return staged ? { ok: true, file: toInfo(staged, kind) } : { ok: false, error: 'unreadable', name: file.name };
    },
    newBlankDocument: () => openUntitled(t('files.untitled'), blankPdf()),
    // Updates kommen auf dem iPad über SideStore
    update: {
      status: async (): Promise<UpdateStatus> => ({ state: 'unsupported', current: appVersion, reason: 'platform' }),
      install: async () => false,
      checkOnline: async (): Promise<OnlineCheck> => ({ state: 'unsupported', current: appVersion, reason: 'platform' }),
      onProgress: () => () => undefined,
      onResult: () => () => undefined,
    },
    fonts: {
      list: async () => {
        const names = IPAD_FONTS.flatMap((family) => Object.values(family.styles));
        const available = await call<Record<string, boolean>>('fonts.available', { names }).catch(() => ({}) as Record<string, boolean>);
        return IPAD_FONTS.map((family): SystemFont => ({
          id: family.id,
          name: family.name,
          styles: (Object.keys(family.styles) as (keyof typeof family.styles)[]).filter((style) => available[family.styles[style] as string]),
        })).filter((family) => family.styles.length > 0);
      },
      read: async (key) => {
        const parsed = parseSystemFontKey(key);
        const postscript = parsed ? IPAD_FONTS.find((family) => family.id === parsed.id)?.styles[parsed.style] : undefined;
        if (!postscript) return null;
        const bytes = await fetchBytes(`font/${encodeURIComponent(postscript)}`).catch(() => null);
        return bytes && embeddingAllowed(bytes) ? bytes : null;
      },
    },
    saveNewFile: (bytes, suggestedName, _referenceFileId, openAfter) => saveNew(bytes, suggestedName, openAfter),
    saveFilesToFolder: async (files) => {
      const valid = validateNamedPdfs(files);
      if (!valid) return { ok: false, error: 'invalid-data' };
      const folder = await pickFolder();
      if (!folder.ok) return { ok: false, error: 'cancelled' };
      const names: string[] = [];
      try {
        for (const file of valid) {
          const written = await writeToFolder(folder.folderId, sanitizeFileName(file.name), file.bytes);
          if (!written.ok) throw new Error(written.error);
          names.push(written.name);
        }
      } catch (error) {
        return { ok: false, error: 'write-failed', detail: `${names.length}/${valid.length}: ${String(error)}` };
      } finally {
        void call('files.releaseFolder', { folderId: folder.folderId });
      }
      return { ok: true, folder: folder.name, names };
    },
    exportImages: {
      chooseFolder: async () => {
        const folder = await pickFolder();
        return folder.ok ? { ok: true, token: folder.folderId, folder: folder.name } : { ok: false, error: 'cancelled' };
      },
      write: async (token, name, kind, bytes) => {
        if (!isImageBytes(bytes, kind) || name.length > 1000) return { ok: false, error: 'invalid-data' };
        try {
          const written = await writeToFolder(token, sanitizeFileName(name, 'Seite', kind === 'png' ? '.png' : '.jpg'), bytes);
          return written.ok ? { ok: true, name: written.name } : { ok: false, error: written.error === 'unknown-folder' ? 'unknown-folder' : 'write-failed' };
        } catch (error) {
          return { ok: false, error: 'write-failed', detail: String(error) };
        }
      },
      end: async (token) => {
        await call('files.releaseFolder', { folderId: token }).catch(() => undefined);
      },
    },
    exportText: async (text, suggestedName) => {
      if (!isExportText(text)) return { ok: false, error: 'invalid-data' };
      const result = await exportFiles([{ name: sanitizeFileName(suggestedName, 'Dokument', '.txt'), bytes: new TextEncoder().encode(text) }]);
      if (!result.ok) return { ok: false, error: result.error === 'cancelled' ? 'cancelled' : 'write-failed' };
      return { ok: true, name: result.files[0]?.name ?? suggestedName };
    },
    convertDocument: {
      pick: async () => {
        const [file] = await pick(DOCUMENT_UTIS, false);
        if (!file) return { ok: false, error: 'cancelled' };
        return convertAndSave(file);
      },
      dropped: async (dropped) => {
        const extension = dropped.name.split('.').pop()?.toLowerCase() ?? '';
        if (!DOCUMENT_EXTENSIONS.includes(extension)) return { ok: false, error: 'unsupported' };
        const bytes = new Uint8Array(await dropped.arrayBuffer());
        const staged = await sendBytes<NativeFile>(`stage?name=${encodeURIComponent(dropped.name)}&open=1`, bytes).catch(() => null);
        return staged ? convertAndSave(staged) : { ok: false, error: 'unreadable' };
      },
    },
    digitalId: {
      pick: async () => {
        const [file] = await pick([UTI.p12], false);
        if (!file) return { ok: false, error: 'cancelled' };
        const read = await readId(file);
        if (read.ok && file.bookmark) await updateSettings({ lastId: { name: file.name, bookmark: file.bookmark } });
        return read;
      },
      last: async () => {
        const last = (await settings()).lastId;
        if (!last) return { ok: false, error: 'cancelled' };
        const file = await call<NativeFile | null>('files.openBookmark', { bookmark: last.bookmark }).catch(() => null);
        return file ? readId(file) : { ok: false, error: 'unreadable' };
      },
      save: async (bytes, suggestedName) => {
        if (!isP12Bytes(bytes)) return { ok: false, error: 'invalid-data' };
        const result = await exportFiles([{ name: sanitizeFileName(suggestedName, 'Digitale ID', '.p12'), bytes }], { register: true });
        if (!result.ok) return { ok: false, error: result.error === 'cancelled' ? 'cancelled' : 'write-failed' };
        const file = result.files[0];
        if (!file) return { ok: false, error: 'write-failed' };
        if (file.bookmark) await updateSettings({ lastId: { name: file.name, bookmark: file.bookmark } });
        void call('files.close', { fileId: file.fileId });
        return { ok: true, name: file.name };
      },
    },
    signatures: {
      list: async () =>
        (await store.json<SavedSignature[]>(SIGNATURES_FILE, [])).filter(
          (entry) =>
            typeof entry?.id === 'string' &&
            typeof entry.created === 'number' &&
            isSignatureInput({ ...entry, png: base64ToBytes(String(entry.png)) }),
        ),
      add: async (input) => {
        if (!isSignatureInput(input)) throw new Error('invalid-signature');
        const entry: SavedSignature = { id: crypto.randomUUID(), kind: input.kind, png: bytesToBase64(input.png), width: input.width, height: input.height, created: Date.now() };
        const list = [entry, ...(await api.signatures.list())].slice(0, MAX_SIGNATURES);
        await store.writeJson(SIGNATURES_FILE, list);
        return list;
      },
      remove: async (id) => {
        const list = (await api.signatures.list()).filter((entry) => entry.id !== id);
        await store.writeJson(SIGNATURES_FILE, list);
        return list;
      },
    },
    // Vollbild gibt es auf dem iPad nicht; die Einstellung dazu zeigt die Oberfläche dort nicht an
    getSettings: appSettings,
    setAuthorName: async (name) => {
      const valid = validateAuthorName(name);
      if (valid !== null) await updateSettings({ authorName: valid });
      return appSettings();
    },
    setReadModeFullscreen: appSettings,
    setCloseGaps: async (on) => {
      await updateSettings({ closeGaps: on === true });
      return appSettings();
    },
    // Auf dem iPad schließt man die App nicht über Blattwerk; ungespeicherte Stände bleiben bis zum Sichern im Tab
    confirmClose: () => undefined,
    cancelClose: () => undefined,
    onRequestClose: () => () => undefined,
    // Ein Fenster: Tabs wandern nicht
    transferTab: async () => ({ ok: false, error: 'nothing-to-do' }),
    onTabReceived: () => () => undefined,
    onMergeRequest: () => () => undefined,
    tabDrag: () => undefined,
    onTabDragHover: () => () => undefined,
    fetchDraggedPages: async () => null,
    onProvidePages: () => () => undefined,
    providePages: () => undefined,
    setTabDragHoverState: () => undefined,
    closeWindow: () => undefined,
    setFullscreen: async () => false,
    // Rückfrage wie auf dem Mac (src/main/security.ts): Host in Punycode, genau diese Adresse öffnen
    openExternal: async (url) => {
      if (!isAllowedExternalUrl(url)) return false;
      const parsed = new URL(url);
      const message =
        parsed.protocol === 'mailto:'
          ? t('dialog.externalLink.messageMail', { address: decodeURIComponent(parsed.pathname) })
          : t('dialog.externalLink.messageHost', { host: parsed.host });
      return call<boolean>('openExternal', {
        url: parsed.href,
        message,
        detail: t('dialog.externalLink.detail', { url: parsed.href }),
        open: t('dialog.externalLink.open'),
        cancel: t('dialog.externalLink.cancel'),
      }).catch(() => false);
    },
    setMenuState: (state) => {
      menuState = state;
      refreshMenu();
    },
    setGlassRegions: () => undefined,
    signalReady: () => {
      void call('ready');
    },
    // Umbenennen gibt es auf dem iPad nicht (Dateien verwaltet die App „Dateien“)
    renameFile: async () => ({ ok: false, error: 'failed' }),
    onFileRenamed: () => () => undefined,
    onFileOpened: (listener) => {
      openedListeners.add(listener);
      return () => openedListeners.delete(listener);
    },
    onMenuCommand: (listener) => {
      commandListeners.add(listener);
      return () => commandListeners.delete(listener);
    },
    onRecentChanged: (listener) => {
      recentListeners.add(listener);
      return () => recentListeners.delete(listener);
    },
  };
  return api;
}
