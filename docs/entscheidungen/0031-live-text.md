# 0031: Live-Text (Text in Bildern auswählen und markieren)

- Status: angenommen (2026-11-03)

## Anforderung

Auftraggeber: Hervorheben und Text auswählen müssen zuverlässig auf jedem Text gehen, auch wenn die Seite nur ein Foto
oder ein Scan ist. Bisher ging das erst nach „Text erkennen“ (ADR 0015) von Hand, und das ändert die Datei.

## Entscheidung

- **Automatisch und ohne die Datei zu ändern** (wie „Live Text“ unter macOS): Sichtbare Seiten werden im Hintergrund
  geprüft (`features/live-text/live-text.ts`). Erkannt wird, wenn die Seite weniger als 20 Zeichen echten Text hat oder
  Bilder mindestens 10 % der Fläche bedecken (`imageCoverage` aus der Befehlsliste von pdf.js, mit Transformationsmatrix).
  So zählen auch Mischseiten (Text mit eingeklebtem Foto) und Text als Kurven. Die Erkennung beginnt erst, wenn die Seite
  1,5 s ruhig im Fenster steht: Beim Öffnen und Blättern bleibt die Rechenzeit bei der Bedienung.
- Gezeichnet mit pdf.js (300 dpi, höchstens 3000 Bildpunkte Kantenlänge, ohne Anmerkungen), erkannt mit der vorhandenen
  Engine (tesseract.js, Deutsch und Englisch). Ein Auftrag nach dem anderen; Seiten, die bis zum Start nicht mehr zu sehen
  sind, werden übersprungen. Braucht eine Seite länger als 20 s (Rauschen, Muster), wird die Engine beendet und die Seite bleibt ohne Live-Text. Die Engine endet 30 s nach dem letzten Auftrag. Ergebnis je Dokumentstand und Seite im
  Speicher (`WeakMap` am `PDFDocumentProxy`); nach Änderungen am Inhalt wird neu erkannt.
- Wörter, die zum großen Teil über echtem Text liegen (`mostlyInside`), entfallen: Dort gibt es schon etwas zum Auswählen.
- **Ebene wie die von pdf.js** (`layer.ts`): `div.textLayer[data-live-text]` direkt hinter der Textebene von pdf.js,
  Wörter als durchsichtige Spans (Lage in Prozent, Schriftgröße in `cqh`, Breite per `scaleX`), Leerzeichen-Spans in den
  Lücken, `<br>` je Zeile. Dadurch laufen Auswählen, Kopieren, Markieren und das Ziehen an Markierungsenden über den
  vorhandenen Weg (`text-selection.ts`, `text-caret.ts` mit mehreren Ebenen). Alle Wörter einer Zeile sind gleich hoch
  (`selectableLines`), damit Hervorhebungen gleichmäßig werden. Die Ebene nimmt die Maus nur auf Wörtern an.
- **Freihand-Textmarker:** Findet ein Zug mit dem Hervorheben-Werkzeug keinen Text (Handschrift, Bild, Seite noch nicht
  erkannt), wird die Zugbahn ein Freihandstrich in der Farbe der Hervorhebung (12 pt, Deckkraft 0,4; `AnnotationLayer`).
  Mit Vorschau beim Ziehen, solange dabei kein Text ausgewählt wird.

## Nachtrag 2026-11-04: Auswählen über mehrere Zeilen

Fehlerbericht: Beim Ziehen über mehrere Zeilen sprang die Auswahl nach oben. Gemessen: Im Scan fiel sie in jeder
Zeilenlücke von 450 Zeichen auf 0, weil Live-Text keine Abdeckung wie `.endOfContent` von pdf.js hatte; auf normalen
Seiten klappte sie um, sobald der Zeiger eine Fußzeile erreichte, die im PDF vorn steht. Behoben mit
`annotations/selection-drag.ts` und `annotations/text-order.ts`.

## Grenzen

- Quer oder kopfüber fotografierter Text wird nicht erkannt (keine Lageerkennung); schräge Fotos nur ungefähr.
- Die Suche findet Live-Text nicht. Dafür bleibt „Text erkennen“, das die Textebene in die Datei schreibt.
- Rechenzeit: etwa 1 bis 3 s je Seite, im Hintergrund.

## Prüfung

- `test/unit/live-text.test.ts`: Bildanteil, Zeilen, Abgleich mit echtem Text.
- `test/e2e/comments.spec.ts`: Scan öffnen, Wort auswählen und kopieren, markieren (Lage auf dem Wort), Datei unverändert;
  Hervorheben ohne Text malt einen Textmarker-Strich.
