// Updates (ADR 0025, ADR 0027): Stand prüfen beim Start und wenn das Fenster nach vorn kommt; neue Versionen im Netz
// suchen und laden („Nach Updates suchen“, sonst still im Hauptprozess, siehe main/update/schedule.ts). Hinweis ausblenden gilt nur für die
// angezeigte Version.
import { create } from 'zustand';
import type { OnlineCheck, UpdateProgress, UpdateStatus } from '../../../shared/update';
import { api } from '../../api';

interface UpdateState {
  status: UpdateStatus | null;
  dismissed: string | null;
  installing: boolean;
  // Von Hand angestoßene Suche läuft (Hinweis „Suche nach einer neuen Version …“)
  searching: boolean;
  // Neue Version wird geladen
  download: UpdateProgress | null;
  check: () => Promise<UpdateStatus | null>;
  searchOnline: () => Promise<OnlineCheck | null>;
  setProgress: (progress: UpdateProgress | null) => void;
  dismiss: () => void;
  install: () => Promise<boolean>;
}

export const useUpdate = create<UpdateState>((set, get) => ({
  status: null,
  dismissed: null,
  installing: false,
  searching: false,
  download: null,
  check: async () => {
    try {
      const status = await api.update.status();
      set({ status });
      return status;
    } catch {
      return null;
    }
  },
  searchOnline: async () => {
    set({ searching: true, dismissed: null });
    try {
      const result = await api.update.checkOnline();
      if (result.state === 'downloaded') await get().check();
      return result;
    } catch {
      return null;
    } finally {
      set({ searching: false, download: null });
    }
  },
  setProgress: (download) => set({ download }),
  dismiss: () => {
    const status = get().status;
    if (status?.state === 'available') set({ dismissed: status.version });
  },
  install: async () => {
    set({ installing: true });
    const started = await api.update.install().catch(() => false);
    // Abgebrochen (z. B. „Abbrechen“ bei der Rückfrage zum Speichern): Das Update bleibt vorgemerkt und kommt beim
    // nächsten Beenden
    set({ installing: false });
    return started;
  },
}));
