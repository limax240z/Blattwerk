# 0033: Löschen im Modus „Inhalt bearbeiten“, Linien und Flächen, Nachrücken

- Status: angenommen (2026-11-11)

## Anforderung

Auftraggeber: Wer viel Text auswählt und löscht, behält kleine grüne Rahmen auf der Seite, manchmal bleiben Kommas
stehen, Tabellen gehen gar nicht weg. Steht unter gelöschtem Text weiterer, soll er automatisch nachrücken; das soll
sich in den Einstellungen ein- und ausschalten lassen.

## Ursachen

Untersucht an einem aus dem Browser gedruckten PDF (2357 Textobjekte auf einer Seite): Browser setzen jedes Zeichen als
eigenes Textobjekt, Leerzeichen eingeschlossen.

- **Grüne Rahmen:** Ein Objekt nur aus einem Leerzeichen liest PDFium als leeren Text ohne Fläche. Es gehörte zu keiner
  Zeile, das Auswahlrechteck übersprang leere Stücke, die Oberfläche zeichnete sie trotzdem (mindestens 2 × 2 Punkt).
- **Kommas:** Zeilen wurden über die Überlappung der Höhen gebildet. Ein Komma liegt auf der Grundlinie und überlappt
  mit Buchstaben weniger als zur Hälfte, es blieb ein eigenes Objekt.
- **Tabellen:** Linien und Flächen (Pfade) standen nicht in der Objektliste und ließen sich weder auswählen noch löschen.

## Entscheidung

- **Zeilen:** Aufrechte Stücke mit derselben Grundlinie gehören zur selben Zeile (`sameLine`). Leere Objekte ohne Fläche
  gelten als Leerzeichen (`listPageObjects`), schließen sich auch über einen Schriftwechsel hinweg einer Zeile an und
  werden zuletzt zugeordnet (sonst bildeten sie Zeilen aus fett und normal). Gibt es solche Leerzeichen in einer Zeile,
  entsteht ein Wortabstand erst ab 0,35 statt 0,12 Schriftgrößen Lücke; vorher wurde „Kurzfassung“ zu „Ku rzfassu ng“.
- **Leere Reste** zeichnet die Oberfläche nicht mehr. Das Auswahlrechteck nimmt sie mit, wenn es sie ganz umschließt.
- **Linien und Flächen** sind Objekte der Art `path` („Linie oder Fläche“): auswählbar, verschiebbar, skalierbar,
  löschbar. Nur sichtbare Pfade (Füllung oder Kontur), höchstens 600 je Seite (Text bleibt auf Seiten mit vielen
  Vektorgrafiken auswählbar), keine, die mehr als 60 % der Seite bedecken (ein Seitenhintergrund würde sonst jeden Klick
  neben dem Text fangen). Das Auswahlrechteck erfasst Pfade nur, wenn es sie ganz umschließt; sonst nähme jedes Rechteck
  über einer Tabelle ihren Rahmen mit.
- **Nachrücken** (`src/shared/close-gaps.ts`, Einstellung „Nach dem Löschen nachrücken“, Vorgabe an, `closeGaps`):
  Beim Löschen der Auswahl wandert, was darunter steht, nach oben, in derselben Operation wie das Löschen (ein Schritt
  zum Rückgängigmachen). Regeln:
  - betroffen ist nur, was waagerecht in den Bereich des Gelöschten ragt (eine Spalte bleibt für sich);
  - frei wird nur Höhe, neben der nichts stehen bleibt: Bleibt in derselben Zeile etwas dicht daneben (unter 12 pt) oder
    ein Tabellenrahmen um gelöschten Zelltext, rückt nichts nach;
  - der erste Block unter einer Lücke landet dort, wo das Gelöschte begann; der Abstand zum Inhalt darüber bleibt der,
    der vor dem Gelöschten stand;
  - Abstand über 48 pt zum Inhalt darüber beendet das Nachrücken (Fußzeile, Seitenzahl);
  - nur innerhalb der Seite; „oben“ folgt der Seitendrehung.
  Beim Leeren eines Textes über die Eingabe rückt nichts nach, nur beim Löschen der Auswahl.

## Grenzen

- Was die App nicht als Objekt anbietet (Schattierungen, seitenfüllende Flächen, Pfade über der Höchstzahl), rückt nicht
  mit.
- Nachrücken über Seitengrenzen hinweg (Text der nächsten Seite heraufholen) gibt es nicht: Die Seiten eines PDFs sind
  unabhängig gesetzt.
