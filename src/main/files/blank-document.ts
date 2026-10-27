// Neues leeres Dokument („Unbenannt“): eine leere A4-Seite in einem temporären Ordner der App. Der Tab gilt als
// unbenannt; „Sichern“ fragt nach Ort und Namen (wie in Pages oder Word). Der Ordner wird beim Beenden gelöscht.
import { app } from 'electron';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { blankPdf } from '../../shared/blank-pdf';
import { PRODUCT_NAME } from '../../shared/product';

let folder: string | null = null;

const folderPrefix = `${PRODUCT_NAME.toLowerCase()}-neu-`;

function blankFolder(): string {
  if (!folder) {
    folder = path.join(app.getPath('temp'), `${folderPrefix}${process.pid}`);
    removeLeftovers(path.dirname(folder));
  }
  mkdirSync(folder, { recursive: true });
  return folder;
}

// true, wenn ein Prozess mit dieser Nummer läuft (Signal 0 prüft nur, ob es ihn gibt)
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: Den Prozess gibt es, er gehört nur einem anderen Benutzer
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Reste früherer Läufe, die beim Beenden nicht gelöscht werden konnten (siehe removeBlankDocuments). Ordner noch
// laufender Instanzen bleiben unangetastet (z. B. die eigentliche App, während Tests mit eigenem Profil laufen).
function removeLeftovers(tempDir: string): void {
  try {
    for (const name of readdirSync(tempDir)) {
      if (!name.startsWith(folderPrefix)) continue;
      const pid = Number(name.slice(folderPrefix.length));
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isRunning(pid)) removeQuietly(path.join(tempDir, name));
    }
  } catch {
    // Temporärer Ordner nicht lesbar: nichts aufzuräumen
  }
}

function removeQuietly(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Windows: Eine noch geöffnete Datei lässt sich nicht löschen; der Ordner verschwindet beim nächsten Start
  }
}

// Legt „Unbenannt.pdf“ (bzw. „Unbenannt 2.pdf“ …) an und liefert den Pfad
export async function createBlankDocument(baseName: string): Promise<string> {
  return createUntitledDocument(baseName, blankPdf());
}

// Unbenanntes Dokument mit diesem Inhalt (z. B. aus einer Vorlage): „Brief.pdf“, beim nächsten Mal „Brief 2.pdf“
const used = new Map<string, number>();
export async function createUntitledDocument(baseName: string, bytes: Uint8Array): Promise<string> {
  const count = (used.get(baseName) ?? 0) + 1;
  used.set(baseName, count);
  const file = path.join(blankFolder(), `${baseName}${count > 1 ? ` ${count}` : ''}.pdf`);
  await writeFile(file, bytes);
  return file;
}

export const isBlankDocumentPath = (filePath: string): boolean => folder !== null && path.dirname(filePath) === folder;

// Beim Beenden (will-quit). Darf nie werfen: Ein Fehler hier hielte das Beenden auf. Unter Windows sind die Dateien
// in diesem Moment oft noch geöffnet und lassen sich nicht löschen; dann räumt der nächste Start auf.
export function removeBlankDocuments(): void {
  if (folder) removeQuietly(folder);
}
