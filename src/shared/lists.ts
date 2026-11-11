// Aufzählungen und Nummerierungen in Texten (Textfelder der Kommentare, neuer und vorhandener Text auf der Seite).
// Eine Liste steht als gewöhnliche Zeichen im Text: Einzug aus Leerzeichen, Zeichen bzw. Nummer, ein Leerzeichen, dann
// der Inhalt. So bleibt sie in jedem Programm sichtbar, das das PDF öffnet. Alle Zeichen gehören zum westeuropäischen
// Zeichensatz, den die Standardschriften darstellen.
// Positionen sind Zeichenpositionen im ganzen Text (wie in einer Texteingabe), \n trennt Zeilen.

export type BulletKind = 'bullet' | 'dash' | 'circle';
export type NumberKind = 'decimal' | 'decimalParen' | 'lowerParen' | 'upper' | 'roman';
export type ListKind = BulletKind | NumberKind;

export const BULLET_KINDS: readonly BulletKind[] = ['bullet', 'dash', 'circle'];
export const NUMBER_KINDS: readonly NumberKind[] = ['decimal', 'decimalParen', 'lowerParen', 'upper', 'roman'];

const BULLETS: Record<BulletKind, string> = { bullet: '•', dash: '–', circle: 'o' };

// Leerzeichen je Einzugsstufe
export const INDENT = '    ';
export const MAX_LEVEL = 8;

export type ListAction = { type: 'toggle'; kind: ListKind } | { type: 'indent'; delta: -1 | 0 | 1 };

export interface TextEdit {
  // Ersetzt [at, at + remove) durch insert
  at: number;
  remove: number;
  insert: string;
}

// Änderungen in Schritten: Jeder Schritt bezieht sich auf den Text nach den vorherigen. start und end: Auswahl danach.
export interface ListResult {
  steps: TextEdit[][];
  start: number;
  end: number;
}

export interface ListLine {
  // Einzugsstufe (volle INDENT), Leerzeichen davor insgesamt
  level: number;
  spaces: number;
  kind: ListKind | null;
  // Länge des Vorspanns (Einzug, Zeichen, Leerzeichen); der Inhalt beginnt dort
  prefix: number;
}

function toRoman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  let rest = n;
  for (const [value, digits] of table) {
    while (rest >= value) {
      out += digits;
      rest -= value;
    }
  }
  return out;
}

// a, b, …, z, aa, ab, … (wie in Textverarbeitungen)
function toLetters(n: number): string {
  let out = '';
  let rest = n;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    out = String.fromCharCode(97 + digit) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
}

// Zeichen bzw. Nummer (ohne Leerzeichen danach) für den n-ten Eintrag
export function marker(kind: ListKind, n = 1): string {
  switch (kind) {
    case 'bullet':
    case 'dash':
    case 'circle':
      return BULLETS[kind];
    case 'decimal':
      return `${n}.`;
    case 'decimalParen':
      return `${n})`;
    case 'lowerParen':
      return `${toLetters(n)})`;
    case 'upper':
      return `${toLetters(n).toUpperCase()}.`;
    case 'roman':
      return `${toRoman(n)}.`;
  }
}

const PATTERNS: Array<[ListKind, RegExp]> = [
  ['bullet', /^• /],
  ['dash', /^– /],
  ['circle', /^o /],
  ['decimal', /^\d{1,4}\. /],
  ['decimalParen', /^\d{1,4}\) /],
  // Römisch vor den Buchstaben: „i.“, „v.“, „x.“ usw. sind römische Zahlen
  ['roman', /^[ivxlcdm]{1,8}\. /],
  ['lowerParen', /^[a-z]{1,3}\) /],
  ['upper', /^[A-Z]{1,3}\. /],
];

export function parseLine(line: string): ListLine {
  const spaces = /^ */.exec(line)?.[0].length ?? 0;
  const level = Math.min(MAX_LEVEL, Math.floor(spaces / INDENT.length));
  const rest = line.slice(spaces);
  for (const [kind, pattern] of PATTERNS) {
    const match = pattern.exec(rest);
    if (match) return { level, spaces, kind, prefix: spaces + match[0].length };
  }
  return { level, spaces, kind: null, prefix: spaces };
}

// Länge des Vorspanns einer Listenzeile (für den hängenden Einzug beim Umbrechen), 0 bei gewöhnlichen Zeilen
export function hangingPrefix(line: string): number {
  const parsed = parseLine(line);
  return parsed.kind === null ? 0 : parsed.prefix;
}

interface LineInfo {
  start: number;
  text: string;
}

function lines(text: string): LineInfo[] {
  const out: LineInfo[] = [];
  let start = 0;
  for (const part of text.split('\n')) {
    out.push({ start, text: part });
    start += part.length + 1;
  }
  return out;
}

// Zeilen, die die Auswahl berührt (eine Auswahl, die genau am Zeilenanfang endet, zählt die Zeile nicht mit)
function touched(all: LineInfo[], start: number, end: number): number[] {
  const last = end > start ? end - 1 : end;
  const out: number[] = [];
  all.forEach((line, i) => {
    const lineEnd = line.start + line.text.length;
    if (lineEnd >= start && line.start <= last) out.push(i);
  });
  return out;
}

const prefixFor = (level: number, kind: ListKind | null, n: number) => INDENT.repeat(level) + (kind ? `${marker(kind, n)} ` : '');

// Neue Vorspänne für alle Zeilen: Nummern laufen je Stufe hoch; eine Zeile ohne Liste (auch eine leere) beendet die
// Listen, eine weniger eingerückte Zeile beendet die tieferen Stufen.
function renumbered(all: Array<{ level: number; kind: ListKind | null; spaces: number }>): string[] {
  const counters: Array<{ kind: ListKind; n: number } | undefined> = [];
  return all.map((line) => {
    if (line.kind === null) {
      counters.length = 0;
      return ' '.repeat(line.spaces);
    }
    counters.length = line.level + 1;
    const previous = counters[line.level];
    const n = previous && previous.kind === line.kind ? previous.n + 1 : 1;
    counters[line.level] = { kind: line.kind, n };
    return prefixFor(line.level, line.kind, n);
  });
}

// Änderungen, die die Vorspänne aller Zeilen auf next bringen (nur wo sie sich unterscheiden)
function prefixEdits(all: LineInfo[], parsed: ListLine[], next: string[]): TextEdit[] {
  const edits: TextEdit[] = [];
  all.forEach((line, i) => {
    const old = line.text.slice(0, (parsed[i] as ListLine).prefix);
    const updated = next[i] as string;
    if (old !== updated) edits.push({ at: line.start, remove: old.length, insert: updated });
  });
  return edits;
}

// Stelle nach den Änderungen (Änderungen aufsteigend, ohne Überschneidung). Eine Stelle im ersetzten Bereich oder
// genau an einer Einfügung rückt dahinter (der Zeiger bleibt beim Inhalt der Zeile).
export function mapOffset(offset: number, edits: TextEdit[]): number {
  let shift = 0;
  for (const edit of edits) {
    if (edit.at > offset) break;
    if (offset < edit.at + edit.remove) return edit.at + shift + edit.insert.length;
    shift += edit.insert.length - edit.remove;
  }
  return offset + shift;
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  let out = '';
  let position = 0;
  for (const edit of edits) {
    out += text.slice(position, edit.at) + edit.insert;
    position = edit.at + edit.remove;
  }
  return out + text.slice(position);
}

// Liste ein- oder ausschalten bzw. ein- oder ausrücken für die Zeilen der Auswahl; danach stimmen alle Nummern
export function listEdit(text: string, start: number, end: number, action: ListAction): ListResult {
  const all = lines(text);
  const parsed = all.map((line) => parseLine(line.text));
  const chosen = touched(all, start, end);
  const state = parsed.map((line) => ({ level: line.level, kind: line.kind, spaces: line.spaces }));
  if (action.type === 'toggle') {
    // Haben schon alle Zeilen diese Art, wird die Liste entfernt (Einzug bleibt), sonst bekommen alle diese Art
    const off = chosen.every((i) => parsed[i]?.kind === action.kind);
    for (const i of chosen) {
      const line = state[i] as (typeof state)[number];
      line.kind = off ? null : action.kind;
      line.spaces = line.level * INDENT.length;
    }
  } else {
    for (const i of chosen) {
      const line = state[i] as (typeof state)[number];
      line.level = Math.max(0, Math.min(MAX_LEVEL, line.level + action.delta));
      line.spaces = line.level * INDENT.length;
    }
  }
  const edits = prefixEdits(all, parsed, renumbered(state));
  return result(edits, start, end, all, parsed);
}

// Eingabetaste in einer Listenzeile: neue Zeile mit dem nächsten Zeichen; in einem leeren Eintrag endet die Liste
// (eingerückt: eine Stufe zurück). null: keine Listenzeile, die Eingabe macht wie gewohnt einen Umbruch.
export function listEnter(text: string, start: number, end: number): ListResult | null {
  const all = lines(text);
  const index = touched(all, start, start)[0] ?? 0;
  const line = all[index] as LineInfo;
  const parsed = parseLine(line.text);
  if (parsed.kind === null || start < line.start + parsed.prefix) return null;
  if (line.text.slice(parsed.prefix).trim() === '' && start === end) {
    return listEdit(text, start, end, parsed.level > 0 ? { type: 'indent', delta: -1 } : { type: 'toggle', kind: parsed.kind });
  }
  // Umbruch einfügen, die neue Zeile bekommt denselben Vorspann; die Nummern ordnet renumbered danach
  const insert = `\n${prefixFor(parsed.level, parsed.kind, 1)}`;
  const broken = applyEdits(text, [{ at: start, remove: end - start, insert }]);
  const caret = start + insert.length;
  const renumber = listEdit(broken, caret, caret, { type: 'indent', delta: 0 });
  return { steps: [[{ at: start, remove: end - start, insert }], ...renumber.steps], start: renumber.start, end: renumber.end };
}

function result(edits: TextEdit[], start: number, end: number, all: LineInfo[], parsed: ListLine[]): ListResult {
  // Steht die Auswahl im alten Vorspann, rückt sie an den Anfang des Inhalts
  const content = (offset: number) => {
    const line = all.find((info) => offset >= info.start && offset <= info.start + info.text.length);
    const prefix = line ? (parsed[all.indexOf(line)] as ListLine).prefix : 0;
    return line && offset < line.start + prefix ? line.start + prefix : offset;
  };
  return { steps: edits.length > 0 ? [edits] : [], start: mapOffset(content(start), edits), end: mapOffset(content(end), edits) };
}

export function applyList(text: string, change: ListResult): string {
  return change.steps.reduce(applyEdits, text);
}
