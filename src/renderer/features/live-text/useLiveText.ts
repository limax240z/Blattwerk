// Hängt Live-Text in die sichtbaren Seiten von pdf.js: erkennt sie der Reihe nach im Hintergrund und legt die
// auswählbare Ebene direkt hinter die Textebene von pdf.js (unter Formularfelder, Links und Kommentare).
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useRef } from 'react';
import type { PageGeometry } from '../../engine/coords';
import { getRuntime } from '../../engine/runtime';
import { createLiveTextLayer, fillLiveTextLayer } from './layer';
import { liveText, type LiveLine } from './live-text';

interface PageLayer {
  layer: HTMLDivElement;
  lines: LiveLine[];
  geometry: PageGeometry;
}

// Erst erkennen, wenn eine Seite so lange ruhig zu sehen ist: Beim Blättern und gleich nach dem Öffnen bleibt die
// Rechenzeit bei der Bedienung
const SETTLE_MS = 1500;

interface LiveTextState {
  // Dokumentstand, zu dem die Ebenen gehören (nach Änderungen am Inhalt neu erkennen)
  pdf: PDFDocumentProxy | null;
  pages: Map<number, PageLayer>;
  shown: Set<number>;
  // Seiten, deren Erkennung nach SETTLE_MS beginnt
  waiting: Map<number, number>;
}

// Ebene an ihren Platz bringen: hinter die Textebene von pdf.js, die beim Neuzeichnen einer Seite neu entsteht
function place(tabId: string, pageIndex: number, entry: PageLayer): void {
  const div = getRuntime(tabId)?.viewer?.getPageView(pageIndex)?.div as HTMLElement | undefined;
  if (!div) return;
  const text = div.querySelector<HTMLElement>(':scope > .textLayer:not([data-live-text])');
  if (text) {
    if (entry.layer.previousElementSibling !== text) text.after(entry.layer);
  } else if (entry.layer.parentElement !== div) {
    div.append(entry.layer);
  }
}

// Steht die Seite wirklich im Fenster? (Die sichtbaren Seiten der Kommentarebene schließen einen Vorladebereich ein.)
function onScreen(tabId: string, pageIndex: number): boolean {
  const runtime = getRuntime(tabId);
  const div = runtime?.viewer?.getPageView(pageIndex)?.div as HTMLElement | undefined;
  const view = runtime?.container?.getBoundingClientRect();
  const box = div?.getBoundingClientRect();
  return !!view && !!box && box.bottom > view.top && box.top < view.bottom && box.right > view.left && box.left < view.right;
}

function reset(state: LiveTextState, pdf: PDFDocumentProxy | null): void {
  for (const { layer } of state.pages.values()) layer.remove();
  state.pages.clear();
  for (const timer of state.waiting.values()) window.clearTimeout(timer);
  state.waiting.clear();
  state.pdf = pdf;
}

export function useLiveText(tabId: string, visible: number[], geometries: Map<number, PageGeometry>, pagesReady: number): void {
  const state = useRef<LiveTextState>({ pdf: null, pages: new Map(), shown: new Set(), waiting: new Map() });

  useEffect(() => {
    const current = state.current;
    const doc = getRuntime(tabId)?.pdf ?? null;
    if (current.pdf !== doc) reset(current, doc);
    current.shown = new Set(visible);
    for (const [pageIndex, timer] of current.waiting) {
      if (current.shown.has(pageIndex)) continue;
      window.clearTimeout(timer);
      current.waiting.delete(pageIndex);
    }
    if (!doc) return;
    for (const pageIndex of visible) {
      const geometry = geometries.get(pageIndex);
      if (!geometry) continue;
      const existing = current.pages.get(pageIndex);
      if (existing) {
        // Schon erkannt: nur bei geänderter Drehung neu aufbauen (Zoom regelt CSS)
        if (existing.geometry !== geometry) {
          fillLiveTextLayer(existing.layer, existing.lines, geometry);
          existing.geometry = geometry;
        }
        place(tabId, pageIndex, existing);
        continue;
      }
      if (current.waiting.has(pageIndex)) continue;
      const start = () => {
        current.waiting.delete(pageIndex);
        if (!current.shown.has(pageIndex) || current.pdf !== doc) return;
        if (!onScreen(tabId, pageIndex)) {
          current.waiting.set(pageIndex, window.setTimeout(start, SETTLE_MS));
          return;
        }
        void liveText(doc, pageIndex, () => current.shown.has(pageIndex) && current.pdf === doc).then((lines) => {
          if (!lines || lines.length === 0 || current.pdf !== doc || current.pages.has(pageIndex)) return;
          const entry: PageLayer = { layer: createLiveTextLayer(), lines, geometry };
          fillLiveTextLayer(entry.layer, lines, geometry);
          current.pages.set(pageIndex, entry);
          place(tabId, pageIndex, entry);
        });
      };
      current.waiting.set(pageIndex, window.setTimeout(start, SETTLE_MS));
    }
  }, [tabId, visible, geometries]);

  // pdf.js baut Seiten beim Zoomen neu auf; die Ebenen danach wieder einhängen
  useEffect(() => {
    const current = state.current;
    const container = getRuntime(tabId)?.viewer?.viewer as HTMLElement | undefined;
    if (!container) return;
    const observer = new MutationObserver(() => {
      for (const [pageIndex, entry] of current.pages) place(tabId, pageIndex, entry);
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [tabId, pagesReady]);

  // Tab geschlossen
  useEffect(() => {
    const current = state.current;
    return () => reset(current, null);
  }, [tabId]);
}
