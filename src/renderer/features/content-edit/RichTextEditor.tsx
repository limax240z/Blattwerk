// Texteingabe mit gemischter Gestaltung (wie in einer Textverarbeitung): Größe, Schrift oder Farbe ohne Auswahl gelten
// für das, was danach getippt wird; mit Auswahl für den ausgewählten Text. Das Modell sind Stücke (shared/rich-text.ts);
// die Eingabe zeichnet sie als Spannen in einem bearbeitbaren Element. Tippen, Umbrüche und Einfügen übernimmt das
// Modell selbst, Löschen und Eingaben mit Zusammensetzen (z. B. ¨ + u) der Browser, danach wird das Modell gelesen.
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeRuns, replaceRange, restyleRange, styleAt, withStyle, type RunStyle, type StylePatch, type TextRun } from '../../../shared/rich-text';
import { useContentEdit } from '../../state/content-edit-store';
import { listEdit, listEnter, type ListResult } from '../../../shared/lists';
import { registerListTarget } from '../lists/list-bridge';

export interface RichEditorHandle {
  runs: () => TextRun[];
}

interface Props {
  initial: TextRun[];
  // Gestaltung, solange noch nichts geschrieben ist
  typing: RunStyle;
  css: (style: RunStyle) => CSSProperties;
  className: string;
  handleRef: { current: RichEditorHandle | null };
  onChange: (runs: TextRun[]) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onBlur: (related: EventTarget | null) => void;
}

// Die geöffnete Eingabe (es gibt höchstens eine): die Leiste wendet Größe, Schrift und Farbe über sie an
const bridge: { active: { apply: (patch: StylePatch) => void } | null } = { active: null };

export function applyToRichEditor(patch: StylePatch): boolean {
  if (!bridge.active) return false;
  bridge.active.apply(patch);
  return true;
}

interface Selection {
  start: number;
  end: number;
}

interface Snapshot {
  runs: TextRun[];
  selection: Selection;
}

// Text eines Knotens, wie ihn das Modell zählt: Text, <br> als Umbruch (außer dem Platzhalter am Ende)
function textLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (node instanceof HTMLBRElement) return node.dataset.sentinel === undefined ? 1 : 0;
  let length = 0;
  node.childNodes.forEach((child) => {
    length += textLength(child);
  });
  return length;
}

function offsetIn(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return textLength(range.cloneContents());
}

// Stelle im gezeichneten Text: am Übergang zweier Stücke das Ende des vorderen (dort wird weitergeschrieben)
function pointAt(root: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let position = 0;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const length = node.data.length;
    if (offset <= position + length) return { node, offset: offset - position };
    position += length;
    last = node;
  }
  return last ? { node: last, offset: last.data.length } : { node: root, offset: 0 };
}

export function RichTextEditor({ initial, typing, css, className, handleRef, onChange, onKeyDown, onBlur }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const runs = useRef<TextRun[]>(initial);
  // Gestaltung je gezeichneter Spanne (Index in data-run)
  const drawn = useRef<RunStyle[]>([]);
  const selection = useRef<Selection>({ start: 0, end: 0 });
  // Ohne Auswahl gewählte Gestaltung: gilt für das nächste Getippte an dieser Stelle
  const pending = useRef<{ offset: number; style: RunStyle } | null>(null);
  const undo = useRef<Snapshot[]>([]);
  const redo = useRef<Snapshot[]>([]);
  const lastTyping = useRef(0);
  const composing = useRef(false);
  const typingRef = useRef(typing);
  const cssRef = useRef(css);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    typingRef.current = typing;
    cssRef.current = css;
    onChangeRef.current = onChange;
  });

  // Gestaltung an der Einfügestelle: vorgemerkte, sonst die des Zeichens davor (bei Auswahl: des ersten ausgewählten)
  const caretStyle = (): RunStyle => {
    const { start, end } = selection.current;
    if (pending.current && pending.current.offset === start && start === end) return pending.current.style;
    return styleAt(runs.current, start === end ? start : start + 1) ?? typingRef.current;
  };

  const report = () => useContentEdit.getState().setCaret(caretStyle());

  const draw = () => {
    const root = ref.current;
    if (!root) return;
    const spans: Node[] = runs.current.map((run, index) => {
      const span = document.createElement('span');
      span.dataset.run = String(index);
      Object.assign(span.style, cssRef.current(run));
      span.textContent = run.text;
      return span;
    });
    drawn.current = runs.current.map((run) => ({ ...run }));
    // Leerer Text oder Umbruch am Ende: Platzhalter, damit die letzte Zeile Höhe hat und der Zeiger dort steht
    const text = runs.current.map((run) => run.text).join('');
    if (text === '' || text.endsWith('\n')) {
      const br = document.createElement('br');
      br.dataset.sentinel = '';
      spans.push(br);
    }
    root.replaceChildren(...spans);
    // Grundgröße der Eingabe: die kleinste Schrift (bestimmt die kleinste Zeilenhöhe), leer die Schrift fürs Tippen
    const smallest = runs.current.reduce<RunStyle | null>((min, run) => (!min || run.size < min.size ? run : min), null);
    Object.assign(root.style, cssRef.current(smallest ?? typingRef.current));
  };

  const select = (start: number, end = start) => {
    const root = ref.current;
    if (!root) return;
    selection.current = { start, end };
    const from = pointAt(root, start);
    const to = pointAt(root, end);
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const current = window.getSelection();
    current?.removeAllRanges();
    current?.addRange(range);
  };

  // Modell aus dem gezeichneten Text lesen (nach Löschen oder Zusammensetzen durch den Browser)
  const read = (): TextRun[] => {
    const root = ref.current;
    if (!root) return runs.current;
    const out: TextRun[] = [];
    const visit = (node: Node, style: RunStyle) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out.push({ ...style, text: node.textContent ?? '' });
        return;
      }
      if (node instanceof HTMLBRElement) {
        if (node.dataset.sentinel === undefined) out.push({ ...style, text: '\n' });
        return;
      }
      const own = node instanceof HTMLElement && node.dataset.run !== undefined ? drawn.current[Number(node.dataset.run)] : undefined;
      node.childNodes.forEach((child) => visit(child, own ?? style));
    };
    root.childNodes.forEach((child) => visit(child, drawn.current[0] ?? typingRef.current));
    return normalizeRuns(out);
  };

  const remember = (coalesce: boolean) => {
    const now = Date.now();
    if (!coalesce || now - lastTyping.current > 800) undo.current.push({ runs: runs.current, selection: { ...selection.current } });
    if (undo.current.length > 200) undo.current.shift();
    redo.current = [];
    lastTyping.current = coalesce ? now : 0;
  };

  const update = (next: TextRun[], caret: Selection) => {
    runs.current = next;
    draw();
    select(caret.start, caret.end);
    onChangeRef.current(next);
    report();
  };

  // Aufzählung, Nummerierung oder Einzug: Die Änderungen betreffen den Anfang von Zeilen; eingefügte Zeichen bekommen
  // die Gestaltung des ersten Zeichens ihrer Zeile (leere Zeile: die an der Einfügestelle)
  const applyList = (change: ListResult) => {
    if (change.steps.length === 0) return;
    remember(false);
    pending.current = null;
    let next = runs.current;
    for (const step of change.steps) {
      // Von hinten nach vorn, damit die Stellen davor gültig bleiben
      for (const edit of [...step].reverse()) {
        const style = styleAt(next, edit.at + edit.remove + 1) ?? caretStyle();
        next = replaceRange(next, edit.at, edit.at + edit.remove, edit.insert, style);
      }
    }
    update(next, { start: change.start, end: change.end });
  };
  const text = () => runs.current.map((run) => run.text).join('');

  const insert = (text: string, coalesce: boolean) => {
    const { start, end } = selection.current;
    const style = caretStyle();
    remember(coalesce);
    pending.current = null;
    update(replaceRange(runs.current, start, end, text, style), { start: start + text.length, end: start + text.length });
  };

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    draw();
    root.focus({ preventScroll: true });
    const length = initial.reduce((sum, run) => sum + run.text.length, 0);
    select(length);
    report();
    const onSelection = () => {
      const current = window.getSelection();
      if (!current || current.rangeCount === 0 || composing.current) return;
      const range = current.getRangeAt(0);
      // Fokus in der Leiste: die Auswahl in der Eingabe bleibt gemerkt
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
      const start = offsetIn(root, range.startContainer, range.startOffset);
      const end = offsetIn(root, range.endContainer, range.endOffset);
      selection.current = { start: Math.min(start, end), end: Math.max(start, end) };
      if (pending.current && (pending.current.offset !== start || start !== end)) pending.current = null;
      report();
    };
    document.addEventListener('selectionchange', onSelection);
    bridge.active = {
      apply: (patch) => {
        const { start, end } = selection.current;
        if (start === end) {
          // Ohne Auswahl: gilt für das, was hier als Nächstes getippt wird
          pending.current = { offset: start, style: withStyle(caretStyle(), patch) };
          root.focus({ preventScroll: true });
          select(start);
          report();
          return;
        }
        remember(false);
        update(restyleRange(runs.current, start, end, patch), { start, end });
        root.focus({ preventScroll: true });
      },
    };
    handleRef.current = { runs: () => runs.current };
    const unregister = registerListTarget({
      apply: (action) => {
        root.focus({ preventScroll: true });
        const { start, end } = selection.current;
        applyList(listEdit(text(), start, end, action));
      },
    });
    return () => {
      document.removeEventListener('selectionchange', onSelection);
      unregister();
      bridge.active = null;
      handleRef.current = null;
      useContentEdit.getState().setCaret(null);
    };
    // Nur beim Öffnen: Danach führt die Eingabe ihr Modell selbst
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onBeforeInput = (event: InputEvent) => {
    const type = event.inputType;
    if (type === 'insertText' && event.data !== null) {
      event.preventDefault();
      insert(event.data.replace(/\r\n?/g, '\n'), true);
    } else if (type === 'insertLineBreak' || type === 'insertParagraph') {
      event.preventDefault();
      // In einer Listenzeile geht die Liste weiter (Umschalt+Eingabe: einfacher Umbruch)
      const { start, end } = selection.current;
      const change = type === 'insertParagraph' ? listEnter(text(), start, end) : null;
      if (change) applyList(change);
      else insert('\n', false);
    } else if (type === 'insertFromPaste' || type === 'insertFromDrop') {
      event.preventDefault();
      const text = event.dataTransfer?.getData('text/plain') ?? '';
      if (text) insert(text.replace(/\r\n?/g, '\n'), false);
    } else if (type === 'historyUndo' || type === 'historyRedo') {
      event.preventDefault();
      const [from, to] = type === 'historyUndo' ? [undo.current, redo.current] : [redo.current, undo.current];
      const snapshot = from.pop();
      if (!snapshot) return;
      to.push({ runs: runs.current, selection: { ...selection.current } });
      lastTyping.current = 0;
      update(snapshot.runs, snapshot.selection);
    } else if (type.startsWith('format')) {
      // Fett, Kursiv usw. des Browsers: nicht im Modell, deshalb gesperrt
      event.preventDefault();
    } else if (type.startsWith('delete')) {
      remember(false);
      pending.current = null;
    }
  };

  // Nach Änderungen durch den Browser: Modell lesen und sauber neu zeichnen
  const onInput = () => {
    if (composing.current) return;
    const root = ref.current;
    if (!root) return;
    const current = window.getSelection();
    const range = current && current.rangeCount > 0 ? current.getRangeAt(0) : null;
    const caret = range && root.contains(range.startContainer) ? offsetIn(root, range.startContainer, range.startOffset) : selection.current.start;
    update(read(), { start: caret, end: caret });
  };

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    // React kennt beforeinput nur eingeschränkt (ohne inputType): direkt anmelden
    const before = (event: Event) => onBeforeInput(event as InputEvent);
    root.addEventListener('beforeinput', before);
    return () => root.removeEventListener('beforeinput', before);
  });

  return (
    <div
      ref={ref}
      className={className}
      contentEditable="true"
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={t('contentEdit.textInput')}
      onInput={onInput}
      onCompositionStart={() => {
        composing.current = true;
        remember(false);
      }}
      onCompositionEnd={() => {
        composing.current = false;
        onInput();
      }}
      onKeyDown={(event) => {
        // Alles auswählen (Cmd/Strg+A): im Modell, damit die Auswahl auch ohne Menü stimmt
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          event.stopPropagation();
          select(0, runs.current.reduce((sum, run) => sum + run.text.length, 0));
          report();
          return;
        }
        // Tabulator rückt ein, Umschalt+Tabulator aus (wie in einer Textverarbeitung)
        if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          const { start, end } = selection.current;
          applyList(listEdit(text(), start, end, { type: 'indent', delta: event.shiftKey ? -1 : 1 }));
          return;
        }
        onKeyDown(event);
      }}
      onBlur={(event) => onBlur(event.relatedTarget)}
      onPointerDown={(event) => event.stopPropagation()}
      data-testid="content-text-editor"
    />
  );
}
