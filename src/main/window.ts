import { BrowserWindow, nativeTheme, screen, type Rectangle } from 'electron';
import path from 'node:path';
import { PRODUCT_NAME } from '../shared/product';
import { JsonStore } from './files/json-store';

export interface WindowState {
  bounds: Rectangle | null;
  maximized: boolean;
}

export interface SettingsData {
  version: 1;
  window: WindowState;
  // Name, der als Autor in Kommentaren steht; null = Benutzername des Systems
  authorName: string | null;
  // Zuletzt verwendete digitale ID (.p12) zum Unterschreiben; nur der Pfad, nie das Kennwort
  lastIdPath: string | null;
  // Eigener Update-Ordner (z. B. in iCloud Drive oder OneDrive), ADR 0025
  updateFolder: string | null;
  // Letzte Suche nach einer neuen Version im Netz (ms seit 1970), ADR 0027
  lastUpdateCheck?: number;
  // false = Lesemodus ohne Vollbild; fehlt = mit Vollbild
  readModeFullscreen?: boolean;
}

function isRect(value: unknown): value is Rectangle {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]));
}

function validateSettings(raw: unknown): SettingsData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as {
    version?: unknown;
    window?: { bounds?: unknown; maximized?: unknown };
    authorName?: unknown;
    lastIdPath?: unknown;
    updateFolder?: unknown;
    lastUpdateCheck?: unknown;
    readModeFullscreen?: unknown;
  };
  if (data.version !== 1 || typeof data.window !== 'object' || data.window === null) return null;
  const author = typeof data.authorName === 'string' ? data.authorName.trim().slice(0, 200) : '';
  return {
    version: 1,
    window: {
      bounds: isRect(data.window.bounds) ? data.window.bounds : null,
      maximized: data.window.maximized === true,
    },
    authorName: author || null,
    lastIdPath: typeof data.lastIdPath === 'string' && path.isAbsolute(data.lastIdPath) && data.lastIdPath.length < 4096 ? data.lastIdPath : null,
    updateFolder: typeof data.updateFolder === 'string' && path.isAbsolute(data.updateFolder) && data.updateFolder.length < 4096 ? data.updateFolder : null,
    ...(typeof data.lastUpdateCheck === 'number' && Number.isFinite(data.lastUpdateCheck) ? { lastUpdateCheck: data.lastUpdateCheck } : {}),
    ...(typeof data.readModeFullscreen === 'boolean' ? { readModeFullscreen: data.readModeFullscreen } : {}),
  };
}

export function createSettingsStore(userDataDir: string): JsonStore<SettingsData> {
  return new JsonStore<SettingsData>(
    path.join(userDataDir, 'settings.json'),
    () => ({ version: 1, window: { bounds: null, maximized: false }, authorName: null, lastIdPath: null, updateFolder: null }),
    validateSettings,
  );
}

// Größe für weitere Fenster: wie das vordere, sonst wie gespeichert
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 860 };

// Gespeicherte Fensterposition nur übernehmen, wenn sie noch auf einem vorhandenen Bildschirm liegt.
export function visibleBounds(bounds: Rectangle | null): Rectangle | null {
  if (!bounds) return null;
  const visible = screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
    const overlapY = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
    return overlapX > 100 && overlapY > 100;
  });
  return visible ? bounds : null;
}

export interface CreateWindowOptions {
  preloadPath: string;
  state: WindowState;
  // Lage eines weiteren Fensters (versetzt zum vorderen bzw. an der Stelle eines herausgezogenen Tabs);
  // ohne Angabe gilt die gespeicherte Lage
  bounds?: Rectangle;
  devTools: boolean;
  // Oberflächentests: Fenster unsichtbar lassen (zeichnet trotzdem vollständig)
  hidden?: boolean;
  // Durchsichtiges Fenster für Apples Liquid Glass (ADR 0023); muss beim Erzeugen feststehen, sonst löscht Chromium
  // durchsichtig gewordene Bereiche nicht und zeigt alte Bilder
  transparent?: boolean;
  onStateChange: (state: WindowState) => void;
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const bounds = options.bounds ?? visibleBounds(options.state.bounds);
  const win = new BrowserWindow({
    ...(bounds ?? DEFAULT_WINDOW_SIZE),
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: PRODUCT_NAME,
    ...(options.transparent
      ? { transparent: true, backgroundColor: '#00000000', hasShadow: true }
      : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1d1a' : '#f3efe6' }),
    // macOS: Titelleiste und Werkzeugleiste in einem (wie Vorschau); die Leiste ist Zugfläche (global.css)
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } } : {}),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: options.devTools,
      // Unsichtbare Fenster würden sonst gedrosselt (Zeichnen, Zeitgeber)
      backgroundThrottling: !options.hidden,
    },
  });

  if (options.state.maximized && !options.bounds) win.maximize();
  // Pinch-Zoom des Browsers aus: Zoomen übernimmt der Viewer selbst.
  void win.webContents.setVisualZoomLevelLimits(1, 1);
  if (!options.hidden) win.once('ready-to-show', () => win.show());

  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      options.onStateChange({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
    }, 500);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    options.onStateChange({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  });

  return win;
}
