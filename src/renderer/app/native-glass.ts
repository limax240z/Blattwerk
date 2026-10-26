// Apples Liquid Glass unter macOS 26+ (ADR 0023): meldet dem Hauptprozess, wo Glas unter dem Fenster liegen soll.
// Die Oberfläche ist dort durchsichtig (CSS unter [data-native-glass='on']), überall sonst deckend.
//   Startseite: das ganze Fenster
//   Dokument: das Band oben (Werkzeugleiste, Tabs, Modusleiste) und die schwebenden Seitenleisten
//   Startseite über offenen Dokumenten (Home-Knopf): nur das Band; die Startseite selbst ist dann deckend
import { useEffect } from 'react';
import type { GlassRegion } from '../../shared/ipc';
import { api } from '../api';

// Deckkraft der Tönung: genug Papierfarbe, damit Text gut lesbar bleibt
const TINT_BAND = 0.72;
const TINT_PANEL = 0.68;

function cssColor(name: string): [number, number, number] {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const [r = 0, g = 0, b = 0] = (getComputedStyle(probe).color.match(/[\d.]+/g) ?? []).map(Number);
  probe.remove();
  return [r, g, b];
}

function measure(): GlassRegion[] {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const band = cssColor('--color-bg');
  const surface = cssColor('--color-surface');
  const start = document.querySelector('[data-testid="start-screen"]');
  if (start && !start.hasAttribute('data-overlay')) {
    return [{ x: 0, y: 0, width, height, radius: 0, tint: [...band, TINT_BAND], style: 'regular', anchor: 'fill' }];
  }
  const regions: GlassRegion[] = [];
  const workspace = document.querySelector('[data-glass-workspace]');
  const top = workspace ? workspace.getBoundingClientRect().top : 0;
  regions.push({ x: 0, y: 0, width, height: top, radius: 0, tint: [...band, TINT_BAND], style: 'regular', anchor: 'band' });
  if (start) return regions;
  for (const [selector, anchor] of [
    ['[data-testid="left-sidebar"]', 'left'],
    ['[data-testid="right-panel"]', 'right'],
  ] as const) {
    const panel = document.querySelector(selector);
    if (!panel) continue;
    const box = panel.getBoundingClientRect();
    const radius = Number.parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 0;
    regions.push({ x: box.left, y: box.top, width: box.width, height: box.height, radius, tint: [...surface, TINT_PANEL], style: 'regular', anchor });
  }
  return regions;
}

export function useNativeGlass(): void {
  useEffect(() => {
    let active = true;
    let frame = 0;
    let last = '';
    const observers: Array<ResizeObserver | MutationObserver> = [];
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const send = () => {
      frame = 0;
      const regions = measure();
      const key = JSON.stringify(regions);
      if (key === last) return;
      last = key;
      api.setGlassRegions(regions);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(send);
    };

    void api.getAppInfo().then((info) => {
      if (!active || !info.nativeGlass) return;
      document.documentElement.dataset.nativeGlass = 'on';
      const app = document.querySelector('[data-glass-app]');
      const workspace = document.querySelector('[data-glass-workspace]');
      const resize = new ResizeObserver(schedule);
      if (workspace) resize.observe(workspace);
      resize.observe(document.documentElement);
      // Seitenleisten und Startseite kommen und gehen (direkte Kinder von App und Arbeitsfläche)
      const children = new MutationObserver(() => {
        for (const panel of document.querySelectorAll('[data-testid="left-sidebar"], [data-testid="right-panel"]')) resize.observe(panel);
        schedule();
      });
      if (app) children.observe(app, { childList: true });
      if (workspace) children.observe(workspace, { childList: true });
      observers.push(resize, children);
      media.addEventListener('change', schedule);
      schedule();
    });

    return () => {
      active = false;
      for (const observer of observers) observer.disconnect();
      media.removeEventListener('change', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
}
