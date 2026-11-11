// Listen in einer gewöhnlichen Texteingabe (Textfeld eines Kommentars, Text aus anderen Programmen): Knöpfe der
// Leiste, Tabulator zum Ein- und Ausrücken, Eingabetaste setzt eine Liste fort.
import type { KeyboardEvent } from 'react';
import { applyList, listEdit, listEnter, type ListAction, type ListResult } from '../../../shared/lists';

// Ergebnis anwenden: neuer Text über setValue, danach die Auswahl setzen. Der Text steht vorher schon im Feld, React
// ändert es beim Neuzeichnen also nicht mehr (und lässt die Auswahl stehen).
export function applyToTextarea(area: HTMLTextAreaElement, change: ListResult, setValue: (text: string) => void): void {
  const text = applyList(area.value, change);
  // Gleich ins Feld schreiben, damit Messungen (wachsendes Textfeld) den neuen Text sehen
  area.value = text;
  setValue(text);
  area.focus({ preventScroll: true });
  area.setSelectionRange(change.start, change.end);
}

export function textareaListAction(area: HTMLTextAreaElement, action: ListAction, setValue: (text: string) => void): void {
  applyToTextarea(area, listEdit(area.value, area.selectionStart, area.selectionEnd, action), setValue);
}

// Tasten für Listen; true, wenn die Taste verbraucht wurde. enter: Die Eingabetaste macht hier einen Zeilenumbruch.
export function textareaListKey(event: KeyboardEvent<HTMLTextAreaElement>, setValue: (text: string) => void, enter: boolean): boolean {
  const area = event.currentTarget;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key === 'Tab') {
    event.preventDefault();
    textareaListAction(area, { type: 'indent', delta: event.shiftKey ? -1 : 1 }, setValue);
    return true;
  }
  if (event.key === 'Enter' && enter && !event.shiftKey && !event.nativeEvent.isComposing) {
    const change = listEnter(area.value, area.selectionStart, area.selectionEnd);
    if (!change) return false;
    event.preventDefault();
    applyToTextarea(area, change, setValue);
    return true;
  }
  return false;
}
