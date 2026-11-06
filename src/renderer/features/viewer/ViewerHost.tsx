import { useEffect, useRef } from 'react';
import { attachViewer, getRuntime } from '../../engine/runtime';
import { AnnotationLayer } from '../annotations/AnnotationLayer';
import { syncFormChanges } from '../forms/form-sync';
import type { TabState } from '../../state/documents-store';
import styles from './ViewerHost.module.css';
import { PageFlipAccumulator, SCROLL_MODE, wheelDeltaPixels } from './view-modes';
import { PinchAccumulator, wheelZoomIntent } from './zoom';

// So lange nach dem letzten Zoomschritt wird die Seite scharf neu gezeichnet (bis dahin nur skaliert)
const ZOOM_REDRAW_MS = 150;

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
    const pinch = new PinchAccumulator();
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

    let pendingFactor = 1;
    let pendingOrigin: number[] = [0, 0];
    let zoomFrame = 0;
    const applyPinch = () => {
      zoomFrame = 0;
      const viewer = runtime.viewer;
      const collected = pendingFactor;
      pendingFactor = 1;
      if (!viewer) return;
      const factor = pinch.add(viewer.currentScale, collected);
      if (factor !== null) viewer.updateScale({ scaleFactor: factor, origin: pendingOrigin, drawingDelay: ZOOM_REDRAW_MS });
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        flipPages(event);
        return;
      }
      event.preventDefault();
      const viewer = runtime.viewer;
      if (!viewer) return;
      // pdf.js rechnet den Anker relativ zum offsetParent des Containers (containerTopLeft).
      // Mauskoordinaten deshalb in dieses Koordinatensystem umrechnen.
      const rect = container.getBoundingClientRect();
      const origin = [event.clientX - rect.left + container.offsetLeft, event.clientY - rect.top + container.offsetTop];
      const intent = wheelZoomIntent(event);
      if (intent.kind === 'factor') {
        // Das Trackpad meldet weit über 100 Ereignisse je Sekunde, gezeichnet wird nur einmal je Bild: sammeln
        pendingFactor *= intent.factor;
        pendingOrigin = origin;
        zoomFrame ||= requestAnimationFrame(applyPinch);
      } else {
        pinch.reset();
        viewer.updateScale({ steps: intent.steps, origin, drawingDelay: ZOOM_REDRAW_MS });
      }
    };
    container.addEventListener('wheel', onWheel, { passive: false });

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
      if (zoomFrame) cancelAnimationFrame(zoomFrame);
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
