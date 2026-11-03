// Textstelle (Textknoten und Zeichenposition) an einem Bildschirmpunkt in der Textebene von pdf.js (oder mehreren:
// pdf.js und Live-Text). Liegt der Punkt zwischen Zeilen oder neben dem Text, gilt die nächstgelegene Stelle (bevorzugt
// in derselben Zeile).
export interface Caret {
  node: Text;
  offset: number;
}

function textNodes(layers: Element[]): Text[] {
  const list: Text[] = [];
  for (const layer of layers) {
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node as Text).data.trim() !== '') list.push(node as Text);
    }
  }
  return list;
}

const distance = (value: number, low: number, high: number) => (value < low ? low - value : value > high ? value - high : 0);

export function caretAt(layer: Element | Element[], x: number, y: number): Caret | null {
  const range = document.createRange();
  let best: { node: Text; score: number } | null = null;
  for (const node of textNodes(Array.isArray(layer) ? layer : [layer])) {
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    // Abstand in der Höhe zählt viel mehr: erst die Zeile, dann die Stelle in der Zeile
    const score = distance(y, box.top, box.bottom) * 1000 + distance(x, box.left, box.right);
    if (!best || score < best.score) best = { node, score };
  }
  if (!best) return null;
  const { node } = best;
  let offset = 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= node.length; i++) {
    // Grenze vor Zeichen i: linke Kante des Zeichens, am Ende die rechte Kante des letzten
    range.setStart(node, Math.min(i, node.length - 1));
    range.setEnd(node, Math.min(i, node.length - 1) + 1);
    const box = range.getBoundingClientRect();
    const edge = i < node.length ? box.left : box.right;
    const gap = Math.abs(edge - x);
    if (gap < nearest) {
      nearest = gap;
      offset = i;
    }
  }
  return { node, offset };
}

// Textbereich zwischen zwei Stellen, gleich in welcher Reihenfolge sie stehen
export function rangeBetween(a: Caret, b: Caret): Range {
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(a.node, a.offset);
  const other = document.createRange();
  other.setStart(b.node, b.offset);
  if (range.compareBoundaryPoints(Range.START_TO_START, other) <= 0) {
    range.setEnd(b.node, b.offset);
  } else {
    range.setStart(b.node, b.offset);
    range.setEnd(a.node, a.offset);
  }
  return range;
}
