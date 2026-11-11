# 0032: Aufzählungen und Nummerierungen, alles bleibt auf der Seite

- Status: angenommen (2026-11-11)

## Anforderung

Auftraggeber: Lange Texte in Textfeldern ragten über den Rand der Seite hinaus und mussten von Hand angepasst werden;
gezeichnet werden konnte auch neben der Seite. Alle derartigen Funktionen prüfen. Dazu Stichpunkte für alle Arten von
Textfeldern und für vorhandenen Text: verschiedene Aufzählungszeichen und Nummerierungen, mit Einrücken.

## Entscheidung: Seitenrand

- Gemeinsame Rechnungen in `features/annotations/geometry.ts`: `clampMove` (Verschieben endet am Rand; was schon
  hinausragt, darf bleiben, aber nicht weiter hinaus), `fitOnPage`/`keepOnPage` (Neues am Rand ganz auf die Seite
  schieben), `resizeFrom` mit Seite (Ecke endet an der Kante, Unterschriften behalten ihr Seitenverhältnis), `maxScale`
  (größter Faktor beim Skalieren), `fitFreeText` (Textfeld wächst mit).
- **Kommentare:** Verschieben (auch mit Pfeiltasten), Größe ändern, Linienenden ziehen, Notiz, Stempel, Unterschrift und
  Textfeld/Form/Linie in Standardgröße. Die Vorschau beim Verschieben folgt dem begrenzten Versatz, nicht dem Zeiger.
  Ein Textfeld wächst beim Tippen nach unten mit (am unteren Rand nach oben) und übernimmt die Höhe beim Beenden.
- **Text bearbeiten:** Erreicht neuer oder geänderter Text den rechten Rand (18 pt Abstand), bekommt die Eingabe
  automatisch eine feste Breite und bricht dort um, wie beim Ziehen der Breite. Neuer Text am unteren Rand rückt nach
  oben. Vorhandener Text, der schon breiter ist, bleibt unverändert. Verschieben, Skalieren und Breite ziehen enden am
  Rand.
- **Formular bearbeiten:** Felder anlegen, verschieben und in der Größe ändern nur innerhalb der Seite.

## Entscheidung: Listen

- **Listen sind gewöhnliche Zeichen im Text** (`src/shared/lists.ts`): Einzug aus vier Leerzeichen je Stufe, Zeichen
  bzw. Nummer, ein Leerzeichen, Inhalt. So bleiben sie in jedem Programm sichtbar, das das PDF öffnet, und brauchen kein
  eigenes Datenmodell. Alle Zeichen gehören zum westeuropäischen Zeichensatz der Standardschriften (•, –, o, Ziffern,
  Buchstaben); Zeichen wie ◦ oder ▪ würden in den Standardschriften fehlen.
- Arten: Punkt, Strich, Kreis; 1. / 1) / a) / A. / i. Nummern zählen je Stufe; eine Zeile ohne Liste beendet sie.
- Bedienung wie in Word: Knöpfe „Aufzählung“ und „Nummerierung“ (Pfeil daneben: Art wählen), „Einzug verkleinern/
  vergrößern“; Tab und Umschalt+Tab; Eingabetaste setzt die Liste fort, in einem leeren Eintrag geht sie eine Stufe
  zurück bzw. endet. Die Knöpfe erscheinen nur, solange eine Eingabe offen ist (`ListControls`, verbunden über
  `list-bridge.ts`: Textfeld eines Kommentars, Text aus anderen Programmen über `textarea-lists.ts`, Eingabe mit
  gemischter Gestaltung im `RichTextEditor`).
- **Hängender Einzug beim Setzen:** Folgezeilen eines umbrochenen Eintrags beginnen hinter dem Zeichen
  (`hangingPrefix`, `wrapText` und `addRichText` in `workers/pdfium/content.ts`). Leerzeichen am Zeilenanfang bleiben
  erhalten; ihre Anzahl steht zusätzlich in der Kennzeichnung (`/L`), weil PDFium mehrere davon nicht zuverlässig
  ausliest.

## Grenzen

- Textfelder der Kommentare: PDFium erzeugt das Aussehen selbst; umbrochene Listenzeilen beginnen dort am Rand, nicht
  hinter dem Zeichen.
- In der Eingabe auf der Seite stehen umbrochene Folgezeilen noch am linken Rand; erst der gesetzte Text hat den
  hängenden Einzug.
