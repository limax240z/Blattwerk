// Prüfungen für Daten, die über IPC aus dem Renderer kommen. Der Renderer gilt als nicht vertrauenswürdig.
import {
  MAX_FILE_NAME,
  MAX_NEW_FILES,
  MAX_READ_CHUNK,
  MAX_SIGNATURE_BYTES,
  MAX_SIGNATURE_SIDE,
  type GlassRegion,
  type MenuState,
  type NamedBytes,
  type PickKind,
  type SignatureInput,
  type TabDestination,
  type TabDragHoverState,
  type TabDragMessage,
  type TabTransfer,
  type ViewMode,
} from './ipc';

const VIEW_MODES: readonly ViewMode[] = ['single', 'continuous', 'two-page', 'two-page-continuous'];

export function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isFileId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
}

export function validateReadRange(
  begin: unknown,
  end: unknown,
  size: number,
): { begin: number; end: number } | null {
  if (!isNonNegativeInt(begin) || !isNonNegativeInt(end)) return null;
  if (end < begin || begin > size) return null;
  const clampedEnd = Math.min(end, size);
  if (clampedEnd - begin > MAX_READ_CHUNK) return null;
  return { begin, end: clampedEnd };
}

const GLASS_ANCHORS = new Set(['band', 'left', 'right', 'fill']);

// Glasflächen aus dem Renderer: höchstens 16, nur endliche Zahlen in sinnvollen Grenzen
export function validateGlassRegions(value: unknown): GlassRegion[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const regions: GlassRegion[] = [];
  const finite = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const r = item as Record<string, unknown>;
    const tint = r.tint;
    if (!finite(r.x, -10_000, 100_000) || !finite(r.y, -10_000, 100_000) || !finite(r.width, 0, 100_000) || !finite(r.height, 0, 100_000) || !finite(r.radius, 0, 1000)) return null;
    if (!Array.isArray(tint) || tint.length !== 4 || !tint.every((c, i) => finite(c, 0, i === 3 ? 1 : 255))) return null;
    if ((r.style !== 'regular' && r.style !== 'clear') || typeof r.anchor !== 'string' || !GLASS_ANCHORS.has(r.anchor)) return null;
    regions.push({ x: r.x, y: r.y, width: r.width, height: r.height, radius: r.radius, tint: tint as GlassRegion['tint'], style: r.style, anchor: r.anchor as GlassRegion['anchor'] });
  }
  return regions;
}

export function validateMenuState(value: unknown): MenuState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const bool = (x: unknown) => typeof x === 'boolean';
  const flags = ['hasDocument', 'canPrint', 'sidebarVisible', 'readMode', 'rightPanelVisible', 'canUndo', 'canRedo', 'activeDirty', 'commentToolsVisible', 'organizeMode', 'canAssemble', 'canExtract', 'formEditing', 'canEditForms', 'redactToolsVisible', 'hasRedactionMarks', 'contentEditing', 'markToolsVisible'];
  if (!flags.every((key) => bool(v[key]))) return null;
  if (!isNonNegativeInt(v.tabCount) || !isNonNegativeInt(v.dirtyCount)) return null;
  if (v.viewMode !== null && !VIEW_MODES.includes(v.viewMode as ViewMode)) return null;
  return {
    hasDocument: v.hasDocument as boolean,
    canPrint: v.canPrint as boolean,
    sidebarVisible: v.sidebarVisible as boolean,
    readMode: v.readMode as boolean,
    rightPanelVisible: v.rightPanelVisible as boolean,
    tabCount: v.tabCount,
    viewMode: v.viewMode as ViewMode | null,
    dirtyCount: v.dirtyCount,
    canUndo: v.canUndo as boolean,
    canRedo: v.canRedo as boolean,
    activeDirty: v.activeDirty as boolean,
    commentToolsVisible: v.commentToolsVisible as boolean,
    organizeMode: v.organizeMode as boolean,
    canAssemble: v.canAssemble as boolean,
    canExtract: v.canExtract as boolean,
    formEditing: v.formEditing as boolean,
    canEditForms: v.canEditForms as boolean,
    redactToolsVisible: v.redactToolsVisible as boolean,
    markToolsVisible: v.markToolsVisible as boolean,
    hasRedactionMarks: v.hasRedactionMarks as boolean,
    contentEditing: v.contentEditing as boolean,
  };
}

// Neuer Dateiinhalt aus dem Renderer: Bytes, nicht leer, mit PDF-Kopf, höchstens 2 GB.
export function isPdfBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length > 0 && value.length < 2 ** 31 && looksLikePdf(value.subarray(0, 1024));
}

// Macht aus einem vorgeschlagenen Namen einen sicheren Dateinamen ohne Pfadanteile, mit Endung (Standard .pdf).
// Entfernt Trennzeichen und in Windows verbotene Zeichen, vermeidet reservierte Gerätenamen (CON, NUL, COM1 …).
export function sanitizeFileName(value: unknown, fallback = 'Dokument', extension = '.pdf'): string {
  const raw = typeof value === 'string' ? value : '';
  let base = raw
    .replace(new RegExp(`\\${extension}$`, 'i'), '')
    // eslint-disable-next-line no-control-regex -- Steuerzeichen sind in Dateinamen nicht erlaubt
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!base) base = fallback;
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(base)) base = `_${base}`;
  const max = MAX_FILE_NAME - extension.length;
  if (base.length > max) base = base.slice(0, max).trim();
  return `${base}${extension}`;
}

export function isPickKind(value: unknown): value is PickKind {
  return value === 'pdf' || value === 'images' || value === 'pdf-or-images';
}

// Liste neuer Dateien für „in Ordner speichern“: 1 bis MAX_NEW_FILES Einträge mit Namen und PDF-Bytes.
export function validateNamedPdfs(value: unknown): NamedBytes[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_NEW_FILES) return null;
  const result: NamedBytes[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { name, bytes } = entry as { name: unknown; bytes: unknown };
    if (typeof name !== 'string' || name.length > 1000 || !isPdfBytes(bytes)) return null;
    result.push({ name, bytes });
  }
  return result;
}

// Neue Unterschrift: PNG (Signatur geprüft), höchstens 2 MB, Maße 1 bis 4000 Pixel
export function isSignatureInput(value: unknown): value is SignatureInput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const png = v.png;
  const side = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_SIGNATURE_SIDE;
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return (
    (v.kind === 'drawn' || v.kind === 'typed' || v.kind === 'image') &&
    png instanceof Uint8Array &&
    png.length > 8 &&
    png.length <= MAX_SIGNATURE_BYTES &&
    pngSignature.every((b, i) => png[i] === b) &&
    side(v.width) &&
    side(v.height)
  );
}

export function validateAuthorName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null;
}

// Nur Web- und Mail-Links dürfen extern geöffnet werden. Links mit Benutzername oder Passwort im Host-Teil
// (z. B. https://bank.de@boese.example) werden abgelehnt, weil sie Nutzer über das wahre Ziel täuschen.
export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '') return false;
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

// Pfad, den der Renderer (Drag & Drop) liefert: nur absolute, lokale Pfade.
// Unter Windows keine UNC- oder Gerätepfade (\\server\freigabe, \\?\…), damit ein manipulierter Renderer
// keine Netzwerkzugriffe (und damit keine Anmeldedaten-Weitergabe) auslösen kann.
export function isSafeLocalPath(value: unknown, platform: string): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) return false;
  if (platform === 'win32') {
    if (value.startsWith('\\\\') || value.startsWith('//')) return false;
    return /^[a-zA-Z]:[\\/]/.test(value);
  }
  return value.startsWith('/');
}

// Ein PDF beginnt mit "%PDF-". Die Spezifikation erlaubt Müll davor, Leser suchen in den ersten 1024 Bytes.
export function looksLikePdf(head: Uint8Array): boolean {
  const marker = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  const limit = Math.min(head.length, 1024) - marker.length;
  for (let i = 0; i <= limit; i++) {
    let match = true;
    for (let j = 0; j < marker.length; j++) {
      if (head[i + j] !== marker[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

// Exportiertes Bild: PNG oder JPEG (am Inhalt erkannt), höchstens 1 GB
export function isImageBytes(value: unknown, kind: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length < 8 || value.length > 2 ** 30) return false;
  if (kind === 'png') return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => value[i] === b);
  if (kind === 'jpeg') return value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  return false;
}

// Exportierter Text: höchstens 256 Mio. Zeichen
export function isExportText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 * 1024 * 1024;
}

// Digitale ID (PKCS#12): DER-Struktur (beginnt mit SEQUENCE), höchstens 1 MB
export const MAX_ID_BYTES = 1024 * 1024;
export function isP12Bytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length >= 16 && value.length <= MAX_ID_BYTES && value[0] === 0x30;
}

// Tab, der in ein anderes Fenster wandert (ADR 0026): Bytes nur als PDF, Kennwörter begrenzt, Seite ganzzahlig
export function validateTabTransfer(value: unknown): TabTransfer | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const password = (x: unknown): x is string | null => x === null || (typeof x === 'string' && x.length <= 1024);
  if (v.bytes !== null && !isPdfBytes(v.bytes)) return null;
  if (!password(v.password) || !password(v.filePassword)) return null;
  if (!isNonNegativeInt(v.page) || v.page < 1 || v.page > 1_000_000) return null;
  return { bytes: v.bytes as Uint8Array | null, password: v.password, filePassword: v.filePassword, page: v.page };
}

export function validateTabDestination(value: unknown): TabDestination | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.kind === 'merge' || v.kind === 'new') return { kind: v.kind };
  return v.kind === 'point' && isCoordinate(v.x) && isCoordinate(v.y) ? { kind: 'point', x: v.x, y: v.y } : null;
}

const isCoordinate = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1_000_000;

function point(value: unknown): { x: number; y: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  return isCoordinate(v.x) && isCoordinate(v.y) ? { x: v.x, y: v.y } : null;
}

// Ziehen eines Tabs über die Fenstergrenze (ADR 0026)
export function validateTabDragMessage(value: unknown): TabDragMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.kind === 'end') return { kind: 'end' };
  if (v.kind === 'move') {
    const at = point(v);
    return at && typeof v.detached === 'boolean' ? { kind: 'move', ...at, detached: v.detached } : null;
  }
  if (v.kind !== 'start' || typeof v.title !== 'string' || v.title.length > 1024) return null;
  const tabOffset = point(v.tabOffset);
  const grip = point(v.grip);
  return tabOffset && grip ? { kind: 'start', title: v.title, tabOffset, grip } : null;
}

export function validateTabDragHoverState(value: unknown): TabDragHoverState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  return typeof v.overBar === 'boolean' && isNonNegativeInt(v.index) && v.index <= 10_000 ? { overBar: v.overBar, index: v.index } : null;
}
