# 0029: iPad-App

Stand: 2026-10-27 · Status: angenommen

## Ausgangslage

Der Auftraggeber möchte Blattwerk auch auf seinem iPad nutzen, mit möglichst vielen Funktionen der Mac-App. Veröffentlicht wird die App nicht. Ein bezahltes Apple-Entwicklerkonto gibt es nicht. Installiert wird mit der kostenlosen Apple-ID über einen Sideloading-Store (SideStore), der die 7 Tage gültige Signatur selbst erneuert.

Electron läuft nicht auf iPadOS. Die Oberfläche (React) und die PDF-Technik (pdf.js, PDFium-WASM, pdf-lib, tesseract.js) sind aber reine Web-Technik und laufen auch in WebKit.

## Entscheidung

Eine eigene, schlanke iPad-Hülle in Swift (`ios/`), ohne zusätzliche Bibliotheken:

- **`WKWebView`** zeigt dieselbe Oberfläche wie auf dem Mac. Die Dateien kommen wie bei Electron über ein eigenes Schema `app://bundle/` (`WKURLSchemeHandler`), mit derselben CSP in jeder Antwort. Netzwerk gibt es nicht.
- **`window.blattwerk`** stellt auf dem iPad `src/ios/` bereit (TypeScript, läuft in der WebView). Es setzt dieselbe Schnittstelle `BlattwerkApi` auf wenige native Bausteine (`src/ios/native.ts` ↔ `ios/Blattwerk/Bridge.swift`): Dateien wählen, lesen, schreiben, exportieren, Drucken, HTML → PDF, Ablage im App-Ordner, Schriften, Menü.
- **Dateien** werden in der Dateien-App gewählt und an Ort und Stelle bearbeitet (Lesezeichen mit Sicherheitsbereich, `NSFileCoordinator`). Speichern ersetzt die Datei atomar. „Zuletzt geöffnet“ merkt sich die Lesezeichen.
- **Große Datenmengen** (Lesen, Schreiben) laufen nicht über Nachrichten, sondern über `fetch` an `app://file/…` mit Bytes im Rumpf. Nachrichten tragen nur kleine Werte.
- **Menü:** iPadOS 26 hat eine Menüleiste. Ihr Inhalt kommt aus demselben Aufbau wie auf dem Mac (`buildMenuTemplate`), nur ohne Punkte, die es auf dem iPad nicht gibt.
- Was der Hauptprozess an reiner Logik hat (Vorlagen, Umwandeln von Textdokumenten, Zuletzt-Liste, Unterschriften, Prüfungen), wird weiterverwendet. Nur der Zugriff auf Dateien und Electron wird ersetzt.

## Verworfen

- **Capacitor:** bringt eine eigene Brücke mit Base64 für Binärdaten und zieht Swift-Pakete aus dem Netz. Für die wenigen Bausteine, die wir brauchen, ist eine eigene Hülle kleiner und passt zur bisherigen Linie (kein electron-vite).
- **Nativ mit PDFKit neu schreiben:** würde alle Bearbeitungsfunktionen (PDFium, pdf-lib) verlieren oder doppelt bauen.
- **Web-App über Safari:** dauerhaft ohne Signatur, aber App-Dateien öffentlich und Dateizugriff nur über Hoch- und Herunterladen. Der Auftraggeber hat sich für die echte App entschieden.

## Was es auf dem iPad nicht gibt

- Mehrere Fenster, Tabs zwischen Fenstern ziehen, Seiten zwischen Fenstern ziehen (eine Szene, Tabs innerhalb).
- Updates aus dem Update-Ordner und aus dem Netz (Updates kommen über SideStore).
- Standardprogramm festlegen (iPadOS bietet Blattwerk im Teilen-Menü und unter „Öffnen mit“ an).
- Natives Liquid Glass unter der WebView (die CSS-Variante bleibt).

## Folgen

- Neue Funktionen der Oberfläche kommen automatisch aufs iPad, solange sie nur `window.blattwerk` nutzen.
- Neue Methoden in `BlattwerkApi` brauchen eine Umsetzung in `src/ios/` (die Typprüfung erzwingt das).
- Gebaut wird mit `npm run build:ios` (Oberfläche) und `npm run dist:ios` (unsignierte `.ipa`, die SideStore mit der Apple-ID des Auftraggebers signiert).
