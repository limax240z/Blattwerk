// Zoomen mit zwei Fingern auf dem iPad (ADR 0029). WebKit meldet die Geste als gesturestart/gesturechange (Faktor
// scale seit Beginn). Die Oberfläche zoomt bereits bei Strg + Mausrad (Trackpad-Pinch auf dem Mac, ViewerHost.tsx,
// Faktor exp(-deltaY / 100)); die Geste wird deshalb in solche Ereignisse übersetzt, verankert zwischen den Fingern.

interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

// Größter Schritt je Ereignis (wheelZoomIntent wertet nur kleine Pixel-Schritte als stufenloses Zoomen)
const MAX_DELTA = 30;

export function installPinchZoom(): void {
  let last = 1;
  const onStart = (event: Event) => {
    event.preventDefault();
    last = (event as GestureEvent).scale || 1;
  };
  const onChange = (event: Event) => {
    event.preventDefault();
    const gesture = event as GestureEvent;
    const ratio = gesture.scale / last;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    last = gesture.scale;
    const target = document.elementFromPoint(gesture.clientX, gesture.clientY);
    if (!target) return;
    let delta = -100 * Math.log(ratio);
    while (Math.abs(delta) > 0.01) {
      const step = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta));
      delta -= step;
      target.dispatchEvent(
        new WheelEvent('wheel', { deltaY: step, deltaMode: 0, ctrlKey: true, clientX: gesture.clientX, clientY: gesture.clientY, bubbles: true, cancelable: true }),
      );
    }
  };
  document.addEventListener('gesturestart', onStart, { passive: false });
  document.addEventListener('gesturechange', onChange, { passive: false });
  document.addEventListener('gestureend', (event) => event.preventDefault(), { passive: false });
}

// Zeichnen, Verschieben und Anfasser mit dem Finger (iPhone, iPad): WebKit beachtet touch-action: none an SVG-Elementen
// nicht und scrollt die Seite, statt die Zeigerereignisse an die Kommentarebene zu geben. Dort wird die Bewegung
// deshalb selbst angehalten (PageOverlay.tsx setzt data-touch-draw, die Anfasser tragen data-handle).
// Wie in Notizen: ein Finger malt, zwei Finger schieben (und zoomen über installPinchZoom). Kommt ein zweiter Finger
// dazu, wird der angefangene Strich verworfen (pointercancel) und die Ansicht folgt der Mitte beider Finger.
const DRAW_SURFACE = '[data-touch-draw], [data-handle]';

export function installTouchDrawing(): void {
  // Finger, die auf einer Zeichenfläche begonnen haben, und die Fläche dazu
  const fingers = new Map<number, Element>();
  let lastMid: { x: number; y: number } | null = null;

  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType !== 'touch') return;
      const surface = (event.target as Element | null)?.closest?.(DRAW_SURFACE);
      if (!surface && fingers.size === 0) return;
      fingers.set(event.pointerId, surface ?? (fingers.values().next().value as Element));
      if (fingers.size < 2) return;
      // Der zweite Finger beginnt keinen Strich; der des ersten wird verworfen
      event.stopImmediatePropagation();
      for (const [id, element] of fingers) {
        if (id !== event.pointerId) element.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch', bubbles: true }));
      }
    },
    true,
  );
  const release = (event: PointerEvent) => {
    fingers.delete(event.pointerId);
    if (fingers.size < 2) lastMid = null;
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);

  document.addEventListener(
    'touchmove',
    (event) => {
      const target = event.target as Element | null;
      if (!target?.closest?.(DRAW_SURFACE)) return;
      if (event.cancelable) event.preventDefault();
      if (event.touches.length < 2) return;
      const [a, b] = [event.touches[0], event.touches[1]] as [Touch, Touch];
      const mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
      const scroller = scrollParent(target);
      if (lastMid && scroller) scroller.scrollBy(lastMid.x - mid.x, lastMid.y - mid.y);
      lastMid = mid;
    },
    { passive: false },
  );
  document.addEventListener('touchend', (event) => {
    if (event.touches.length < 2) lastMid = null;
  });
}

// Nächster scrollbarer Vorfahre (die Dokumentansicht von pdf.js)
function scrollParent(element: Element): Element | null {
  for (let current = element.parentElement; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(style.overflowY + style.overflowX) && (current.scrollHeight > current.clientHeight || current.scrollWidth > current.clientWidth)) return current;
  }
  return null;
}
