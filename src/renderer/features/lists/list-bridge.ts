// Verbindung zwischen den Listen-Knöpfen in den Leisten und der geöffneten Texteingabe (es gibt höchstens eine):
// Textfeld eines Kommentars, neuer Text oder bearbeiteter Text auf der Seite.
import { create } from 'zustand';
import type { ListAction } from '../../../shared/lists';

export interface ListTarget {
  apply: (action: ListAction) => void;
}

interface ListTargetState {
  target: ListTarget | null;
}

export const useListTarget = create<ListTargetState>(() => ({ target: null }));

// Meldet eine Eingabe an; liefert die Abmeldung (nur wirksam, wenn sie noch die angemeldete ist)
export function registerListTarget(target: ListTarget): () => void {
  useListTarget.setState({ target });
  return () => {
    if (useListTarget.getState().target === target) useListTarget.setState({ target: null });
  };
}

export function applyListAction(action: ListAction): boolean {
  const { target } = useListTarget.getState();
  if (!target) return false;
  target.apply(action);
  return true;
}
