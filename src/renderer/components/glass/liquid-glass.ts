// Liquid Glass nachgebildet (ADR 0022): Lichtbrechung am Rand einer Glasfläche. Für jede Fläche entsteht eine
// Verschiebungskarte in ihrer Form (abgerundetes Rechteck): innen neutral, zum Rand hin wird der Hintergrund nach außen
// verschoben, wie durch eine gewölbte Glaskante. Ein SVG-Filter (feDisplacementMap) wendet sie über
// `backdrop-filter: url(#…)` auf den Hintergrund an, danach Unschärfe und Sättigung.
// Chromium (Electron) unterstützt SVG-Filter in backdrop-filter; sonst bleibt das einfache CSS-Glas aus tokens.css.
import { useLayoutEffect, useState } from 'react';

const SVG_NS = 'http://www.w3.org/2000/svg';
// Karte in halber Auflösung genügt (sie wird glatt hochskaliert)
const MAP_SCALE = 0.5;
const MAX_MAP_PIXELS = 180_000;

export interface GlassOptions {
  // Breite der gewölbten Kante in Bildpunkten
  bevel?: number;
  // Stärke der Brechung (größte Verschiebung in Bildpunkten)
  refraction?: number;
  // Unschärfe des Hintergrunds
  blur?: number;
  saturation?: number;
}

const DEFAULTS: Required<GlassOptions> = { bevel: 14, refraction: 10, blur: 10, saturation: 1.8 };

// Voreinstellungen: kleine Bedienflächen, Seitenleisten, Dialoge, kleine Einblendungen
export const GLASS = {
  control: { bevel: 12, refraction: 9, blur: 6 },
  panel: { bevel: 18, refraction: 14, blur: 16 },
  sheet: { bevel: 22, refraction: 16, blur: 14 },
  small: { bevel: 8, refraction: 6, blur: 12 },
} satisfies Record<string, GlassOptions>;

let supported: boolean | null = null;
export function liquidGlassSupported(): boolean {
  if (supported === null) supported = typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'url(#a)') && !navigator.userAgent.includes('jsdom');
  return supported;
}

let defs: SVGDefsElement | null = null;
function filterDefs(): SVGDefsElement {
  if (defs?.isConnected) return defs;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.style.pointerEvents = 'none';
  defs = document.createElementNS(SVG_NS, 'defs');
  svg.append(defs);
  document.body.append(svg);
  return defs;
}

const maps = new Map<string, string>();

// Verschiebungskarte: Rot = waagerecht, Grün = senkrecht, 128 = keine Verschiebung
export function displacementMap(width: number, height: number, radius: number, bevel: number): string {
  const scale = Math.min(MAP_SCALE, Math.sqrt(MAX_MAP_PIXELS / Math.max(1, width * height)));
  const w = Math.max(2, Math.round(width * scale));
  const h = Math.max(2, Math.round(height * scale));
  const key = `${w}x${h}:${Math.round(radius * scale)}:${Math.round(bevel * scale)}`;
  const cached = maps.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const image = context.createImageData(w, h);
  const r = Math.min(radius * scale, w / 2, h / 2);
  const b = Math.max(1, Math.min(bevel * scale, w / 2, h / 2));
  const hw = w / 2;
  const hh = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Abstand zum Rand des abgerundeten Rechtecks und Richtung nach außen
      const px = x + 0.5 - hw;
      const py = y + 0.5 - hh;
      const qx = Math.abs(px) - (hw - r);
      const qy = Math.abs(py) - (hh - r);
      let nx = 0;
      let ny = 0;
      let inside: number;
      if (qx > 0 && qy > 0) {
        const length = Math.hypot(qx, qy);
        inside = r - length;
        nx = (qx / (length || 1)) * Math.sign(px);
        ny = (qy / (length || 1)) * Math.sign(py);
      } else {
        inside = r - Math.max(qx, qy);
        if (qx > qy) nx = Math.sign(px);
        else ny = Math.sign(py);
      }
      // Wölbung: am Rand am stärksten, nach innen weich auslaufend
      const t = Math.min(1, Math.max(0, inside / b));
      const strength = (1 - t) * (1 - t);
      const offset = (y * w + x) * 4;
      image.data[offset] = Math.round(128 + nx * strength * 127);
      image.data[offset + 1] = Math.round(128 + ny * strength * 127);
      image.data[offset + 2] = 128;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const url = canvas.toDataURL('image/png');
  maps.set(key, url);
  return url;
}

let nextId = 0;

// Stromsparen: im Akkubetrieb oder bei „Transparenz reduzieren“ (macOS) ruht der Lichtschein, und die Glasflächen
// verzichten auf die Lichtbrechung (SVG-Filter im Hintergrund, kostet die Grafikkarte bei jedem Neuzeichnen). Unschärfe
// und Sättigung bleiben, das Glas sieht also weiter wie Glas aus.
let saving = false;
const savingListeners = new Set<() => void>();

export function energySaving(): boolean {
  return saving;
}

function setSaving(next: boolean): void {
  if (next === saving) return;
  saving = next;
  document.documentElement.toggleAttribute('data-energy-saving', saving);
  for (const listener of savingListeners) listener();
}

interface BatteryLike extends EventTarget {
  charging: boolean;
}

// Beobachtet Netzteil und Bedienungshilfen; liefert eine Funktion zum Beenden
export function watchEnergy(): () => void {
  const reduced = window.matchMedia('(prefers-reduced-transparency: reduce)');
  let battery: BatteryLike | null = null;
  const update = () => setSaving(reduced.matches || (battery !== null && !battery.charging));
  reduced.addEventListener('change', update);
  const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery;
  void getBattery
    ?.call(navigator)
    .then((value) => {
      battery = value;
      value.addEventListener('chargingchange', update);
      update();
    })
    .catch(() => undefined);
  update();
  return () => {
    reduced.removeEventListener('change', update);
    battery?.removeEventListener('chargingchange', update);
  };
}

// Glasflächen und Lage des Zeigers für den Lichtschein (trackPointerLight)
const glassElements = new Set<HTMLElement>();
const pointer = { x: 0, y: -80 };
// So weit reicht der Lichtschein (größter Kreis in global.css, .liquid::before)
const LIGHT_REACH = 260;
const lit = new Set<HTMLElement>();

// Erst alle Lagen lesen, dann schreiben: Abwechselnd lesen und schreiben zwänge den Browser zu einer Neuberechnung je
// Fläche
function light(elements: Iterable<HTMLElement>): void {
  if (saving) {
    for (const element of lit) {
      element.style.removeProperty('--pointer-x');
      element.style.removeProperty('--pointer-y');
    }
    lit.clear();
    return;
  }
  const reach = [...elements].map((element) => {
    const box = element.getBoundingClientRect();
    const near =
      pointer.x >= box.left - LIGHT_REACH && pointer.x <= box.right + LIGHT_REACH && pointer.y >= box.top - LIGHT_REACH && pointer.y <= box.bottom + LIGHT_REACH;
    return [element, near] as const;
  });
  const x = `${Math.round(pointer.x)}px`;
  const y = `${Math.round(pointer.y)}px`;
  for (const [element, near] of reach) {
    if (near) {
      element.style.setProperty('--pointer-x', x);
      element.style.setProperty('--pointer-y', y);
      lit.add(element);
    } else if (lit.delete(element)) {
      element.style.removeProperty('--pointer-x');
      element.style.removeProperty('--pointer-y');
    }
  }
}

// Verbindet ein Element mit einem eigenen Glasfilter, der seiner Größe und Rundung folgt. Liefert eine Ref-Funktion
// (wirkt auch, wenn das Element erst später erscheint).
export function useLiquidGlass<T extends HTMLElement>(options: GlassOptions = {}): (element: T | null) => void {
  const [element, setElement] = useState<T | null>(null);
  const { bevel, refraction, blur, saturation } = { ...DEFAULTS, ...options };

  useLayoutEffect(() => {
    if (!element || !liquidGlassSupported()) return;
    const id = `liquid-glass-${++nextId}`;
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.id = id;
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
    const map = document.createElementNS(SVG_NS, 'feImage');
    map.setAttribute('result', 'map');
    map.setAttribute('preserveAspectRatio', 'none');
    const displace = document.createElementNS(SVG_NS, 'feDisplacementMap');
    displace.setAttribute('in', 'SourceGraphic');
    displace.setAttribute('in2', 'map');
    displace.setAttribute('xChannelSelector', 'R');
    displace.setAttribute('yChannelSelector', 'G');
    displace.setAttribute('scale', String(refraction * 2));
    filter.append(map, displace);
    filterDefs().append(filter);

    const update = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width < 4 || height < 4) return;
      const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
      for (const target of [filter, map]) {
        target.setAttribute('x', '0');
        target.setAttribute('y', '0');
        target.setAttribute('width', String(width));
        target.setAttribute('height', String(height));
      }
      map.setAttribute('href', displacementMap(width, height, Math.min(radius, width / 2, height / 2), bevel));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const backdrop = () => {
      const value = `${saving ? '' : `url(#${id}) `}blur(${blur}px) saturate(${saturation})`;
      element.style.setProperty('-webkit-backdrop-filter', value);
      element.style.setProperty('backdrop-filter', value);
    };
    backdrop();
    savingListeners.add(backdrop);
    element.classList.add('liquid');
    glassElements.add(element);
    light([element]);
    return () => {
      savingListeners.delete(backdrop);
      glassElements.delete(element);
      lit.delete(element);
      element.style.removeProperty('--pointer-x');
      element.style.removeProperty('--pointer-y');
      observer.disconnect();
      filter.remove();
      element.style.removeProperty('-webkit-backdrop-filter');
      element.style.removeProperty('backdrop-filter');
      element.classList.remove('liquid');
    };
  }, [element, bevel, refraction, blur, saturation]);

  return setElement;
}

// Lichtquelle für die Glanzkanten: folgt dem Mauszeiger. Die Werte (--pointer-x/-y) stehen nur an Glasflächen in
// Reichweite, nicht am Wurzelelement: Eine Variable dort ließe den Browser bei jeder Mausbewegung die Darstellung des
// ganzen Fensters neu berechnen (auch Tausende Textstücke der PDF-Seiten). Gemessen: 300 Bewegungen über einer Seite
// kosteten so rund 0,6 s Stilberechnung; das war der größte Energieverbrauch der App.
export function trackPointerLight(): () => void {
  let frame = 0;
  pointer.x = window.innerWidth * 0.3;
  pointer.y = -80;
  const apply = () => {
    frame = 0;
    light(glassElements);
  };
  const move = (event: PointerEvent) => {
    // Nicht beim Ziehen (verschobene Objekte sollen dem Zeiger ohne Verzögerung folgen)
    if (event.buttons !== 0) return;
    if (saving) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (!frame) frame = requestAnimationFrame(apply);
  };
  apply();
  window.addEventListener('pointermove', move, { passive: true });
  savingListeners.add(apply);
  return () => {
    savingListeners.delete(apply);
    window.removeEventListener('pointermove', move);
    if (frame) cancelAnimationFrame(frame);
  };
}
