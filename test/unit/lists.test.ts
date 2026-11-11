// Aufzählungen und Nummerierungen als Text: einschalten, wechseln, einrücken, Eingabetaste, Nummern.
import { describe, expect, it } from 'vitest';
import { applyList, hangingPrefix, listEdit, listEnter, mapOffset, marker, parseLine } from '../../src/shared/lists';

const run = (text: string, start: number, end: number, action: Parameters<typeof listEdit>[3]) => {
  const change = listEdit(text, start, end, action);
  return { text: applyList(text, change), start: change.start, end: change.end };
};

describe('Zeichen und Nummern', () => {
  it('zählt in allen Arten', () => {
    expect([marker('bullet'), marker('dash'), marker('decimal', 3), marker('decimalParen', 2)]).toEqual(['•', '–', '3.', '2)']);
    expect([marker('lowerParen', 1), marker('lowerParen', 27), marker('upper', 3), marker('roman', 4), marker('roman', 9)]).toEqual(['a)', 'aa)', 'C.', 'iv.', 'ix.']);
  });

  it('erkennt Listenzeilen', () => {
    expect(parseLine('    • Text')).toEqual({ level: 1, spaces: 4, kind: 'bullet', prefix: 6 });
    expect(parseLine('12. Punkt').kind).toBe('decimal');
    expect(parseLine('iv. vier').kind).toBe('roman');
    expect(parseLine('b) zwei').kind).toBe('lowerParen');
    expect(parseLine('Hallo Welt').kind).toBeNull();
    expect(hangingPrefix('1. Text')).toBe(3);
    expect(hangingPrefix('Text')).toBe(0);
  });
});

describe('Liste ein- und ausschalten', () => {
  it('nummeriert alle ausgewählten Zeilen', () => {
    expect(run('eins\nzwei\ndrei', 0, 13, { type: 'toggle', kind: 'decimal' }).text).toBe('1. eins\n2. zwei\n3. drei');
  });

  it('wechselt die Art und schaltet sie wieder aus', () => {
    const numbered = '1. eins\n2. zwei';
    const bullets = run(numbered, 0, numbered.length, { type: 'toggle', kind: 'bullet' }).text;
    expect(bullets).toBe('• eins\n• zwei');
    expect(run(bullets, 0, bullets.length, { type: 'toggle', kind: 'bullet' }).text).toBe('eins\nzwei');
  });

  it('wirkt ohne Auswahl auf die Zeile des Zeigers und hält ihn beim Inhalt', () => {
    const result = run('eins\nzwei', 7, 7, { type: 'toggle', kind: 'dash' });
    expect(result.text).toBe('eins\n– zwei');
    expect(result.start).toBe(9);
  });
});

describe('Einrücken', () => {
  it('rückt ein und zählt je Stufe neu', () => {
    const text = '1. a\n2. b\n3. c';
    const result = run(text, 6, 6, { type: 'indent', delta: 1 });
    expect(result.text).toBe('1. a\n    1. b\n2. c');
    expect(run(result.text, 10, 10, { type: 'indent', delta: -1 }).text).toBe(text);
  });

  it('rückt auch gewöhnliche Zeilen ein', () => {
    expect(run('Text', 0, 0, { type: 'indent', delta: 1 }).text).toBe('    Text');
    expect(run('Text', 0, 0, { type: 'indent', delta: -1 }).text).toBe('Text');
  });
});

describe('Eingabetaste', () => {
  it('setzt die Liste fort und zählt weiter', () => {
    const text = '1. eins\n2. zwei';
    const change = listEnter(text, 7, 7);
    expect(change).not.toBeNull();
    if (!change) return;
    expect(applyList(text, change)).toBe('1. eins\n2. \n3. zwei');
    expect(change.start).toBe(11);
  });

  it('beendet die Liste in einem leeren Eintrag', () => {
    const text = '• eins\n• ';
    const change = listEnter(text, text.length, text.length);
    expect(change && applyList(text, change)).toBe('• eins\n');
  });

  it('geht in einem leeren eingerückten Eintrag eine Stufe zurück', () => {
    const text = '• eins\n    • ';
    const change = listEnter(text, text.length, text.length);
    expect(change && applyList(text, change)).toBe('• eins\n• ');
  });

  it('greift nur in Listenzeilen', () => {
    expect(listEnter('Text', 4, 4)).toBeNull();
  });
});

describe('Stellen umrechnen', () => {
  it('verschiebt hinter Änderungen', () => {
    const edits = [{ at: 0, remove: 0, insert: '• ' }];
    expect(mapOffset(3, edits)).toBe(5);
    expect(mapOffset(0, edits)).toBe(2);
  });
});
