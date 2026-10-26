# Nächste Arbeiten

Stand: 2026-10-24. Reihenfolge = Vorrang. Erledigte Punkte hier streichen und im Commit nennen.

## Erledigt in 0.15.0 (Pull Request #4)

- **Tab schließen mit offener Texteingabe:** Der Punkt „ungespeichert“ erschien mitten im Klick und schob ✕ weg; zudem
  schloss der Tab ohne Rückfrage, weil das Übernehmen des Textes noch lief (`trackPending`).
- **Windows-Update:** Das Hilfsskript startet die App nach der Installation selbst neu, wartet auf alle Prozesse und
  schreibt `update.log`. CI spielt das fertige Installationsprogramm als Update ein (`smoke-update-win.mjs`).
- **Ziehen:** Anfassen ohne Aussetzer (ein Zurücklesen statt fünf), Lichtschein ruht beim Ziehen. `drag.spec.ts` prüft
  Text, Kommentare und Formularfelder. Auf dem echten Bildschirm vom Auftraggeber zu bestätigen.
- **Letzter Tab:** Startseite; ⌘W im letzten Fenster beendet die App nicht mehr.
- **Updates bei jedem Start**, **„Hilfe → Über Blattwerk“** unter Windows.
- **Auswahlrahmen neben der Seite** (Inhalt bearbeiten; Kommentare, Formulare und Seitenraster haben keinen Rahmen).
- **Text auf Objekten:** kleine Objekte liegen beim Klicken oben. Im Beispiel des Auftraggebers
  (`.tools/beispiele/text-auf-objekt.pdf`, nie einchecken) ist der Fließtext auf Seite 1 ein Bild (Scan); ein
  Doppelklick auf ein Bild sagt das jetzt. Echtes Bearbeiten siehe unten.

## Erledigt in 0.16.0 (Zweig `erweiterungen`)

- **Text in Bildern bearbeitbar machen** (Inhalt bearbeiten → Bild wählen → „Text im Bild bearbeitbar machen“).
- **Barrierefreiheit:** Alternativtexte von Abbildungen in der Seitenleiste „Tags“ (automatisches Taggen bewusst
  nicht, ADR 0018).
- **PDF/A:** nicht eingebettete Schriften mit der Schrift des Rechners einbetten.
- **Kommentare:** eigene Stempel (Text, Datum, Name, Bild), Deckkraft und Füllfarbe, Liste filtern, sortieren, als
  Zusammenfassung sichern.
- **Seiten:** ersetzen, zuschneiden, zwischen Dokumenten und Fenstern ziehen.
- **Anzeige:** Zoom-Prozentwert eintippen.
- **Wasserzeichen, Kopf-/Fußzeilen:** Schriften des Rechners für alle Schriftsysteme.
- **Werkzeuge:** „Dokument bereinigen“ (Metadaten, Anhänge, Skripte, Lesezeichen).

## Nächster Punkt (erst umsetzen, wenn der Auftraggeber sagt, dass GitHub wieder geht)

**Fehler: Home-Knopf überlagert das Dokument** (gemeldet 2026-10-26). Der Home-Knopf am Anfang der Tableiste zeigt die
Startseite, aber das bisher Angezeigte verschwindet nicht: Startseite und Dokument liegen sichtbar übereinander.

- **Wo:** `app/StartScreen.tsx` als Überlagerung (`ui.homeOpen`, Befehl `app.home`), Home-Knopf in `TabBar.tsx`,
  Gestaltung ADR 0028. Vermutung (noch nicht geprüft): Die Überlagerung ist durchsichtig (Glas, unter macOS 26 echtes
  `NSGlassEffectView` mit durchsichtigem Fenster, ADR 0023) und deckt das Dokument dahinter nicht ab, oder die
  Glasflächen des Dokuments bleiben stehen.
- **Bildschirmfoto des Auftraggebers (2026-10-26):** nur unter macOS, unter Windows nicht. Durch die Startseite scheinen
  das Dokument **und sogar andere Programme hinter dem Fenster** (Word, Schreibtisch). Damit ist die Ursache fast sicher
  das native Glas (ADR 0023): Für die Startseite wird das Fenster durchsichtig gemacht (`windowOpaque: false`, ein
  Glas über das ganze Fenster); mit offenem Dokument darunter darf das nicht passieren. Prüfen in
  `src/renderer/app/native-glass.ts` (Glasflächen je Zustand, `ui.homeOpen`) und `src/main/native-glass.ts`; die
  Überlagerung braucht einen deckenden Hintergrund oder das Fenster bleibt undurchsichtig.
- **Ziel:** Mit offenem Home-Knopf ist nur die Startseite zu sehen (Dokument ganz verdeckt oder ausgeblendet); Esc und
  „Zurück“ zeigen das Dokument wieder wie vorher. Unter macOS mit und ohne Liquid Glass und unter Windows prüfen.
- **Test:** Oberflächentest in `start.spec.ts` (Home-Knopf mit offenem Dokument: Dokument nicht sichtbar bzw. verdeckt;
  Bildschirmfoto ansehen), dazu Rückweg.
- **Ablauf:** Pull Request, CI abwarten, Handy-Nachricht, Version erhöhen.

## Offen

- **Windows:** von Hand ausprobieren (Auftraggeber), gefundene Fehler hier eintragen.
- **Text im Bild:** Erkennungsqualität hängt an der Texterkennung (Umlaute in unscharfen Scans); Schriftarten außer
  Helvetica werden nicht nachgebildet.

Für jede Auslieferung die Version erhöhen.
