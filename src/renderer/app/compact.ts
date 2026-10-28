// Kompaktansicht für schmale Bildschirme (ADR 0030): iPhone und iPad im geteilten Bildschirm. Die Mac-App erreicht diese
// Breite nie (Fenster mindestens 760 breit). CSS fragt das Kennzeichen data-compact am Dokument ab.
import { useSyncExternalStore } from 'react';

export const COMPACT_QUERY = '(max-width: 599px)';

const query = typeof window !== 'undefined' ? window.matchMedia(COMPACT_QUERY) : null;

function mark(): void {
  if (!query) return;
  if (query.matches) document.documentElement.dataset.compact = '';
  else delete document.documentElement.dataset.compact;
}

mark();
query?.addEventListener('change', mark);

const subscribe = (listener: () => void) => {
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
};

export function isCompact(): boolean {
  return query?.matches ?? false;
}

export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, isCompact, () => false);
}
