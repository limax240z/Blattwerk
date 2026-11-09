// Typen der Schnittstelle, die der Preload dem Renderer als window.blattwerk bereitstellt.
import type { CommandId } from '../shared/commands';
import type { SystemFont } from '../shared/fonts';
import type { OnlineCheck, UpdateProgress, UpdateStatus } from '../shared/update';
import type { SaveTemplateResult, TemplateInfo } from '../shared/templates';
import type {
  ConvertResult,
  GlassRegion,
  AppInfo,
  AppSettings,
  ExportFolderResult,
  ExportImageKind,
  ExportTextResult,
  ExportWriteResult,
  IdFileResult,
  SaveIdResult,
  MenuState,
  NamedBytes,
  OpenResult,
  PickKind,
  PickResult,
  PrintRequest,
  PrintResult,
  RecentFile,
  SaveNewResult,
  SaveResult,
  RenameResult,
  RenamedInfo,
  SaveToFolderResult,
  SavedSignature,
  SignatureInput,
  TabDestination,
  TabDragHover,
  PagesProvideRequest,
  ThumbnailRequest,
  ThumbnailResult,
  TabDragHoverState,
  TabDragMessage,
  TabReceived,
  TabTransfer,
  TabTransferResult,
} from '../shared/ipc';

export interface BlattwerkApi {
  getAppInfo(): Promise<AppInfo>;
  openFileDialog(): Promise<OpenResult[]>;
  // Für Drag & Drop: Der Preload ermittelt den Pfad der Datei, der Renderer sieht ihn nie.
  openDroppedFile(file: File): Promise<OpenResult>;
  readRange(fileId: string, begin: number, end: number): Promise<Uint8Array>;
  closeFile(fileId: string): Promise<void>;
  recent: {
    list(): Promise<RecentFile[]>;
    open(path: string): Promise<OpenResult>;
    remove(path: string): Promise<RecentFile[]>;
    clear(): Promise<RecentFile[]>;
    pin(path: string, pinned: boolean): Promise<RecentFile[]>;
  };
  // Vorlagen der Startseite (ADR 0028)
  templates: {
    list(): Promise<TemplateInfo[]>;
    // Öffnet eine Kopie als unbenanntes Dokument
    open(id: string): Promise<OpenResult>;
    // PDF der Vorlage, um ein Vorschaubild zu zeichnen
    preview(id: string): Promise<Uint8Array | null>;
    save(bytes: Uint8Array, name: string): Promise<SaveTemplateResult>;
    remove(id: string): Promise<TemplateInfo[]>;
    onChanged(listener: () => void): () => void;
  };
  // Vorschaubilder der Startseite (PNG): gespeicherte abfragen, für eine offene Datei oder eine Vorlage ablegen
  thumbnails: {
    get(request: ThumbnailRequest): Promise<ThumbnailResult>;
    setFile(fileId: string, png: Uint8Array): Promise<boolean>;
    setTemplate(id: string, png: Uint8Array): Promise<boolean>;
  };
  print(request: PrintRequest): Promise<PrintResult>;
  // Speichert neue Bytes über die geöffnete Datei. force überschreibt auch bei Änderungen von außen.
  saveFile(fileId: string, bytes: Uint8Array, force?: boolean): Promise<SaveResult>;
  saveFileAs(fileId: string, bytes: Uint8Array): Promise<SaveResult>;
  // Dokument im selben Ordner umbenennen
  renameFile(fileId: string, name: string): Promise<RenameResult>;
  // Quelldateien (PDFs, Bilder) wählen bzw. per Drag & Drop anmelden; gelesen wird danach über readRange.
  pickFiles(kind: PickKind): Promise<PickResult>;
  registerDroppedFile(file: File): Promise<OpenResult>;
  // Neues leeres Dokument (eine A4-Seite, unbenannt) anlegen und öffnen
  newBlankDocument(): Promise<OpenResult>;
  // Updates ohne Internet: Stand prüfen, „Jetzt aktualisieren“ (schließt die App, tauscht sie aus, öffnet sie neu)
  update: {
    status(): Promise<UpdateStatus>;
    install(): Promise<boolean>;
    // Neue Version im Netz suchen und in den Update-Ordner laden (ADR 0027)
    checkOnline(): Promise<OnlineCheck>;
    onProgress(listener: (progress: UpdateProgress) => void): () => void;
    onResult(listener: (result: OnlineCheck) => void): () => void;
  };
  // Schriften des Rechners (Aptos, Arial, Times New Roman …), nur einbettbare
  fonts: {
    list(): Promise<SystemFont[]>;
    read(key: string): Promise<Uint8Array | null>;
  };
  // Neues Dokument über den Sichern-Dialog speichern, auf Wunsch danach im Tab öffnen
  saveNewFile(bytes: Uint8Array, suggestedName: string, referenceFileId: string | null, openAfter: boolean): Promise<SaveNewResult>;
  saveFilesToFolder(files: NamedBytes[], referenceFileId: string | null): Promise<SaveToFolderResult>;
  // Export als Bilder (Phase 6): Ordner wählen, Seite für Seite schreiben, beenden
  exportImages: {
    chooseFolder(referenceFileId: string | null): Promise<ExportFolderResult>;
    write(token: string, name: string, kind: ExportImageKind, bytes: Uint8Array): Promise<ExportWriteResult>;
    end(token: string): Promise<void>;
  };
  // Export als Text über den Sichern-Dialog (UTF-8)
  exportText(text: string, suggestedName: string, referenceFileId: string | null): Promise<ExportTextResult>;
  // Textdokument wählen bzw. abgelegtes umwandeln, als PDF speichern und öffnen
  convertDocument: {
    pick(): Promise<ConvertResult>;
    dropped(file: File): Promise<ConvertResult>;
  };
  // Digitale ID (Phase 7): wählen, zuletzt verwendete laden, neu erstellte speichern
  digitalId: {
    pick(): Promise<IdFileResult>;
    last(): Promise<IdFileResult>;
    save(bytes: Uint8Array, suggestedName: string): Promise<SaveIdResult>;
  };
  signatures: {
    list(): Promise<SavedSignature[]>;
    add(input: SignatureInput): Promise<SavedSignature[]>;
    remove(id: string): Promise<SavedSignature[]>;
  };
  getSettings(): Promise<AppSettings>;
  setAuthorName(name: string): Promise<AppSettings>;
  setReadModeFullscreen(on: boolean): Promise<AppSettings>;
  confirmClose(): void;
  cancelClose(): void;
  onRequestClose(listener: () => void): () => void;
  // Mehrere Fenster (ADR 0026): Tab in ein anderes oder neues Fenster geben, Tab übernehmen, alle Tabs abgeben
  transferTab(fileId: string, transfer: TabTransfer, destination: TabDestination): Promise<TabTransferResult>;
  onTabReceived(listener: (message: TabReceived) => void): () => void;
  onMergeRequest(listener: () => void): () => void;
  // Tab über die Fenstergrenze ziehen: Vorschau am Zeiger, schwebender Tab über einem anderen Fenster
  tabDrag(message: TabDragMessage): void;
  onTabDragHover(listener: (hover: TabDragHover | null) => void): () => void;
  // Seiten aus einem anderen Fenster ziehen: abholen (null: Quelle nicht mehr da) bzw. auf Anfrage liefern
  fetchDraggedPages(token: string): Promise<Uint8Array | null>;
  onProvidePages(listener: (request: PagesProvideRequest) => void): () => void;
  providePages(requestId: number, bytes: Uint8Array | null): void;
  setTabDragHoverState(state: TabDragHoverState): void;
  // Fenster schließen, nachdem sein letzter Tab weitergegeben wurde
  closeWindow(): void;
  // Vollbild ein oder aus; liefert, ob das Fenster vorher schon im Vollbild war
  setFullscreen(on: boolean): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  setMenuState(state: MenuState): void;
  // Glasflächen für Apples Liquid Glass (nur wirksam, wenn appInfo().nativeGlass)
  setGlassRegions(regions: GlassRegion[]): void;
  signalReady(): void;
  onFileOpened(listener: (result: OpenResult) => void): () => void;
  // Ein geöffnetes Dokument wurde umbenannt oder verschoben (auch im Finder)
  onFileRenamed(listener: (renamed: RenamedInfo) => void): () => void;
  onMenuCommand(listener: (command: CommandId) => void): () => void;
  onRecentChanged(listener: () => void): () => void;
}
