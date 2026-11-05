import path from 'node:path';
import type { RecentFile } from '../../shared/ipc';
import { JsonStore } from './json-store';

// Höchstzahl nicht angehefteter Einträge; angeheftete kommen dazu (höchstens MAX_PINNED_FILES)
export const MAX_RECENT_FILES = 15;
export const MAX_PINNED_FILES = 15;

interface RecentFilesData {
  version: 1;
  files: RecentFile[];
}

function validate(raw: unknown): RecentFilesData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as { version?: unknown; files?: unknown };
  if (data.version !== 1 || !Array.isArray(data.files)) return null;
  const files = data.files.filter(
    (f): f is RecentFile =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as RecentFile).path === 'string' &&
      path.isAbsolute((f as RecentFile).path) &&
      typeof (f as RecentFile).openedAt === 'number',
  );
  return {
    version: 1,
    files: limit(
      files.map((f) => ({
        path: f.path,
        name: path.basename(f.path),
        dir: path.dirname(f.path),
        openedAt: f.openedAt,
        ...(f.pinned === true ? { pinned: true } : {}),
      })),
    ),
  };
}

// Angeheftete zuerst (in ihrer Reihenfolge), dann die übrigen nach Zeit; beide Teile begrenzt
function limit(files: RecentFile[]): RecentFile[] {
  const pinned = files.filter((f) => f.pinned).slice(0, MAX_PINNED_FILES);
  const others = files.filter((f) => !f.pinned).slice(0, MAX_RECENT_FILES);
  return [...pinned, ...others];
}

// Pfade werden unter Windows ohne Beachtung der Groß-/Kleinschreibung verglichen.
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class RecentFiles {
  #store: JsonStore<RecentFilesData>;
  #platform: NodeJS.Platform;
  #cache: RecentFilesData | null = null;

  constructor(filePath: string, platform: NodeJS.Platform = process.platform) {
    this.#store = new JsonStore(filePath, () => ({ version: 1, files: [] }), validate);
    this.#platform = platform;
  }

  async list(): Promise<RecentFile[]> {
    this.#cache ??= await this.#store.read();
    return [...this.#cache.files];
  }

  async contains(filePath: string): Promise<boolean> {
    const files = await this.list();
    return files.some((f) => samePath(f.path, filePath, this.#platform));
  }

  async add(filePath: string, now: number = Date.now()): Promise<RecentFile[]> {
    const all = await this.list();
    const previous = all.find((f) => samePath(f.path, filePath, this.#platform));
    const files = all.filter((f) => f !== previous);
    const entry: RecentFile = { path: filePath, name: path.basename(filePath), dir: path.dirname(filePath), openedAt: now };
    // Angeheftete behalten ihren Platz, andere rücken nach oben
    if (previous?.pinned) files.splice(all.indexOf(previous), 0, { ...entry, pinned: true });
    else files.splice(files.filter((f) => f.pinned).length, 0, entry);
    return this.#save(limit(files));
  }

  async setPinned(filePath: string, pinned: boolean): Promise<RecentFile[]> {
    const all = await this.list();
    const entry = all.find((f) => samePath(f.path, filePath, this.#platform));
    if (!entry || entry.pinned === pinned) return all;
    const others = all.filter((f) => f !== entry);
    const updated: RecentFile = { path: entry.path, name: entry.name, dir: entry.dir, openedAt: entry.openedAt, ...(pinned ? { pinned: true } : {}) };
    const pinnedCount = others.filter((f) => f.pinned).length;
    // Neu angeheftet: ans Ende der angehefteten; gelöst: ganz oben unter die angehefteten
    others.splice(pinnedCount, 0, updated);
    return this.#save(limit(others));
  }

  async remove(filePath: string): Promise<RecentFile[]> {
    const files = (await this.list()).filter((f) => !samePath(f.path, filePath, this.#platform));
    return this.#save(files);
  }

  // Datei umbenannt oder verschoben: Eintrag behält Platz, Anheften und Zeitpunkt
  async rename(oldPath: string, newPath: string): Promise<RecentFile[]> {
    const files = (await this.list()).map((f) =>
      samePath(f.path, oldPath, this.#platform) ? { ...f, path: newPath, name: path.basename(newPath), dir: path.dirname(newPath) } : f,
    );
    return this.#save(files);
  }

  // Angeheftete bleiben stehen (wie in Word „Nicht angeheftete Elemente löschen“)
  async clear(): Promise<RecentFile[]> {
    return this.#save((await this.list()).filter((f) => f.pinned));
  }

  async #save(files: RecentFile[]): Promise<RecentFile[]> {
    this.#cache = { version: 1, files };
    await this.#store.write(this.#cache);
    return [...files];
  }
}
