// ZIP-Archive lesen (DOCX und ODT sind ZIP-Dateien). Nur „gespeichert“ und „Deflate“, mit Grenzen gegen
// überdimensionierte oder präparierte Archive. Entpackt mit fflate statt node:zlib, damit es auch auf dem iPad
// (WebView, ADR 0029) läuft.
import { inflateSync } from 'fflate';

const MAX_ENTRIES = 20_000;
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

export class ZipError extends Error {}

export interface ZipArchive {
  names: string[];
  has(name: string): boolean;
  // null, wenn es den Eintrag nicht gibt
  read(name: string): Uint8Array | null;
  text(name: string): string | null;
}

export function readZip(bytes: Uint8Array): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Ende des zentralen Verzeichnisses rückwärts suchen (Kommentar bis 64 KB)
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('kein ZIP-Archiv');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count > MAX_ENTRIES) throw new ZipError('zu viele Einträge');
  const entries = new Map<string, { method: number; compressed: number; size: number; local: number }>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new ZipError('Verzeichnis beschädigt');
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { method, compressed, size, local });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  let total = 0;
  const read = (name: string): Uint8Array | null => {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.size > MAX_ENTRY_BYTES) throw new ZipError('Eintrag zu groß');
    total += entry.size;
    if (total > MAX_TOTAL_BYTES) throw new ZipError('Archiv zu groß');
    if (entry.local + 30 > bytes.length || view.getUint32(entry.local, true) !== 0x04034b50) throw new ZipError('Eintrag beschädigt');
    const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
    const data = bytes.subarray(start, start + entry.compressed);
    if (entry.method === 0) return data.slice();
    // Höchstens die angegebene Größe (fflate kürzt längere Daten ab)
    if (entry.method === 8) return inflateSync(data, { out: new Uint8Array(Math.max(entry.size, 1)) }).subarray(0, entry.size);
    throw new ZipError(`Komprimierung ${entry.method} nicht unterstützt`);
  };
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    text: (name) => {
      const data = read(name);
      return data ? new TextDecoder().decode(data) : null;
    },
  };
}
