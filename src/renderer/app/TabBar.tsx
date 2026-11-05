import { FileText, House, Loader2, Lock, TriangleAlert, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { closeTab, executeCommand, transferTab } from '../engine/session';
import { useAnnotations } from '../state/annotations-store';
import { isDirtyState } from '../state/dirty';
import { useForms } from '../state/forms-store';
import { useHistory } from '../state/history-store';
import { useDocuments, type TabState } from '../state/documents-store';
import { useUi } from '../state/ui-store';
import styles from './TabBar.module.css';
import { clampDrag, hoverIndex, shiftFor, slotGap, targetIndex, type Slot } from './tab-drag';

function TabIcon({ tab }: { tab: TabState }) {
  const common = { size: 14, strokeWidth: 1.75, 'aria-hidden': true } as const;
  switch (tab.status) {
    case 'loading':
      return <Loader2 {...common} className={styles.spin} />;
    case 'password':
      return <Lock {...common} />;
    case 'error':
      return <TriangleAlert {...common} />;
    default:
      return <FileText {...common} />;
  }
}

// Ab dieser Bewegung (Pixel) ist ein gedrückter Tab gezogen statt angeklickt
const DRAG_THRESHOLD = 6;
// So weit ober- oder unterhalb der Tableiste gilt ein Tab als herausgezogen
const DETACH_DISTANCE = 24;
// Breite des Platzhalters für einen Tab, der aus einem anderen Fenster über der Leiste schwebt
const PHANTOM_WIDTH = 180;
// So lange wartet die Leiste nach dem Loslassen auf den übergebenen Tab, bevor sie die Lücke wieder schließt
const DROP_WAIT_MS = 600;
const SETTLE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

interface DragSession {
  tabId: string;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  // Lagen aller Tabs beim Beginn des Ziehens und Stelle des gezogenen
  slots: Slot[];
  origin: number;
  step: number;
  // Einziger Tab: Er lässt sich nur aus der Leiste ziehen (das Fenster wandert dann), nicht umsortieren
  solo: boolean;
  // Der Hauptprozess zeigt die Vorschau am Zeiger (beim ersten Verlassen der Leiste gemeldet)
  announced: boolean;
  outside: boolean;
}

// Darstellung während des Ziehens: Verschiebung des gezogenen Tabs und Zielstelle (null: aus der Leiste heraus)
interface DragView {
  tabId: string;
  dx: number;
  origin: number;
  target: number | null;
  step: number;
  solo: boolean;
}

// Tab aus einem anderen Fenster schwebt über diesem
interface HoverView {
  left: number;
  index: number;
  overBar: boolean;
  title: string;
  step: number;
}

function measure(bar: HTMLElement): Slot[] {
  return [...bar.querySelectorAll<HTMLElement>('[role="tab"]')].map((element) => {
    const rect = element.getBoundingClientRect();
    return { id: element.dataset.tabId ?? '', left: rect.left, width: rect.width };
  });
}

// Liegt der Zeiger außerhalb der Tableiste (darüber, darunter oder außerhalb des Fensters)?
function isOutside(bar: HTMLElement | null, event: { clientX: number; clientY: number }): boolean {
  if (!bar) return false;
  const rect = bar.getBoundingClientRect();
  const outsideWindow = event.clientX < 0 || event.clientY < 0 || event.clientX > window.innerWidth || event.clientY > window.innerHeight;
  return outsideWindow || event.clientY < rect.top - DETACH_DISTANCE || event.clientY > rect.bottom + DETACH_DISTANCE;
}

// Lage des gezogenen Tabs in der Leiste (begrenzt auf die Leiste) und Zielstelle (nach dem Zeiger, unbegrenzt: Wer über
// den letzten Tab hinauszieht, landet sicher dahinter)
function placement(current: DragSession, clientX: number): { dx: number; target: number } {
  const slot = current.slots[current.origin];
  if (current.solo || !slot) return { dx: 0, target: current.origin };
  const moved = clientX - current.startX;
  return { dx: clampDrag(current.slots, current.tabId, moved), target: targetIndex(current.slots, current.tabId, slot.left + moved + slot.width / 2) };
}

// Tab ziehen (ADR 0026): Innerhalb der Leiste folgt der Tab dem Zeiger, die anderen weichen aus, beim Loslassen gleitet
// er an seinen Platz. Außerhalb der Leiste (in jede Richtung) schließt sich die Lücke, und der Hauptprozess zeigt den Tab
// mit einer Vorschau des Fensters am Zeiger; Loslassen gibt ihn an das Fenster darunter oder an ein neues Fenster.
// Das Festhalten des Zeigers liefert Bewegungen auch außerhalb des Fensters. Umsortiert wird erst beim Loslassen, weil
// React beim Umhängen des Elements das Festhalten beenden würde.
function useTabDrag(bar: RefObject<HTMLDivElement | null>) {
  const session = useRef<DragSession | null>(null);
  // Nach einem Ziehen keinen Klick auslösen
  const suppressClick = useRef(false);
  const [view, setView] = useState<DragView | null>(null);
  // Nach dem Loslassen einen Augenblick ohne Übergänge, damit die Tabs nicht von ihrer alten Stelle herübergleiten
  const [settling, setSettling] = useState(false);
  // Gezogener Tab: von hier (Bildschirmlage vor dem Loslassen) an seinen neuen Platz gleiten lassen
  const flip = useRef<{ tabId: string; from: number } | null>(null);

  useLayoutEffect(() => {
    if (!settling) return;
    const pending = flip.current;
    flip.current = null;
    const element = pending ? bar.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(pending.tabId)}"]`) : null;
    if (pending && element) {
      const delta = pending.from - element.getBoundingClientRect().left;
      if (Math.abs(delta) > 0.5) {
        element.animate([{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }], { duration: 180, easing: SETTLE_EASING });
      }
    }
    const frame = requestAnimationFrame(() => setSettling(false));
    return () => cancelAnimationFrame(frame);
  }, [settling, bar]);

  const settle = (dragged?: { tabId: string; from: number }) => {
    flip.current = dragged ?? null;
    setSettling(true);
    setView(null);
  };

  const update = (current: DragSession, event: { clientX: number; clientY: number; screenX: number; screenY: number }) => {
    const outside = isOutside(bar.current, event);
    current.outside = outside;
    const tab = useDocuments.getState().tabs.find((candidate) => candidate.id === current.tabId);
    if (outside && !current.announced && tab) {
      const element = bar.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(current.tabId)}"]`);
      const rect = element?.getBoundingClientRect();
      const tabOffset = { x: current.startX - (rect?.left ?? current.startX), y: current.startY - (rect?.top ?? current.startY) };
      // Im neuen Fenster ist der Tab der erste der Leiste (hinter dem Home-Knopf); der Zeiger soll ihn dort an derselben
      // Stelle halten
      const grip = { x: (current.slots[0]?.left ?? 0) + tabOffset.x, y: current.startY };
      api.tabDrag({ kind: 'start', title: tab.name, tabOffset, grip });
      current.announced = true;
    }
    if (current.announced) api.tabDrag({ kind: 'move', x: Math.round(event.screenX), y: Math.round(event.screenY), detached: outside });
    if (outside) {
      setView({ tabId: current.tabId, dx: 0, origin: current.origin, target: null, step: current.step, solo: current.solo });
      return;
    }
    const { dx, target } = placement(current, event.clientX);
    setView({ tabId: current.tabId, dx, origin: current.origin, target, step: current.step, solo: current.solo });
  };

  const finish = async (current: DragSession, event: { clientX: number; screenX: number; screenY: number }) => {
    session.current = null;
    suppressClick.current = true;
    if (current.outside) {
      // Die Lücke bleibt, bis die Übergabe fertig ist (die Bytes ungespeicherter Änderungen entstehen erst jetzt)
      const moved = await transferTab(current.tabId, { kind: 'point', x: Math.round(event.screenX), y: Math.round(event.screenY) });
      // Kam die Übergabe nicht beim Hauptprozess an (Tab beschäftigt), verschwindet die Vorschau trotzdem
      if (current.announced) api.tabDrag({ kind: 'end' });
      if (moved) settle();
      else setView(null);
      return;
    }
    if (current.announced) api.tabDrag({ kind: 'end' });
    const slot = current.slots[current.origin];
    const { dx, target } = placement(current, event.clientX);
    if (target !== current.origin) useDocuments.getState().moveTab(current.tabId, target);
    settle(slot ? { tabId: current.tabId, from: slot.left + dx } : undefined);
  };

  const cancel = () => {
    const current = session.current;
    session.current = null;
    if (current?.announced) api.tabDrag({ kind: 'end' });
    setView(null);
  };

  return {
    view,
    settling,
    suppressClick,
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, tabId: string) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button') || session.current) return;
      session.current = {
        tabId,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        slots: [],
        origin: 0,
        step: 0,
        solo: false,
        announced: false,
        outside: false,
      };
      suppressClick.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = session.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.moved) {
        if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD || !bar.current) return;
        current.moved = true;
        current.slots = measure(bar.current);
        current.origin = Math.max(0, current.slots.findIndex((slot) => slot.id === current.tabId));
        current.step = (current.slots[current.origin]?.width ?? 0) + slotGap(current.slots);
        current.solo = current.slots.length <= 1;
        // Wie in Safari und Chrome: Der gezogene Tab wird der aktive (die Vorschau am Zeiger zeigt dann sein Dokument)
        useDocuments.getState().setActive(current.tabId);
      }
      update(current, event);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = session.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.moved) {
        session.current = null;
        return;
      }
      void finish(current, event);
    },
    onPointerCancel: cancel,
  };
}

// Ein Tab aus einem anderen Fenster schwebt über diesem Fenster (Meldung des Hauptprozesses). Über der Leiste macht sie
// an der Einfügestelle Platz und zeigt den Tab am Zeiger; die Antwort sagt dem Hauptprozess, wo der Tab landen würde.
function useIncomingTab(bar: RefObject<HTMLDivElement | null>, tabCount: number) {
  const [hover, setHover] = useState<HoverView | null>(null);
  const [settling, setSettling] = useState(false);
  const slots = useRef<Slot[] | null>(null);
  const reported = useRef<string>('');
  // Nach dem Loslassen über der Leiste: Lücke halten, bis der Tab ankommt
  const awaiting = useRef<{ count: number; timer: number } | null>(null);

  useEffect(() => {
    // Aktueller Stand für den Empfänger (die Meldungen kommen außerhalb von React)
    let current: HoverView | null = null;
    const show = (next: HoverView | null) => {
      current = next;
      setHover(next);
    };
    const clearAwaiting = () => {
      if (awaiting.current) window.clearTimeout(awaiting.current.timer);
      awaiting.current = null;
    };
    const off = api.onTabDragHover((incoming) => {
      const element = bar.current;
      if (!incoming || !element) {
        slots.current = null;
        reported.current = '';
        clearAwaiting();
        if (!current?.overBar) {
          show(null);
          return;
        }
        // Über der Leiste losgelassen: Lücke halten, bis der Tab ankommt (oder die Übergabe scheitert)
        const timer = window.setTimeout(() => {
          awaiting.current = null;
          show(null);
        }, DROP_WAIT_MS);
        awaiting.current = { count: useDocuments.getState().tabs.length, timer };
        return;
      }
      clearAwaiting();
      const measured = (slots.current ??= measure(element));
      const rect = element.getBoundingClientRect();
      const gap = slotGap(measured);
      const overBar = incoming.y >= rect.top - DETACH_DISTANCE && incoming.y <= rect.bottom + DETACH_DISTANCE;
      const index = overBar ? hoverIndex(measured, incoming.x) : measured.length;
      // Platzhalter am Zeiger, höchstens direkt hinter dem letzten Tab
      const last = measured[measured.length - 1];
      const padding = parseFloat(getComputedStyle(element).paddingLeft) || 0;
      // Nicht vor den ersten Tab (dort sitzt der Home-Knopf)
      const minLeft = measured[0] ? measured[0].left - rect.left : padding;
      const maxLeft = last ? last.left + last.width - rect.left + gap : minLeft;
      const left = Math.min(Math.max(incoming.x - rect.left - PHANTOM_WIDTH / 2, minLeft), maxLeft) + element.scrollLeft;
      show({ left, index, overBar, title: incoming.title, step: PHANTOM_WIDTH + gap });
      const key = `${overBar}:${index}`;
      if (key !== reported.current) {
        reported.current = key;
        api.setTabDragHoverState({ overBar, index });
      }
    });
    return () => {
      off();
      clearAwaiting();
    };
  }, [bar]);

  // Der übergebene Tab ist da: Lücke ohne Übergang schließen (er steht jetzt genau dort)
  useLayoutEffect(() => {
    const pending = awaiting.current;
    if (!pending || tabCount <= pending.count) return;
    window.clearTimeout(pending.timer);
    awaiting.current = null;
    setSettling(true);
    setHover(null);
  }, [tabCount]);

  useEffect(() => {
    if (!settling) return;
    const frame = requestAnimationFrame(() => setSettling(false));
    return () => cancelAnimationFrame(frame);
  }, [settling]);

  return { hover, settling };
}

export function TabBar() {
  const { t } = useTranslation();
  const tabs = useDocuments((s) => s.tabs);
  const activeId = useDocuments((s) => s.activeId);
  const setActive = useDocuments((s) => s.setActive);
  const annotationTabs = useAnnotations((s) => s.tabs);
  const historyTabs = useHistory((s) => s.tabs);
  const formTabs = useForms((s) => s.tabs);
  const homeOpen = useUi((s) => s.homeOpen);
  const bar = useRef<HTMLDivElement>(null);
  const drag = useTabDrag(bar);
  const incoming = useIncomingTab(bar, tabs.length);
  const { view } = drag;
  const hover = incoming.hover;

  // Waagerechte Verschiebung eines Tabs während des Ziehens bzw. für einen schwebenden Tab aus einem anderen Fenster
  const offset = (tab: TabState, index: number): number => {
    if (view) return tab.id === view.tabId ? view.dx : view.solo ? 0 : shiftFor(index, view.origin, view.target, view.step);
    return hover?.overBar && index >= hover.index ? hover.step : 0;
  };

  return (
    <div
      ref={bar}
      className={[styles.bar, drag.settling || incoming.settling ? styles.settling : ''].join(' ')}
      role="tablist"
      aria-label={t('tabs.label')}
      data-testid="tab-bar"
    >
      <button
        type="button"
        className={styles.home}
        aria-label={t('toolbar.home')}
        aria-pressed={homeOpen}
        data-tooltip={t('toolbar.home')}
        onClick={() => executeCommand('app.home')}
        data-testid="home-button"
      >
        <House size={15} strokeWidth={1.9} aria-hidden="true" />
      </button>
      {tabs.map((tab, index) => {
        const active = tab.id === activeId;
        const dragged = view?.tabId === tab.id;
        const detached = dragged && view.target === null;
        const dx = offset(tab, index);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-tab-id={tab.id}
            className={[
              styles.tab,
              active ? styles.active : '',
              dragged && !detached ? styles.dragging : '',
              detached ? (view.solo ? styles.detaching : styles.collapsed) : '',
            ].join(' ')}
            style={dx !== 0 ? { transform: `translateX(${dx}px)` } : undefined}
            title={view ? undefined : `${tab.dir}/${tab.name}`}
            onPointerDown={(event) => drag.onPointerDown(event, tab.id)}
            onPointerMove={drag.onPointerMove}
            onPointerUp={drag.onPointerUp}
            onPointerCancel={drag.onPointerCancel}
            onClick={() => {
              if (drag.suppressClick.current) drag.suppressClick.current = false;
              else setActive(tab.id);
            }}
            onAuxClick={(event) => {
              if (event.button === 1) void closeTab(tab.id);
            }}
            // Doppelklick auf den Tab: Datei umbenennen
            onDoubleClick={() => {
              setActive(tab.id);
              if (tab.status === 'ready') executeCommand('file.rename');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') setActive(tab.id);
            }}
            data-testid="tab"
          >
            <TabIcon tab={tab} />
            <span className={styles.name}>{tab.name}</span>
            {/* Der Platz für den Punkt bleibt immer frei: Erscheint er während eines Klicks auf ✕ (offene Eingabe wird
                übernommen), würde ✕ sonst unter dem Zeiger wegrutschen und der Klick ginge an den Tab. */}
            {isDirtyState(annotationTabs[tab.id], historyTabs[tab.id], formTabs[tab.id]) ? (
              <span className={styles.dirty} data-tooltip={t('tabs.unsaved')} aria-label={t('tabs.unsaved')} data-testid="tab-dirty" />
            ) : (
              <span className={[styles.dirty, styles.clean].join(' ')} aria-hidden="true" />
            )}
            <button
              type="button"
              className={styles.close}
              aria-label={t('tabs.close')}
              data-tooltip={t('tabs.close')}
              onClick={(event) => {
                event.stopPropagation();
                void closeTab(tab.id);
              }}
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      {hover?.overBar && (
        <div className={[styles.tab, styles.active, styles.phantom].join(' ')} style={{ left: hover.left, width: PHANTOM_WIDTH }} aria-hidden="true" data-testid="tab-phantom">
          <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles.name}>{hover.title}</span>
        </div>
      )}
    </div>
  );
}
