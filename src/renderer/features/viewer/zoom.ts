// Zoom-Logik ohne DOM, damit sie testbar bleibt.

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 25;

export const PRESET_SCALE_VALUES = ['auto', 'page-width', 'page-fit', 'page-actual'] as const;
export type PresetScaleValue = (typeof PRESET_SCALE_VALUES)[number];

export const PERCENT_STEPS = [10, 25, 50, 75, 100, 125, 150, 200, 300, 400, 800, 1600, 2500];
export const ZOOM_MENU_PERCENTS = [50, 75, 100, 125, 150, 200, 300, 400];

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function isPresetScaleValue(value: string): value is PresetScaleValue {
  return (PRESET_SCALE_VALUES as readonly string[]).includes(value);
}

export function scaleToPercent(scale: number): number {
  return Math.round(scale * 100);
}

// Wandelt eine Eingabe wie "150", "150 %" oder "150,5" in einen Maßstab um.
export function parsePercentInput(input: string): number | null {
  const cleaned = input.replace('%', '').replace(',', '.').trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const percent = Number(cleaned);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return clampScale(percent / 100);
}

// Wheel-Ereignis mit gedrückter Strg-/Cmd-Taste oder Trackpad-Pinch in einen Zoomwunsch übersetzen.
export function wheelZoomIntent(event: { deltaY: number; deltaMode: number }):
  | { kind: 'factor'; factor: number }
  | { kind: 'steps'; steps: number } {
  const PIXEL_MODE = 0;
  // Trackpad und Pinch liefern viele kleine Pixel-Deltas, Mausräder große Sprünge.
  if (event.deltaMode === PIXEL_MODE && Math.abs(event.deltaY) < 40) {
    return { kind: 'factor', factor: Math.exp(-event.deltaY / 100) };
  }
  return { kind: 'steps', steps: event.deltaY < 0 ? 1 : -1 };
}

// Pinch-Zoom als Vorschau: Während der Geste wird nur das fertige Bild der Seiten vergrößert (CSS-Transformation,
// zeichnet die Grafikkarte), pdf.js setzt die Seiten erst danach einmal neu. Die Verschiebung hält den Punkt unter
// dem Zeiger fest und folgt sonst dem, was pdf.js und das Scrollen danach zeigen: Passt der Inhalt in die Ansicht,
// steht er waagrecht in der Mitte und senkrecht oben; sonst bleibt kein leerer Rand in der Ansicht.
// Alle Werte in Koordinaten des Scrollinhalts; ein Punkt p landet bei origin + (p - origin) * scale + shift.
export interface PinchAxis {
  pointer: number;
  origin: number;
  contentStart: number;
  contentEnd: number;
  viewStart: number;
  viewSize: number;
  centerWhenFits: boolean;
}

export function pinchShift(scale: number, axis: PinchAxis): number {
  const { pointer, origin, contentStart, contentEnd, viewStart, viewSize } = axis;
  let shift = (pointer - origin) * (1 - scale);
  const start = origin + (contentStart - origin) * scale + shift;
  const end = origin + (contentEnd - origin) * scale + shift;
  if (end - start <= viewSize) {
    shift += axis.centerWhenFits ? viewStart + viewSize / 2 - (start + end) / 2 : viewStart - start;
  } else if (start > viewStart) {
    shift += viewStart - start;
  } else if (end < viewStart + viewSize) {
    shift += viewStart + viewSize - end;
  }
  return shift;
}
