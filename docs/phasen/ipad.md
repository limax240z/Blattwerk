# Bericht: iPad- und iPhone-App

Stand: 2026-10-27 · Version 0.17.0 · Entscheidung: [ADR 0029](../entscheidungen/0029-ipad-app.md) · Installation: [ipad-installieren.md](../ipad-installieren.md)

## Was gebaut ist

Blattwerk läuft als eigene iPad-App mit derselben Oberfläche wie auf dem Mac. Eine schlanke Hülle in Swift übernimmt, was auf dem Mac Electron macht: Dateien öffnen und speichern, Sichern-Dialoge, Drucken, Menüleiste und HTML → PDF. Alle Bearbeitungsfunktionen (Kommentieren, Seiten, Formulare, Inhalt bearbeiten, Schwärzen, OCR, Komprimieren, Kennwortschutz, Vergleichen, Signaturen, PDF/A, Barrierefreiheit) sind dieselben wie auf dem Mac, weil sie in der Oberfläche laufen.

Fürs iPad neu:

- Dateien aus der Dateien-App werden an Ort und Stelle bearbeitet, auch in iCloud Drive. „Zuletzt geöffnet“ merkt sich den Zugriff dauerhaft.
- Blattwerk erscheint unter „Öffnen mit“ bzw. „Teilen“ für PDFs.
- Die Menüleiste von iPadOS bekommt dieselben Menüs wie auf dem Mac, mit Tastatur auch dieselben Kürzel.
- Zoomen mit zwei Fingern.
- Vorlagen und „PDF aus Textdokument“ setzt das iPad selbst, ohne Internet.
- Schriften für neuen Text: Arial, Times New Roman, Georgia, Verdana, Trebuchet MS und Courier New, soweit iPadOS sie als einzelne Dateien hat.

## Geprüft (iPad-Simulator, iPadOS 27)

- Start, Startseite mit allen Vorlagen-Vorschauen (HTML → PDF auf dem iPad).
- PDF öffnen, Anzeige, Miniaturen, vorhandene Kommentare.
- Notiz setzen und speichern: Die Datei wird angehängt (inkrementell) und lässt sich mit pdf-lib wieder öffnen.
- Große Datei (60 MB, 10 Seiten mit Bildern): öffnen, kommentieren, speichern.
- Texterkennung (OCR) über die Menüleiste auf einer gescannten Seite.
- Sicherer Kontext (WebCrypto für Signaturen), OffscreenCanvas, Worker von pdf.js, PDFium und Tesseract.
- Unit-Tests für Tastenkürzel, das iPad-Menü und das leere Dokument. Typprüfung, Lint, `npm test` und die ganze Oberflächen-Testreihe der Mac-App sind grün.

## Auf dem echten iPad geprüft (iPadOS 27.2, 2026-10-28)

- Installation mit iloader („Import IPA“). Die Anmeldung in SideStore scheitert zurzeit an Apples Fehler -80045.
- Start, Startseite, Menüleiste mit allen Blattwerk-Menüs, Bedienung mit dem Finger: laut Auftraggeber „geht alles“.
- Behoben: Die Menüleiste blieb zuerst leer, weil ⌘, schon „Einstellungen“ im App-Menü des Systems belegt. Bei doppelten Kürzeln lehnt iPadOS alle eingefügten Menüs ab.

## Noch nicht geprüft

- Apple Pencil im Einzelnen (Freihand, Unterschrift).
- Die Dialoge der Dateien-App (Öffnen, Sichern unter, Ordner wählen) und Drucken. Der Code nutzt die Standardwege von iPadOS, ausprobiert wurden sie noch nicht.
- Verlängern nach 7 Tagen über iloader.

## Bekannte Grenzen

- Ein Fenster, darin Tabs. Tabs lassen sich nicht in ein neues Fenster ziehen.
- Updates kommen über eine neue `.ipa` in SideStore, nicht aus Blattwerk heraus.
- Der Sichern-Dialog der Dateien-App lässt den Dateinamen nicht ändern. Neue Dokumente bekommen den vorgeschlagenen Namen.
- Liegt ein PDF bei einem Anbieter, der nur Zugriff auf die einzelne Datei gibt, schreibt Blattwerk direkt in die Datei, ohne atomares Ersetzen.
- Die App läuft mit kostenloser Apple-ID nur 7 Tage am Stück, danach muss SideStore sie verlängern.

## iPhone (2026-10-28, ADR 0030)

Dieselbe App läuft jetzt auch auf dem iPhone. Auf schmalen Bildschirmen (iPhone, iPad im geteilten Bildschirm) gilt eine Kompaktansicht:

- Knopf **„Alle Befehle“** (☰) oben rechts zeigt alle Menüs als Liste, denn das iPhone hat keine Menüleiste.
- Die Seitenleiste liegt über dem Dokument und schließt sich, sobald man eine Seite antippt.
- Dialoge nutzen fast die ganze Breite.

Geprüft im iPhone-Simulator (iPhone 18 Pro): Start, Startseite, Dokument öffnen, Befehlsliste, Seitenleiste, Werkzeuge unter „⋯“, Kommentarleiste, Zeichnen mit dem Finger, Dialog „Seitenzahlen“.

Dabei behoben, auch für das iPad: Zeichnen mit dem Finger scrollte die Seite, statt zu malen. Dialoge waren durchsichtig.

Noch nicht geprüft: auf einem echten iPhone, Querformat mit Notch, Bildschirmtastatur bei Textfeldern.

## Rückmeldungen vom echten iPhone (2026-10-28)

- Oben blieb hinter der Statusleiste ein schwarzer Streifen, unten wurden Inhalte an einem festen Rand abgeschnitten. Jetzt reicht die Oberfläche bis an alle Ränder.
- Vorlagen öffneten als leere Datei: Auf dem Gerät liefert WebKit größere Daten als Strom, der zu früh als leer galt. Das hätte auch beim Speichern eine Datei leeren können. Behoben, und die Hülle schreibt nur noch, wenn genau so viele Bytes ankommen, wie die Oberfläche geschickt hat.
- Beim Malen zeichnete jeder Finger: Jetzt malt ein Finger, zwei Finger schieben.
