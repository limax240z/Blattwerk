import { useEffect, useRef } from 'react';
import { attachViewer, getRuntime } from '../../engine/runtime';
import { AnnotationLayer } from '../annotations/AnnotationLayer';
import { syncFormChanges } from '../forms/form-sync';
import type { TabState } from '../../state/documents-store';
import styles from './ViewerHost.module.css';
import { PageFlipAccumulator, SCROLL_MODE, wheelDeltaPixels } from './view-modes';
import { clampScale, pinchShift, wheelZoomIntent } from './zoom';

// So lange nach dem letzten Zoomschritt wird die Seite scharf neu gezeichnet (bis dahin nur skaliert)
const ZOOM_REDRAW_MS = 150;
// So lange nach dem letzten Pinch-Ereignis setzt pdf.js die Seiten im neuen Maßstab (bis dahin nur die Vorschau)
const PINCH_COMMIT_MS = 140;
// So lange danach bleibt die vereinfachte Darstellung, damit sie nicht zwischen zwei Fingerbewegungen zurückspringt
const ZOOM_SETTLE_MS = 100;

// Laufende Pinch-Vorschau (siehe pinchShift in zoom.ts)
interface PinchPreview {
  baseScale: number;
  factor: number;
  // Zeiger und linke obere Ecke der Seitenansicht in Koordinaten des Scrollinhalts
  pointer: [number, number];
  origin: [number, number];
  // waagrecht die Seiten, senkrecht der ganze Scrollinhalt
  content: { left: number; right: number; top: number; bottom: number };
  view: { left: number; top: number; width: number; height: number };
  // Anker für pdf.js (relativ zum offsetParent des Containers) und Zeiger im Fenster
  anchor: number[];
  client: [number, number];
  // hält die Scrollfläche während des Verkleinerns, sonst springt die Scrollposition
  spacer: HTMLDivElement;
}

// Bindet die pdf.js-Seitenansicht in React ein. pdf.js verwaltet den Inhalt des Containers selbst.
export function ViewerHost({ tab, active }: { tab: TabState; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const runtime = getRuntime(tab.id);
    const container = containerRef.current;
    const viewerElement = viewerRef.current;
    if (!runtime || !container || !viewerElement) return;
    const detach = attachViewer(runtime, container, viewerElement);

    // Zoomen mit Trackpad-Pinch oder Strg/Cmd + Mausrad, verankert an der Mausposition.
    const pageFlip = new PageFlipAccumulator();

    // In den Seitenansichten am Seitenrand weiterscrollen = umblättern (wie in Acrobat).
    const flipPages = (event: WheelEvent) => {
      const viewer = runtime.viewer;
      const delta = wheelDeltaPixels(event);
      if (!viewer || viewer.scrollMode !== SCROLL_MODE.PAGE || delta === 0) return;
      const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 1;
      const atTop = container.scrollTop <= 0;
      if ((delta > 0 && !atBottom) || (delta < 0 && !atTop)) {
        pageFlip.reset();
        return;
      }
      event.preventDefault();
      const direction = pageFlip.add(delta, event.timeStamp);
      if (direction > 0) {
        viewer.nextPage();
      } else if (direction < 0 && viewer.previousPage()) {
        // Rückwärts blättern landet am Ende der vorherigen Seite, so liest man nahtlos weiter.
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight;
        });
      }
    };

    // Solange gezoomt wird, liegt data-zooming am Bereich: Teure Überblendungen ruhen dann (global.css)
    let zoomEnd = 0;
    const markZooming = () => {
      container.dataset.zooming = '';
      window.clearTimeout(zoomEnd);
      zoomEnd = window.setTimeout(() => delete container.dataset.zooming, PINCH_COMMIT_MS + ZOOM_REDRAW_MS + ZOOM_SETTLE_MS);
    };

    // Pinch-Zoom: Bei jedem Zoomschritt alle Seiten neu zu setzen (pdf.js) kostet Anordnen und Zeichnen des ganzen
    // Dokuments und ließ das Zoomen spürbar hinterherlaufen. Deshalb vergrößert eine CSS-Transformation während der
    // Geste nur das fertige Bild; pdf.js übernimmt den Maßstab einmal, sobald die Finger kurz ruhen.
    let preview: PinchPreview | null = null;
    let pendingFactor = 1;
    let zoomFrame = 0;
    let commitTimer = 0;

    const startPreview = (event: WheelEvent, baseScale: number, anchor: number[]): PinchPreview => {
      const rect = container.getBoundingClientRect();
      const left = rect.left + container.clientLeft - container.scrollLeft;
      const top = rect.top + container.clientTop - container.scrollTop;
      let pagesLeft = Infinity;
      let pagesRight = -Infinity;
      for (const page of viewerElement.querySelectorAll<HTMLElement>('.page')) {
        const box = page.getBoundingClientRect();
        pagesLeft = Math.min(pagesLeft, box.left - left);
        pagesRight = Math.max(pagesRight, box.right - left);
      }
      if (!Number.isFinite(pagesLeft)) [pagesLeft, pagesRight] = [0, container.scrollWidth];
      const spacer = document.createElement('div');
      spacer.style.cssText = `position:absolute;width:1px;height:1px;left:${container.scrollWidth - 1}px;top:${container.scrollHeight - 1}px;pointer-events:none`;
      container.append(spacer);
      viewerElement.style.transformOrigin = '0 0';
      viewerElement.style.willChange = 'transform';
      return {
        baseScale,
        factor: 1,
        pointer: [event.clientX - left, event.clientY - top],
        origin: [viewerElement.offsetLeft, viewerElement.offsetTop],
        content: { left: pagesLeft, right: pagesRight, top: 0, bottom: container.scrollHeight },
        view: { left: container.scrollLeft, top: container.scrollTop, width: container.clientWidth, height: container.clientHeight },
        anchor,
        client: [event.clientX, event.clientY],
        spacer,
      };
    };

    const endPreview = (): PinchPreview | null => {
      const ended = preview;
      preview = null;
      window.clearTimeout(commitTimer);
      if (zoomFrame) cancelAnimationFrame(zoomFrame);
      zoomFrame = 0;
      pendingFactor = 1;
      if (!ended) return null;
      viewerElement.style.transform = '';
      viewerElement.style.transformOrigin = '';
      viewerElement.style.willChange = '';
      ended.spacer.remove();
      return ended;
    };

    // Seite, die dem Zeiger am nächsten liegt (an ihr richtet sich die Ansicht nach dem Übernehmen aus)
    const pageNear = (y: number): HTMLElement | null => {
      let best: HTMLElement | null = null;
      let distance = Infinity;
      for (const page of viewerElement.querySelectorAll<HTMLElement>('.page')) {
        const box = page.getBoundingClientRect();
        const d = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
        if (d < distance) [best, distance] = [page, d];
        if (d === 0) break;
      }
      return best;
    };

    // Vorschau beenden und den Maßstab an pdf.js geben (im selben Bild, damit nichts springt)
    const commitPinch = () => {
      if (pendingFactor !== 1 && preview) applyPinch();
      const page = preview ? pageNear(preview.client[1]) : null;
      const shown = page?.getBoundingClientRect();
      const ended = endPreview();
      const viewer = runtime.viewer;
      if (!ended || !viewer || ended.factor === 1) return;
      viewer.updateScale({ scaleFactor: ended.factor, origin: ended.anchor, drawingDelay: 0 });
      // pdf.js verankert ohne die festen Ränder um die Seiten; deshalb die Stelle unter dem Zeiger dorthin
      // zurückschieben, wo die Vorschau sie gezeigt hat
      if (!page || !shown || shown.width === 0 || shown.height === 0) return;
      const placed = page.getBoundingClientRect();
      const [x, y] = ended.client;
      container.scrollLeft += placed.left + ((x - shown.left) / shown.width) * placed.width - x;
      container.scrollTop += placed.top + ((y - shown.top) / shown.height) * placed.height - y;
    };
    runtime.flushZoom = commitPinch;

    const applyPinch = () => {
      zoomFrame = 0;
      if (!preview) return;
      const factor = clampScale(preview.baseScale * preview.factor * pendingFactor) / preview.baseScale;
      pendingFactor = 1;
      preview.factor = factor;
      const { pointer, origin, content, view } = preview;
      const x = pinchShift(factor, { pointer: pointer[0], origin: origin[0], contentStart: content.left, contentEnd: content.right, viewStart: view.left, viewSize: view.width, centerWhenFits: true });
      const y = pinchShift(factor, { pointer: pointer[1], origin: origin[1], contentStart: content.top, contentEnd: content.bottom, viewStart: view.top, viewSize: view.height, centerWhenFits: false });
      viewerElement.style.transform = `translate(${x}px, ${y}px) scale(${factor})`;
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        if (preview) commitPinch();
        flipPages(event);
        return;
      }
      event.preventDefault();
      const viewer = runtime.viewer;
      if (!viewer) return;
      markZooming();
      // pdf.js rechnet den Anker relativ zum offsetParent des Containers (containerTopLeft).
      // Mauskoordinaten deshalb in dieses Koordinatensystem umrechnen.
      const rect = container.getBoundingClientRect();
      const origin = [event.clientX - rect.left + container.offsetLeft, event.clientY - rect.top + container.offsetTop];
      const intent = wheelZoomIntent(event);
      if (intent.kind === 'factor') {
        // Das Trackpad meldet weit über 100 Ereignisse je Sekunde, gezeichnet wird nur einmal je Bild: sammeln
        preview ??= startPreview(event, viewer.currentScale, origin);
        pendingFactor *= intent.factor;
        zoomFrame ||= requestAnimationFrame(applyPinch);
        window.clearTimeout(commitTimer);
        commitTimer = window.setTimeout(commitPinch, PINCH_COMMIT_MS);
      } else {
        commitPinch();
        viewer.updateScale({ steps: intent.steps, origin, drawingDelay: ZOOM_REDRAW_MS });
      }
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    // Scrollen während der Vorschau (Scrollbalken, Tasten): erst den Maßstab übernehmen
    const onScroll = () => {
      if (preview) commitPinch();
    };
    container.addEventListener('scroll', onScroll, { passive: true });

    // Eingaben in Formularfelder (pdf.js legt die Werte in seinem Anmerkungsspeicher ab) als Änderung erfassen.
    // Erst nach dem Ereignis abgleichen: pdf.js speichert den Wert im selben Ereignis.
    const onFormInput = (event: Event) => {
      if (!(event.target as Element | null)?.closest?.('.annotationLayer')) return;
      setTimeout(() => void syncFormChanges(tab.id), 0);
    };
    container.addEventListener('input', onFormInput);
    container.addEventListener('change', onFormInput);
    container.addEventListener('click', onFormInput);

    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('scroll', onScroll);
      endPreview();
      if (runtime.flushZoom === commitPinch) runtime.flushZoom = null;
      window.clearTimeout(zoomEnd);
      container.removeEventListener('input', onFormInput);
      container.removeEventListener('change', onFormInput);
      container.removeEventListener('click', onFormInput);
      detach();
    };
    // Der Viewer wird einmal pro Tab erstellt; Änderungen am Tab-Zustand steuern ihn über Befehle.
  }, [tab.id]);

  // Beim Sichtbarwerden Größe neu berechnen (das Fenster kann sich verändert haben) und Fokus setzen.
  useEffect(() => {
    if (!active) return;
    const runtime = getRuntime(tab.id);
    runtime?.viewer?.update();
    containerRef.current?.focus({ preventScroll: true });
  }, [active, tab.id]);

  // Größenänderungen des Bereichs (Seitenleisten ein/aus, Fenstergröße) an pdf.js melden.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const viewer = getRuntime(tab.id)?.viewer;
      if (!viewer) return;
      const value = viewer.currentScaleValue;
      if (value === 'auto' || value === 'page-width' || value === 'page-fit') {
        viewer.currentScaleValue = value;
      }
      viewer.update();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [tab.id]);

  return (
    <div
      ref={containerRef}
      className={styles.container}
      tabIndex={0}
      data-testid="viewer-container"
      // Formular bearbeiten: Felder und Links von pdf.js reagieren nicht, die Bearbeitungsebene übernimmt.
      data-form-editing={tab.formEditing || tab.contentEditing ? '' : undefined}
      // Inhalt bearbeiten: kein Markieren von Text, Klicks gehen an die Objekte
      data-content-editing={tab.contentEditing ? '' : undefined}
    >
      <div ref={viewerRef} className="pdfViewer" />
      <AnnotationLayer tabId={tab.id} active={active} />
    </div>
  );
}
