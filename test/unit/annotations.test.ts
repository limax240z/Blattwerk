// Kommentarlogik ohne Oberfläche: Geometrie, Anlegen, Änderungen fürs Speichern, Rückgängig/Wiederholen, Einlesen.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Annotation, Quad, Rect } from '../../src/shared/annotations';
import { parsePdfDate, toPdfDate } from '../../src/shared/annotations';
import { computeChanges, hasChanges, hiddenOriginals, needsAppearance } from '../../src/renderer/features/annotations/changes';
import {
  appendInkStroke,
  createFreeText,
  createInk,
  createLine,
  createMarkup,
  createNote,
  createShape,
  createStamp,
  LINE_LENGTH,
  simplifyPath,
  type Base,
} from '../../src/renderer/features/annotations/create';
import { convertPageAnnotations, pdfText, toQuads, type PdfjsAnnotationData } from '../../src/renderer/features/annotations/from-pdfjs';
import { clampToRect, clipPath, dragRect, isMovable, isResizable, pageRect, quadsFromRects, translate } from '../../src/renderer/features/annotations/geometry';
import { isDirty, useAnnotations } from '../../src/renderer/state/annotations-store';

const red = { r: 1, g: 0, b: 0 };
let counter = 0;
const base = (pageIndex = 0): Base => ({
  id: `neu-${++counter}`,
  ref: null,
  pageIndex,
  author: 'Test',
  created: 'D:20260101120000Z',
  modified: 'D:20260101120000Z',
  contents: '',
  opacity: 1,
  replies: [],
  statuses: [],
});

describe('Geometrie', () => {
  it('fasst Auswahlrechtecke einer Zeile zu einem Viereck zusammen', () => {
    const rects: Rect[] = [
      [100, 700, 150, 712],
      [150, 700.5, 220, 712.5],
      [100, 680, 180, 692],
    ];
    const quads = quadsFromRects(rects);
    expect(quads).toHaveLength(2);
    // Oberste Zeile zuerst, Reihenfolge der Ecken wie /QuadPoints: oben links, oben rechts, unten links, unten rechts
    expect(quads[0]).toEqual([
      { x: 100, y: 712.5 },
      { x: 220, y: 712.5 },
      { x: 100, y: 700 },
      { x: 220, y: 700 },
    ]);
  });

  it('ignoriert leere Rechtecke', () => {
    expect(quadsFromRects([[10, 10, 10.2, 20]])).toEqual([]);
  });

  it('Klick ohne Ziehen ergibt die Standardgröße unterhalb des Punkts', () => {
    expect(dragRect({ x: 50, y: 500 }, { x: 51, y: 501 }, { width: 100, height: 60 })).toEqual([50, 440, 150, 500]);
    expect(dragRect({ x: 200, y: 500 }, { x: 100, y: 600 }, { width: 1, height: 1 })).toEqual([100, 500, 200, 600]);
  });

  it('verschiebt alle Punkte eines Kommentars', () => {
    const ink = createInk(base(), [[{ x: 0, y: 0 }, { x: 10, y: 10 }]], red, 2);
    const moved = translate(ink, 5, -5);
    expect(moved.kind === 'ink' && moved.paths[0]).toEqual([
      { x: 5, y: -5 },
      { x: 15, y: 5 },
    ]);
    expect(moved.rect).toEqual([ink.rect[0] + 5, ink.rect[1] - 5, ink.rect[2] + 5, ink.rect[3] - 5]);
    const line = createLine(base(), 'arrow', { x: 0, y: 0 }, { x: 50, y: 0 }, red, 1);
    const movedLine = translate(line, 1, 2);
    expect(movedLine.kind === 'arrow' && [movedLine.start, movedLine.end]).toEqual([
      { x: 1, y: 2 },
      { x: 51, y: 2 },
    ]);
  });

  it('Textmarkierungen bleiben an ihrem Text, Rahmen und Stempel sind veränderbar', () => {
    const quad: Quad = [
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(isMovable(createMarkup(base(), 'highlight', [quad], red))).toBe(false);
    expect(isResizable(createShape(base(), 'square', [0, 0, 10, 10], red, 1))).toBe(true);
    expect(isResizable(createInk(base(), [[{ x: 0, y: 0 }, { x: 1, y: 1 }]], red, 1))).toBe(false);
  });
});

describe('Anlegen', () => {
  it('Notiz, Stempel und Linie mit sinnvollen Standardmaßen', () => {
    expect(createNote(base(), { x: 100, y: 700 }, red).rect).toEqual([100, 680, 120, 700]);
    const stamp = createStamp(base(), { x: 300, y: 400 }, 'final', 'ENDGÜLTIG', red);
    expect(stamp.rect[2] - stamp.rect[0]).toBeGreaterThan(stamp.rect[3] - stamp.rect[1]);
    expect((stamp.rect[0] + stamp.rect[2]) / 2).toBe(300);
    const click = createLine(base(), 'line', { x: 10, y: 10 }, { x: 11, y: 10 }, red, 1);
    expect(click.kind === 'line' && click.end).toEqual({ x: 10 + LINE_LENGTH, y: 10 });
  });

  it('Freihand: Striche anhängen und Punkte ausdünnen', () => {
    const ink = createInk(base(), [[{ x: 0, y: 0 }, { x: 10, y: 0 }]], red, 2);
    const more = appendInkStroke(ink, [
      { x: 0, y: 50 },
      { x: 10, y: 60 },
    ]);
    expect(more.paths).toHaveLength(2);
    expect(more.rect[3]).toBeGreaterThanOrEqual(60);
    const dense = Array.from({ length: 100 }, (_, i) => ({ x: i * 0.1, y: 0 }));
    const thin = simplifyPath(dense);
    expect(thin.length).toBeLessThan(20);
    expect(thin.at(-1)).toEqual(dense.at(-1));
  });
});

function existing(id: string, extra: Partial<Annotation> = {}): Annotation {
  return { ...createShape({ ...base(), id, ref: id }, 'square', [0, 0, 50, 50], red, 2), ...extra } as Annotation;
}

describe('Änderungen fürs Speichern', () => {
  it('neue Kommentare werden mit Darstellung geschrieben', () => {
    const note = createNote(base(), { x: 1, y: 1 }, red);
    const changes = computeChanges([note], {});
    expect(changes.upserts).toEqual([{ annotation: note, appearance: true }]);
    expect(changes.deletions).toEqual([]);
  });

  it('nur Text geändert: vorhandene Darstellung bleibt', () => {
    const original = existing('5R');
    const changed = { ...original, contents: 'neu' } as Annotation;
    expect(needsAppearance(original, changed)).toBe(false);
    expect(computeChanges([changed], { '5R': original }).upserts).toEqual([{ annotation: changed, appearance: false }]);
    expect(hiddenOriginals([changed], { '5R': original }).size).toBe(0);
  });

  it('verschoben: neue Darstellung, pdf.js blendet das Original aus', () => {
    const original = existing('5R');
    const moved = translate(original, 10, 0);
    expect(computeChanges([moved], { '5R': original }).upserts[0]?.appearance).toBe(true);
    expect(hiddenOriginals([moved], { '5R': original })).toEqual(new Map([['5R', 0]]));
  });

  it('gelöscht: Kommentar samt Antworten und Status werden entfernt', () => {
    const original = existing('5R', {
      replies: [{ id: '6R', ref: '6R', author: 'A', contents: 'x', modified: '' }],
      statuses: [{ id: '7R', ref: '7R', author: 'A', status: 'Accepted', modified: '' }],
    });
    const changes = computeChanges([], { '5R': original });
    expect(changes.deletions.sort()).toEqual(['5R', '6R', '7R']);
    expect(hasChanges(changes)).toBe(true);
  });

  it('gelöschte vorhandene Antwort wird entfernt, der Kommentar bleibt', () => {
    const original = existing('5R', { replies: [{ id: '6R', ref: '6R', author: 'A', contents: 'x', modified: '' }] });
    const changed = { ...original, replies: [] } as Annotation;
    const changes = computeChanges([changed], { '5R': original });
    expect(changes.deletions).toEqual(['6R']);
    expect(changes.upserts[0]?.appearance).toBe(false);
  });

  it('unverändert: nichts zu speichern', () => {
    const original = existing('5R');
    expect(hasChanges(computeChanges([original], { '5R': original }))).toBe(false);
  });
});

describe('Rückgängig und Wiederholen', () => {
  const tab = 'tab-1';
  const state = () => useAnnotations.getState().tabs[tab];
  beforeEach(() => useAnnotations.getState().init(tab));

  it('Anlegen, Ändern, Löschen lassen sich zurücknehmen und wiederholen', () => {
    const store = useAnnotations.getState();
    const square = createShape(base(), 'square', [0, 0, 10, 10], red, 1);
    store.apply(tab, { type: 'add', annotation: square });
    const moved = translate(square, 5, 5);
    store.apply(tab, { type: 'update', before: square, after: moved });
    store.apply(tab, { type: 'remove', annotation: moved, index: 0 });
    expect(state()?.items).toEqual([]);
    store.undo(tab);
    expect(state()?.items).toEqual([moved]);
    store.undo(tab);
    expect(state()?.items).toEqual([square]);
    store.redo(tab);
    expect(state()?.items).toEqual([moved]);
    expect(state()?.redo).toHaveLength(1);
  });

  it('Ungespeichert-Markierung folgt dem Stand beim Speichern', () => {
    const store = useAnnotations.getState();
    const square = createShape(base(), 'square', [0, 0, 10, 10], red, 1);
    expect(isDirty(state())).toBe(false);
    store.apply(tab, { type: 'add', annotation: square });
    expect(isDirty(state())).toBe(true);
    store.markSaved(tab);
    expect(isDirty(state())).toBe(false);
    store.undo(tab);
    expect(isDirty(state())).toBe(true);
    store.redo(tab);
    expect(isDirty(state())).toBe(false);
    // Nach Rückgängig etwas Neues: Der gespeicherte Stand ist nicht mehr erreichbar.
    store.undo(tab);
    store.apply(tab, { type: 'add', annotation: createNote(base(), { x: 0, y: 0 }, red) });
    store.undo(tab);
    expect(isDirty(state())).toBe(true);
  });

  it('leeres neues Textfeld verschwindet spurlos', () => {
    const store = useAnnotations.getState();
    const box = createFreeText(base(), [0, 0, 100, 40], red, 12);
    store.apply(tab, { type: 'add', annotation: box });
    store.select(tab, box.id);
    store.discard(tab, box.id);
    expect(state()?.items).toEqual([]);
    expect(state()?.undo).toEqual([]);
    expect(state()?.selectedId).toBeNull();
    expect(isDirty(state())).toBe(false);
  });

  it('Rückgängig hebt die Auswahl eines verschwundenen Kommentars auf', () => {
    const store = useAnnotations.getState();
    const square = createShape(base(), 'square', [0, 0, 10, 10], red, 1);
    store.apply(tab, { type: 'add', annotation: square });
    store.select(tab, square.id);
    store.undo(tab);
    expect(state()?.selectedId).toBeNull();
  });
});

describe('Einlesen aus pdf.js', () => {
  const utf16 = (text: string) =>
    'þÿ' + Array.from(text, (c) => String.fromCharCode(c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff)).join('');

  it('entschlüsselt rohe PDF-Zeichenketten', () => {
    expect(pdfText(utf16('Accepted'))).toBe('Accepted');
    expect(pdfText('Review')).toBe('Review');
    expect(pdfText(null)).toBe('');
  });

  it('hängt Antworten und Prüfstatus an ihren Kommentar', () => {
    const items: PdfjsAnnotationData[] = [
      { id: '10R', subtype: 'Text', rect: [0, 0, 20, 20], name: 'Comment', contentsObj: { str: 'Notiz' }, titleObj: { str: 'Erika' } },
      { id: '11R', subtype: 'Text', rect: [0, 0, 20, 20], inReplyTo: '10R', replyType: 'R', contentsObj: { str: 'Antwort' } },
      {
        id: '12R',
        subtype: 'Text',
        rect: [0, 0, 20, 20],
        inReplyTo: '10R',
        state: utf16('Completed'),
        stateModel: utf16('Review'),
        modificationDate: 'D:20260102',
      },
      { id: '13R', subtype: 'Text', rect: [0, 0, 20, 20], inReplyTo: '10R', state: 'Marked', stateModel: 'Marked' },
      { id: '14R', subtype: 'Link', rect: [0, 0, 20, 20] },
    ];
    const [note, ...rest] = convertPageAnnotations(items, 3);
    expect(rest).toEqual([]);
    expect(note?.kind).toBe('note');
    expect(note?.pageIndex).toBe(3);
    expect(note?.replies.map((r) => r.contents)).toEqual(['Antwort']);
    expect(note?.statuses.map((s) => s.status)).toEqual(['Completed']);
  });

  it('liest Textmarkierungen, Linien und Pfeile', () => {
    const quads = toQuads([0, 10, 10, 10, 0, 0, 10, 0]);
    expect(quads).toHaveLength(1);
    const [highlight, arrow] = convertPageAnnotations(
      [
        { id: '1R', subtype: 'Highlight', rect: [0, 0, 10, 10], quadPoints: [0, 10, 10, 10, 0, 0, 10, 0], color: [255, 0, 0] },
        { id: '2R', subtype: 'Line', rect: [0, 0, 10, 10], lineCoordinates: [0, 0, 10, 10], lineEndings: ['None', 'OpenArrow'] },
      ],
      0,
    );
    expect(highlight?.kind === 'highlight' && highlight.quads).toEqual(quads);
    expect(highlight?.color).toEqual({ r: 1, g: 0, b: 0 });
    expect(arrow?.kind).toBe('arrow');
  });
});

describe('PDF-Datum', () => {
  it('schreibt und liest dasselbe Datum', () => {
    const date = new Date(2026, 9, 12, 18, 5, 7);
    expect(parsePdfDate(toPdfDate(date))?.getTime()).toBe(date.getTime());
  });

  it('versteht Zeitzonen und unvollständige Angaben', () => {
    expect(parsePdfDate("D:20260115093000+01'00'")?.toISOString()).toBe('2026-01-15T08:30:00.000Z');
    expect(parsePdfDate('D:20260115093000Z')?.toISOString()).toBe('2026-01-15T09:30:00.000Z');
    expect(parsePdfDate('D:2026')?.getFullYear()).toBe(2026);
    expect(parsePdfDate('kein Datum')).toBeNull();
  });
});

describe('Zeichnen endet am Seitenrand', () => {
  const page: Rect = [0, 0, 100, 100];

  it('lässt Striche innerhalb der Seite unverändert', () => {
    const path = [{ x: 10, y: 10 }, { x: 50, y: 60 }, { x: 90, y: 20 }];
    expect(clipPath(path, page)).toEqual([path]);
  });

  it('schneidet am Rand ab und lässt nichts außerhalb stehen', () => {
    expect(clipPath([{ x: 50, y: 50 }, { x: 150, y: 50 }], page)).toEqual([[{ x: 50, y: 50 }, { x: 100, y: 50 }]]);
    expect(clipPath([{ x: 200, y: 50 }, { x: 300, y: 50 }], page)).toEqual([]);
  });

  it('hinaus und wieder hinein ergibt zwei Stücke', () => {
    const runs = clipPath([{ x: 50, y: 90 }, { x: 50, y: 120 }, { x: 80, y: 120 }, { x: 80, y: 90 }], page);
    expect(runs).toEqual([
      [{ x: 50, y: 90 }, { x: 50, y: 100 }],
      [{ x: 80, y: 100 }, { x: 80, y: 90 }],
    ]);
  });

  it('Seitenrechteck und Begrenzen eines Punkts', () => {
    expect(pageRect({ width: 100, height: 200, toPdf: (x, y) => ({ x, y: 200 - y }) })).toEqual([0, 0, 100, 200]);
    expect(clampToRect({ x: -5, y: 300 }, [0, 0, 100, 200])).toEqual({ x: 0, y: 200 });
  });
});
