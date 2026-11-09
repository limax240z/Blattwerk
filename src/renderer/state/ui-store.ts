import { create } from 'zustand';
import type { AppSettings, FileKind, RecentFile } from '../../shared/ipc';
import type { ImageInfo } from '../../shared/image-info';

// Gelesene Quelldatei zum Einfügen oder Zusammenführen (Bytes im Speicher, Kennwort bereits geprüft)
export interface SourceFile {
  name: string;
  kind: FileKind;
  bytes: Uint8Array;
  password: string | null;
  pageCount: number;
  image: ImageInfo | null;
  // Seitenauswahl im Dialog „Dateien zusammenführen“, wie eingegeben (leer = alle Seiten)
  selection?: string;
}

// Offener Dialog für Seitenoperationen (Seiten 0-basiert)
export type PageDialog =
  | { kind: 'delete'; tabId: string; pages: number[] }
  | { kind: 'insertBlank'; tabId: string; after: number }
  | { kind: 'insertFiles'; tabId: string; after: number; sources: SourceFile[] }
  | { kind: 'extract'; tabId: string; pages: number[] }
  | { kind: 'split'; tabId: string }
  | { kind: 'replace'; tabId: string; pages: number[]; source: SourceFile }
  | { kind: 'crop'; tabId: string; pages: number[] };

export interface PasswordRequest {
  name: string;
  incorrect: boolean;
  resolve: (password: string | null) => void;
}

export interface Notice {
  id: number;
  message: string;
  detail?: string;
  // Fehler (Standard) oder Bestätigung, dass etwas geklappt hat
  tone: 'error' | 'success';
}

export interface PrintProgress {
  tabId: string;
  current: number;
  total: number;
}

interface UiState {
  sidebarVisible: boolean;
  // Lesemodus (features/read-mode): nur das Dokument, keine Änderungen
  readMode: boolean;
  rightPanelVisible: boolean;
  propertiesTabId: string | null;
  goToPageOpen: boolean;
  print: PrintProgress | null;
  notices: Notice[];
  recent: RecentFile[];
  draggingFiles: boolean;
  // Zähler, damit die Suche den Fokus bekommt, auch wenn der Bereich schon offen ist.
  // searchFocusHandled merkt sich die zuletzt erfüllte Anforderung, damit ein Tab-Wechsel nicht erneut fokussiert.
  searchFocusRequest: number;
  searchFocusHandled: number;
  // Name für neue Kommentare (aus den Einstellungen)
  authorName: string;
  // Lesemodus mit Vollbild (aus den Einstellungen)
  readModeFullscreen: boolean;
  commentToolsVisible: boolean;
  // Leiste „Schwärzen“ (Phase 5) und ihre Dialoge
  redactToolsVisible: boolean;
  // Leiste „Markieren“ (Text hervorheben, unterstreichen, durchstreichen)
  markToolsVisible: boolean;
  redactDialog: 'apply' | 'find' | null;
  // Wasserzeichen, Kopf- und Fußzeile, Seitenzahlen (Phase 5)
  stampDialog: 'watermark' | 'headerFooter' | 'pageNumbers' | null;
  // Kennwortschutz (Phase 6)
  securityDialogOpen: boolean;
  // Export als Bilder (Phase 6)
  exportImagesOpen: boolean;
  // Komprimieren (Phase 6)
  compressOpen: boolean;
  cleanOpen: boolean;
  // Texterkennung (Phase 6)
  ocrOpen: boolean;
  settingsOpen: boolean;
  // Offene Rückfrage (ungespeicherte Änderungen, von außen geänderte Datei)
  prompt: Prompt | null;
  pageDialog: PageDialog | null;
  // Dialog „Dateien zusammenführen“ mit den bisher gewählten Dateien
  combine: SourceFile[] | null;
  passwordRequest: PasswordRequest | null;
  // Lang laufende Aufgabe ohne Tab (Zusammenführen, Extrahieren …): Übersetzungsschlüssel der Meldung
  busy: string | null;
  // Dateien werden gerade über das Seitenraster gezogen (dort einfügen statt als Tab öffnen)
  fileDropInsert: boolean;
  // Dialog für Unterschriften: Auswahl gespeicherter oder neue anlegen
  signatureDialog: 'choose' | 'create' | null;
  setSidebarVisible: (visible: boolean) => void;
  setReadMode: (on: boolean) => void;
  setRightPanelVisible: (visible: boolean) => void;
  openProperties: (tabId: string | null) => void;
  setGoToPageOpen: (open: boolean) => void;
  setPrint: (progress: PrintProgress | null) => void;
  notify: (message: string, detail?: string) => void;
  // Bestätigung (z. B. „2 Stellen geschwärzt“), nicht als Fehler dargestellt
  confirm: (message: string) => void;
  dismissNotice: (id: number) => void;
  setRecent: (recent: RecentFile[]) => void;
  // Startseite über den offenen Dokumenten (Home-Knopf, ADR 0028)
  homeOpen: boolean;
  setHomeOpen: (open: boolean) => void;
  // „Als Vorlage sichern“: Dialog für diesen Tab
  templateDialogTab: string | null;
  // Tab, dessen Datei gerade umbenannt wird (Dialog „Umbenennen“)
  renameTab: string | null;
  setRenameTab: (tabId: string | null) => void;
  setTemplateDialogTab: (tabId: string | null) => void;
  setDraggingFiles: (dragging: boolean) => void;
  requestSearchFocus: () => void;
  markSearchFocusHandled: (request: number) => void;
  setAuthorName: (name: string) => void;
  applySettings: (settings: AppSettings) => void;
  setCommentToolsVisible: (visible: boolean) => void;
  setRedactToolsVisible: (visible: boolean) => void;
  setMarkToolsVisible: (visible: boolean) => void;
  setRedactDialog: (dialog: 'apply' | 'find' | null) => void;
  setStampDialog: (dialog: 'watermark' | 'headerFooter' | 'pageNumbers' | null) => void;
  setSecurityDialogOpen: (open: boolean) => void;
  setExportImagesOpen: (open: boolean) => void;
  setCompressOpen: (open: boolean) => void;
  setCleanOpen: (open: boolean) => void;
  setOcrOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setPrompt: (prompt: Prompt | null) => void;
  setPageDialog: (dialog: PageDialog | null) => void;
  setCombine: (files: SourceFile[] | null) => void;
  setPasswordRequest: (request: PasswordRequest | null) => void;
  setBusy: (busy: string | null) => void;
  setFileDropInsert: (value: boolean) => void;
  setSignatureDialog: (dialog: 'choose' | 'create' | null) => void;
}

export type PromptAnswer = 'save' | 'discard' | 'cancel' | 'overwrite' | 'saveAs';

export interface Prompt {
  kind: 'unsaved' | 'changed-externally';
  tabId: string;
  name: string;
  resolve: (answer: PromptAnswer) => void;
}

let nextNoticeId = 1;

export const useUi = create<UiState>((set) => ({
  sidebarVisible: true,
  readMode: false,
  rightPanelVisible: false,
  propertiesTabId: null,
  goToPageOpen: false,
  print: null,
  notices: [],
  recent: [],
  homeOpen: false,
  templateDialogTab: null,
  renameTab: null,
  draggingFiles: false,
  searchFocusRequest: 0,
  searchFocusHandled: 0,
  authorName: '',
  readModeFullscreen: true,
  commentToolsVisible: false,
  markToolsVisible: false,
  redactToolsVisible: false,
  redactDialog: null,
  stampDialog: null,
  securityDialogOpen: false,
  exportImagesOpen: false,
  compressOpen: false,
  cleanOpen: false,
  ocrOpen: false,
  settingsOpen: false,
  prompt: null,
  pageDialog: null,
  combine: null,
  passwordRequest: null,
  busy: null,
  fileDropInsert: false,
  signatureDialog: null,
  setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
  setReadMode: (readMode) => set({ readMode }),
  setRightPanelVisible: (rightPanelVisible) => set({ rightPanelVisible }),
  openProperties: (propertiesTabId) => set({ propertiesTabId }),
  setGoToPageOpen: (goToPageOpen) => set({ goToPageOpen }),
  setPrint: (print) => set({ print }),
  notify: (message, detail) =>
    set((state) => ({ notices: [...state.notices, { id: nextNoticeId++, message, detail, tone: 'error' as const }].slice(-5) })),
  confirm: (message) =>
    set((state) => ({ notices: [...state.notices, { id: nextNoticeId++, message, tone: 'success' as const }].slice(-5) })),
  dismissNotice: (id) => set((state) => ({ notices: state.notices.filter((n) => n.id !== id) })),
  setRecent: (recent) => set({ recent }),
  setHomeOpen: (homeOpen) => set({ homeOpen }),
  setTemplateDialogTab: (templateDialogTab) => set({ templateDialogTab }),
  setRenameTab: (renameTab) => set({ renameTab }),
  setDraggingFiles: (draggingFiles) => set({ draggingFiles }),
  requestSearchFocus: () =>
    set((state) => ({ rightPanelVisible: true, searchFocusRequest: state.searchFocusRequest + 1 })),
  markSearchFocusHandled: (request) => set({ searchFocusHandled: request }),
  setAuthorName: (authorName) => set({ authorName }),
  applySettings: ({ authorName, readModeFullscreen }) => set({ authorName, readModeFullscreen }),
  // Kommentieren und Schwärzen nutzen dieselbe Ebene; es ist immer nur eine der beiden Leisten offen.
  // Höchstens eine der Leisten „Kommentieren“, „Schwärzen“ und „Markieren“ ist offen
  setCommentToolsVisible: (commentToolsVisible) =>
    set((state) => (commentToolsVisible ? { commentToolsVisible, redactToolsVisible: false, markToolsVisible: false } : { ...state, commentToolsVisible })),
  setRedactToolsVisible: (redactToolsVisible) =>
    set((state) => (redactToolsVisible ? { redactToolsVisible, commentToolsVisible: false, markToolsVisible: false } : { ...state, redactToolsVisible })),
  setMarkToolsVisible: (markToolsVisible) =>
    set((state) => (markToolsVisible ? { markToolsVisible, commentToolsVisible: false, redactToolsVisible: false } : { ...state, markToolsVisible })),
  setRedactDialog: (redactDialog) => set({ redactDialog }),
  setStampDialog: (stampDialog) => set({ stampDialog }),
  setSecurityDialogOpen: (securityDialogOpen) => set({ securityDialogOpen }),
  setExportImagesOpen: (exportImagesOpen) => set({ exportImagesOpen }),
  setCompressOpen: (compressOpen) => set({ compressOpen }),
  setCleanOpen: (cleanOpen) => set({ cleanOpen }),
  setOcrOpen: (ocrOpen) => set({ ocrOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPrompt: (prompt) => set({ prompt }),
  setPageDialog: (pageDialog) => set({ pageDialog }),
  setCombine: (combine) => set({ combine }),
  setPasswordRequest: (passwordRequest) => set({ passwordRequest }),
  setBusy: (busy) => set({ busy }),
  setFileDropInsert: (fileDropInsert) => set({ fileDropInsert }),
  setSignatureDialog: (signatureDialog) => set({ signatureDialog }),
}));
