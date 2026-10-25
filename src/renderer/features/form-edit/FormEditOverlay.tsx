import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeRect, type Point, type Rect } from '../../../shared/annotations';
import { DEFAULT_FIELD_SIZE, MIN_FIELD_SIDE, type FieldKind } from '../../../shared/forms';
import type { PageGeometry } from '../../engine/coords';
import { getRuntime } from '../../engine/runtime';
import { useFormEdit, type FieldWidget } from '../../state/form-edit-store';
import { dragRect } from '../annotations/geometry';
import { moveField, openFieldProperties, startCreateField } from './actions';
import { pageWidgets } from './field-widgets';
import styles from './FormEditOverlay.module.css';

type Gesture =
  | { kind: 'create'; tool: FieldKind; from: Point; to: Point }
  // client: Zeigerlage beim Anfassen; beim Ziehen wird das Feld nur verschoben, nicht neu gezeichnet
  | { kind: 'move'; widget: FieldWidget; origin: Point; dx: number; dy: number; client: { x: number; y: number } }
  | { kind: 'resize'; widget: FieldWidget; fixed: Point; to: Point };

// Bildschirmpixel → Einheiten des SVG (PDF-Punkte); pdf.js rechnet 1 Punkt = 96/72 Pixel bei 100 %.
const pxToUnits = (px: number, scale: number) => px / (scale * (96 / 72));

function corners([l, b, r, t]: Rect): Point[] {
  return [
    { x: l, y: b },
    { x: r, y: b },
    { x: r, y: t },
    { x: l, y: t },
  ];
}

const translated = ([l, b, r, t]: Rect, dx: number, dy: number): Rect => [l + dx, b + dy, r + dx, t + dy];

// Lage eines Feldes während einer Mausaktion
function previewRect(widget: FieldWidget, gesture: Gesture | null): Rect {
  if (!gesture || gesture.kind === 'create' || gesture.widget.ref !== widget.ref) return widget.rect;
  if (gesture.kind === 'move') return translated(widget.rect, gesture.dx, gesture.dy);
  return normalizeRect([gesture.fixed.x, gesture.fixed.y, gesture.to.x, gesture.to.y]);
}

interface FormEditOverlayProps {
  tabId: string;
  pageIndex: number;
  geometry: PageGeometry;
  scale: number;
}

// Felder einer Seite im Modus „Formular bearbeiten“: anzeigen, auswählen, verschieben, Größe ändern, neue aufziehen.
export function FormEditOverlay({ tabId, pageIndex, geometry, scale }: FormEditOverlayProps) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [widgets, setWidgets] = useState<FieldWidget[]>([]);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const tool = useFormEdit((s) => s.tool);
  const selected = useFormEdit((s) => s.selected[tabId] ?? null);
  const pendingRect = useFormEdit((s) => s.pendingRect[tabId] ?? null);
  const pdf = getRuntime(tabId)?.pdf ?? null;

  const frame = useRef(0);
  const pointer = useRef({ x: 0, y: 0 });
  const setGesture = (next: Gesture | null) => {
    // Die Verschiebung aus dem Ziehen gehört nicht React: vor dem nächsten Zeichnen wieder entfernen
    if (gestureRef.current?.kind === 'move') for (const group of svgRef.current?.querySelectorAll('[data-move-ref]') ?? []) group.removeAttribute('transform');
    gestureRef.current = next;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    setGestureState(next);
  };

  // Höchstens einmal je Bild neu zeichnen; Verschieben setzt nur eine Verschiebung an Feld und Anfassern
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
      for (const group of svg.querySelectorAll(`[data-move-ref="${CSS.escape(current.widget.ref)}"]`)) group.setAttribute('transform', `translate(${vx} ${vy})`);
    });
  };

  // Felder der Seite laden; nach dem Neuladen die Auswahl auf den frischen Stand setzen.
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    void pageWidgets(pdf, pageIndex).then((list) => {
      if (cancelled) return;
      setWidgets(list);
      const store = useFormEdit.getState();
      const current = store.selected[tabId];
      const fresh = current ? list.find((w) => w.ref === current.ref) : undefined;
      if (fresh && fresh !== current) store.select(tabId, fresh);
      // Gerade angelegtes Feld auswählen (bei mehreren Knöpfen einer Gruppe: der neueste)
      const pendingName = store.pendingSelect[tabId];
      if (pendingName) {
        const matches = list.filter((w) => w.settings.name === pendingName);
        const newest = matches.sort((a, b) => parseInt(b.ref, 10) - parseInt(a.ref, 10))[0];
        if (newest) {
          store.select(tabId, newest);
          store.setPendingSelect(tabId, null);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, pageIndex, tabId]);

  const toPdf = (event: { clientX: number; clientY: number }): Point => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return { x: 0, y: 0 };
    const x = ((event.clientX - box.left) / box.width) * geometry.width;
    const y = ((event.clientY - box.top) / box.height) * geometry.height;
    return geometry.toPdf(x, y);
  };

  const capture = (event: ReactPointerEvent) => {
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };

  const creating = tool !== 'select';

  const onBackgroundPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!creating || event.button !== 0) return;
    event.preventDefault();
    capture(event);
    const at = toPdf(event);
    setGesture({ kind: 'create', tool, from: at, to: at });
  };

  const onFieldPointerDown = (event: ReactPointerEvent, widget: FieldWidget) => {
    if (creating || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    useFormEdit.getState().select(tabId, widget);
    capture(event);
    pointer.current = { x: event.clientX, y: event.clientY };
    setGesture({ kind: 'move', widget, origin: toPdf(event), dx: 0, dy: 0, client: { x: event.clientX, y: event.clientY } });
  };

  const onHandlePointerDown = (event: ReactPointerEvent, widget: FieldWidget, corner: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    capture(event);
    const points = corners(widget.rect);
    const fixed = points[(corner + 2) % 4] ?? points[0] ?? { x: 0, y: 0 };
    setGesture({ kind: 'resize', widget, fixed, to: toPdf(event) });
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const current = gestureRef.current;
    if (!current) return;
    const at = toPdf(event);
    pointer.current = { x: event.clientX, y: event.clientY };
    if (current.kind === 'create') scheduleGesture({ ...current, to: at });
    else if (current.kind === 'move') scheduleGesture({ ...current, dx: at.x - current.origin.x, dy: at.y - current.origin.y });
    else scheduleGesture({ ...current, to: at });
  };

  const finish = () => {
    const current = gestureRef.current;
    setGesture(null);
    if (!current) return;
    if (current.kind === 'create') {
      const rect = dragRect(current.from, current.to, DEFAULT_FIELD_SIZE[current.tool]);
      const [l, b, r, top] = rect;
      if (r - l < MIN_FIELD_SIDE || top - b < MIN_FIELD_SIDE) return;
      useFormEdit.getState().setTool('select');
      void startCreateField(tabId, pageIndex, rect, current.tool);
      return;
    }
    const rect = previewRect(current.widget, current);
    if (current.kind === 'move' && Math.hypot(current.dx, current.dy) < 1) return;
    const [l, b, r, top] = rect;
    if (r - l < MIN_FIELD_SIDE || top - b < MIN_FIELD_SIDE) return;
    void moveField(tabId, current.widget, rect);
  };

  const handleSize = pxToUnits(8, scale);
  const labelSize = pxToUnits(10, scale);

  return (
    <svg
      ref={svgRef}
      className={[styles.svg, creating ? styles.creating : '', gesture ? styles.capturing : ''].join(' ')}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      preserveAspectRatio="none"
      onPointerDown={onBackgroundPointerDown}
      onMouseDown={(event) => {
        if (creating || gestureRef.current) event.preventDefault();
      }}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={() => setGesture(null)}
      data-testid={`form-edit-overlay-${pageIndex}`}
      data-form-edit-overlay=""
    >
      {widgets.map((widget) => {
        const pending = pendingRect?.ref === widget.ref ? pendingRect.rect : null;
        const r = geometry.rectToView(pending ?? previewRect(widget, gesture));
        const isSelected = selected?.ref === widget.ref;
        const showLabel = r.w > labelSize * 4 && r.h > labelSize * 1.2;
        const moving = gesture?.kind === 'move' && gesture.widget.ref === widget.ref;
        return (
          <g key={widget.ref} data-move-ref={moving ? widget.ref : undefined}>
            <rect
              className={[styles.field, isSelected ? styles.selected : '', creating ? styles.passive : ''].join(' ')}
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              onPointerDown={(event) => onFieldPointerDown(event, widget)}
              onDoubleClick={() => openFieldProperties(tabId, widget)}
              data-testid="form-field"
              data-field-name={widget.settings.name}
              data-field-ref={widget.ref}
            >
              <title>{`${widget.settings.name} (${t(`formEdit.kinds.${widget.kind ?? 'other'}`)})`}</title>
            </rect>
            {showLabel && (
              <text className={styles.label} x={r.x + labelSize * 0.3} y={r.y + labelSize} fontSize={labelSize}>
                {widget.settings.name}
              </text>
            )}
          </g>
        );
      })}
      {widgets
        .filter((widget) => widget.ref === selected?.ref && !creating)
        .map((widget) => {
          const rect = pendingRect?.ref === widget.ref ? pendingRect.rect : previewRect(widget, gesture);
          return (
            <g key={`handles-${widget.ref}`} data-testid="form-field-selection" data-move-ref={gesture?.kind === 'move' && gesture.widget.ref === widget.ref ? widget.ref : undefined}>
              {corners(rect).map((p, i) => {
                const [x, y] = geometry.toView(p);
                return (
                  <rect
                    key={i}
                    className={styles.handle}
                    x={x - handleSize / 2}
                    y={y - handleSize / 2}
                    width={handleSize}
                    height={handleSize}
                    onPointerDown={(event) => onHandlePointerDown(event, widget, i)}
                    data-handle={`corner-${i}`}
                  />
                );
              })}
            </g>
          );
        })}
      {gesture?.kind === 'create' &&
        (() => {
          const r = geometry.rectToView(normalizeRect([gesture.from.x, gesture.from.y, gesture.to.x, gesture.to.y]));
          return <rect className={styles.draft} x={r.x} y={r.y} width={r.w} height={r.h} />;
        })()}
    </svg>
  );
}
