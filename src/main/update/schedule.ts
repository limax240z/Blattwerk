// Wann die App von selbst nach Updates sucht (Wunsch des Auftraggebers, 2026-11-04): bei jedem Start, bei jedem neuen
// Dokument, bei der Rückkehr in die App nach einiger Zeit und alle paar Stunden. Ohne Electron, damit testbar.

export type UpdateTrigger = 'start' | 'document' | 'return' | 'timer';

// Abstand zwischen zwei Suchen: GitHub erlaubt ohne Anmeldung 60 Anfragen je Stunde und Internetanschluss. Wer zehn PDFs
// auf einmal öffnet, soll nicht zehnmal fragen.
export const MIN_GAP_MS = 2 * 60_000;
// So lange muss die App im Hintergrund gewesen sein, damit die Rückkehr zählt
export const RETURN_AWAY_MS = 10 * 60_000;
// Spätestens nach dieser Zeit wird wieder gesucht
export const PERIOD_MS = 3 * 60 * 60_000;
// So oft prüft der Zeitgeber, ob die Zeit um ist. Kleiner Takt statt eines Zeitgebers über drei Stunden: Der stünde
// im Ruhezustand still, nach dem Aufwachen fiele die Suche sonst stundenlang aus.
export const TICK_MS = 5 * 60_000;

export interface UpdateClock {
  now: number;
  // Beginn der letzten Suche (null = noch keine seit dem Start)
  last: number | null;
  // Seit wann die App im Hintergrund war (nur bei „return“)
  awaySince?: number | null;
}

export function shouldCheck(trigger: UpdateTrigger, { now, last, awaySince = null }: UpdateClock): boolean {
  const gap = last === null ? Number.POSITIVE_INFINITY : now - last;
  switch (trigger) {
    // Auch der Start hält den Abstand ein: Ein Doppelklick auf ein PDF ist Start und neues Dokument zugleich
    case 'start':
    case 'document':
      return gap >= MIN_GAP_MS;
    case 'return':
      return gap >= MIN_GAP_MS && awaySince !== null && now - awaySince >= RETURN_AWAY_MS;
    case 'timer':
      return gap >= PERIOD_MS;
  }
}
