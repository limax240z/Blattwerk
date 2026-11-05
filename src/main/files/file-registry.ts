import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { FileInfo, FileKind, OpenResult, PickKind, RenameResult } from '../../shared/ipc';
import { looksLikePdf, validateReadRange } from '../../shared/validate';

// Erkennt die Dateiart am Inhalt, nicht an der Endung.
function detectKind(head: Uint8Array): FileKind | null {
  if (looksLikePdf(head)) return 'pdf';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  return null;
}

function accepts(accept: PickKind | 'pdf-only', kind: FileKind): boolean {
  if (accept === 'pdf-only' || accept === 'pdf') return kind === 'pdf';
  if (accept === 'images') return kind !== 'pdf';
  return true;
}

interface OpenFile {
  info: FileInfo;
  path: string;
  // null, solange die Datei unter Windows zum Überschreiben freigegeben ist (whileReleased)
  handle: fs.FileHandle | null;
  ownerId: number;
  // Dokument in einem Tab (nicht Quelldatei zum Einfügen, Zusammenführen oder Vergleichen)
  document: boolean;
  // Stand beim Öffnen. Ändert sich die Datei danach, liefern Lesezugriffe einen Fehler statt falscher Daten.
  mtimeMs: number;
  // Kennung im Dateisystem (Laufwerk und Dateinummer): bleibt beim Umbenennen und Verschieben gleich
  dev: bigint;
  ino: bigint;
}

// Umbenannt oder verschoben (im Finder oder in der App): neuer Pfad einer geöffneten Datei
export interface RenamedFile {
  ownerId: number;
  info: FileInfo;
  oldPath: string;
  newPath: string;
}

// Ordner mit so vielen Einträgen werden beim Suchen der umbenannten Datei nicht ganz durchgesehen
const MAX_SCAN = 5000;
// Ereignisse des Dateisystems kommen oft gehäuft; erst danach suchen
const FOLLOW_DELAY_MS = 150;
// Im Papierkorb gilt eine Datei als weg: dorthin folgt das Register nicht
const TRASH = /[\\/]\.Trash(es)?[\\/]|[\\/]\$Recycle\.Bin[\\/]/i;

// Aktueller Pfad einer geöffneten Datei (nur macOS: lsof kennt ihn über das Handle, auch nach dem Verschieben)
function pathOfHandle(fd: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-a', '-p', String(process.pid), '-d', String(fd), '-Fn'], { timeout: 3000 }, (error, stdout) => {
      const line = error ? undefined : stdout.split('\n').find((entry) => entry.startsWith('n/'));
      resolve(line ? line.slice(1) : null);
    });
  });
}

function normalizePath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(filePath);
  // macOS und Windows unterscheiden Groß- und Kleinschreibung in Dateinamen normalerweise nicht
  return platform === 'linux' ? resolved : resolved.toLowerCase();
}

export class FileChangedError extends Error {
  constructor() {
    super('file-changed');
    this.name = 'FileChangedError';
  }
}

// Verwaltet geöffnete Dateien. Der Renderer kennt nur Datei-IDs, nie die Handles.
// Jede Datei gehört zu genau einem Renderer (webContents-ID); nur dieser darf daraus lesen.
export class FileRegistry {
  #files = new Map<string, OpenFile>();

  // Öffnet eine Datei zum Lesen. Standard: nur PDFs (Tabs). Quelldateien zum Einfügen dürfen auch Bilder sein.
  async open(filePath: string, ownerId: number, accept: PickKind | 'pdf-only' = 'pdf-only'): Promise<OpenResult> {
    const name = path.basename(filePath);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { ok: false, error: code === 'ENOENT' ? 'not-found' : 'unreadable', name };
    }
    if (!stat.isFile()) return { ok: false, error: 'not-a-file', name };

    let handle: fs.FileHandle;
    try {
      handle = await fs.open(filePath, 'r');
    } catch {
      return { ok: false, error: 'unreadable', name };
    }

    let kind: FileKind | null;
    try {
      const head = new Uint8Array(1024);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      kind = detectKind(head.subarray(0, bytesRead));
      if (!kind || !accepts(accept, kind)) {
        await handle.close();
        return { ok: false, error: 'not-pdf', name };
      }
    } catch {
      await handle.close().catch(() => undefined);
      return { ok: false, error: 'unreadable', name };
    }

    // Größe und Zeitstempel über das geöffnete Handle, nicht über den Pfad: kein Zeitfenster dazwischen.
    let opened;
    try {
      opened = await handle.stat();
    } catch {
      await handle.close().catch(() => undefined);
      return { ok: false, error: 'unreadable', name };
    }
    let id;
    try {
      id = await handle.stat({ bigint: true });
    } catch {
      await handle.close().catch(() => undefined);
      return { ok: false, error: 'unreadable', name };
    }
    const info: FileInfo = { fileId: randomUUID(), name, dir: path.dirname(filePath), size: opened.size, kind };
    const document = accept === 'pdf-only';
    this.#files.set(info.fileId, { info, path: filePath, handle, ownerId, document, mtimeMs: opened.mtimeMs, dev: id.dev, ino: id.ino });
    if (document) this.#watch(info.dir);
    return { ok: true, file: info };
  }

  async read(fileId: string, begin: unknown, end: unknown, ownerId: number): Promise<Uint8Array> {
    const file = this.#files.get(fileId);
    if (!file || file.ownerId !== ownerId) throw new Error('unknown-file');
    const range = validateReadRange(begin, end, file.info.size);
    if (!range) throw new Error('invalid-range');
    const handle = file.handle;
    // Datei wird gerade überschrieben (Windows): wie eine von außen geänderte Datei behandeln
    if (!handle) throw new FileChangedError();
    const current = await handle.stat();
    if (current.size !== file.info.size || current.mtimeMs !== file.mtimeMs) throw new FileChangedError();
    const length = range.end - range.begin;
    const buffer = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, range.begin + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // Weniger Bytes als erwartet heißt: Die Datei wurde gekürzt. Nie still unvollständige Daten liefern.
    if (offset !== length) throw new FileChangedError();
    return buffer;
  }

  // true, wenn die Datei auf der Platte noch dem Stand beim Öffnen entspricht (Größe und Änderungszeit).
  // Wird vor dem Überschreiben geprüft, damit fremde Änderungen nicht verloren gehen.
  async isUnchangedOnDisk(fileId: string, ownerId: number): Promise<boolean> {
    const file = this.#files.get(fileId);
    if (!file || file.ownerId !== ownerId) return false;
    await this.#follow(file);
    try {
      const current = await fs.stat(file.path);
      return current.size === file.info.size && current.mtimeMs === file.mtimeMs;
    } catch {
      return false;
    }
  }

  // Nach dem Speichern: alte Datei-ID schließen, die gespeicherte Datei neu öffnen.
  async reopen(fileId: string, ownerId: number, newPath?: string): Promise<OpenResult> {
    const file = this.#files.get(fileId);
    if (!file || file.ownerId !== ownerId) return { ok: false, error: 'not-found' };
    await this.close(fileId, ownerId);
    return this.open(newPath ?? file.path, ownerId);
  }

  // true, wenn diese Datei (gleicher Pfad) gerade in irgendeinem Tab geöffnet ist
  isOpenPath(filePath: string): boolean {
    const wanted = normalizePath(filePath);
    return [...this.#files.values()].some((file) => normalizePath(file.path) === wanted);
  }

  // Fenster (webContents-ID), in dem diese Datei als Dokument in einem Tab offen ist; sonst null
  documentOwner(filePath: string): number | null {
    const wanted = normalizePath(filePath);
    return [...this.#files.values()].find((file) => file.document && normalizePath(file.path) === wanted)?.ownerId ?? null;
  }

  // Pfade der Dokumente in den Tabs eines Fensters
  documentPaths(ownerId: number): string[] {
    return [...this.#files.values()].filter((file) => file.document && file.ownerId === ownerId).map((file) => file.path);
  }

  // true, wenn das Fenster mindestens ein Dokument in einem Tab hat
  hasDocuments(ownerId: number): boolean {
    return [...this.#files.values()].some((file) => file.document && file.ownerId === ownerId);
  }

  // Angaben zu einer geöffneten Datei (für die Übergabe eines Tabs)
  infoOf(fileId: string, ownerId: number): FileInfo | null {
    const file = this.#files.get(fileId);
    return file && file.ownerId === ownerId ? file.info : null;
  }

  // Gibt eine geöffnete Datei an ein anderes Fenster weiter (Tab wandert, ADR 0026). Handle und Stand beim Öffnen
  // bleiben, damit Änderungen von außen weiterhin erkannt werden.
  transfer(fileId: string, fromOwner: number, toOwner: number): boolean {
    const file = this.#files.get(fileId);
    if (!file || file.ownerId !== fromOwner) return false;
    file.ownerId = toOwner;
    return true;
  }

  // Windows lässt eine Datei, die noch geöffnet ist, nicht ersetzen. Vor dem Überschreiben (Speichern über eine offene
  // Datei) schließt das Register deshalb alle Handles auf diesen Pfad und öffnet sie danach wieder. Hat sich die Datei
  // geändert, melden spätere Lesezugriffe das wie eine Änderung von außen. Andere Systeme ersetzen offene Dateien
  // problemlos; dort läuft write unverändert.
  async whileReleased<T>(filePath: string, write: () => Promise<T>, platform: NodeJS.Platform = process.platform): Promise<T> {
    if (platform !== 'win32') return write();
    const wanted = normalizePath(filePath, platform);
    const affected = [...this.#files.values()].filter((file) => file.handle && normalizePath(file.path, platform) === wanted);
    for (const file of affected) {
      const handle = file.handle;
      file.handle = null;
      await handle?.close().catch(() => undefined);
    }
    try {
      return await write();
    } finally {
      for (const file of affected) {
        // Inzwischen geschlossen (z. B. durch reopen nach dem Speichern): nichts wieder zu öffnen
        if (this.#files.get(file.info.fileId) !== file || file.handle) continue;
        try {
          file.handle = await fs.open(file.path, 'r');
        } catch {
          file.handle = null;
        }
      }
    }
  }

  // Meldet umbenannte und verschobene Dokumente (Fenster aktualisieren Tab, Titel und „Zuletzt geöffnet“)
  onRenamed: ((file: RenamedFile) => void) | null = null;

  #watchers = new Map<string, { watcher: FSWatcher; count: number }>();
  #pending = new Map<string, ReturnType<typeof setTimeout>>();

  // Ordner beobachten, in denen Dokumente liegen: Wird eine davon umbenannt, folgt das Register ihr sofort
  #watch(dir: string): void {
    const entry = this.#watchers.get(dir);
    if (entry) {
      entry.count++;
      return;
    }
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => this.#changedIn(dir, filename?.toString() ?? null));
      watcher.on('error', () => this.#unwatch(dir, true));
      this.#watchers.set(dir, { watcher, count: 1 });
    } catch {
      // Ordner nicht beobachtbar: Das Register folgt der Datei dann spätestens beim Speichern
    }
  }

  #unwatch(dir: string, all = false): void {
    const entry = this.#watchers.get(dir);
    if (!entry) return;
    entry.count--;
    if (entry.count > 0 && !all) return;
    entry.watcher.close();
    this.#watchers.delete(dir);
  }

  #changedIn(dir: string, filename: string | null): void {
    for (const file of this.#files.values()) {
      if (!file.document || path.dirname(file.path) !== dir) continue;
      if (filename !== null && filename !== path.basename(file.path)) continue;
      const id = file.info.fileId;
      clearTimeout(this.#pending.get(id));
      this.#pending.set(
        id,
        setTimeout(() => {
          this.#pending.delete(id);
          void this.#follow(file);
        }, FOLLOW_DELAY_MS),
      );
    }
  }

  // Liegt die Datei nicht mehr unter ihrem Pfad, sucht das Register sie anhand ihrer Kennung: erst im selben Ordner
  // (Umbenennen im Finder), unter macOS dann über das offene Handle (Verschieben in einen anderen Ordner).
  async #follow(file: OpenFile): Promise<void> {
    try {
      const current = await fs.stat(file.path, { bigint: true });
      if (current.dev === file.dev && current.ino === file.ino) return;
    } catch {
      // Pfad gibt es nicht mehr: suchen
    }
    const found = await this.#find(file);
    if (found && found !== file.path && this.#files.get(file.info.fileId) === file) this.#moved(file, found);
  }

  async #find(file: OpenFile): Promise<string | null> {
    const same = async (candidate: string) => {
      const stat = await fs.lstat(candidate, { bigint: true }).catch(() => null);
      return stat?.isFile() === true && stat.dev === file.dev && stat.ino === file.ino;
    };
    const dir = path.dirname(file.path);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names.slice(0, MAX_SCAN)) {
      const candidate = path.join(dir, name);
      if (await same(candidate)) return candidate;
    }
    if (process.platform === 'darwin' && file.handle) {
      const candidate = await pathOfHandle(file.handle.fd);
      if (candidate && !TRASH.test(candidate) && (await same(candidate))) return candidate;
    }
    return null;
  }

  #moved(file: OpenFile, newPath: string): void {
    const oldPath = file.path;
    const oldDir = path.dirname(oldPath);
    file.path = newPath;
    file.info = { ...file.info, name: path.basename(newPath), dir: path.dirname(newPath) };
    if (file.document && oldDir !== file.info.dir) {
      this.#unwatch(oldDir);
      this.#watch(file.info.dir);
    }
    this.onRenamed?.({ ownerId: file.ownerId, info: file.info, oldPath, newPath });
  }

  // Benennt ein Dokument im selben Ordner um. name ist schon geprüft (validFileName).
  async rename(fileId: string, ownerId: number, name: string): Promise<RenameResult> {
    const file = this.#files.get(fileId);
    if (!file || file.ownerId !== ownerId || !file.document) return { ok: false, error: 'unknown-file' };
    await this.#follow(file);
    const target = path.join(path.dirname(file.path), name);
    if (target === file.path) return { ok: true, file: file.info };
    // Gibt es den Namen schon? (Nur andere Groß- und Kleinschreibung ist unter macOS und Windows dieselbe Datei.)
    const existing = await fs.stat(target, { bigint: true }).catch(() => null);
    if (existing && !(existing.dev === file.dev && existing.ino === file.ino)) return { ok: false, error: 'exists' };
    try {
      await fs.rename(file.path, target);
    } catch (error) {
      return { ok: false, error: 'failed', detail: String(error) };
    }
    this.#moved(file, target);
    return { ok: true, file: file.info };
  }

  pathOf(fileId: string, ownerId: number): string | null {
    const file = this.#files.get(fileId);
    return file && file.ownerId === ownerId ? file.path : null;
  }

  async close(fileId: string, ownerId: number): Promise<void> {
    const file = this.#files.get(fileId);
    if (!file || file.ownerId !== ownerId) return;
    this.#files.delete(fileId);
    clearTimeout(this.#pending.get(fileId));
    this.#pending.delete(fileId);
    if (file.document) this.#unwatch(path.dirname(file.path));
    await file.handle?.close().catch(() => undefined);
  }

  async closeAllOwnedBy(ownerId: number): Promise<void> {
    const ids = [...this.#files.values()].filter((f) => f.ownerId === ownerId).map((f) => f.info.fileId);
    await Promise.all(ids.map((id) => this.close(id, ownerId)));
  }

  get openCount(): number {
    return this.#files.size;
  }
}
