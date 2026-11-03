import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Annotation, FreeTextAnnotation, InkAnnotation, MarkupAnnotation, Point, Quad, Rect } from '../../../shared/annotations';
import { boundsOf, dashPattern, normalizeRect } from '../../../shared/annotations';
import { ERASER_RADIUS_PX, erasePaths, pathsTouch, quadsTouch } from '../../../shared/eraser';
import { CUSTOM_STAMP_COLORS, DRAWING_TOOLS as STORE_DRAWING_TOOLS, useAnnotations, type Tool } from '../../state/annotations-store';
import { i18n } from '../../i18n';
import { useUi } from '../../state/ui-store';
import { useDocuments } from '../../state/documents-store';
import type { PageGeometry } from '../../engine/coords';
import { AnnotationShape, css } from './AnnotationShape';
import { needsAppearance } from './changes';
import {
  addAnnotation,
  applyErase,
  baseFields,
  deleteAnnotation,
  setContents,
  updateAnnotation,
} from './controller';
import {
  appendInkStroke,
  createFreeText,
  createInk,
  dotPath,
  createLine,
  createNote,
  createShape,
  createRedaction,
  createSignature,
  createStamp,
  FREETEXT_SIZE,
  SHAPE_SIZE,
  simplifyPath,
} from './create';
import { dragRect, inkRect, isMovable, isResizable, lineRect, quadsFromRects, rectOfQuads, resizeFrom, translate } from './geometry';
import { recognizeShape, SNAP_HOLD_MS, SNAP_JITTER_PX } from './shape-snap';
import { caretAt, rangeBetween, type Caret } from './text-caret';
import { rangeTextRects } from './text-selection';
import styles from './PageOverlay.module.css';

// Laufende Mausaktion auf der Seite
type Gesture =
  | { kind: 'rect'; tool: 'square' | 'circle' | 'freetext' | 'redact'; from: Point; to: Point }
  | { kind: 'line'; tool: 'line' | 'arrow'; from: Point; to: Point }
  // snapped: erkannte Form, wenn der Stift am Ende still gehalten wurde (ersetzt den Freihandstrich)
  | { kind: 'ink'; points: Point[]; snapped?: Point[] }
  // client: Zeigerlage beim Anfassen; während des Ziehens wird der Kommentar nur verschoben, nicht neu gezeichnet
  | { kind: 'move'; id: string; origin: Point; dx: number; dy: number; client: { x: number; y: number } }
  | { kind: 'resize'; id: string; fixed: Point; to: Point }
  | { kind: 'endpoint'; id: string; which: 'start' | 'end'; to: Point }
  // Anfang oder Ende einer Textmarkierung ziehen: das andere Ende bleibt fest, die Markierung folgt dem Text
  | { kind: 'markup'; id: string; fixed: Caret; quads: Quad[] | null }
  // Radierer: letzte Lage und bisheriges Ergebnis je Kommentar (null = ganz entfernt)
  | EraseGesture;

interface EraseGesture {
  kind: 'erase';
  last: Point;
  changes: Record<string, Annotation | null>;
}

// Freihandstriche, die kurz nacheinander entstehen, bilden eine Zeichnung (wie Handschrift).
const INK_MERGE_MS = 1500;
const lastInk = new Map<string, { id: string; pageIndex: number; time: number }>();

// Bildschirmpixel → Einheiten des SVG (PDF-Punkte); pdf.js rechnet 1 Punkt = 96/72 Pixel bei 100 %.
const pxToUnits = (px: number, scale: number) => px / (scale * (96 / 72));

const DRAWING_TOOLS = new Set<Tool>(STORE_DRAWING_TOOLS);

function corners([l, b, r, t]: Rect): Point[] {
  return [
    { x: l, y: b },
    { x: r, y: b },
    { x: r, y: t },
    { x: l, y: t },
  ];
}

// Aktuelle Vorschau eines Kommentars während einer Mausaktion
function preview(a: Annotation, gesture: Gesture | null): Annotation {
  if (gesture?.kind === 'erase') return gesture.changes[a.id] ?? a;
  if (!gesture || !('id' in gesture) || gesture.id !== a.id) return a;
  switch (gesture.kind) {
    case 'move':
      return translate(a, gesture.dx, gesture.dy);
    case 'resize':
      return resizeFrom(a, gesture.fixed, gesture.to);
    case 'endpoint': {
      if (a.kind !== 'line' && a.kind !== 'arrow') return a;
      const start = gesture.which === 'start' ? gesture.to : a.start;
      const end = gesture.which === 'end' ? gesture.to : a.end;
      return { ...a, start, end, rect: lineRect(start, end, a.width) };
    }
    case 'markup':
      if (!gesture.quads || gesture.quads.length === 0 || !isTextMarkup(a)) return a;
      return { ...a, quads: gesture.quads, rect: rectOfQuads(gesture.quads) };
  }
}

const isTextMarkup = (a: Annotation): a is MarkupAnnotation =>
  a.kind === 'highlight' || a.kind === 'underline' || a.kind === 'strikeout' || a.kind === 'squiggly';

// Mitte der linken Kante des ersten bzw. der rechten Kante des letzten Vierecks (Lesereihenfolge)
function markupEnds(a: MarkupAnnotation): { start: Point; end: Point; height: number } | null {
  const first = a.quads[0];
  const last = a.quads.at(-1);
  if (!first || !last) return null;
  const mid = (p: Point, q: Point): Point => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  return { start: mid(first[0], first[2]), end: mid(last[1], last[3]), height: Math.abs(first[0].y - first[2].y) };
}

interface PageOverlayProps {
  tabId: string;
  pageIndex: number;
  geometry: PageGeometry;
  items: Annotation[];
  originals: Record<string, Annotation>;
  selectedId: string | null;
  editingId: string | null;
  scale: number;
  readOnly: boolean;
  // Keine Mausaktionen (Modus „Formular bearbeiten“); Kommentare bleiben sichtbar.
  inert?: boolean;
}


// Eigener Stempel an der Klickstelle: Text, darunter Name und Datum (fest beim Setzen, wie bei einem Papierstempel)
function customStampAt(base: ReturnType<typeof baseFields>, at: Point) {
  const custom = useAnnotations.getState().customStamp;
  const details = [custom.name ? base.author : '', custom.date ? new Date().toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) : '']
    .filter((part) => part.trim() !== '')
    .join(' · ');
  return createStamp(base, at, 'custom', details ? `${custom.text}\n${details}` : custom.text, CUSTOM_STAMP_COLORS[custom.color]);
}
export function PageOverlay({
  tabId,
  pageIndex,
  geometry,
  items,
  originals,
  selectedId,
  editingId,
  scale,
  readOnly,
  inert = false,
}: PageOverlayProps) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const tool = useAnnotations((s) => s.tool);
  const drawing = !readOnly && DRAWING_TOOLS.has(tool);
  const markupTool = ['highlight', 'underline', 'strikeout', 'squiggly', 'redactText'].includes(tool);

  const frame = useRef(0);
  const pointer = useRef({ x: 0, y: 0 });
  // Stillhalten beim Zeichnen: Ruheposition des Stifts und Zeitgeber für die Formerkennung
  const hold = useRef<{ timer: number; anchor: Point }>({ timer: 0, anchor: { x: 0, y: 0 } });
  const stopHold = () => {
    window.clearTimeout(hold.current.timer);
    hold.current.timer = 0;
  };
  useEffect(() => stopHold, []);
  const armHold = (anchor: Point) => {
    stopHold();
    hold.current.anchor = anchor;
    hold.current.timer = window.setTimeout(() => {
      hold.current.timer = 0;
      const current = gestureRef.current;
      if (current?.kind !== 'ink' || current.snapped || !store().snapShapes) return;
      const snapped = recognizeShape(current.points);
      if (snapped) setGesture({ ...current, snapped });
    }, SNAP_HOLD_MS);
  };
  const setGesture = (next: Gesture | null) => {
    stopHold();
    // Die Verschiebung aus dem Ziehen gehört nicht React: vor dem nächsten Zeichnen wieder entfernen
    if (gestureRef.current?.kind === 'move') for (const group of svgRef.current?.querySelectorAll('[data-move-id]') ?? []) group.removeAttribute('transform');
    gestureRef.current = next;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    setGestureState(next);
  };

  // Während des Ziehens höchstens einmal je Bild neu zeichnen; Verschieben setzt nur eine Verschiebung an den
  // Gruppen des Kommentars (data-move-id), ohne die Ebene neu zu zeichnen (unter Windows spürbar schneller)
  const scheduleGesture = (next: Gesture) => {
    gestureRef.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const current = gestureRef.current;
      if (!current) return;
      if (current.kind !== 'move') {
        setGestureState(current);
        return;
      }
      const svg = svgRef.current;
      const box = svg?.getBoundingClientRect();
      if (!svg || !box || box.width === 0) return;
      const vx = ((pointer.current.x - current.client.x) / box.width) * geometry.width;
      const vy = ((pointer.current.y - current.client.y) / box.height) * geometry.height;
      for (const group of svg.querySelectorAll(`[data-move-id="${CSS.escape(current.id)}"]`)) group.setAttribute('transform', `translate(${vx} ${vy})`);
    });
  };

  // Position des Zeigers in PDF-Punkten
  const toPdf = (event: { clientX: number; clientY: number }): Point => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return { x: 0, y: 0 };
    const x = ((event.clientX - box.left) / box.width) * geometry.width;
    const y = ((event.clientY - box.top) / box.height) * geometry.height;
    return geometry.toPdf(x, y);
  };

  // Das angeklickte Element hält den Zeiger bis zum Loslassen. Bewegungen kommen per Bubbling bei der Ebene an,
  // Klick und Doppelklick bleiben beim Element (sonst erreicht ein Doppelklick den Kommentar nicht).
  const capture = (event: ReactPointerEvent) => {
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };

  const store = useAnnotations.getState;

  // Radierer von from nach to: Pixel-Radierer kürzt Freihandstriche, Strich-Radierer entfernt berührte Striche,
  // Textmarker-Radierer nur durchscheinende Striche und Hervorhebungen. Größe in Bildschirmpunkten, unabhängig vom Zoom.
  const eraseStep = (current: EraseGesture, from: Point, to: Point): EraseGesture => {
    const { eraser } = store();
    const radius = pxToUnits(ERASER_RADIUS_PX[eraser.size], scale);
    let changes = current.changes;
    const change = (id: string, next: Annotation | null) => {
      if (changes === current.changes) changes = { ...changes };
      changes[id] = next;
    };
    for (const original of items) {
      const a = original.id in changes ? changes[original.id] : original;
      if (!a) continue;
      if (a.kind === 'ink') {
        const reach = radius + a.width / 2;
        if (eraser.mode === 'pixel') {
          const paths = erasePaths(a.paths, from, to, reach);
          if (paths) change(a.id, paths.length > 0 ? { ...a, paths, rect: inkRect(paths, a.width) } : null);
        } else if ((eraser.mode === 'stroke' || a.opacity < 1) && pathsTouch(a.paths, from, to, reach)) {
          change(a.id, null);
        }
      } else if (eraser.mode === 'highlighter' && a.kind === 'highlight' && quadsTouch(a.quads, from, to, radius)) {
        change(a.id, null);
      }
    }
    return { ...current, last: to, changes };
  };

  // Neuen Kommentar mit einem Zeichenwerkzeug beginnen
  const onBackgroundPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawing || event.button !== 0) return;
    event.preventDefault();
    const at = toPdf(event);
    const { colors, stamp } = store();
    const base = baseFields(pageIndex);
    switch (tool) {
      case 'note': {
        const note = createNote(base, at, colors.note);
        addAnnotation(tabId, note);
        store().setTool('select');
        // Text der Notiz direkt in der Kommentarliste eingeben
        store().setEditing(tabId, note.id);
        openCommentsPanel(tabId);
        return;
      }
      case 'stamp':
        addAnnotation(tabId, stamp === 'custom' ? customStampAt(base, at) : createStamp(base, at, stamp, t(`stamps.${stamp}`), colors.stamp));
        store().setTool('select');
        return;
      case 'signature': {
        const signature = store().pendingSignature;
        if (signature) addAnnotation(tabId, createSignature(base, at, signature.image, signature.width, signature.height));
        store().setPendingSignature(null);
        return;
      }
      case 'ink':
        capture(event);
        setGesture({ kind: 'ink', points: [at] });
        armHold(at);
        return;
      case 'eraser':
        capture(event);
        setGesture(eraseStep({ kind: 'erase', last: at, changes: {} }, at, at));
        return;
      case 'line':
      case 'arrow':
        capture(event);
        setGesture({ kind: 'line', tool, from: at, to: at });
        return;
      case 'square':
      case 'circle':
      case 'freetext':
      case 'redact':
        capture(event);
        setGesture({ kind: 'rect', tool, from: at, to: at });
        return;
      default:
        return;
    }
  };

  // Kommentar anklicken: auswählen und ggf. verschieben
  const onItemPointerDown = (event: ReactPointerEvent, a: Annotation) => {
    if (event.button !== 0 || drawing || markupTool) return;
    event.stopPropagation();
    event.preventDefault();
    store().select(tabId, a.id);
    if (editingId && editingId !== a.id) store().setEditing(tabId, null);
    if (readOnly || !isMovable(a) || editingId === a.id) return;
    capture(event);
    pointer.current = { x: event.clientX, y: event.clientY };
    setGesture({ kind: 'move', id: a.id, origin: toPdf(event), dx: 0, dy: 0, client: { x: event.clientX, y: event.clientY } });
  };

  const onHandlePointerDown = (event: ReactPointerEvent, a: Annotation, corner: number) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const points = corners(a.rect);
    const fixed = points[(corner + 2) % 4] as Point;
    capture(event);
    setGesture({ kind: 'resize', id: a.id, fixed, to: toPdf(event) });
  };

  const onEndpointPointerDown = (event: ReactPointerEvent, a: Annotation, which: 'start' | 'end') => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    capture(event);
    setGesture({ kind: 'endpoint', id: a.id, which, to: toPdf(event) });
  };

  // Bildschirmpunkt zu einer Stelle in PDF-Punkten
  const toClient = (p: Point): { x: number; y: number } | null => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return null;
    const [vx, vy] = geometry.toView(p);
    return { x: box.left + (vx / geometry.width) * box.width, y: box.top + (vy / geometry.height) * box.height };
  };
  // Textebene von pdf.js und, falls vorhanden, Live-Text (erkannter Text in Bildern)
  const textLayer = () => {
    const layers = Array.from(svgRef.current?.closest('.page')?.querySelectorAll('.textLayer') ?? []);
    return layers.length > 0 ? layers : null;
  };

  const onMarkupHandleDown = (event: ReactPointerEvent, a: MarkupAnnotation, which: 'start' | 'end') => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const ends = markupEnds(a);
    const layer = textLayer();
    const other = ends ? toClient(which === 'start' ? ends.end : ends.start) : null;
    if (!ends || !layer || !other) return;
    // Etwas nach innen, damit die feste Stelle sicher im markierten Text liegt
    const inward = which === 'start' ? -2 : 2;
    const fixed = caretAt(layer, other.x + inward, other.y);
    if (!fixed) return;
    setGesture({ kind: 'markup', id: a.id, fixed, quads: null });
    // Am ganzen Fenster verfolgen: pdf.js hängt Seitenteile beim Neuzeichnen um, dabei ginge ein Festhalten des
    // Zeigers am Anfasser verloren, und das Loslassen über dem Text würde eine neue Markierung anlegen
    const onMove = (move: PointerEvent) => {
      const current = gestureRef.current;
      if (current?.kind !== 'markup') return;
      move.preventDefault();
      window.getSelection()?.removeAllRanges();
      setGesture({ ...current, quads: markupQuads(current.fixed, move.clientX, move.clientY) ?? current.quads });
    };
    const onUp = (up: PointerEvent) => {
      up.stopPropagation();
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.getSelection()?.removeAllRanges();
      finish(up.timeStamp);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  };

  const markupQuads = (fixed: Caret, clientX: number, clientY: number): Quad[] | null => {
    const layer = textLayer();
    const page = svgRef.current?.closest<HTMLElement>('.page');
    const moving = layer ? caretAt(layer, clientX, clientY) : null;
    if (!layer || !page || !moving) return null;
    const range = rangeBetween(fixed, moving);
    const rects = rangeTextRects([range], page, (index) => (index === pageIndex ? geometry : undefined)).find((entry) => entry.pageIndex === pageIndex)?.rects ?? [];
    const quads = quadsFromRects(rects);
    return quads.length > 0 ? quads : null;
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const current = gestureRef.current;
    if (!current) return;
    const at = toPdf(event);
    pointer.current = { x: event.clientX, y: event.clientY };
    switch (current.kind) {
      case 'ink': {
        if (current.snapped) {
          // Eine erkannte Gerade folgt dem Stift weiter (Endpunkt nachziehen), andere Formen bleiben stehen
          if (current.snapped.length === 2) scheduleGesture({ ...current, snapped: [current.snapped[0] as Point, at] });
          return;
        }
        const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [];
        const added = coalesced.length > 0 ? coalesced.map((e) => toPdf(e)) : [at];
        const anchor = hold.current.anchor;
        if (Math.hypot(at.x - anchor.x, at.y - anchor.y) > pxToUnits(SNAP_JITTER_PX, scale)) armHold(at);
        scheduleGesture({ ...current, points: [...current.points, ...added] });
        return;
      }
      case 'erase': {
        const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [];
        let next = current;
        for (const point of coalesced.length > 0 ? coalesced.map((e) => toPdf(e)) : [at]) next = eraseStep(next, next.last, point);
        scheduleGesture(next);
        return;
      }
      case 'line':
      case 'rect':
        scheduleGesture({ ...current, to: at });
        return;
      case 'move':
        scheduleGesture({ ...current, dx: at.x - current.origin.x, dy: at.y - current.origin.y });
        return;
      case 'resize':
      case 'endpoint':
        scheduleGesture({ ...current, to: at });
        return;
      case 'markup':
        // Läuft über die Fenster-Ereignisse (onMarkupHandleDown)
        return;
    }
  };

  const finish = (time: number) => {
    const current = gestureRef.current;
    setGesture(null);
    if (!current) return;
    const { colors, width, fontSize, dash } = store();
    switch (current.kind) {
      case 'ink': {
        // Klick ohne Ziehen setzt einen Punkt
        const stroke = current.snapped ?? simplifyPath(current.points);
        const path = stroke.length < 2 ? dotPath(stroke[0] ?? current.points[0] ?? { x: 0, y: 0 }) : stroke;
        const last = lastInk.get(tabId);
        const previous = last ? items.find((a) => a.id === last.id) : undefined;
        const now = time;
        if (
          previous?.kind === 'ink' &&
          last?.pageIndex === pageIndex &&
          now - last.time < INK_MERGE_MS &&
          previous.width === width &&
          (previous.dash ?? 'solid') === dash
        ) {
          updateAnnotation(tabId, previous, appendInkStroke(previous, path));
          lastInk.set(tabId, { id: previous.id, pageIndex, time: now });
          return;
        }
        const ink: InkAnnotation = createInk(baseFields(pageIndex), [path], colors.ink, width, dash);
        addAnnotation(tabId, ink);
        lastInk.set(tabId, { id: ink.id, pageIndex, time: now });
        return;
      }
      case 'erase':
        applyErase(tabId, current.changes);
        return;
      case 'line':
        addAnnotation(tabId, createLine(baseFields(pageIndex), current.tool, current.from, current.to, colors[current.tool], width));
        store().setTool('select');
        return;
      case 'rect': {
        if (current.tool === 'redact') {
          // Schwärzen: nur aufgezogene Bereiche (ein Klick allein markiert nichts); das Werkzeug bleibt aktiv.
          const rect = normalizeRect([current.from.x, current.from.y, current.to.x, current.to.y]);
          if (rect[2] - rect[0] < 2 || rect[3] - rect[1] < 2) return;
          addAnnotation(tabId, createRedaction(baseFields(pageIndex), rect, [], colors.redact));
          return;
        }
        if (current.tool === 'freetext') {
          const rect = dragRect(current.from, current.to, FREETEXT_SIZE);
          const box = createFreeText(baseFields(pageIndex), rect, colors.freetext, fontSize);
          addAnnotation(tabId, box);
          store().setEditing(tabId, box.id);
        } else {
          const rect = dragRect(current.from, current.to, SHAPE_SIZE);
          addAnnotation(tabId, createShape(baseFields(pageIndex), current.tool, rect, colors[current.tool], width, store().fill));
        }
        store().setTool('select');
        return;
      }
      default: {
        const before = items.find((a) => a.id === current.id);
        if (!before) return;
        const after = preview(before, current);
        if (after === before) return;
        if (current.kind === 'resize') {
          const [l, b, r, t] = after.rect;
          if (r - l < 6 || t - b < 6) return;
        }
        updateAnnotation(tabId, before, after);
      }
    }
  };

  const onDoubleClick = (a: Annotation) => {
    if (readOnly) return;
    store().select(tabId, a.id);
    store().setEditing(tabId, a.id);
    if (a.kind !== 'freetext') openCommentsPanel(tabId);
  };

  // Gerade erstelltes Werkzeug-Rechteck/Linie/Strich als Vorschau
  const draft = gesture ? draftShape(gesture, geometry, store(), scale) : null;
  const handleSize = pxToUnits(8, scale);
  const hitWidth = pxToUnits(10, scale);

  return (
    <svg
      ref={svgRef}
      className={[
        styles.svg,
        drawing ? styles.drawing : '',
        drawing && (tool === 'note' || tool === 'stamp' || tool === 'signature') ? styles.place : '',
        gesture ? styles.capturing : '',
        inert ? styles.inert : '',
      ].join(' ')}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      preserveAspectRatio="none"
      // Mit dem Finger zeichnen statt scrollen: WebKit beachtet touch-action an SVG nicht (src/ios/touch.ts)
      data-touch-draw={drawing || gesture ? '' : undefined}
      onPointerDown={onBackgroundPointerDown}
      // Beim Zeichnen weder Text auswählen noch den Fokus wechseln (sonst verliert ein neues Textfeld ihn sofort)
      onMouseDown={(event) => {
        if (drawing || gestureRef.current) event.preventDefault();
      }}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event.timeStamp)}
      onPointerCancel={() => setGesture(null)}
      data-testid={`annotation-overlay-${pageIndex}`}
      data-annotation-overlay={pageIndex}
    >
      {items.map((original) => {
        if (gesture?.kind === 'erase' && gesture.changes[original.id] === null) return null;
        const a = preview(original, gesture);
        const fromFile = original.ref ? originals[original.id] : undefined;
        // Unveränderte vorhandene Kommentare zeichnet pdf.js selbst; hier nur die Klickfläche.
        // Schwärzungsmarkierungen haben keine Darstellung in der Datei; pdf.js zeichnet sie nicht.
        const moving = gesture?.kind === 'move' && gesture.id === a.id;
        const drawn = !fromFile || needsAppearance(fromFile, original) || a !== original || a.kind === 'redact' || moving;
        const editing = editingId === a.id && a.kind === 'freetext';
        return (
          <g key={a.id} data-move-id={moving ? a.id : undefined}>
            {drawn && !editing && <AnnotationShape annotation={a} geometry={geometry} />}
            {!editing && (
              <HitArea
                annotation={a}
                geometry={geometry}
                hitWidth={hitWidth}
                movable={!readOnly && isMovable(a)}
                passive={drawing || markupTool}
                onPointerDown={(event) => onItemPointerDown(event, original)}
                onDoubleClick={() => onDoubleClick(original)}
              />
            )}
            {editing && a.kind === 'freetext' && <FreeTextEditor tabId={tabId} annotation={a} geometry={geometry} />}
          </g>
        );
      })}
      {items
        .filter((a) => a.id === selectedId)
        .map((original) => {
          const a = preview(original, gesture);
          return (
            <g key={`selection-${a.id}`} data-move-id={gesture?.kind === 'move' && gesture.id === a.id ? a.id : undefined}>
            <SelectionFrame
              annotation={a}
              geometry={geometry}
              handleSize={handleSize}
              readOnly={readOnly || drawing}
              onCornerDown={(event, corner) => onHandlePointerDown(event, original, corner)}
              onEndpointDown={(event, which) => onEndpointPointerDown(event, original, which)}
              onMarkupDown={(event, which) => isTextMarkup(original) && onMarkupHandleDown(event, original, which)}
            />
            </g>
          );
        })}
      {draft}
    </svg>
  );
}

function openCommentsPanel(tabId: string): void {
  useUi.getState().setSidebarVisible(true);
  useDocuments.getState().updateTab(tabId, { sidebarTab: 'comments' });
}

function draftShape(gesture: Gesture, geometry: PageGeometry, settings: ReturnType<typeof useAnnotations.getState>, scale: number) {
  const { colors, width } = settings;
  switch (gesture.kind) {
    case 'erase': {
      // Kreis in der Größe des Radierers unter dem Finger bzw. Zeiger
      const [cx, cy] = geometry.toView(gesture.last);
      return <circle cx={cx} cy={cy} r={pxToUnits(ERASER_RADIUS_PX[settings.eraser.size], scale)} fill="rgba(128, 128, 128, 0.15)" stroke="rgba(80, 80, 80, 0.7)" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
    }
    case 'ink':
      return (
        <polyline
          points={(gesture.snapped ?? gesture.points).map((p) => geometry.toView(p).join(',')).join(' ')}
          fill="none"
          stroke={css(colors.ink)}
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={dashPattern(settings.dash, width).join(' ') || undefined}
        />
      );
    case 'line': {
      const [x1, y1] = geometry.toView(gesture.from);
      const [x2, y2] = geometry.toView(gesture.to);
      return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={css(colors[gesture.tool])} strokeWidth={width} strokeLinecap="round" />;
    }
    case 'rect': {
      const r = geometry.rectToView(normalizeRect([gesture.from.x, gesture.from.y, gesture.to.x, gesture.to.y]));
      const color = css(colors[gesture.tool]);
      if (gesture.tool === 'circle') {
        return <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} fill="none" stroke={color} strokeWidth={width} />;
      }
      return (
        <rect
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          fill="none"
          stroke={color}
          strokeWidth={gesture.tool === 'freetext' ? 1 : width}
          strokeDasharray={gesture.tool === 'freetext' ? '4 3' : undefined}
          vectorEffect={gesture.tool === 'freetext' ? 'non-scaling-stroke' : undefined}
        />
      );
    }
    default:
      return null;
  }
}

interface HitAreaProps {
  annotation: Annotation;
  geometry: PageGeometry;
  hitWidth: number;
  movable: boolean;
  passive: boolean;
  onPointerDown: (event: ReactPointerEvent) => void;
  onDoubleClick: () => void;
}

// Unsichtbare Klickfläche. Linien und Rahmen reagieren nur auf ihren Strich, damit Text darunter auswählbar bleibt.
function HitArea({ annotation: a, geometry, hitWidth, movable, passive, onPointerDown, onDoubleClick }: HitAreaProps) {
  const className = [styles.hit, movable ? styles.movable : '', passive ? styles.passive : ''].join(' ');
  const common = {
    className,
    onPointerDown,
    onDoubleClick,
    'data-annotation-hit': a.id,
  };
  const points = (list: Point[]) => list.map((p) => geometry.toView(p).join(',')).join(' ');
  switch (a.kind) {
    case 'redact':
      if (a.quads.length === 0) {
        const r = geometry.rectToView(a.rect);
        return <rect {...common} x={r.x} y={r.y} width={r.w} height={r.h} />;
      }
      return (
        <g {...common}>
          {a.quads.map((q, i) => (
            <polygon key={i} points={points([q[0], q[1], q[3], q[2]])} />
          ))}
        </g>
      );
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
      return (
        <g {...common}>
          {a.quads.map((q, i) => (
            <polygon key={i} points={points([q[0], q[1], q[3], q[2]])} />
          ))}
        </g>
      );
    case 'ink':
      return (
        <g {...common} strokeWidth={Math.max(hitWidth, a.width)} fill="none">
          {a.paths.map((path, i) => (
            <polyline key={i} points={points(path)} />
          ))}
        </g>
      );
    case 'line':
    case 'arrow':
      return <polyline {...common} points={points([a.start, a.end])} strokeWidth={Math.max(hitWidth, a.width)} fill="none" />;
    case 'square':
    case 'circle': {
      const r = geometry.rectToView(a.rect);
      const filled = Boolean(a.fill);
      const props = { ...common, strokeWidth: Math.max(hitWidth, a.width), fill: filled ? 'transparent' : 'none' };
      return a.kind === 'square' ? (
        <rect {...props} x={r.x} y={r.y} width={r.w} height={r.h} />
      ) : (
        <ellipse {...props} cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} />
      );
    }
    default: {
      const r = geometry.rectToView(a.rect);
      return <rect {...common} x={r.x} y={r.y} width={r.w} height={r.h} />;
    }
  }
}

interface SelectionFrameProps {
  annotation: Annotation;
  geometry: PageGeometry;
  handleSize: number;
  readOnly: boolean;
  onCornerDown: (event: ReactPointerEvent, corner: number) => void;
  onEndpointDown: (event: ReactPointerEvent, which: 'start' | 'end') => void;
  onMarkupDown: (event: ReactPointerEvent, which: 'start' | 'end') => void;
}

function SelectionFrame({ annotation: a, geometry, handleSize, readOnly, onCornerDown, onEndpointDown, onMarkupDown }: SelectionFrameProps) {
  const isLine = a.kind === 'line' || a.kind === 'arrow';
  const frame = geometry.rectToView(isLine ? boundsOf([a.start, a.end]) : a.rect);
  const handle = (p: Point, key: string, onDown: (event: ReactPointerEvent) => void, cursor: string) => {
    const [x, y] = geometry.toView(p);
    return (
      <rect
        key={key}
        className={styles.handle}
        style={{ cursor }}
        x={x - handleSize / 2}
        y={y - handleSize / 2}
        width={handleSize}
        height={handleSize}
        onPointerDown={onDown}
        data-handle={key}
      />
    );
  };
  return (
    <g data-testid="annotation-selection">
      {!isLine && <rect className={styles.frame} x={frame.x} y={frame.y} width={frame.w} height={frame.h} />}
      {!readOnly &&
        isResizable(a) &&
        corners(a.rect).map((p, i) => handle(p, `corner-${i}`, (event) => onCornerDown(event, i), 'nwse-resize'))}
      {!readOnly &&
        isLine && [
          handle(a.start, 'start', (event) => onEndpointDown(event, 'start'), 'crosshair'),
          handle(a.end, 'end', (event) => onEndpointDown(event, 'end'), 'crosshair'),
        ]}
      {!readOnly && isTextMarkup(a) && <MarkupHandles annotation={a} geometry={geometry} size={handleSize} onDown={onMarkupDown} />}
    </g>
  );
}

// Freitext direkt auf der Seite bearbeiten
function FreeTextEditor({ tabId, annotation: a, geometry }: { tabId: string; annotation: FreeTextAnnotation; geometry: PageGeometry }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(a.contents);
  const r = geometry.rectToView(a.rect);
  const done = useRef(false);

  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.focus({ preventScroll: true });
    area.setSelectionRange(area.value.length, area.value.length);
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const store = useAnnotations.getState();
    if (value.trim() === '') {
      // Leeres Textfeld entfernen: ein gerade angelegtes spurlos, ein älteres als rückgängig machbares Löschen.
      const last = store.tabs[tabId]?.undo.at(-1);
      if (last?.type === 'add' && last.annotation.id === a.id) store.discard(tabId, a.id);
      else deleteAnnotation(tabId, a.id);
    } else {
      setContents(tabId, a.id, value);
    }
    store.setEditing(tabId, null);
  };

  // Auch beim Verschwinden des Editors (z. B. Wechsel ins Seitenraster) den Text übernehmen
  const commitRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => () => commitRef.current(), []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      commit();
    }
  };

  return (
    <foreignObject x={r.x} y={r.y} width={r.w} height={r.h}>
      <textarea
        ref={ref}
        className={styles.freeTextEditor}
        style={{ color: css(a.color), fontSize: a.fontSize }}
        value={value}
        aria-label={t('comments.freeTextInput')}
        data-testid="freetext-editor"
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      />
    </foreignObject>
  );
}

// Anfasser an Anfang und Ende einer Textmarkierung (wie bei einer Textauswahl): Ziehen kürzt oder verlängert sie
function MarkupHandles({
  annotation,
  geometry,
  size,
  onDown,
}: {
  annotation: MarkupAnnotation;
  geometry: PageGeometry;
  size: number;
  onDown: (event: ReactPointerEvent, which: 'start' | 'end') => void;
}) {
  const ends = markupEnds(annotation);
  if (!ends) return null;
  // Höhe der Zeile in Ansichtseinheiten (bei gedrehten Seiten über zwei umgerechnete Punkte)
  const [ax, ay] = geometry.toView({ x: ends.start.x, y: ends.start.y - ends.height / 2 });
  const [bx, by] = geometry.toView({ x: ends.start.x, y: ends.start.y + ends.height / 2 });
  const length = Math.hypot(bx - ax, by - ay);
  const angle = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI - 90;
  const knob = (p: Point, which: 'start' | 'end') => {
    const [x, y] = geometry.toView(p);
    return (
      <g key={which} transform={`translate(${x} ${y}) rotate(${angle})`} className={styles.markupHandle} onPointerDown={(event) => onDown(event, which)} data-handle={`markup-${which}`}>
        <rect x={-size} y={-length / 2 - size} width={size * 2} height={length + size * 2} fill="transparent" />
        <line x1={0} y1={-length / 2} x2={0} y2={length / 2} />
        <circle cx={0} cy={which === 'start' ? -length / 2 : length / 2} r={size / 2} />
      </g>
    );
  };
  return (
    <>
      {knob(ends.start, 'start')}
      {knob(ends.end, 'end')}
    </>
  );
}
