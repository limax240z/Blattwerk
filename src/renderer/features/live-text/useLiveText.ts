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

interface LiveTextState {
  // Dokumentstand, zu dem die Ebenen gehören (nach Änderungen am Inhalt neu erkennen)
  pdf: PDFDocumentProxy | null;
  pages: Map<number, PageLayer>;
  shown: Set<number>;
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

function reset(state: LiveTextState, pdf: PDFDocumentProxy | null): void {
  for (const { layer } of state.pages.values()) layer.remove();
  state.pages.clear();
  state.pdf = pdf;
}

export function useLiveText(tabId: string, visible: number[], geometries: Map<number, PageGeometry>, pagesReady: number): void {
  const state = useRef<LiveTextState>({ pdf: null, pages: new Map(), shown: new Set() });

  useEffect(() => {
    const current = state.current;
    const doc = getRuntime(tabId)?.pdf ?? null;
    if (current.pdf !== doc) reset(current, doc);
    current.shown = new Set(visible);
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
      void liveText(doc, pageIndex, () => current.shown.has(pageIndex) && current.pdf === doc).then((lines) => {
        if (!lines || lines.length === 0 || current.pdf !== doc || current.pages.has(pageIndex)) return;
        const entry: PageLayer = { layer: createLiveTextLayer(), lines, geometry };
        fillLiveTextLayer(entry.layer, lines, geometry);
        current.pages.set(pageIndex, entry);
        place(tabId, pageIndex, entry);
      });
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
