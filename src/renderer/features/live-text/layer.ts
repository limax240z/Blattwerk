// Unsichtbare, auswählbare Textebene aus Live-Text, gebaut wie die Textebene von pdf.js (Klasse „textLayer“, Wörter als
// durchsichtige Spans). Dadurch funktionieren Auswählen, Kopieren und Markieren (text-selection.ts, text-caret.ts) ohne
// Sonderweg. Lage in Prozent und Schriftgröße in Containereinheiten: Die Ebene passt bei jedem Zoom, ohne neu zu bauen.
import type { Point } from '../../../shared/annotations';
import type { PageGeometry } from '../../engine/coords';
import type { LiveLine } from './live-text';

const FONT = 'sans-serif';

let measureContext: CanvasRenderingContext2D | null = null;

// Breite des Textes bei Schriftgröße 1
function naturalWidth(text: string): number {
  measureContext ??= document.createElement('canvas').getContext('2d');
  if (!measureContext) return text.length * 0.5;
  measureContext.font = `100px ${FONT}`;
  return measureContext.measureText(text).width / 100;
}

export function createLiveTextLayer(): HTMLDivElement {
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  layer.dataset.liveText = '';
  // Nur die Wörter nehmen die Maus an; dazwischen erreicht sie die Textebene von pdf.js und Links darunter
  layer.style.pointerEvents = 'none';
  layer.style.containerType = 'size';
  return layer;
}

export function fillLiveTextLayer(layer: HTMLElement, lines: LiveLine[], geometry: PageGeometry): void {
  const view = (p: Point) => geometry.toView(p);
  const add = (text: string, topLeft: [number, number], topRight: [number, number], bottomLeft: [number, number]) => {
    const width = Math.hypot(topRight[0] - topLeft[0], topRight[1] - topLeft[1]);
    const height = Math.hypot(bottomLeft[0] - topLeft[0], bottomLeft[1] - topLeft[1]);
    if (width <= 0 || height <= 0) return;
    const angle = (Math.atan2(topRight[1] - topLeft[1], topRight[0] - topLeft[0]) * 180) / Math.PI;
    const natural = naturalWidth(text) * height;
    const span = document.createElement('span');
    span.textContent = text;
    span.style.left = `${(topLeft[0] / geometry.width) * 100}%`;
    span.style.top = `${(topLeft[1] / geometry.height) * 100}%`;
    span.style.fontFamily = FONT;
    span.style.fontSize = `${(height / geometry.height) * 100}cqh`;
    span.style.transform = `rotate(${angle}deg) scaleX(${natural > 0 ? width / natural : 1})`;
    span.style.pointerEvents = 'auto';
    layer.append(span);
  };
  layer.replaceChildren();
  for (const line of lines) {
    line.words.forEach((word, i) => {
      const topLeft = view(word.topLeft);
      const topRight = view(word.topRight);
      const bottomLeft = view(word.bottomLeft);
      add(word.text, topLeft, topRight, bottomLeft);
      // Leerzeichen in der Lücke zum nächsten Wort: Kopierter Text hat so Abstände, Markierungen bleiben lückenlos
      const next = line.words[i + 1];
      if (!next) return;
      const nextLeft = view(next.topLeft);
      const down: [number, number] = [bottomLeft[0] - topLeft[0], bottomLeft[1] - topLeft[1]];
      add(' ', topRight, nextLeft, [topRight[0] + down[0], topRight[1] + down[1]]);
    });
    layer.append(document.createElement('br'));
  }
  // Deckt beim Ziehen die Lücken ab (siehe annotations/selection-drag.ts), wie in der Textebene von pdf.js
  const end = document.createElement('div');
  end.className = 'endOfContent';
  layer.append(end);
}
