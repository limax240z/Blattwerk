import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/shared/annotations';
import { closeGaps } from '../../src/shared/close-gaps';

// Zeile auf einer A4-Seite: Unterkante bottom, 12 pt hoch, von x 50 bis right
const line = (bottom: number, right = 500, left = 50): Rect => [left, bottom, right, bottom + 12];
const unit = (id: number, bounds: Rect) => ({ members: [id], bounds });

describe('Nachrücken nach dem Löschen', () => {
  it('rückt Zeilen unter einem gelöschten Absatz an seine Stelle', () => {
    // Zeile 1 bei 700, gelöschter Absatz 650 bis 690, Zeilen darunter bei 620 und 600
    const shifts = closeGaps([line(678), line(664), line(650)], [unit(1, line(700)), unit(2, line(620)), unit(3, line(600))]);
    // Oberkante des Gelöschten 690, Oberkante der ersten Zeile darunter 632: 58 pt nach oben
    expect(shifts).toEqual([
      { members: [2], delta: { x: 0, y: 58 } },
      { members: [3], delta: { x: 0, y: 58 } },
    ]);
  });

  it('lässt alles stehen, wenn neben dem Gelöschten etwas bleibt', () => {
    // ein Wort aus einer Zeile gelöscht
    expect(closeGaps([[50, 650, 90, 662]], [unit(1, [95, 650, 500, 662]), unit(2, line(630))])).toEqual([]);
    // Text in einer Tabellenzelle: der Rahmen der Tabelle bleibt
    expect(closeGaps([[60, 650, 150, 662]], [unit(1, [50, 500, 500, 700]), unit(2, line(450))])).toEqual([]);
  });

  it('bewegt nur, was in den Bereich des Gelöschten ragt, und keine Fußzeile', () => {
    const shifts = closeGaps([line(650, 250)], [unit(1, line(630, 250)), unit(2, line(630, 500, 300)), unit(3, line(30, 250))]);
    expect(shifts).toEqual([{ members: [1], delta: { x: 0, y: 20 } }]);
  });

  it('summiert mehrere Lücken und beachtet die Seitendrehung', () => {
    const shifts = closeGaps([line(680), line(640)], [unit(1, line(700)), unit(2, line(660)), unit(3, line(620))]);
    expect(shifts).toEqual([
      { members: [2], delta: { x: 0, y: 20 } },
      { members: [3], delta: { x: 0, y: 40 } },
    ]);
    // Seite um 90° gedreht: oben in der Anzeige ist links im PDF
    const turned = closeGaps([[100, 50, 112, 500]], [unit(1, [80, 50, 92, 500]), unit(2, [120, 50, 132, 500])], 90);
    expect(turned).toEqual([{ members: [2], delta: { x: -20, y: 0 } }]);
  });
});
