// Modus „Inhalt bearbeiten“ (Phase 5): ein- und ausschalten, Text und Bilder einfügen, Objekte ändern.
// Jede Änderung ist eine Inhaltsoperation und damit ein neuer Dokumentstand (Rückgängig wie bei Seiten).
import type { Point, Rect } from '../../../shared/annotations';
import { closeGaps, type GapShift } from '../../../shared/close-gaps';
import { editUnits, LINE_HEIGHT, translation, type ContentOperation, type EditUnit, type Matrix, type ParagraphStyle } from '../../../shared/content';
import { isMixed, normalizeRuns, restyleRange, runsText, type StylePatch, type TextRun } from '../../../shared/rich-text';
import { focusViewer, getRuntime } from '../../engine/runtime';
import { applyContentOperations, commitPendingEdits } from '../../engine/session';
import { t } from '../../i18n';
import { useAnnotations } from '../../state/annotations-store';
import { useContentEdit } from '../../state/content-edit-store';
import { useDocuments, type TabState } from '../../state/documents-store';
import { useUi } from '../../state/ui-store';
import { toggleFormEditing } from '../form-edit/actions';
import { pageObjects } from './page-objects';
import { withFontData } from './system-fonts';
import { imageSource, pickSources } from '../pages/actions';

export function toggleContentEditing(tab: TabState): void {
  if (tab.status !== 'ready' || tab.mode !== 'view') return;
  const store = useContentEdit.getState();
  if (tab.contentEditing) {
    useDocuments.getState().updateTab(tab.id, { contentEditing: false });
    store.select(tab.id, null);
    store.setEditing(null);
    store.setTool('select');
    requestAnimationFrame(() => focusViewer(getRuntime(tab.id)));
    return;
  }
  if (!tab.canModify) {
    useUi.getState().notify(t('contentEdit.notAllowed'));
    return;
  }
  commitPendingEdits();
  if (tab.formEditing) toggleFormEditing(tab);
  const ui = useUi.getState();
  if (ui.commentToolsVisible) ui.setCommentToolsVisible(false);
  if (ui.redactToolsVisible) ui.setRedactToolsVisible(false);
  if (ui.markToolsVisible) ui.setMarkToolsVisible(false);
  useAnnotations.getState().setTool('select');
  useAnnotations.getState().select(tab.id, null);
  store.setTool('select');
  useDocuments.getState().updateTab(tab.id, { contentEditing: true });
}

async function run(tabId: string, operation: ContentOperation | ContentOperation[]): Promise<boolean> {
  // Schriften des Rechners: Daten mitgeben, der Worker bettet sie ein
  const operations = await Promise.all((Array.isArray(operation) ? operation : [operation]).map(withFontData));
  return applyContentOperations(tabId, operations, { keepScroll: true });
}

// Text mit gemischter Gestaltung: origin = Anfang und Oberkante der ersten Zeile (PDF-Punkte), replace = Objekte, an
// deren Stelle er tritt. Danach wird der Text an seiner linken oberen Ecke wieder ausgewählt (nur beim Ersetzen).
export async function addRichText(
  tabId: string,
  pageIndex: number,
  origin: Point,
  value: TextRun[],
  options: { width?: number; flow?: { top: number; bottom: number }; replace?: number[] } = {},
): Promise<boolean> {
  // Leerraum am Ende entfällt
  const runs = normalizeRuns(value.map((run) => ({ ...run })));
  for (let i = runs.length - 1; i >= 0; i--) {
    const piece = runs[i] as TextRun;
    piece.text = piece.text.replace(/\s+$/, '');
    if (piece.text !== '') break;
  }
  const cleaned = normalizeRuns(runs);
  const replace = options.replace ?? [];
  if (runsText(cleaned).trim() === '') return replace.length > 0 ? run(tabId, { type: 'delete', pageIndex, indices: replace }) : false;
  const store = useContentEdit.getState();
  if (replace.length > 0) store.select(tabId, null);
  const done = await run(tabId, {
    type: 'addRichText',
    pageIndex,
    origin,
    runs: cleaned,
    ...(options.width ? { width: options.width } : {}),
    ...(options.flow ? { flow: options.flow } : {}),
    ...(replace.length > 0 ? { replace } : {}),
  });
  if (done && replace.length > 0) store.setReselect({ tabId, pageIndex, at: { x: origin.x + 1, y: origin.y - 1 } });
  return done;
}

// merge: weitere Stücke derselben Zeile (siehe lineOf), die im ersten aufgehen
export async function editText(tabId: string, pageIndex: number, index: number, merge: number[], value: string, before: string): Promise<boolean> {
  const text = value.replace(/\n/g, ' ');
  if (text === before) return false;
  // Leere Zeile: wie Löschen
  if (text.trim() === '') return run(tabId, { type: 'delete', pageIndex, indices: [index, ...merge] });
  return run(tabId, { type: 'editText', pageIndex, index, text, ...(merge.length > 0 ? { merge } : {}) });
}

// members: alle Objekte der Einheit (index ist ihr Anker)
// Absatz: Text mit harten Umbrüchen, der Worker bricht in der Breite des Absatzes um
export async function editParagraph(tabId: string, pageIndex: number, lines: number[][], value: string, before: string): Promise<boolean> {
  const text = value.replace(/\r/g, '').replace(/[ \t]+$/gm, '');
  if (text === before) return false;
  if (text.trim() === '') return run(tabId, { type: 'delete', pageIndex, indices: lines.flat() });
  return run(tabId, { type: 'editParagraph', pageIndex, lines, text });
}

// Zeile oder Absatz neu setzen: andere Breite (box, Seitenkoordinaten der sichtbaren Ränder), Größe, Schrift oder
// Farbe. Der Text bricht dabei in der Breite neu um.
export async function reflowText(
  tabId: string,
  pageIndex: number,
  unit: Pick<EditUnit, 'index' | 'members' | 'lines' | 'bounds' | 'runs' | 'origin' | 'mark'>,
  text: string,
  change: { box?: { left: number; right: number }; style?: ParagraphStyle; bounds?: Rect },
): Promise<boolean> {
  // Gemischte Gestaltung (z. B. ein größeres Wort): neu setzen, jedes Stück behält, was sich nicht ändert
  if (unit.runs && unit.origin && isMixed(unit.runs) && text === runsText(unit.runs)) {
    const patch: StylePatch = {
      ...(change.style?.size !== undefined ? { size: change.style.size } : {}),
      ...(change.style?.color ? { color: change.style.color } : {}),
      ...(change.style?.font ? { font: change.style.font } : {}),
    };
    const runs = restyleRange(unit.runs, 0, text.length, patch);
    const shift = change.box ? change.box.left - unit.bounds[0] : 0;
    const width = change.box ? change.box.right - change.box.left : unit.mark?.w;
    return addRichText(tabId, pageIndex, { x: unit.origin.x + shift, y: unit.origin.y }, runs, { ...(width ? { width } : {}), replace: unit.members });
  }
  const value = text.replace(/\r/g, '').replace(/[ \t]+$/gm, '');
  if (value.trim() === '') return run(tabId, { type: 'delete', pageIndex, indices: unit.members });
  const store = useContentEdit.getState();
  if (change.bounds) store.setPending(tabId, { pageIndex, bounds: { [unit.index]: change.bounds } });
  // Die bisherige Auswahl gilt nicht mehr (Objekte und Text ändern sich). Nach dem Neuladen wird der Text an seiner
  // linken oberen Ecke wieder ausgewählt.
  store.select(tabId, null);
  const [left, , , top] = change.bounds ?? unit.bounds;
  try {
    const done = await run(tabId, {
      type: 'editParagraph',
      pageIndex,
      lines: unit.lines ?? [unit.members],
      text: value,
      ...(change.box ? { box: change.box } : {}),
      ...(change.style ? { style: change.style } : {}),
    });
    if (done) store.setReselect({ tabId, pageIndex, at: { x: left + 1, y: top - 1 } });
    return done;
  } finally {
    if (change.bounds) store.setPending(tabId, null);
  }
}

// Eine oder mehrere Einheiten verschieben oder skalieren (dieselbe Abbildung für alle). units: Anker, alle Objekte und
// neue Lage je Einheit (für die Anzeige bis zum Neuladen)
export async function transformObjects(tabId: string, pageIndex: number, units: Array<{ index: number; members: number[]; bounds: Rect }>, matrix: Matrix): Promise<void> {
  const store = useContentEdit.getState();
  store.setPending(tabId, { pageIndex, bounds: Object.fromEntries(units.map((unit) => [unit.index, unit.bounds])) });
  try {
    await run(tabId, units.flatMap((unit) => unit.members).map((member) => ({ type: 'transform' as const, pageIndex, index: member, matrix })));
  } finally {
    store.setPending(tabId, null);
  }
}

export function deleteSelectedObject(tab: TabState): boolean {
  const store = useContentEdit.getState();
  const selected = store.selected[tab.id];
  if (!tab.contentEditing || !selected) return false;
  store.select(tab.id, null);
  const indices = selected.group ? selected.group.flatMap((unit) => unit.members) : selected.members;
  void (async () => {
    const shifts = useUi.getState().closeGaps ? await gapShifts(tab.id, selected.pageIndex, indices) : [];
    // Erst verschieben, dann löschen: Löschen ändert die Positionen der Objekte in der Liste der Seite
    await run(tab.id, [
      ...shifts.flatMap((shift) => shift.members.map((index) => ({ type: 'transform' as const, pageIndex: selected.pageIndex, index, matrix: translation(shift.delta.x, shift.delta.y) }))),
      { type: 'delete', pageIndex: selected.pageIndex, indices },
    ]);
  })();
  return true;
}

// Nachrücken (Einstellung, ADR 0033): Einheiten unter dem Gelöschten und ihre Verschiebung
async function gapShifts(tabId: string, pageIndex: number, indices: number[]): Promise<GapShift[]> {
  const runtime = getRuntime(tabId);
  const pdf = runtime?.pdf;
  if (!pdf) return [];
  const [listing, page] = await Promise.all([pageObjects(pdf, runtime.password ?? null, pageIndex), pdf.getPage(pageIndex + 1)]);
  if (!listing) return [];
  const gone = new Set(indices);
  const units = editUnits(listing.objects, listing.fonts);
  const removed = units.filter((unit) => unit.members.some((member) => gone.has(member)));
  const remaining = units.filter((unit) => !unit.members.some((member) => gone.has(member)));
  return closeGaps(
    removed.map((unit) => unit.bounds),
    remaining.map((unit) => ({ members: unit.members, bounds: unit.bounds })),
    page.rotate,
  );
}

// Bild wählen und mittig auf die aktuelle Seite legen (höchstens halbe Seitenbreite, Seitenverhältnis bleibt)
export async function addImage(tab: TabState): Promise<void> {
  const runtime = getRuntime(tab.id);
  const pdf = runtime?.pdf;
  if (!pdf) return;
  const picked = await pickSources('images');
  const first = picked?.[0];
  if (!first?.image) return;
  const source = imageSource(first);
  const pageIndex = Math.max(0, tab.currentPage - 1);
  const page = await pdf.getPage(pageIndex + 1);
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
  // Auf gedrehten Seiten aufrecht zur Anzeige: Maße in der Ansicht berechnen, Bild gegenläufig drehen
  const turned = page.rotate % 180 !== 0;
  const viewWidth = turned ? y1 - y0 : x1 - x0;
  const viewHeight = turned ? x1 - x0 : y1 - y0;
  const swapped = source.rotation === 90 || source.rotation === 270;
  const aspect = swapped ? source.width / source.height : source.height / source.width;
  // 1 Pixel = 1 Punkt, aber höchstens halbe Seitenbreite bzw. -höhe
  let width = Math.min(swapped ? source.height : source.width, viewWidth / 2);
  let height = width * aspect;
  if (height > viewHeight / 2) {
    height = viewHeight / 2;
    width = height / aspect;
  }
  const [userWidth, userHeight] = turned ? [height, width] : [width, height];
  const left = (x0 + x1 - userWidth) / 2;
  const bottom = (y0 + y1 - userHeight) / 2;
  const rotation = (((source.rotation - page.rotate) % 360) + 360) % 360;
  await run(tab.id, {
    type: 'addImage',
    pageIndex,
    rect: [left, bottom, left + userWidth, bottom + userHeight],
    image: { ...source, rotation: rotation as typeof source.rotation },
  });
}

export const lineHeight = (size: number) => size * LINE_HEIGHT;

// Seitenränder für Fließtext (Punkt, Ansicht): 2,5 cm links, rechts und oben, 2 cm unten; auf kleinen Seiten weniger
export function flowMargins(width: number, height: number): { left: number; right: number; top: number; bottom: number } {
  const side = Math.min(70.87, width * 0.1);
  return { left: side, right: side, top: Math.min(70.87, height * 0.1), bottom: Math.min(56.69, height * 0.08) };
}
