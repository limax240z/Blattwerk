import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { boundsOf, normalizeRect, type Point, type Rect } from '../../../shared/annotations';
import { editUnits, LINE_HEIGHT, missingChars, scalingAbout, translation, type EditUnit, type PageObjectInfo, type PageObjects } from '../../../shared/content';
import type { PageGeometry } from '../../engine/coords';
import { getRuntime } from '../../engine/runtime';
import { trackPending } from '../../engine/session';
import { clampMove, clampToRect, maxScale, pageRect } from '../annotations/geometry';
import { useContentEdit, type TextEditing, type TextStyle } from '../../state/content-edit-store';
import { useUi } from '../../state/ui-store';
import { isMixed, runsText, sameStyle, type RunStyle, type TextRun } from '../../../shared/rich-text';
import { RichTextEditor, type RichEditorHandle } from './RichTextEditor';
import { isSystemFontKey } from '../../../shared/fonts';
import { previewFamily, registerPreview } from './system-fonts';
import { addRichText, editParagraph, editText, flowMargins, lineHeight, reflowText, transformObjects } from './actions';
import { registerListTarget } from '../lists/list-bridge';
import { LIST_MENU_ATTRIBUTE } from '../lists/ListControls';
import { textareaListAction, textareaListKey } from '../lists/textarea-lists';
import styles from './ContentEditOverlay.module.css';
import { pageObjects } from './page-objects';

type Gesture =
  // Verschieben: object ist die angefasste Einheit, group alle, die mitwandern (Mehrfachauswahl)
  // client: Zeigerlage beim Anfassen (Fenster); die Vorschau folgt dem Zeiger ohne Neuzeichnen (moveLayer)
  | { kind: 'move'; object: EditUnit; group: EditUnit[]; origin: Point; dx: number; dy: number; client: { x: number; y: number } }
  // Auswahlrechteck auf freier Fläche (Ansichtskoordinaten); additive: Umschalt/Cmd ergänzt die Auswahl
  | { kind: 'marquee'; start: Point; to: Point; additive: boolean }
  // limit: größter Faktor, bei dem das Objekt auf der Seite bleibt
  | { kind: 'scale'; object: EditUnit; fixed: Point; to: Point; limit: number }
  // Breite eines Textes ändern (Anfasser links oder rechts); der Text bricht neu um
  | { kind: 'width'; object: EditUnit; side: 'left' | 'right'; to: Point };

const MIN_EDITOR_PX = 11;
// Rahmen (1 px) und Innenabstand (2 px) der Eingabe links: So beginnt der Text genau an der Klickstelle
const EDITOR_INSET_PX = 3;
// Abstand des Textes zur Seitenkante, wenn er dort automatisch umbricht (Punkt)
const EDGE_GAP = 18;
const pxToUnits = (px: number, scale: number) => px / (scale * (96 / 72));
// Schmalste Breite eines Textes beim Ziehen: zwei Schriftgrößen
const minTextWidth = (object: PageObjectInfo) => 2 * (object.visualSize ?? object.fontSize ?? 12);

// Die Seite wird ungedreht angezeigt (x der Seite läuft nach rechts): nur dann gibt es Anfasser für die Breite
// vorhandener Texte, deren Ränder im PDF links und rechts liegen.
export function isUprightView(geometry: PageGeometry): boolean {
  const [x0, y0] = geometry.toView({ x: 0, y: 0 });
  const [x1, y1] = geometry.toView({ x: 1, y: 0 });
  return x1 > x0 && Math.abs(y1 - y0) < 1e-6;
}

// Leiste „Inhalt bearbeiten“: Klicks dort beenden die Texteingabe nicht (Größe, Schrift, Farbe wirken auf sie)
const inToolbar = (target: EventTarget | null) =>
  target instanceof Element && target.closest(`[data-testid="content-edit-toolbar"], [data-testid="content-size-list"], [data-color-panel], [${LIST_MENU_ATTRIBUTE}]`) !== null;

// Live-Vorschau beim Verschieben und Skalieren: Abbild der Einheit aus dem gezeichneten Seitenbild, dazu die Farbe
// des Hintergrunds um sie herum (verdeckt die alte Stelle, bis die geänderte Seite geladen ist)
interface Ghost {
  href: string;
  background: string;
}

// Ränder (Ansichtseinheiten) um das Objekt, damit Unter- und Oberlängen mitkommen
const GHOST_PAD = 1.5;

// Papierweiß durchsichtig machen („Farbe zu Transparenz“): Nur der Inhalt wandert, der Text darunter bleibt sichtbar
function whiteToAlpha(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const b = data[i + 2] as number;
    const alpha = 1 - Math.min(r, g, b) / 255;
    if (alpha <= 0.01) {
      data[i + 3] = 0;
      continue;
    }
    // Farbe so zurückrechnen, dass sie über Weiß wieder genauso aussieht
    data[i] = Math.round((r - 255 * (1 - alpha)) / alpha);
    data[i + 1] = Math.round((g - 255 * (1 - alpha)) / alpha);
    data[i + 2] = Math.round((b - 255 * (1 - alpha)) / alpha);
    data[i + 3] = Math.round(alpha * (data[i + 3] as number));
  }
  context.putImageData(image, 0, 0);
}

function snapshot(canvas: HTMLCanvasElement | null, geometry: PageGeometry, units: EditUnit[]): Map<number, Ghost> {
  const ghosts = new Map<number, Ghost>();
  if (!canvas || canvas.width === 0) return ghosts;
  const sx = canvas.width / geometry.width;
  const sy = canvas.height / geometry.height;
  // Rand für die Hintergrundfarbe (knapp außerhalb der Ecken)
  const edge = 3;
  for (const unit of units) {
    const r = geometry.rectToView(unit.bounds);
    const x = Math.max(0, (r.x - GHOST_PAD) * sx);
    const y = Math.max(0, (r.y - GHOST_PAD) * sy);
    const w = Math.min(canvas.width - x, (r.w + 2 * GHOST_PAD) * sx);
    const h = Math.min(canvas.height - y, (r.h + 2 * GHOST_PAD) * sy);
    if (w < 1 || h < 1) continue;
    // Ein einziges Zurücklesen von der Grafikkarte: Ausschnitt samt Rand in eine Leinwand im Arbeitsspeicher kopieren
    // und alles Weitere dort lesen (früher fünf Lesevorgänge je Objekt an der Seite selbst, spürbar beim Anfassen)
    const ex = Math.max(0, x - edge);
    const ey = Math.max(0, y - edge);
    const ew = Math.min(canvas.width - ex, w + (x - ex) + edge);
    const eh = Math.min(canvas.height - ey, h + (y - ey) + edge);
    const around = document.createElement('canvas');
    around.width = Math.ceil(ew);
    around.height = Math.ceil(eh);
    const read = around.getContext('2d', { willReadFrequently: true });
    if (!read) continue;
    read.drawImage(canvas, ex, ey, ew, eh, 0, 0, around.width, around.height);
    const pixel = (px: number, py: number) =>
      read.getImageData(Math.min(around.width - 1, Math.max(0, Math.round(px - ex))), Math.min(around.height - 1, Math.max(0, Math.round(py - ey))), 1, 1).data;
    const crop = document.createElement('canvas');
    crop.width = Math.ceil(w);
    crop.height = Math.ceil(h);
    crop.getContext('2d', { willReadFrequently: true })?.drawImage(around, x - ex, y - ey, w, h, 0, 0, crop.width, crop.height);
    // Hintergrund: häufigste Farbe knapp außerhalb der vier Ecken (meist Papierweiß)
    const corners = [pixel(x - 2, y - 2), pixel(x + w + 2, y - 2), pixel(x - 2, y + h + 2), pixel(x + w + 2, y + h + 2)];
    const samples = corners.map((d) => `rgb(${d[0]} ${d[1]} ${d[2]})`);
    const background = [...samples].sort((a, b) => samples.filter((c) => c === b).length - samples.filter((c) => c === a).length)[0] ?? '#fff';
    const light = corners.every((d) => (d[0] ?? 0) + (d[1] ?? 0) + (d[2] ?? 0) > 3 * 225);
    if (light) whiteToAlpha(crop);
    ghosts.set(unit.index, { href: crop.toDataURL('image/png'), background });
  }
  return ghosts;
}

function area([l, b, r, t]: Rect): number {
  return Math.abs(r - l) * Math.abs(t - b);
}

const blank = (unit: EditUnit): boolean => unit.kind === 'text' && (unit.text ?? '').trim() === '';

function corners([l, b, r, t]: Rect): Point[] {
  return [
    { x: l, y: b },
    { x: r, y: b },
    { x: r, y: t },
    { x: l, y: t },
  ];
}

// Gleichmäßiger Faktor beim Ziehen einer Ecke (das Seitenverhältnis bleibt)
function scaleFactor(object: PageObjectInfo, fixed: Point, to: Point, limit = Infinity): number {
  const [l, b, r, t] = object.bounds;
  const width = Math.max(1, r - l);
  const height = Math.max(1, t - b);
  return Math.min(limit, Math.max(0.05, Math.max(Math.abs(to.x - fixed.x) / width, Math.abs(to.y - fixed.y) / height)));
}

function previewBounds(object: PageObjectInfo, gesture: Gesture | null): Rect {
  if (!gesture || gesture.kind === 'marquee') return object.bounds;
  const [l, b, r, t] = object.bounds;
  if (gesture.kind === 'move') {
    return gesture.group.some((unit) => unit.index === object.index) ? [l + gesture.dx, b + gesture.dy, r + gesture.dx, t + gesture.dy] : object.bounds;
  }
  if (gesture.object.index !== object.index) return object.bounds;
  if (gesture.kind === 'width') {
    const min = minTextWidth(object);
    return gesture.side === 'left' ? [Math.min(gesture.to.x, r - min), b, r, t] : [l, b, Math.max(gesture.to.x, l + min), t];
  }
  const f = scaleFactor(object, gesture.fixed, gesture.to, gesture.limit);
  const { x, y } = gesture.fixed;
  return normalizeRect([x + (l - x) * f, y + (b - y) * f, x + (r - x) * f, y + (t - y) * f]);
}

interface Props {
  tabId: string;
  pageIndex: number;
  geometry: PageGeometry;
  scale: number;
}

// Text und Bilder einer Seite im Modus „Inhalt bearbeiten“
export function ContentEditOverlay({ tabId, pageIndex, geometry, scale }: Props) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [listing, setListing] = useState<PageObjects | null>(null);
  // Dokumentstand, zu dem listing gehört (nach einer Änderung kommt die neue Liste erst etwas später)
  const [listingSource, setListingSource] = useState<unknown>(null);
  // Vorschau nach dem Loslassen, bis der neu gesetzte Text geladen ist (kein kurzes Aufblitzen des alten Textes)
  const [afterglow, setAfterglow] = useState<{ unit: EditUnit; bounds: Rect; source: unknown } | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  // Abbilder der bewegten Einheiten (bis zum Neuladen der geänderten Seite)
  const [ghosts, setGhosts] = useState<Map<number, Ghost> | null>(null);
  const pageCanvas = () => svgRef.current?.closest('.page')?.querySelector<HTMLCanvasElement>('.canvasWrapper canvas') ?? null;
  const gestureRef = useRef<Gesture | null>(null);
  const tool = useContentEdit((s) => s.tool);
  const selected = useContentEdit((s) => s.selected[tabId] ?? null);
  const editing = useContentEdit((s) => (s.editing?.tabId === tabId && s.editing.pageIndex === pageIndex ? s.editing : null));
  const pending = useContentEdit((s) => s.pending[tabId] ?? null);
  const runtime = getRuntime(tabId);
  const pdf = runtime?.pdf ?? null;

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    void pageObjects(pdf, runtime?.password ?? null, pageIndex).then((result) => {
      if (cancelled) return;
      setListing(result);
      setListingSource(pdf);
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, pageIndex, runtime?.password]);

  const objects = useMemo(() => editUnits(listing?.objects ?? [], listing?.fonts), [listing]);
  // Zum Anklicken: Text über Bildern und Grafiken, innerhalb einer Art die kleineren oben
  const stacked = useMemo(() => [...objects].sort((a, b) => Number(a.kind === 'text') - Number(b.kind === 'text') || area(b.bounds) - area(a.bounds)), [objects]);

  const frame = useRef(0);
  const moveLayer = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const setGesture = (next: Gesture | null) => {
    gestureRef.current = next;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    setGestureState(next);
  };

  // Während des Ziehens höchstens einmal je Bild neu zeichnen (Rahmen, Größe, Breite). Verschieben zeichnet gar nicht
  // neu: Die Vorschau liegt in einer eigenen Ebene und wird nur verschoben (das übernimmt die Grafikkarte; unter
  // Windows hing sie sonst spürbar hinterher, weil jede Bewegung die ganze Ebene der Seite neu zeichnete).
  const scheduleGesture = (next: Gesture) => {
    gestureRef.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const current = gestureRef.current;
      if (!current) return;
      if (current.kind === 'move') {
        // Versatz aus dem (auf die Seite begrenzten) Verschieben in PDF-Punkten, umgerechnet in Bildschirmpixel
        const layer = moveLayer.current;
        const box = svgRef.current?.getBoundingClientRect();
        if (layer && box && box.width > 0) {
          const [ox, oy] = geometry.toView(current.origin);
          const [mx, my] = geometry.toView({ x: current.origin.x + current.dx, y: current.origin.y + current.dy });
          layer.style.transform = `translate(${((mx - ox) / geometry.width) * box.width}px, ${((my - oy) / geometry.height) * box.height}px)`;
        }
      } else {
        setGestureState(current);
      }
    });
  };

  const toPdf = (event: { clientX: number; clientY: number }): Point => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return { x: 0, y: 0 };
    return geometry.toPdf(((event.clientX - box.left) / box.width) * geometry.width, ((event.clientY - box.top) / box.height) * geometry.height);
  };

  const toView = (event: { clientX: number; clientY: number }): Point => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return { x: 0, y: 0 };
    return { x: ((event.clientX - box.left) / box.width) * geometry.width, y: ((event.clientY - box.top) / box.height) * geometry.height };
  };

  const store = useContentEdit.getState;

  const onBackgroundPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (tool === 'select' && event.button === 0 && !editing) {
      // Auswahlrechteck aufziehen
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const at = toView(event);
      setGesture({ kind: 'marquee', start: at, to: at, additive: event.shiftKey || event.metaKey });
      return;
    }
    if ((tool !== 'text' && tool !== 'flow') || event.button !== 0 || editing) return;
    event.preventDefault();
    const at = toView(event);
    if (tool === 'flow' && isUprightView(geometry)) {
      // Fließtext: Zeile der Klickstelle, über die ganze Breite zwischen den Seitenrändern
      const margins = flowMargins(geometry.width, geometry.height);
      const half = lineHeight(store().style.size) / 2;
      store().setEditing({ tabId, pageIndex, mode: 'new', at: { x: margins.left, y: Math.min(Math.max(at.y, margins.top + half), geometry.height - margins.bottom - half) }, flow: true });
    } else {
      // Neuer Text: Eingabe an der Klickstelle (in der Ansicht, damit sie auch auf gedrehten Seiten aufrecht steht)
      store().setEditing({ tabId, pageIndex, mode: 'new', at });
    }
    store().setTool('select');
  };

  const onObjectPointerDown = (event: ReactPointerEvent, object: EditUnit) => {
    if (tool !== 'select' || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = groupUnits();
    if (event.shiftKey || event.metaKey) {
      // Umschalt/Cmd: zur Auswahl hinzufügen oder herausnehmen
      const included = current.some((unit) => unit.index === object.index);
      selectUnits(included ? current.filter((unit) => unit.index !== object.index) : [...current, object]);
      return;
    }
    // Angefasste Einheit gehört zur Mehrfachauswahl: alle wandern mit, sonst nur sie
    const group = current.length > 1 && current.some((unit) => unit.index === object.index) ? current : [object];
    if (group.length === 1) selectUnits([object]);
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    setGhosts(snapshot(pageCanvas(), geometry, group));
    setGesture({ kind: 'move', object, group, origin: toPdf(event), dx: 0, dy: 0, client: { x: event.clientX, y: event.clientY } });
  };

  // Ausgewählte Einheiten dieser Seite, aus der aktuellen Liste (Lage und Text immer aktuell)
  const groupUnits = (): EditUnit[] => {
    const current = store().selected[tabId];
    if (!current || current.pageIndex !== pageIndex) return [];
    const indices = current.group ? current.group.map((unit) => unit.index) : [current.index];
    return objects.filter((object) => indices.includes(object.index));
  };

  // Auswahl setzen: keine, eine (mit Anfassern) oder mehrere; die zuletzt hinzugefügte ist die Haupteinheit
  const selectUnits = (units: EditUnit[]) => {
    const last = units[units.length - 1];
    if (!last) {
      store().select(tabId, null);
      return;
    }
    store().select(tabId, {
      pageIndex,
      index: last.index,
      members: last.members,
      unit: last,
      ...(units.length > 1 ? { group: units.map((unit) => ({ index: unit.index, members: unit.members })) } : {}),
    });
  };

  // Alle Einheiten, die das Rechteck berührt (in Ansichtskoordinaten verglichen, auch bei gedrehten Seiten). Linien und
  // Flächen nur, wenn das Rechteck sie ganz umschließt (sonst erfasst jeder Rahmen über einer Tabelle ihre Linien).
  // Leere Textstücke (Leerzeichen) kommen mit, damit beim Löschen nichts davon zurückbleibt.
  const selectInView = (x0: number, x1: number, y0: number, y1: number, additive: boolean) => {
    const hit = objects.filter((object) => {
      const r = geometry.rectToView(object.bounds);
      if (object.kind === 'path') return r.x >= x0 - 1 && r.x + r.w <= x1 + 1 && r.y >= y0 - 1 && r.y + r.h <= y1 + 1;
      return r.x <= x1 && r.x + r.w >= x0 && r.y <= y1 && r.y + r.h >= y0 && (!blank(object) || (r.x >= x0 && r.x + r.w <= x1 && r.y >= y0 && r.y + r.h <= y1));
    });
    const base = additive ? groupUnits().filter((unit) => !hit.some((other) => other.index === unit.index)) : [];
    selectUnits([...base, ...hit]);
  };

  // Rahmen, der neben der Seite begann (useContentEditInput): in Ansichtskoordinaten dieser Seite umrechnen
  const marquee = useContentEdit((s) => (s.marquee?.tabId === tabId && s.marquee.pageIndex === pageIndex ? s.marquee : null));
  useEffect(() => {
    if (!marquee) return;
    useContentEdit.getState().setMarquee(null);
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    const vx = (clientX: number) => ((clientX - box.left) / box.width) * geometry.width;
    const vy = (clientY: number) => ((clientY - box.top) / box.height) * geometry.height;
    selectInView(vx(marquee.left), vx(marquee.right), vy(marquee.top), vy(marquee.bottom), marquee.additive);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur auf eine neue Anfrage reagieren
  }, [marquee]);

  const onHandlePointerDown = (event: ReactPointerEvent, object: EditUnit, corner: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    const points = corners(object.bounds);
    setGhosts(snapshot(pageCanvas(), geometry, [object]));
    const fixed = points[(corner + 2) % 4] as Point;
    setGesture({ kind: 'scale', object, fixed, to: toPdf(event), limit: maxScale(object.bounds, fixed, pageRect(geometry)) });
  };

  const onSidePointerDown = (event: ReactPointerEvent, object: EditUnit, side: 'left' | 'right') => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    setGesture({ kind: 'width', object, side, to: toPdf(event) });
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const current = gestureRef.current;
    if (!current) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    if (current.kind === 'marquee') {
      scheduleGesture({ ...current, to: toView(event) });
      return;
    }
    const at = toPdf(event);
    if (current.kind === 'move') {
      // Text und Bilder nicht über den Seitenrand hinaus verschieben
      const bounds = boundsOf(current.group.flatMap(({ bounds: [l, b, r, t] }) => [{ x: l, y: b }, { x: r, y: t }]));
      scheduleGesture({ ...current, ...clampMove(bounds, at.x - current.origin.x, at.y - current.origin.y, pageRect(geometry)) });
    } else if (current.kind === 'scale') scheduleGesture({ ...current, to: at });
    else scheduleGesture({ ...current, to: current.kind === 'width' ? clampToRect(at, pageRect(geometry)) : at });
  };

  const finish = () => {
    const current = gestureRef.current;
    setGesture(null);
    if (!current) return;
    if (current.kind === 'marquee') {
      const x0 = Math.min(current.start.x, current.to.x);
      const x1 = Math.max(current.start.x, current.to.x);
      const y0 = Math.min(current.start.y, current.to.y);
      const y1 = Math.max(current.start.y, current.to.y);
      if (x1 - x0 < 2 && y1 - y0 < 2) return;
      selectInView(x0, x1, y0, y1, current.additive);
      return;
    }
    const bounds = previewBounds(current.object, current);
    if (current.kind === 'width') {
      const [l, , r] = current.object.bounds;
      if (Math.abs(bounds[0] - l) < 0.5 && Math.abs(bounds[2] - r) < 0.5) return;
      setAfterglow({ unit: current.object, bounds, source: pdf });
      void reflowText(tabId, pageIndex, current.object, current.object.text ?? '', { box: { left: bounds[0], right: bounds[2] }, bounds }).then((done) => {
        if (!done) setAfterglow(null);
      });
      return;
    }
    if (current.kind === 'move') {
      if (Math.hypot(current.dx, current.dy) < 0.5) {
        setGhosts(null);
        return;
      }
      const moved = current.group.map((unit) => ({ index: unit.index, members: unit.members, bounds: previewBounds(unit, current) }));
      void transformObjects(tabId, pageIndex, moved, translation(current.dx, current.dy));
      return;
    }
    const factor = scaleFactor(current.object, current.fixed, current.to, current.limit);
    if (Math.abs(factor - 1) < 0.01) {
      setGhosts(null);
      return;
    }
    void transformObjects(tabId, pageIndex, [{ index: current.object.index, members: current.object.members, bounds }], scalingAbout(factor, current.fixed.x, current.fixed.y));
  };

  // Text bearbeiten: immer die ganze Zeile, auch wenn das PDF sie in mehreren Stücken speichert (siehe editUnits)
  const startEdit = (unit: EditUnit) => {
    if (unit.kind !== 'text') return;
    store().select(tabId, { pageIndex, index: unit.index, members: unit.members, unit });
    store().setEditing({
      tabId,
      pageIndex,
      mode: 'edit',
      index: unit.index,
      merge: unit.members.filter((member) => member !== unit.index),
      bounds: unit.bounds,
      text: unit.text ?? '',
      fontSize: unit.visualSize ?? unit.fontSize ?? 12,
      ...(unit.font ? { font: unit.font } : {}),
      ...(unit.lines ? { lines: unit.lines } : {}),
      ...(unit.color ? { color: unit.color } : {}),
      // Von Blattwerk gesetzter Text: mit gemischter Gestaltung bearbeiten
      ...(unit.runs && unit.origin ? { runs: unit.runs, origin: unit.origin, ...(unit.mark?.w ? { width: unit.mark.w } : {}) } : {}),
    });
  };

  const handleSize = pxToUnits(8, scale);
  const upright = isUprightView(geometry);

  // Nach dem Neusetzen eines Textes ist er wieder ausgewählt (Größe, Schrift, Farbe lassen sich weiter ändern)
  const reselect = useContentEdit((s) => (s.reselect?.tabId === tabId && s.reselect.pageIndex === pageIndex ? s.reselect : null));
  useEffect(() => {
    if (!reselect || !listing || listing.pageIndex !== pageIndex || listingSource !== pdf) return;
    const { x, y } = reselect.at;
    const unit = objects.find((object) => object.kind === 'text' && object.bounds[0] - 2 <= x && x <= object.bounds[2] && object.bounds[1] <= y && y <= object.bounds[3] + 2);
    if (!unit) return;
    useContentEdit.getState().setReselect(null);
    useContentEdit.getState().select(tabId, { pageIndex, index: unit.index, members: unit.members, unit });
  }, [reselect, listing, listingSource, pdf, objects, tabId, pageIndex]);

  return (
    <>
      <svg
        ref={svgRef}
        className={[styles.svg, tool === 'text' || tool === 'flow' ? styles.creating : '', tool === 'select' && !editing ? styles.selecting : '', gesture ? styles.capturing : ''].join(' ')}
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        preserveAspectRatio="none"
        onPointerDown={onBackgroundPointerDown}
        onMouseDown={(event) => {
          if (tool === 'text' || tool === 'flow' || gestureRef.current) event.preventDefault();
        }}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={() => setGesture(null)}
        data-testid={`content-edit-overlay-${pageIndex}`}
        data-content-edit-overlay=""
        data-page-index={pageIndex}
      >
        {ghosts && gesture?.kind === 'move' && (
          // Beim Verschieben: die alte Stelle abdecken; das Abbild selbst wandert in der eigenen Ebene (unten)
          <g className={styles.ghosts}>
            {[...ghosts].map(([index, ghost]) => {
              const unit = objects.find((object) => object.index === index);
              if (!unit) return null;
              const from = geometry.rectToView(unit.bounds);
              return <rect key={index} x={from.x - GHOST_PAD} y={from.y - GHOST_PAD} width={from.w + 2 * GHOST_PAD} height={from.h + 2 * GHOST_PAD} fill={ghost.background} />;
            })}
          </g>
        )}
        {ghosts && (gesture?.kind === 'scale' || (!gesture && pending?.pageIndex === pageIndex)) && (
          <g className={styles.ghosts} data-testid="content-ghosts">
            {[...ghosts].map(([index, ghost]) => {
              const unit = objects.find((object) => object.index === index);
              if (!unit) return null;
              const target = gesture ? previewBounds(unit, gesture) : pending?.bounds[index];
              if (!target) return null;
              const from = geometry.rectToView(unit.bounds);
              const to = geometry.rectToView(target);
              // Rand im Verhältnis der neuen Größe (beim Skalieren wächst er mit)
              const fx = from.w > 0 ? to.w / from.w : 1;
              const fy = from.h > 0 ? to.h / from.h : 1;
              return (
                <g key={index}>
                  <rect x={from.x - GHOST_PAD} y={from.y - GHOST_PAD} width={from.w + 2 * GHOST_PAD} height={from.h + 2 * GHOST_PAD} fill={ghost.background} />
                  <image
                    href={ghost.href}
                    x={to.x - GHOST_PAD * fx}
                    y={to.y - GHOST_PAD * fy}
                    width={to.w + 2 * GHOST_PAD * fx}
                    height={to.h + 2 * GHOST_PAD * fy}
                    preserveAspectRatio="none"
                    data-testid="content-ghost"
                  />
                </g>
              );
            })}
          </g>
        )}
        {/* Text oben, sonst kleine Objekte oben: Text auf einem Bild oder einer Fläche bleibt anklickbar, auch wenn das
            Bild später im Seiteninhalt steht. Leere Textstücke (nur Leerzeichen) erscheinen nicht. */}
        {stacked.map((object) => {
          const moving = pending?.pageIndex === pageIndex ? pending.bounds[object.index] : undefined;
          const r = geometry.rectToView(moving ?? previewBounds(object, gesture));
          const isSelected =
            selected?.pageIndex === pageIndex && (selected.index === object.index || (selected.group?.some((unit) => unit.index === object.index) ?? false));
          const hidden = editing?.mode === 'edit' && editing.index === object.index;
          // Leere Textstücke (Leerzeichen ohne Zeile) sind unsichtbar und nicht anklickbar
          if (hidden || blank(object)) return null;
          return (
            <rect
              key={object.index}
              className={[styles.object, styles[object.kind] ?? '', isSelected ? styles.selected : '', tool !== 'select' ? styles.passive : ''].join(' ')}
              x={r.x}
              y={r.y}
              width={Math.max(r.w, 2)}
              height={Math.max(r.h, 2)}
              onPointerDown={(event) => onObjectPointerDown(event, object)}
              onDoubleClick={() => (object.kind === 'image' ? useUi.getState().notify(t('contentEdit.imageText')) : object.kind === 'text' ? startEdit(object) : undefined)}
              data-testid="content-object"
              data-kind={object.kind}
              data-text={object.text}
              data-index={object.index}
              data-selected={isSelected || undefined}
            >
              <title>{object.kind === 'text' ? object.text : t(`contentEdit.kinds.${object.kind}`)}</title>
            </rect>
          );
        })}
        {objects
          .filter((object) => selected?.pageIndex === pageIndex && !selected.group && selected.index === object.index && tool === 'select' && !editing && gesture?.kind !== 'move')
          // eslint-disable-next-line react-hooks/refs -- Refs werden nur in den Zeiger-Handlern gelesen, nicht beim Zeichnen
          .map((object) => {
            const bounds = (pending?.pageIndex === pageIndex ? pending.bounds[object.index] : undefined) ?? previewBounds(object, gesture);
            return (
              <g key={`handles-${object.index}`} data-testid="content-selection">
                {corners(bounds).map((p, i) => {
                  const [x, y] = geometry.toView(p);
                  return (
                    <rect
                      key={i}
                      className={styles.handle}
                      x={x - handleSize / 2}
                      y={y - handleSize / 2}
                      width={handleSize}
                      height={handleSize}
                      onPointerDown={(event) => onHandlePointerDown(event, object, i)}
                      data-handle={`corner-${i}`}
                    />
                  );
                })}
                {object.kind === 'text' &&
                  object.upright &&
                  upright &&
                  (['left', 'right'] as const).map((side) => {
                    const [l, b, r, top] = bounds;
                    const [x, y] = geometry.toView({ x: side === 'left' ? l : r, y: (b + top) / 2 });
                    return (
                      <rect
                        key={side}
                        className={styles.sideHandle}
                        x={x - handleSize / 2}
                        y={y - handleSize}
                        width={handleSize}
                        height={handleSize * 2}
                        onPointerDown={(event) => onSidePointerDown(event, object, side)}
                        data-testid={`content-width-${side}`}
                      />
                    );
                  })}
              </g>
            );
          })}
        {gesture?.kind === 'marquee' && (
          <rect
            className={styles.marquee}
            x={Math.min(gesture.start.x, gesture.to.x)}
            y={Math.min(gesture.start.y, gesture.to.y)}
            width={Math.abs(gesture.to.x - gesture.start.x)}
            height={Math.abs(gesture.to.y - gesture.start.y)}
            data-testid="content-marquee"
          />
        )}
      </svg>
      {ghosts && gesture?.kind === 'move' && (
        <div ref={moveLayer} className={styles.moveLayer} data-testid="content-move-layer">
          {[...ghosts].map(([index, ghost]) => {
            const unit = objects.find((object) => object.index === index);
            if (!unit) return null;
            const from = geometry.rectToView(unit.bounds);
            const percent = (value: number, total: number) => `${(value / total) * 100}%`;
            return (
              <img
                key={index}
                src={ghost.href}
                alt=""
                draggable={false}
                className={styles.moveGhost}
                style={{
                  left: percent(from.x - GHOST_PAD, geometry.width),
                  top: percent(from.y - GHOST_PAD, geometry.height),
                  width: percent(from.w + 2 * GHOST_PAD, geometry.width),
                  height: percent(from.h + 2 * GHOST_PAD, geometry.height),
                }}
                data-testid="content-ghost"
              />
            );
          })}
        </div>
      )}
      {(() => {
        // Live-Vorschau beim Ziehen der Breite: der Text bricht sofort in der neuen Breite um
        const live =
          gesture?.kind === 'width'
            ? { unit: gesture.object, bounds: previewBounds(gesture.object, gesture) }
            : afterglow && afterglow.source === listingSource
              ? afterglow
              : null;
        return live ? <WidthPreview unit={live.unit} bounds={live.bounds} geometry={geometry} scale={scale} listing={listing} /> : null;
      })()}
      {editing && <TextEditor editing={editing} geometry={geometry} scale={scale} listing={listing} />}
    </>
  );
}

// Vorschau eines Textes in neuer Breite: deckt den bisherigen Text ab und zeigt den Text mit einer ähnlichen Schrift
// umbrochen. Endgültig setzt ihn danach PDFium mit den echten Zeichenbreiten.
function WidthPreview({ unit, bounds, geometry, scale, listing }: { unit: EditUnit; bounds: Rect; geometry: PageGeometry; scale: number; listing: PageObjects | null }) {
  const viewScale = scale * (96 / 72);
  const size = unit.visualSize ?? unit.fontSize ?? 12;
  const lines = unit.lines?.length ?? 1;
  // Zeilenabstand wie im Absatz (aus Höhe und Zeilenzahl), sonst 1,2
  const step = lines > 1 ? Math.max(size, (unit.bounds[3] - unit.bounds[1] - size) / (lines - 1)) : size * LINE_HEIGHT;
  const old = geometry.rectToView(unit.bounds);
  const box = geometry.rectToView(bounds);
  const color = unit.color;
  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  return (
    <>
      <div
        className={styles.previewMask}
        style={{ left: percent(old.x, geometry.width), top: percent(old.y, geometry.height), width: percent(old.w, geometry.width), height: percent(old.h, geometry.height) }}
      />
      <div
        className={styles.preview}
        style={{
          left: percent(box.x, geometry.width),
          top: percent(box.y, geometry.height),
          width: percent(box.w, geometry.width),
          fontSize: `${size * viewScale}px`,
          lineHeight: `${step * viewScale}px`,
          ...lookOf(listing?.fonts[unit.font ?? '']?.name ?? ''),
          color: color ? `rgb(${color.r * 255} ${color.g * 255} ${color.b * 255})` : undefined,
        }}
        data-testid="content-width-preview"
      >
        {unit.text}
      </div>
    </>
  );
}

// Schriftschnitt der Eingabe ähnlich der Schrift der Zeile (fett, mit Serifen, Schreibmaschine)
function lookOf(name: string): { fontWeight: number; fontFamily: string } {
  const lower = name.toLowerCase();
  const fontFamily = /courier|mono/.test(lower) ? 'Courier, monospace' : /times|serif|roman/.test(lower) && !/sans/.test(lower) ? 'Times, serif' : 'Helvetica, Arial, sans-serif';
  return { fontWeight: /bold|black|heavy/.test(lower) ? 700 : 400, fontFamily };
}

// Dasselbe als Stilangaben für eine Spanne (Werte als Zeichenketten)
function lookCss(name: string): CSSProperties {
  const look = lookOf(name);
  return { fontFamily: look.fontFamily, fontWeight: String(look.fontWeight) };
}

// Eingabe für neuen Text oder eine vorhandene Zeile, direkt auf der Seite. Neuer Text und von Blattwerk gesetzter Text
// lassen sich gemischt gestalten (RichTextEditor), Text aus anderen Programmen nur als Ganzes (Textfeld).
function TextEditor({ editing, geometry, scale, listing }: { editing: TextEditing; geometry: PageGeometry; scale: number; listing: PageObjects | null }) {
  const { t } = useTranslation();
  const style = useContentEdit((s) => s.style);
  const initial = editing.mode === 'edit' ? editing.text : '';
  const rich = editing.mode === 'new' || editing.runs !== undefined;
  const [initialRuns] = useState<TextRun[]>(() => (editing.mode === 'edit' ? (editing.runs ?? []) : []));
  const [runs, setRuns] = useState<TextRun[]>(initialRuns);
  const [plain, setPlain] = useState(initial);
  const value = rich ? runsText(runs) : plain;
  const ref = useRef<HTMLTextAreaElement>(null);
  const richRef = useRef<RichEditorHandle | null>(null);
  const done = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewScale = scale * (96 / 72);
  // Gestaltung beim Öffnen: Lage der Eingabe für neuen Text (bleibt stehen, auch wenn sich die Größe danach ändert)
  const [opening] = useState<TextStyle>(style);
  // Fließtext: Breite zwischen den Seitenrändern
  const flow = editing.mode === 'new' && editing.flow === true;
  const margins = flowMargins(geometry.width, geometry.height);
  // Vom Nutzer gezogene Breite (Ansichtseinheiten = Punkt); null = wie vorgegeben
  const [frame, setFrame] = useState<{ left: number; width: number } | null>(() =>
    flow ? { left: margins.left - EDITOR_INSET_PX / viewScale, width: geometry.width - margins.left - margins.right + (2 * EDITOR_INSET_PX) / viewScale } : null,
  );
  const resizable = editing.mode === 'new' || isUprightView(geometry);
  const restyle = editing.mode === 'edit' ? editing.style : undefined;

  // Bei kleinem Zoom bleibt die Eingabe lesbar, auch wenn sie dann etwas größer ist als der Text auf der Seite.
  const pointSize = editing.mode === 'edit' ? (restyle?.size ?? editing.fontSize) : rich ? opening.size : style.size;
  const fontSize = Math.max(MIN_EDITOR_PX, pointSize * viewScale);
  // Neuer Text: Eingabe so legen, dass der Text an der Klickstelle beginnt und die erste Zeile mittig auf ihr liegt
  const box =
    editing.mode === 'edit'
      ? geometry.rectToView(editing.bounds)
      : { x: editing.at.x - EDITOR_INSET_PX / viewScale, y: editing.at.y - (fontSize * LINE_HEIGHT) / 2 / viewScale - 1 / viewScale, w: 0, h: 0 };
  const left = frame?.left ?? box.x;
  // Neuer Text am unteren Seitenrand: so weit nach oben, dass alle Zeilen auf die Seite passen
  const [lift, setLift] = useState(0);
  const top = box.y - lift;
  // Rechter Rand für Text: Wird er erreicht, bricht der Text dort um (wie beim Ziehen der Breite), statt über die
  // Seite hinauszulaufen. Vorhandener Text, der schon breiter ist, bleibt, wie er ist.
  const limit = geometry.width - EDGE_GAP;
  const autoWrap = resizable && !flow && (editing.mode === 'new' || box.x + box.w <= limit);
  const fit = () => {
    const wrap = wrapRef.current;
    const editor = wrap?.firstElementChild;
    const container = wrap?.offsetParent;
    if (!wrap || !editor || !container) return;
    const pxPerUnit = container.getBoundingClientRect().width / geometry.width;
    if (!(pxPerUnit > 0)) return;
    const size = editor.getBoundingClientRect();
    if (autoWrap && !frame && (editing.mode === 'new' || value !== initial)) {
      const width = size.width / pxPerUnit;
      if (left + width > limit + 0.5) {
        const min = (6 * fontSize) / viewScale;
        // Klick dicht an der Kante: Anfang so weit nach links, dass wenigstens ein paar Wörter Platz haben
        const start = editing.mode === 'new' ? Math.max(0, Math.min(left, limit - min)) : left;
        if (limit - start > 0) setFrame({ left: start, width: limit - start });
      }
    }
    if (editing.mode === 'new' && !flow) {
      const overflow = box.y + size.height / pxPerUnit - (geometry.height - EDGE_GAP / 2);
      setLift(Math.max(0, Math.min(box.y, overflow)));
    }
  };
  // Bei jeder Größenänderung der Eingabe (Tippen, andere Schriftgröße) prüfen; fitRef hält den neuesten Stand
  const fitRef = useRef(fit);
  useEffect(() => {
    fitRef.current = fit;
  });
  useEffect(() => {
    const editor = wrapRef.current?.firstElementChild;
    if (!editor) return;
    const observer = new ResizeObserver(() => fitRef.current());
    observer.observe(editor);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.focus({ preventScroll: true });
    area.setSelectionRange(area.value.length, area.value.length);
    // Aufzählung, Nummerierung und Einzug aus der Leiste (die Eingabe mit gemischter Gestaltung meldet sich selbst an)
    return registerListTarget({ apply: (action) => textareaListAction(area, action, setPlain) });
  }, []);

  const font = editing.mode === 'edit' && editing.font ? listing?.fonts[editing.font] : undefined;
  // Schrift des Rechners: wird eingebettet und hat (fast) alle Zeichen, keine Warnung
  const chosen = editing.mode === 'new' ? style.font : restyle?.font;
  const embedded = chosen !== undefined && isSystemFontKey(chosen);
  const plainMissing = embedded ? '' : editing.mode === 'edit' ? missingChars(value, font) : missingChars(value, undefined);
  const plainImpossible = embedded ? '' : missingChars(value, undefined);
  const { missing, impossible } = rich ? runWarnings(runs, listing) : { missing: plainMissing, impossible: plainImpossible };
  const previewFonts = rich ? runs.map((run) => run.font ?? '').join(' ') : (chosen ?? '');
  useEffect(() => {
    for (const key of new Set([...previewFonts.split(' '), style.font])) if (key && isSystemFontKey(key)) void registerPreview(key);
  }, [previewFonts, style.font]);

  // Anzeige eines Stücks in der Eingabe (Größe in Bildpunkten der Ansicht, Schrift ähnlich der auf der Seite)
  const cssFor = (run: RunStyle): CSSProperties => {
    const family = run.font ?? (run.key ? (listing?.fonts[run.key]?.name ?? '') : '');
    return {
      fontSize: `${Math.max(MIN_EDITOR_PX, run.size * viewScale)}px`,
      lineHeight: '1.2',
      ...(isSystemFontKey(family) ? { fontFamily: `"${previewFamily(family)}", Helvetica, sans-serif`, fontWeight: '400' } : lookCss(family)),
      color: `rgb(${run.color.r * 255} ${run.color.g * 255} ${run.color.b * 255})`,
    };
  };

  const commitRich = () => {
    const current = richRef.current?.runs() ?? runs;
    const y = box.y;
    if (editing.mode === 'new') {
      // Oberkante der ersten Zeile: innerhalb des Rahmens der Eingabe; der Text beginnt dort, wo die Eingabe steht
      const origin = geometry.toPdf(editing.at.x + (left - box.x), top + 1 / viewScale);
      const width = frame ? frame.width - (2 * EDITOR_INSET_PX) / viewScale : undefined;
      // Fließtext: unterhalb des unteren Rands geht es auf einer neuen Seite oben am Rand weiter
      const flowLimits = flow ? { top: geometry.toPdf(margins.left, margins.top).y, bottom: geometry.toPdf(margins.left, geometry.height - margins.bottom).y } : undefined;
      void trackPending(editing.tabId, addRichText(editing.tabId, editing.pageIndex, origin, current, { ...(width ? { width } : {}), ...(flowLimits ? { flow: flowLimits } : {}) }));
      return;
    }
    const text = runsText(current);
    const members = [editing.index, ...editing.merge];
    const unit = { index: editing.index, members, bounds: editing.bounds, ...(editing.lines ? { lines: editing.lines } : {}) };
    const sides = frame ? { left: geometry.toPdf(frame.left, y).x, right: geometry.toPdf(frame.left + frame.width, y).x } : undefined;
    const [before] = initialRuns;
    const [after] = current;
    if (!isMixed(initialRuns) && !isMixed(current)) {
      // Einheitlich vorher und nachher: wie bisher (behält die Objekte, wo es geht)
      const changed = before && after && !sameStyle(before, after);
      if (sides || changed) {
        const restyled = changed && after ? { size: after.size, color: after.color, ...(after.font !== undefined ? { font: after.font } : {}) } : undefined;
        void trackPending(editing.tabId, reflowText(editing.tabId, editing.pageIndex, unit, text, { ...(sides ? { box: sides } : {}), ...(restyled ? { style: restyled } : {}) }));
      } else if (editing.lines) void trackPending(editing.tabId, editParagraph(editing.tabId, editing.pageIndex, editing.lines, text, initial));
      else void trackPending(editing.tabId, editText(editing.tabId, editing.pageIndex, editing.index, editing.merge, text, initial));
      return;
    }
    // Gemischt: an derselben Stelle neu setzen (gezogene Ränder verschieben den Anfang und ändern die Breite)
    const origin = editing.origin ?? { x: editing.bounds[0], y: editing.bounds[3] };
    const x = origin.x + (sides ? sides.left - editing.bounds[0] : 0);
    const width = sides ? sides.right - x : editing.width;
    void trackPending(editing.tabId, addRichText(editing.tabId, editing.pageIndex, { x, y: origin.y }, current, { ...(width ? { width } : {}), replace: members }));
  };

  const commit = () => {
    if (done.current) return;
    done.current = true;
    useContentEdit.getState().setEditing(null);
    if (impossible) return;
    if (rich) {
      commitRich();
      return;
    }
    if (editing.mode === 'edit' && (frame || (restyle && Object.keys(restyle).length > 0))) {
      // Neue Breite oder Gestaltung: Zeile bzw. Absatz neu setzen (bricht in der Breite um)
      const y = box.y;
      const change = {
        ...(frame ? { box: { left: geometry.toPdf(frame.left, y).x, right: geometry.toPdf(frame.left + frame.width, y).x } } : {}),
        ...(restyle ? { style: restyle } : {}),
      };
      const unit = { index: editing.index, members: [editing.index, ...editing.merge], bounds: editing.bounds, ...(editing.lines ? { lines: editing.lines } : {}) };
      void trackPending(editing.tabId, reflowText(editing.tabId, editing.pageIndex, unit, value, change));
    } else if (editing.mode === 'edit' && editing.lines) {
      void trackPending(editing.tabId, editParagraph(editing.tabId, editing.pageIndex, editing.lines, value, initial));
    } else if (editing.mode === 'edit') {
      void trackPending(editing.tabId, editText(editing.tabId, editing.pageIndex, editing.index, editing.merge, value, initial));
    }
  };

  // Ein Klick irgendwo außerhalb der Eingabe übernimmt den Text, auch auf ein anderes Objekt (dessen Ziehen sonst
  // den Fokus in der Eingabe hält) oder in die Werkzeugleiste. Der Klick wirkt danach wie gewohnt weiter.
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return;
      if (inToolbar(event.target)) return;
      commitRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  const cancel = () => {
    done.current = true;
    useContentEdit.getState().setEditing(null);
  };

  const paragraph = editing.mode === 'edit' && editing.lines !== undefined;
  const focusEditor = () => (rich ? wrapRef.current?.querySelector<HTMLElement>('[data-testid="content-text-editor"]') : ref.current)?.focus({ preventScroll: true });

  // Breite ziehen: Anfasser links und rechts der Eingabe
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>, side: 'left' | 'right') => {
    const wrap = wrapRef.current;
    const container = wrap?.offsetParent;
    if (!wrap || !container || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pxPerUnit = container.getBoundingClientRect().width / geometry.width;
    const startX = event.clientX;
    const startLeft = left;
    const startWidth = wrap.getBoundingClientRect().width / pxPerUnit;
    const min = (2 * fontSize) / viewScale;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - startX) / pxPerUnit;
      // Nicht über die Seitenkanten hinaus ziehen
      if (side === 'right') setFrame({ left: startLeft, width: Math.max(min, Math.min(startWidth + dx, geometry.width - startLeft)) });
      else {
        const width = Math.max(min, Math.min(startWidth - dx, startLeft + startWidth));
        setFrame({ left: startLeft + startWidth - width, width });
      }
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      focusEditor();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    // Text aus anderen Programmen: Tabulator rückt ein; die Eingabetaste setzt nur in Absätzen eine Liste fort
    if (event.currentTarget instanceof HTMLTextAreaElement && textareaListKey(event as KeyboardEvent<HTMLTextAreaElement>, setPlain, paragraph)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter' && ((editing.mode === 'edit' && !paragraph) || event.metaKey || event.ctrlKey)) {
      // Vorhandene Zeile: Eingabe übernimmt; neuer Text und Absätze: Cmd+Eingabe (Eingabe allein beginnt eine neue Zeile)
      event.preventDefault();
      commit();
    }
  };

  const fixedWidth = frame?.width ?? (paragraph ? box.w : null);
  const position = {
    left: `${(left / geometry.width) * 100}%`,
    top: `${(top / geometry.height) * 100}%`,
    // Feste Breite (Absatz oder gezogen): die Eingabe bricht um wie später der Text auf der Seite
    ...(fixedWidth !== null
      ? { width: `${(fixedWidth / geometry.width) * 100}%`, whiteSpace: 'normal' as const }
      : { minWidth: editing.mode === 'edit' ? `${(box.w / geometry.width) * 100}%` : `${12 * fontSize}px` }),
  };
  const textColor = editing.mode === 'new' ? style.color : (restyle?.color ?? editing.color);
  const family = editing.mode === 'new' ? style.font : (restyle?.font ?? font?.name ?? '');
  const className = [styles.editor, fixedWidth !== null ? styles.paragraph : '', flow ? styles.flow : '', rich ? styles.rich : ''].join(' ');

  return (
    <div ref={wrapRef} className={styles.editorWrap} style={position}>
      {rich ? (
        <RichTextEditor
          initial={initialRuns}
          typing={{ size: style.size, color: style.color, font: style.font }}
          css={cssFor}
          className={className}
          handleRef={richRef}
          onChange={setRuns}
          onKeyDown={onKeyDown}
          onBlur={(related) => {
            // Größe, Schrift oder Farbe in der Leiste wählen beendet die Eingabe nicht
            if (!inToolbar(related)) commit();
          }}
        />
      ) : (
        <textarea
          ref={ref}
          className={className}
          style={{
            fontSize: `${fontSize}px`,
            lineHeight: 1.2,
            ...(isSystemFontKey(family) ? { fontFamily: `"${previewFamily(family)}", Helvetica, sans-serif`, fontWeight: 400 } : lookOf(family)),
            color: textColor ? `rgb(${textColor.r * 255} ${textColor.g * 255} ${textColor.b * 255})` : undefined,
          }}
          rows={editing.mode === 'edit' && fixedWidth === null ? 1 : Math.max(1, value.split('\n').length)}
          value={value}
          aria-label={t('contentEdit.textInput')}
          onChange={(event) => setPlain(event.target.value)}
          onBlur={(event) => {
            // Größe, Schrift oder Farbe in der Leiste wählen beendet die Eingabe nicht
            if (!inToolbar(event.relatedTarget)) commit();
          }}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => event.stopPropagation()}
          data-testid="content-text-editor"
        />
      )}
      {resizable &&
        (['left', 'right'] as const).map((side) => (
          <div
            key={side}
            className={[styles.editorHandle, side === 'left' ? styles.editorHandleLeft : styles.editorHandleRight].join(' ')}
            // eslint-disable-next-line react-hooks/refs -- liest Refs erst beim Ziehen, nicht beim Zeichnen
            onPointerDown={(event) => onHandleDown(event, side)}
            onMouseDown={(event) => event.preventDefault()}
            data-testid={`content-editor-width-${side}`}
          />
        ))}
      {(impossible || missing) && (
        <p className={styles.warning} role="status" data-testid="content-font-warning">
          {impossible ? t('contentEdit.impossible', { chars: impossible }) : t('contentEdit.substitute', { chars: missing })}
        </p>
      )}
    </div>
  );
}

// Zeichen, die eine Schrift der Stücke nicht kennt: fehlt die Form in der Schrift des Absatzes, nimmt der Worker eine
// ähnliche Standardschrift (missing); kennen auch die Standardschriften das Zeichen nicht, geht es nicht (impossible)
function runWarnings(runs: TextRun[], listing: PageObjects | null): { missing: string; impossible: string } {
  const missing = new Set<string>();
  const impossible = new Set<string>();
  for (const run of runs) {
    if (run.font !== undefined) {
      if (!isSystemFontKey(run.font)) for (const char of missingChars(run.text, undefined)) impossible.add(char);
      continue;
    }
    const lacking = missingChars(run.text, run.key ? listing?.fonts[run.key] : undefined);
    if (!lacking) continue;
    for (const char of lacking) missing.add(char);
    for (const char of missingChars(run.text, undefined)) impossible.add(char);
  }
  return { missing: [...missing].join(''), impossible: [...impossible].join('') };
}
