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
