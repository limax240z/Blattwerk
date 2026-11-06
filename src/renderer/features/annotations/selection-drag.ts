// Textauswahl mit der Maus über mehrere Zeilen: Über Text wählt der Browser selbst aus. In den Lücken zwischen Zeilen
// und Wörtern gäbe es dort nichts zu treffen; die Auswahl bliebe stehen oder fiele zusammen. Darum folgt sie dort der
// nächstgelegenen Textstelle. Die Ebene mit Live-Text bekommt beim Ziehen dieselbe Abdeckung wie die von pdf.js
// (Klasse „selecting“ mit .endOfContent), die pdf.js für sie nicht verwaltet.
import type { Rect } from '../../../shared/annotations';
import { quadsFromRects } from './geometry';
import { caretAt, rangeBetween, type Caret } from './text-caret';
import { misplacedRuns } from './text-order';

// Beginnt das Ziehen in einer Lücke, zählt die nächste Textstelle nur, wenn sie so nah liegt (Bildschirmpixel). Weiter
// weg meint niemand den Text; Hervorheben malt dort frei (AnnotationLayer).
const NEAR_TEXT_PX = 24;
// Erst ab dieser Strecke ist es ein Ziehen und kein Klick
const DRAG_PX = 3;

// Seite mit Textebene, die dem Punkt am nächsten liegt (auch im Rand neben oder zwischen den Seiten)
function nearestLayers(container: HTMLElement, x: number, y: number): Element[] {
  let best: { page: Element; score: number } | null = null;
  const pages = new Set<Element>();
  for (const layer of container.querySelectorAll('.page .textLayer')) {
    const page = layer.closest('.page');
    if (page) pages.add(page);
  }
  for (const page of pages) {
    const box = page.getBoundingClientRect();
    const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
    const score = dy * 1000 + dx;
    if (!best || score < best.score) best = { page, score };
  }
  return best ? Array.from(best.page.querySelectorAll('.textLayer')) : [];
}

function distanceToCaret({ node }: Caret, x: number, y: number): number {
  const range = document.createRange();
  range.selectNodeContents(node);
  const box = range.getBoundingClientRect();
  const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
  const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
  return Math.hypot(dx, dy);
}

const isText = (target: EventTarget | null) => target instanceof Element && target.closest('.textLayer span') !== null;

// Auswahl im Live-Text: Dort ist jedes Wort ein eigenes Stück, der Browser zeichnete die Auswahl deshalb Wort für Wort. Sie
// wird stattdessen als ein durchgehender Streifen je Zeile gezeichnet (wie die Markierung, die daraus entsteht).
export function paintLiveSelection(container: HTMLElement): () => void {
  let frame = 0;
  const paint = () => {
    frame = 0;
    const selection = window.getSelection();
    const ranges: Range[] = [];
    if (selection && !selection.isCollapsed) for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i));
    for (const layer of container.querySelectorAll<HTMLElement>('.textLayer[data-live-text]')) {
      for (const bar of layer.querySelectorAll('.liveSelection')) bar.remove();
      const box = layer.getBoundingClientRect();
      if (ranges.length === 0 || box.width === 0) continue;
      const rects: Rect[] = [];
      for (const span of layer.querySelectorAll('span')) {
        const node = span.firstChild;
        const text = node?.textContent ?? '';
        if (!(node instanceof Text) || text.trim() === '') continue;
        for (const range of ranges) {
          if (!range.intersectsNode(node)) continue;
          const part = document.createRange();
          part.setStart(node, node === range.startContainer ? range.startOffset : 0);
          part.setEnd(node, node === range.endContainer ? range.endOffset : text.length);
          if (part.collapsed) continue;
          const { left, top, right, bottom } = part.getBoundingClientRect();
          rects.push([left, top, right, bottom]);
        }
      }
      for (const quad of quadsFromRects(rects)) {
        const [topLeft, , , bottomRight] = quad;
        if (!topLeft || !bottomRight) continue;
        const bar = document.createElement('div');
        bar.className = 'liveSelection';
        // Rechtecke in Bildschirmkoordinaten: y wächst nach unten, die kleinere Zahl ist also die Oberkante
        bar.style.left = `${((topLeft.x - box.left) / box.width) * 100}%`;
        bar.style.width = `${((bottomRight.x - topLeft.x) / box.width) * 100}%`;
        bar.style.top = `${((bottomRight.y - box.top) / box.height) * 100}%`;
        bar.style.height = `${((topLeft.y - bottomRight.y) / box.height) * 100}%`;
        layer.append(bar);
      }
    }
  };
  const schedule = () => {
    frame ||= requestAnimationFrame(paint);
  };
  document.addEventListener('selectionchange', schedule);
  return () => {
    document.removeEventListener('selectionchange', schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}

export function followSelectionDrag(container: HTMLElement): () => void {
  let dragging = false;
  // Beginn in einer Lücke: Die Auswahl läuft ganz hier, von dieser Stelle aus (der Browser fände dort keinen Anfang)
  let start: { caret: Caret; x: number; y: number } | null = null;
  let frame = 0;
  let pending: { x: number; y: number } | null = null;
  const live = () => container.querySelectorAll<HTMLElement>('.textLayer[data-live-text]');

  const extend = () => {
    frame = 0;
    const at = pending;
    pending = null;
    const selection = window.getSelection();
    if (!at || !selection) return;
    const caret = caretAt(nearestLayers(container, at.x, at.y), at.x, at.y);
    if (!caret) return;
    if (start) {
      const range = rangeBetween(start.caret, caret);
      selection.removeAllRanges();
      selection.addRange(range);
    } else if (selection.anchorNode && container.contains(selection.anchorNode)) {
      selection.extend(caret.node, caret.offset);
    }
  };

  const cover = () => {
    dragging = true;
    for (const layer of live()) {
      layer.classList.add('selecting');
      layer.style.pointerEvents = 'auto';
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button === 0 && event.pointerType !== 'touch' && isText(event.target)) cover();
  };
  // Nur nötig, wo Live-Text liegt: In der Textebene von pdf.js findet der Browser den Anfang selbst
  const onMouseDown = (event: MouseEvent) => {
    const target = event.target;
    if (event.button !== 0 || isText(target) || !(target instanceof Element) || !target.closest('.textLayer')) return;
    const page = target.closest('.page');
    if (!page?.querySelector('.textLayer[data-live-text] span')) return;
    const { clientX: x, clientY: y } = event;
    const caret = caretAt(Array.from(page.querySelectorAll('.textLayer')), x, y);
    if (!caret || distanceToCaret(caret, x, y) > NEAR_TEXT_PX) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    start = { caret, x, y };
    cover();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    if ((event.buttons & 1) === 0) {
      stop();
      return;
    }
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_PX) return;
    // Über Text wählt der Browser genau aus; eine noch ausstehende Lücke darf ihn nicht überschreiben
    if (!start && isText(event.target)) {
      pending = null;
      return;
    }
    pending = { x: event.clientX, y: event.clientY };
    frame ||= requestAnimationFrame(extend);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    if (frame) cancelAnimationFrame(frame);
    // Die letzte Stelle zählt, bevor das Markieren die Auswahl liest
    extend();
    start = null;
    for (const layer of live()) {
      layer.classList.remove('selecting');
      layer.style.pointerEvents = 'none';
    }
  };

  container.addEventListener('pointerdown', onPointerDown, true);
  container.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', stop, true);
  window.addEventListener('pointercancel', stop, true);
  return () => {
    stop();
    container.removeEventListener('pointerdown', onPointerDown, true);
    container.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', stop, true);
    window.removeEventListener('pointercancel', stop, true);
  };
}

// Ordnet die Textebene von pdf.js um. Suche und Markieren arbeiten über die Liste von pdf.js bzw. die Lage auf der
// Seite, nicht über die Reihenfolge im Dokument.
export function repairTextOrder(layer: Element): void {
  const end = layer.querySelector(':scope > .endOfContent');
  const pieces = Array.from(layer.children).filter((child) => child !== end && child.tagName !== 'BR' && child.textContent?.trim());
  if (pieces.length < 3) return;
  const height = layer.getBoundingClientRect().height;
  if (height === 0) return;
  const { head, tail } = misplacedRuns(pieces.map((piece) => piece.getBoundingClientRect()), height);
  const atEnd = pieces.slice(0, head);
  const atStart = pieces.slice(pieces.length - tail);
  const before = layer.firstChild;
  for (const piece of atStart) layer.insertBefore(piece, before);
  for (const piece of atEnd) layer.insertBefore(piece, end);
}
