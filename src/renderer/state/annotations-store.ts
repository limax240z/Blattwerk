import { create } from 'zustand';
import type { Annotation, Rgb, StampId } from '../../shared/annotations';
import type { EraserMode, EraserSize } from '../../shared/eraser';

export type Tool =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'note'
  | 'freetext'
  | 'ink'
  | 'square'
  | 'circle'
  | 'line'
  | 'arrow'
  | 'stamp'
  | 'signature'
  // Schwärzen (Phase 5): Bereich aufziehen bzw. markierten Text schwärzen
  | 'redact'
  | 'redactText'
  // Radierer für Freihandzeichnungen (Art und Größe: eraser im Zustand)
  | 'eraser';

// Unterschrift, die beim nächsten Klick auf die Seite gesetzt wird (PNG als Base64)
// Eigener Stempel (Werkzeug „Stempel“ mit stamp = 'custom'): Text, auf Wunsch Datum und Name in Zeile zwei
export interface CustomStamp {
  text: string;
  date: boolean;
  name: boolean;
  color: 'green' | 'red' | 'blue';
}

export const CUSTOM_STAMP_COLORS: Record<CustomStamp['color'], Rgb> = {
  green: { r: 0.13, g: 0.55, b: 0.13 },
  red: { r: 0.8, g: 0.1, b: 0.1 },
  blue: { r: 0.15, g: 0.3, b: 0.75 },
};

export interface PendingSignature {
  image: string;
  width: number;
  height: number;
}

export const MARKUP_TOOLS: readonly Tool[] = ['highlight', 'underline', 'strikeout', 'squiggly', 'redactText'];
export const DRAWING_TOOLS: readonly Tool[] = ['note', 'freetext', 'ink', 'square', 'circle', 'line', 'arrow', 'stamp', 'signature', 'redact', 'eraser'];
// Werkzeuge der Leiste „Schwärzen“
export const REDACT_TOOLS: readonly Tool[] = ['redact', 'redactText'];

// Änderungen am Kommentarbestand. Jede ist umkehrbar (Rückgängig/Wiederholen).
export type Command =
  | { type: 'add'; annotation: Annotation }
  // Mehrere auf einmal (Suchen und schwärzen): ein Schritt für Rückgängig
  | { type: 'addMany'; annotations: Annotation[] }
  | { type: 'remove'; annotation: Annotation; index: number }
  | { type: 'update'; before: Annotation; after: Annotation }
  // Mehrere Änderungen als ein Schritt (ein Wisch mit dem Radierer)
  | { type: 'batch'; commands: Command[] };

export interface TabAnnotations {
  // true, sobald alle Seiten eingelesen sind
  loaded: boolean;
  items: Annotation[];
  // Stand der vorhandenen Anmerkungen beim Laden (zum Vergleich beim Speichern), Schlüssel = id = ref
  originals: Record<string, Annotation>;
  undo: Command[];
  redo: Command[];
  // Länge des Rückgängig-Stapels beim letzten Speichern; -1 = Stand nicht mehr erreichbar
  savedCursor: number;
  selectedId: string | null;
  editingId: string | null;
}

const EMPTY: TabAnnotations = {
  loaded: false,
  items: [],
  originals: {},
  undo: [],
  redo: [],
  savedCursor: 0,
  selectedId: null,
  editingId: null,
};

export const DEFAULT_COLORS: Record<Tool, Rgb> = {
  select: { r: 0, g: 0, b: 0 },
  highlight: { r: 1, g: 0.86, b: 0.2 },
  underline: { r: 0.18, g: 0.44, b: 0.87 },
  strikeout: { r: 0.85, g: 0.11, b: 0.11 },
  squiggly: { r: 0.85, g: 0.11, b: 0.11 },
  note: { r: 1, g: 0.82, b: 0.2 },
  freetext: { r: 0, g: 0, b: 0 },
  ink: { r: 0.18, g: 0.44, b: 0.87 },
  square: { r: 0.85, g: 0.11, b: 0.11 },
  circle: { r: 0.85, g: 0.11, b: 0.11 },
  line: { r: 0.85, g: 0.11, b: 0.11 },
  arrow: { r: 0.85, g: 0.11, b: 0.11 },
  stamp: { r: 0.13, g: 0.55, b: 0.13 },
  signature: { r: 0, g: 0, b: 0 },
  redact: { r: 0.85, g: 0.11, b: 0.11 },
  redactText: { r: 0.85, g: 0.11, b: 0.11 },
  eraser: { r: 0, g: 0, b: 0 },
};

interface AnnotationsState {
  tabs: Record<string, TabAnnotations>;
  tool: Tool;
  colors: Record<Tool, Rgb>;
  width: number;
  fontSize: number;
  // Deckkraft neuer Kommentare (0–1) und Füllfarbe neuer Rechtecke und Ellipsen (null = keine)
  opacity: number;
  fill: Rgb | null;
  stamp: StampId;
  customStamp: CustomStamp;
  pendingSignature: PendingSignature | null;
  eraser: { mode: EraserMode; size: EraserSize };
  snapShapes: boolean;
  init: (tabId: string) => void;
  // Gesicherten Zustand eines Dokumentstands wiederherstellen (Rückgängig/Wiederholen von Seitenoperationen)
  restore: (tabId: string, tab: TabAnnotations) => void;
  drop: (tabId: string) => void;
  addLoaded: (tabId: string, items: Annotation[], done: boolean) => void;
  apply: (tabId: string, command: Command) => void;
  // Nimmt das Anlegen eines Kommentars zurück, ohne es wiederholbar zu machen (leeres Textfeld verworfen).
  discard: (tabId: string, id: string) => void;
  undo: (tabId: string) => void;
  redo: (tabId: string) => void;
  markSaved: (tabId: string) => void;
  select: (tabId: string, id: string | null) => void;
  setEditing: (tabId: string, id: string | null) => void;
  setTool: (tool: Tool) => void;
  setColor: (tool: Tool, color: Rgb) => void;
  setWidth: (width: number) => void;
  setFontSize: (size: number) => void;
  setOpacity: (opacity: number) => void;
  setFill: (fill: Rgb | null) => void;
  setStamp: (stamp: StampId) => void;
  setCustomStamp: (stamp: CustomStamp) => void;
  // Unterschrift zum Setzen wählen (schaltet das Werkzeug ein) oder verwerfen
  setPendingSignature: (signature: PendingSignature | null) => void;
  setEraser: (eraser: { mode: EraserMode; size: EraserSize }) => void;
  // Formerkennung beim Stift (Stillhalten am Strichende macht eine saubere Form)
  setSnapShapes: (on: boolean) => void;
}

function run(items: Annotation[], command: Command): Annotation[] {
  switch (command.type) {
    case 'add':
      return [...items, command.annotation];
    case 'addMany':
      return [...items, ...command.annotations];
    case 'remove':
      return items.filter((a) => a.id !== command.annotation.id);
    case 'update':
      return items.map((a) => (a.id === command.after.id ? command.after : a));
    case 'batch':
      return command.commands.reduce(run, items);
  }
}

function invert(items: Annotation[], command: Command): Annotation[] {
  switch (command.type) {
    case 'add':
      return items.filter((a) => a.id !== command.annotation.id);
    case 'addMany': {
      const ids = new Set(command.annotations.map((a) => a.id));
      return items.filter((a) => !ids.has(a.id));
    }
    case 'remove': {
      const next = [...items];
      next.splice(Math.min(command.index, next.length), 0, command.annotation);
      return next;
    }
    case 'update':
      return items.map((a) => (a.id === command.before.id ? command.before : a));
    case 'batch':
      return command.commands.reduceRight(invert, items);
  }
}

const keepSelection = (items: Annotation[], id: string | null) => (id && items.some((a) => a.id === id) ? id : null);

export const useAnnotations = create<AnnotationsState>((set) => {
  const patch = (tabId: string, fn: (tab: TabAnnotations) => Partial<TabAnnotations>) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return { tabs: { ...state.tabs, [tabId]: { ...tab, ...fn(tab) } } };
    });

  return {
    tabs: {},
    tool: 'select',
    colors: DEFAULT_COLORS,
    width: 2,
    fontSize: 12,
    opacity: 1,
    fill: null,
    stamp: 'approved',
    customStamp: { text: '', date: true, name: true, color: 'blue' },
    pendingSignature: null,
    eraser: { mode: 'pixel', size: 'medium' },
    snapShapes: true,
    init: (tabId) => set((state) => ({ tabs: { ...state.tabs, [tabId]: { ...EMPTY } } })),
    restore: (tabId, tab) =>
      set((state) => ({ tabs: { ...state.tabs, [tabId]: { ...tab, loaded: true, editingId: null } } })),
    drop: (tabId) =>
      set((state) => {
        const tabs = { ...state.tabs };
        delete tabs[tabId];
        return { tabs };
      }),
    addLoaded: (tabId, items, done) =>
      patch(tabId, (tab) => {
        const originals = { ...tab.originals };
        const known = new Set(tab.items.map((a) => a.id));
        const added = items.filter((a) => !known.has(a.id));
        for (const a of added) originals[a.id] = a;
        return { items: [...tab.items, ...added], originals, loaded: done || tab.loaded };
      }),
    apply: (tabId, command) =>
      patch(tabId, (tab) => {
        const items = run(tab.items, command);
        return {
          items,
          undo: [...tab.undo, command],
          redo: [],
          // Wer nach Rückgängig etwas Neues macht, kann den gespeicherten Stand nicht mehr per Wiederholen erreichen.
          savedCursor: tab.savedCursor > tab.undo.length ? -1 : tab.savedCursor,
          // Gelöschte (auch mit dem Radierer) sind nicht mehr ausgewählt
          selectedId: keepSelection(items, tab.selectedId),
        };
      }),
    discard: (tabId, id) =>
      patch(tabId, (tab) => {
        const last = tab.undo.at(-1);
        if (last?.type !== 'add' || last.annotation.id !== id) return {};
        return {
          items: tab.items.filter((a) => a.id !== id),
          undo: tab.undo.slice(0, -1),
          selectedId: tab.selectedId === id ? null : tab.selectedId,
          editingId: tab.editingId === id ? null : tab.editingId,
        };
      }),
    undo: (tabId) =>
      patch(tabId, (tab) => {
        const command = tab.undo.at(-1);
        if (!command) return {};
        const items = invert(tab.items, command);
        return { items, undo: tab.undo.slice(0, -1), redo: [...tab.redo, command], editingId: null, selectedId: keepSelection(items, tab.selectedId) };
      }),
    redo: (tabId) =>
      patch(tabId, (tab) => {
        const command = tab.redo.at(-1);
        if (!command) return {};
        const items = run(tab.items, command);
        return { items, undo: [...tab.undo, command], redo: tab.redo.slice(0, -1), editingId: null, selectedId: keepSelection(items, tab.selectedId) };
      }),
    markSaved: (tabId) => patch(tabId, (tab) => ({ savedCursor: tab.undo.length })),
    select: (tabId, id) => patch(tabId, () => ({ selectedId: id })),
    setEditing: (tabId, id) => patch(tabId, () => ({ editingId: id })),
    setTool: (tool) => set({ tool }),
    setColor: (tool, color) => set((state) => ({ colors: { ...state.colors, [tool]: color } })),
    setWidth: (width) => set({ width }),
    setFontSize: (fontSize) => set({ fontSize }),
    setOpacity: (opacity) => set({ opacity }),
    setFill: (fill) => set({ fill }),
    setCustomStamp: (customStamp) => set({ customStamp }),
    setStamp: (stamp) => set({ stamp }),
    setEraser: (eraser) => set({ eraser }),
    setSnapShapes: (snapShapes) => set({ snapShapes }),
    setPendingSignature: (pendingSignature) =>
      set((state) => ({ pendingSignature, tool: pendingSignature ? 'signature' : state.tool === 'signature' ? 'select' : state.tool })),
  };
});

export function isDirty(tab: TabAnnotations | undefined): boolean {
  return Boolean(tab) && (tab as TabAnnotations).undo.length !== (tab as TabAnnotations).savedCursor;
}

export function tabAnnotations(tabId: string): TabAnnotations | undefined {
  return useAnnotations.getState().tabs[tabId];
}

export function useTabAnnotations(tabId: string | undefined): TabAnnotations | undefined {
  return useAnnotations((state) => (tabId ? state.tabs[tabId] : undefined));
}
