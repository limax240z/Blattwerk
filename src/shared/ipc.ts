// IPC-Vertrag zwischen Hauptprozess, Preload und Renderer.
// Nur Typen und Konstanten, keine Node- oder DOM-Imports.
import type { CommandId } from './commands';

export const IPC = {
  // Renderer → Hauptprozess (invoke)
  openDialog: 'file:open-dialog',
  openDropped: 'file:open-dropped',
  readRange: 'file:read-range',
  closeFile: 'file:close',
  recentList: 'recent:list',
  recentOpen: 'recent:open',
  recentRemove: 'recent:remove',
  recentClear: 'recent:clear',
  appInfo: 'app:info',
  print: 'print:run',
  openExternal: 'shell:open-external',
  saveFile: 'file:save',
  saveFileAs: 'file:save-as',
  settingsGet: 'settings:get',
  settingsSetAuthor: 'settings:set-author',
  // Phase 3: Quelldateien wählen (PDFs, Bilder) und neue Dokumente speichern
  pickFiles: 'files:pick',
  registerDropped: 'files:register-dropped',
  saveNewFile: 'files:save-new',
  saveToFolder: 'files:save-to-folder',
  // Neues leeres Dokument (eine A4-Seite), sofort im Tab geöffnet
  newBlank: 'files:new-blank',
  // Schriften des Rechners für neuen Text (ADR 0024): Liste, Daten einer Schrift
  fontsList: 'fonts:list',
  fontsRead: 'fonts:read',
  // Updates ohne Internet (ADR 0025): Stand prüfen, bereitliegendes Update beim Beenden einspielen
  updateStatus: 'update:status',
  updateInstall: 'update:install',
  // Neue Version im Netz suchen und laden (ADR 0027)
  updateCheckOnline: 'update:check-online',
  // Phase 4: gespeicherte Unterschriften
  signaturesList: 'signatures:list',
  signaturesAdd: 'signatures:add',
  signaturesRemove: 'signatures:remove',
  // Phase 6: Export (Bilder in einen gewählten Ordner, Text in eine Datei)
  exportChooseFolder: 'export:choose-folder',
  exportWriteImage: 'export:write-image',
  exportEnd: 'export:end',
  exportSaveText: 'export:save-text',
  // Phase 7: digitale ID (.p12) wählen, zuletzt verwendete laden, neu erstellte speichern
  signingPickId: 'signing:pick-id',
  signingLastId: 'signing:last-id',
  signingSaveId: 'signing:save-id',
  // Textdokumente (Word, OpenDocument, RTF, Text, Markdown) in PDF umwandeln: wählen bzw. abgelegt
  convertPick: 'convert:pick',
  convertDropped: 'convert:dropped',
  // Mehrere Fenster (ADR 0026): Tab in ein anderes oder neues Fenster geben
  tabTransfer: 'window:tab-transfer',
  // Startseite (ADR 0028): Anheften, Vorlagen, Vorschaubilder
  recentPin: 'recent:pin',
  templatesList: 'templates:list',
  templatesOpen: 'templates:open',
  templatesPreview: 'templates:preview',
  templatesSave: 'templates:save',
  templatesRemove: 'templates:remove',
  thumbnailsGet: 'thumbnails:get',
  thumbnailsSetFile: 'thumbnails:set-file',
  thumbnailsSetTemplate: 'thumbnails:set-template',
  // Seiten aus einem anderen Fenster ziehen: das Zielfenster holt sie über den Hauptprozess beim Quellfenster ab
  pagesFetch: 'pages:fetch',
  // Renderer → Hauptprozess (send)
  pagesProvided: 'pages:provided',
  // Glasflächen für Apples Liquid Glass unter macOS 26+ (ADR 0023)
  glassRegions: 'glass:regions',
  menuState: 'app:menu-state',
  rendererReady: 'app:renderer-ready',
  closeConfirmed: 'app:close-confirmed',
  closeCancelled: 'app:close-cancelled',
  // Fenster ohne Tabs schließen (nachdem sein letzter Tab in ein anderes Fenster gewandert ist)
  closeWindow: 'window:close',
  // Tab wird über die Fenstergrenze gezogen (Vorschau am Zeiger) bzw. das Zielfenster meldet seine Einfügestelle
  tabDrag: 'window:tab-drag',
  tabDragHoverState: 'window:tab-drag-hover-state',
  // Hauptprozess → Renderer
  fileOpened: 'file:opened',
  menuCommand: 'menu:command',
  recentChanged: 'recent:changed',
  requestClose: 'app:request-close',
  // Tab aus einem anderen Fenster übernehmen bzw. alle Tabs an das vordere Fenster abgeben
  tabReceived: 'window:tab-received',
  mergeRequest: 'window:merge-request',
  // Ein Tab aus einem anderen Fenster schwebt über diesem Fenster (null: nicht mehr)
  tabDragHover: 'window:tab-drag-hover',
  // Laden einer neuen Version: Fortschritt und Ergebnis (auch bei der Suche beim Start)
  updateProgress: 'update:progress',
  updateResult: 'update:result',
  // Eigene Vorlagen wurden in einem Fenster gesichert oder entfernt
  templatesChanged: 'templates:changed',
  // Ein anderes Fenster will gezogene Seiten (Kennung des Ziehens); der Besitzer antwortet mit pagesProvided
  pagesProvideRequest: 'pages:provide-request',
} as const;

// Vorschaubilder der Startseite: zuletzt geöffnete Dateien (nach Pfad) und Vorlagen (nach Kennung), als data:-Adresse
export interface ThumbnailRequest {
  recent: string[];
  templates: string[];
}
export interface ThumbnailResult {
  recent: Record<string, string | null>;
  templates: Record<string, string | null>;
}

export type FileKind = 'pdf' | 'jpeg' | 'png';

export interface FileInfo {
  fileId: string;
  name: string;
  dir: string;
  size: number;
  // Art der Datei (nur Quelldateien zum Einfügen und Zusammenführen können Bilder sein)
  kind?: FileKind;
  // Neues leeres Dokument ohne festen Ort: „Sichern“ fragt nach Ort und Namen
  untitled?: boolean;
}

// Welche Dateien ein Auswahldialog anbietet
export type PickKind = 'pdf' | 'images' | 'pdf-or-images';

export interface PickResult {
  files: FileInfo[];
  // Namen gewählter Dateien, die weder PDF noch JPEG/PNG sind oder sich nicht lesen ließen
  rejected: string[];
}

// target-open: Die gewählte Zieldatei ist gerade in einem Tab geöffnet und darf so nicht ersetzt werden.
export type SaveNewErrorCode = 'cancelled' | 'write-failed' | 'invalid-data' | 'target-open';

// Neues Dokument gespeichert; open ist das Ergebnis des anschließenden Öffnens im Tab (falls gewünscht)
export type SaveNewResult =
  | { ok: true; name: string; open: OpenResult | null }
  | { ok: false; error: SaveNewErrorCode; detail?: string };

// Umwandeln eines Textdokuments: Fehler beim Lesen bzw. Umwandeln, sonst wie beim Speichern eines neuen Dokuments
export type ConvertErrorCode = 'unsupported' | 'legacy-doc' | 'pages' | 'invalid' | 'too-large' | 'unreadable' | 'failed';
export type ConvertResult = SaveNewResult | { ok: false; error: ConvertErrorCode; detail?: string };

export interface NamedBytes {
  name: string;
  bytes: Uint8Array;
}

export type SaveToFolderResult =
  | { ok: true; folder: string; names: string[] }
  | { ok: false; error: SaveNewErrorCode; detail?: string };

export type SignatureKind = 'drawn' | 'typed' | 'image';

// Neue Unterschrift aus dem Renderer: PNG-Bytes mit Maßen
export interface SignatureInput {
  kind: SignatureKind;
  png: Uint8Array;
  width: number;
  height: number;
}

// Gespeicherte Unterschrift (PNG als Base64)
export interface SavedSignature {
  id: string;
  kind: SignatureKind;
  png: string;
  width: number;
  height: number;
  created: number;
}

export const MAX_SIGNATURES = 20;
export const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;
export const MAX_SIGNATURE_SIDE = 4000;

// Obergrenzen für neue Dokumente über IPC
export const MAX_NEW_FILES = 1000;
export const MAX_FILE_NAME = 150;

// elsewhere: Die Datei öffnet sich in einem anderen Fenster (neues Fenster oder dort schon offen); kein Fehler.
export type OpenErrorCode = 'not-found' | 'not-a-file' | 'not-pdf' | 'unreadable' | 'cancelled' | 'elsewhere';

export type OpenResult =
  | { ok: true; file: FileInfo }
  | { ok: false; error: OpenErrorCode; name?: string };

// Stand eines Tabs, der in ein anderes Fenster wandert (ADR 0026). bytes: ungespeicherter Stand (Kommentare,
// Formularwerte und Dokumentänderungen eingearbeitet); null = die Datei unverändert.
export interface TabTransfer {
  bytes: Uint8Array | null;
  // Kennwort des übergebenen Stands bzw. der Datei (Kennwortschutz kann beide unterscheiden)
  password: string | null;
  filePassword: string | null;
  page: number;
}

// Ziel: Bildschirmpunkt, an dem der Tab losgelassen wurde, ein neues Fenster (Menü) oder „Alle Fenster zusammenführen“
export type TabDestination = { kind: 'point'; x: number; y: number } | { kind: 'new' } | { kind: 'merge' };

export type TabTransferResult = { ok: true } | { ok: false; error: 'nothing-to-do' | 'unknown-file' | 'invalid-data' };

// Übernommener Tab im Zielfenster
export interface TabReceived {
  file: FileInfo;
  transfer: TabTransfer;
  // Stelle in der Tableiste (Tab auf die Leiste gezogen); sonst ans Ende
  index?: number;
}

// Ziehen eines Tabs über die Fenstergrenze (ADR 0026). Der Renderer meldet Beginn, Zeigerbewegungen (Bildschirmpunkt;
// detached: außerhalb der eigenen Tableiste) und das Ende ohne Übergabe. Der Hauptprozess zeigt dazu eine Vorschau am
// Zeiger und meldet dem Fenster darunter den schwebenden Tab.
export type TabDragMessage =
  | {
      kind: 'start';
      title: string;
      // Zeiger relativ zum Tab und zum Fenster (für die Vorschau und die Lage eines neuen Fensters)
      tabOffset: { x: number; y: number };
      grip: { x: number; y: number };
    }
  | { kind: 'move'; x: number; y: number; detached: boolean }
  | { kind: 'end' };

// Schwebender Tab über diesem Fenster, Zeiger in Fensterkoordinaten
export interface TabDragHover {
  x: number;
  y: number;
  title: string;
}

// Antwort des Fensters unter dem Zeiger: Zeiger über der Tableiste und Stelle, an der der Tab landen würde
export interface TabDragHoverState {
  overBar: boolean;
  index: number;
}

export interface RecentFile {
  path: string;
  name: string;
  dir: string;
  openedAt: number;
  // Oben in der Liste festgehalten (Startseite „Anheften“)
  pinned?: boolean;
}

export type ViewMode = 'single' | 'continuous' | 'two-page' | 'two-page-continuous';

export interface MenuState {
  hasDocument: boolean;
  canPrint: boolean;
  viewMode: ViewMode | null;
  sidebarVisible: boolean;
  rightPanelVisible: boolean;
  tabCount: number;
  // Tabs mit ungespeicherten Änderungen (für Schließen-Rückfrage und den Punkt im Schließen-Knopf)
  dirtyCount: number;
  canUndo: boolean;
  canRedo: boolean;
  activeDirty: boolean;
  commentToolsVisible: boolean;
  // Phase 3: Raster „Seiten organisieren“ aktiv, Seiten zusammenstellen bzw. extrahieren erlaubt
  organizeMode: boolean;
  canAssemble: boolean;
  canExtract: boolean;
  // Phase 4: Modus „Formular bearbeiten“ aktiv bzw. möglich (nicht in verschlüsselten Dokumenten)
  formEditing: boolean;
  canEditForms: boolean;
  // Phase 5: Leiste „Schwärzen“ offen, Markierungen zum Anwenden vorhanden
  redactToolsVisible: boolean;
  hasRedactionMarks: boolean;
  contentEditing: boolean;
  // Leiste „Markieren“ offen
  markToolsVisible: boolean;
}

export type SaveErrorCode = 'changed-externally' | 'cancelled' | 'write-failed' | 'unknown-file' | 'invalid-data';

export type SaveResult = { ok: true; file: FileInfo } | { ok: false; error: SaveErrorCode; detail?: string };

export interface AppSettings {
  authorName: string;
}

export interface AppInfo {
  platform: 'darwin' | 'win32' | 'linux' | 'ios';
  version: string;
  productName: string;
  e2e: boolean;
  // Apples Liquid Glass liegt unter dem Fenster (macOS 26+, native Erweiterung geladen)
  nativeGlass: boolean;
}

// Eine Glasfläche in Fensterkoordinaten (Punkte, oben links); tint = [r, g, b, Deckkraft 0–1]
export interface GlassRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  tint: [number, number, number, number];
  style: 'regular' | 'clear';
  // Größenänderung mit dem Fenster: band (oben, volle Breite), left, right (volle Höhe), fill (ganz)
  anchor: 'band' | 'left' | 'right' | 'fill';
}

export interface PrintRequest {
  // Name des Dokuments für die Druckwarteschlange
  documentName: string;
}

export type PrintResult = { ok: true } | { ok: false; reason: 'cancelled' | 'failed'; detail?: string };

export type DefaultAppResult = 'opened-settings' | 'show-instructions' | 'already-default';

export interface MenuCommandMessage {
  command: CommandId;
}

// Obergrenze für einen einzelnen Lesezugriff über IPC. Größere Bereiche teilt der Renderer auf.
export const MAX_READ_CHUNK = 16 * 1024 * 1024;

// Phase 6: Export
export type ExportImageKind = 'png' | 'jpeg';

// Gewählter Ordner für einen Export; token gilt nur für diesen Export und dieses Fenster
export type ExportFolderResult = { ok: true; token: string; folder: string } | { ok: false; error: 'cancelled' };

export type ExportWriteResult = { ok: true; name: string } | { ok: false; error: 'invalid-data' | 'unknown-folder' | 'write-failed'; detail?: string };

export type ExportTextResult = { ok: true; name: string } | { ok: false; error: SaveNewErrorCode; detail?: string };

// Phase 7: digitale ID (PKCS#12)
export type IdFileResult = { ok: true; name: string; bytes: Uint8Array } | { ok: false; error: 'cancelled' | 'unreadable' | 'invalid' };
export type SaveIdResult = { ok: true; name: string } | { ok: false; error: SaveNewErrorCode; detail?: string };

// Gezogene Seiten zwischen Fenstern: Kennung des Ziehens (zufällig, nur im Quellfenster bekannt)
export const PAGE_DRAG_TOKEN = /^[a-z0-9]{16,64}$/;
export interface PagesProvideRequest {
  requestId: number;
  token: string;
}
