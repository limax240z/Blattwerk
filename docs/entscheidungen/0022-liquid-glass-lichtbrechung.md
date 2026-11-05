# 0022 Liquid Glass: Lichtbrechung, Glanzkanten, federnde Bewegung

Stand: 2026-10-15 · ergänzt ADR 0021 (Weg 1 von 2; Weg 2 = Apples eigener Glas-Baustein, noch offen)

## Entscheidung

- **Lichtbrechung** (`src/renderer/components/glass/liquid-glass.ts`): Für jede Glasfläche entsteht eine
  Verschiebungskarte in ihrer Form (abgerundetes Rechteck, Rundung aus dem CSS). Innen neutral, zur Kante hin wird der
  Hintergrund nach außen verschoben (quadratisch ansteigend über die Breite der „Wölbung“). Ein SVG-Filter
  (`feImage` + `feDisplacementMap`) wirkt über `backdrop-filter: url(#…) blur() saturate()`; Chromium unterstützt das.
  Karte in halber Auflösung, zwischengespeichert nach Größe; ein `ResizeObserver` hält sie aktuell. Der Hook
  `useLiquidGlass(GLASS.control | panel | sheet | small)` liefert eine Ref-Funktion. Ohne Unterstützung bleibt das
  einfache CSS-Glas.
- **Glanzkante** (`.liquid` in `global.css`): 1-px-Lichtsaum (Maske Fläche minus Innenfläche), oben heller; dazu
  ein Lichtfleck an Kante und Fläche, der dem Mauszeiger folgt (`trackPointerLight`, CSS-Variablen `--pointer-x/-y`,
  Hintergrund mit `fixed`, also Fensterkoordinaten, ohne Neuberechnung je Element).
- **Bewegung:** Knöpfe federn beim Drücken (Skalierung mit Überschwingen), Modusleisten und Dialoge tauchen federnd
  auf, die Auswahl im Umschalter der Seitenleiste gleitet als Kapsel. `prefers-reduced-motion` schaltet das ab.
- **Inhalt unter Glas:** Der Umschalter der Seitenleiste schwebt über dem Inhalt (Miniaturen, Lesezeichen, Kommentare
  und Tags laufen darunter durch, `--panel-top` bzw. `paddingStart` der virtuellen Liste). Dialoge liegen über dem
  Dokument; dort ist die Brechung am deutlichsten.

## Grenzen

- Die Dokumentansicht läuft nicht unter die Werkzeugleiste: pdf.js setzt die Bildlaufposition beim Springen zu einer
  Seite so, dass die Seite oben am Rand beginnt; sie läge dann unter der Leiste. Über der Leiste ist deshalb nur
  Fensterhintergrund, die Brechung dort kaum sichtbar (Glanzkanten und Unschärfe schon).
- Der Schreibtisch hinter dem Fenster scheint nicht durch (dafür Weg 2: Apples `NSGlassEffectView` über eine
  native Erweiterung; braucht die Xcode-Werkzeuge).

## Nachtrag 2026-11-05: Energie

Auftraggeber: hoher Energieverbrauch. Gemessen (Chromium-Leistungswerte, unsichtbarer Testlauf, Seite mit Text):
300 Mausbewegungen über der Seite kosteten 500 bis 650 ms Stilberechnung und rund 0,9 s Arbeit, weil der Lichtschein
`--pointer-x/-y` am Wurzelelement setzte und so bei jeder Bewegung das ganze Fenster neu berechnet wurde. Im Leerlauf und
beim Scrollen war die App unauffällig.

- Die Werte stehen jetzt nur an Glasflächen in Reichweite des Lichts (260 px), gelesen wird vor dem Schreiben:
  140 bis 200 ms Stilberechnung, Arbeit etwa halbiert.
- Stromsparen (`watchEnergy`): im Akkubetrieb (`navigator.getBattery`) oder bei „Transparenz reduzieren“ ruht der
  Lichtschein ganz, und die Glasflächen verzichten auf die Lichtbrechung (`url(#…)` im `backdrop-filter`); Unschärfe und
  Sättigung bleiben. Gemessen: keine Stilberechnung mehr beim Bewegen der Maus, Arbeit rund 190 ms (ein Fünftel).
- Die Kosten der Lichtbrechung auf der Grafikkarte lassen sich im unsichtbaren Test nicht messen; Seitenleisten und
  Werkzeugleiste nutzen unter macOS ohnehin das Glas des Systems.
