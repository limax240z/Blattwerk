# CLAUDE.md

Desktop-PDF-Editor für macOS und Windows nach dem Bedienkonzept von Acrobat Pro. Die vollständige Vorgabe steht in [docs/spezifikation.md](docs/spezifikation.md). **Vor jeder Arbeit lesen.**

- App-Name: **Blattwerk**, App-ID `de.blattwerk.app`. Im Code steht der Name nur in `src/shared/product.ts`; Texte nutzen die Variable `{{appName}}`. `package.json` und `electron-builder.yml` tragen dieselben Werte (ein Test prüft das). Kein Adobe-Name, kein Adobe-Logo, keine kopierten Icons oder Grafiken.
- Sprache: Gespräch, Doku, Kommentare und UI auf Deutsch. Bezeichner im Code auf Englisch.
- **Auftraggeber programmiert nicht selbst** und hat alle technischen Entscheidungen an Claude delegiert (2026-10-12). Ziel: eine App auf dem MacBook (Apple Silicon), die möglichst viel von Acrobat Pro kann. Daher: Entscheidungen selbst treffen und in `docs/entscheidungen/` begründen, Berichte in einfacher Sprache ohne Fachjargon, nur bei echten Weichenstellungen nachfragen. macOS hat Vorrang, Windows bleibt Ziel der Spezifikation.

## Phasenstatus

| Phase | Inhalt | Status |
|---|---|---|
| 0 | Grundlagen: Spezifikation, Bibliotheksauswahl, CLAUDE.md | erledigt |
| 1 | Viewer | erledigt ([Bericht](docs/phasen/phase-1.md)) |
| 2 | Kommentieren | erledigt ([Bericht](docs/phasen/phase-2.md)) |
| 3 | Seiten organisieren | erledigt ([Bericht](docs/phasen/phase-3.md)) |
| 4 | Formulare und Unterschrift | erledigt ([Bericht](docs/phasen/phase-4.md)) |
| 5 | Bearbeiten (inkl. Schwärzen) | erledigt ([Bericht](docs/phasen/phase-5.md)) |
| 6 | Werkzeuge (OCR, Komprimieren, Passwort, Export, Vergleich) | erledigt ([Bericht](docs/phasen/phase-6.md)) |
| 7 | Profi (PAdES, PDF/A, Tags) | erledigt ([Bericht](docs/phasen/phase-7.md)) |
| – | iPad- und iPhone-App | erledigt ([Bericht](docs/phasen/ipad.md), [Anleitung](docs/ipad-installieren.md)) |

Entschieden am 2026-10-12: PDFium-WASM + pdf.js ([0001](docs/entscheidungen/0001-pdf-bibliotheken.md)), Name Blattwerk, ISC-Lizenz zulässig.

- **Ort:** `~/Projekte/Blattwerk` (nicht in iCloud; bis 2026-10-27 `~/Entwicklung/Blattwerk`). Bis Phase 1 lag das Projekt in `~/Documents`, das iCloud abgleicht; dort entstanden Konfliktkopien („Datei 2.js“) in `node_modules`, `out/` und `src/renderer/public/`. Projekt nie wieder in einen iCloud-Ordner legen.
- **Ablauf ab Phase 2 (Auftraggeber, 2026-10-12):** Phasen 2 bis 7 ohne Pause durcharbeiten. Nach jeder Phase trotzdem Bericht in `docs/phasen/`, Commit „Phase N abgeschlossen“ und neue `.dmg`, aber nicht auf OK warten. Nur bei echten Weichenstellungen nachfragen.

## Arbeitsweise (verbindlich)

- **Testumfang (Auftraggeber, 2026-10-15):** Kleine Änderungen nur gezielt testen (neue und betroffene Oberflächentests mit `-g`, dazu Typprüfung, Lint, `npm test`). Die komplette E2E-Suite vor jeder neuen `.dmg`/Version und nach größeren Umbauten.
- Strikt Phase für Phase. **Fertig** heißt: App startet, alle Features der Phase funktionieren, `npm test` und E2E-Tests sind grün, Git-Commit existiert.
- Nach jeder Phase: Bericht in `docs/phasen/phase-N.md` (was geht, was nicht, bekannte Bugs). Ab Phase 2 ohne Warten weiter (siehe oben).
- Ist ein Feature nicht sauber machbar: sagen und eine Alternative vorschlagen. Nichts halbgar bauen.
- **Keine Platzhalter.** Kein Button, Menüeintrag oder Kürzel ohne Funktion. Was noch nicht gebaut ist, taucht in der UI nicht auf.
- Diese Datei bei jeder Architekturänderung und an jedem Phasenende aktualisieren.
- Entscheidungen mit Begründung als `docs/entscheidungen/NNNN-titel.md` festhalten.

## Architektur

### Prozesse

```
Hauptprozess (Node)                 Preload                       Renderer (React, sandboxed)
- Fenster (eins je Dokument), Menü  contextBridge:                - Oberfläche, Tabs, Seitenleisten
- Dateien öffnen und lesen (IDs)    window.blattwerk (typisiert)  - pdf.js-Worker je Dokument (Parsen, Text)
- Zuletzt geöffnet, Einstellungen                                 - PDFium-Worker (Ändern, Speichern; bei Bedarf)
- app://-Protokoll, Sicherheit                                    - Zustand: zustand-Stores
- Dateizuordnung, Einzelinstanz
```

- **Renderer hat keinen Node-Zugriff.** Alles Dateisystem läuft über `window.blattwerk` (Typ in `src/preload/api-types.ts`) → IPC → Hauptprozess. Der Renderer kennt nur Datei-IDs.
- **Anzeigen mit den Viewer-Bausteinen von pdf.js** (`PDFViewer`, `PDFFindController`, `PDFLinkService`), siehe [ADR 0002](docs/entscheidungen/0002-anzeige-mit-pdfjs-viewer.md). Parsen, Schriften und Bilddekodierung laufen im Worker, gezeichnet wird zeitgeteilt im Hauptthread. Vollständiges Rendern im Worker wurde geprüft und ist nicht nötig (gemessen in den Oberflächentests).
- **Ändern und Speichern mit PDFium-WASM** (`@embedpdf/pdfium`), siehe [0001](docs/entscheidungen/0001-pdf-bibliotheken.md). Zugriff nur über die eigene Schicht `src/workers/pdfium/` (`engine.ts`, Speicherhilfen in `memory.ts`), nie direkt auf das Modul. Ein Worker für die ganze App (`src/renderer/engine/pdfium-client.ts`): startet beim ersten Auftrag, beendet sich 2 s nach dem letzten (WASM-Speicher schrumpft sonst nie).
- **Strukturänderungen mit @cantoo/pdf-lib** im selben Worker, nur wo PDFium es nicht kann: Formularfelder (`fields.ts`, [ADR 0007](docs/entscheidungen/0007-formulare.md)), Verweise nach dem Übernehmen von Seiten (`imported.ts`), Wasserzeichen und Kopf-/Fußzeilen als eigene Inhaltsströme (`stamping.ts`, [ADR 0009](docs/entscheidungen/0009-wasserzeichen.md)), Vor- und Nacharbeiten beim Schwärzen (`sanitize.ts`, [ADR 0008](docs/entscheidungen/0008-schwaerzen.md)). Inkrementell (`commit()`), außer beim Schwärzen (vollständig neu, ohne unerreichbare Objekte). Nie in verschlüsselten Dokumenten. Erst bei Bedarf geladen (eigener Bundle-Teil).
- **Große Dateien** (über 8 MB): eigener `PDFDataRangeTransport` (`src/renderer/engine/range-transport.ts`) liest 1-MB-Blöcke per IPC, höchstens 6 gleichzeitig. Kleinere Dateien werden in einem Stück gelesen.
- **Laden ist abbrechbar:** `LoadedDocumentHandle.promise` lehnt beim Schließen ab; der pdf.js-Worker wird erst nach `task.destroy()` beendet.

### Fenster

- **Jedes Dokument in einem eigenen Fenster** ([ADR 0026](docs/entscheidungen/0026-fenster-je-dokument.md)): Der Hauptprozess hält je Fenster einen `WindowContext` (`src/main/index.ts`: bereit, Menüzustand, Schließen erlaubt, wartende Dateien und Tabs). Menü und Befehle folgen dem vorderen Fenster. `openDocument` öffnet im anfragenden Fenster, wenn es leer ist, holt ein Fenster mit derselben Datei nach vorn oder legt ein neues an (versetzt, `window-layout.ts`); der Renderer bekommt dann `error: 'elsewhere'`.
- **Tabs zwischen Fenstern:** herausziehen (`TabBar.tsx`, Rechnungen in `tab-drag.ts`, Zeiger festhalten, Loslassen außerhalb der Leiste → `transferTab` mit Bildschirmpunkt), „Fenster → Tab in neues Fenster bewegen“, „Fenster → Alle Fenster zusammenführen“ (`mergeRequest`); innerhalb der Leiste umsortieren (andere Tabs weichen aus, `moveTab` erst beim Loslassen). Außerhalb der Leiste hängt der Tab mit Vorschau am Zeiger (`src/main/tab-ghost.ts`, Seite `src/renderer/ghost.html`, IPC `window:tab-drag`); über einem anderen Fenster zeigt dessen Leiste einen Platzhalter und macht Platz (`window:tab-drag-hover`, Antwort mit Einfügestelle). Die Datei wechselt nur den Eigentümer (`FileRegistry.transfer`); ungespeicherte Änderungen wandern als neuer Stand mit (`TabTransfer`, `receiveTab` in `session.ts`), der Rückgängig-Verlauf nicht. Ein Fenster ohne Tabs nach einer Übergabe schließt sich (`window:close`).
- **Seiten zwischen Dokumenten ziehen** (Seitenraster, `features/pages/page-drag.ts`): Beim Ziehen vergibt das Quellfenster eine Kennung (`PAGE_TRANSFER_TYPE`); das Ziel holt die Seiten als PDF ab, im selben Fenster direkt, sonst über den Hauptprozess (`pages:fetch` → `pages:provide-request` an alle Fenster → `pages:provided`). Eingefügt wird eine Kopie samt ungespeicherter Änderungen.
- **Fensterlage je Dokument** (`src/main/files/window-positions.ts`): Fenster mit genau einem Dokument merken sich ihre Lage für dessen Pfad; das Dokument öffnet später wieder dort.
- Schließen fragt je Fenster; Beenden fragt die Fenster nacheinander. Letztes Fenster zu → App beendet. Der letzte Tab zu → Startseite; ⌘W ohne Tabs schließt unter macOS nur ein weiteres Fenster, nie das letzte (sonst beendete Tabs-Schließen mit ⌘W die App).

### Dokumentmodell

- Pro Tab: `TabState` in `src/renderer/state/documents-store.ts` (alles, was die Oberfläche anzeigt) und `DocumentRuntime` in `src/renderer/engine/runtime.ts` (pdf.js-Objekte, Viewer, Miniaturen-Cache, Seitentexte). Ablauf und Befehle in `src/renderer/engine/session.ts`.
- Der Hauptprozess merkt sich je Datei Größe und Änderungszeit beim Öffnen und meldet `file-changed`, wenn die Datei danach von außen geändert wird.
- **Kommentare** ([ADR 0005](docs/entscheidungen/0005-kommentare.md)): Modell in `src/shared/annotations.ts`, Koordinaten im PDF-Benutzerraum (Punkte, Ursprung unten links, ungedrehte Seite), Umrechnung nur über `src/renderer/engine/coords.ts`. Zustand je Tab in `src/renderer/state/annotations-store.ts` (Liste, Stand beim Laden, Rückgängig-Stapel als Befehle, Auswahl, Werkzeug). Ablauf in `src/renderer/features/annotations/controller.ts`.
- **Anzeige der Kommentare:** pdf.js zeichnet vorhandene, unveränderte Kommentare. Neue und geänderte zeichnet je sichtbarer Seite eine SVG-Ebene (`AnnotationLayer` → `PageOverlay`), die in der Seite von pdf.js hängt. Geänderte und gelöschte vorhandene blendet pdf.js über seinen Anmerkungsspeicher aus (`syncHiddenAnnotations`).
- **Formerkennung beim Stift** (wie in GoodNotes): Wer am Strichende `SNAP_HOLD_MS` (550 ms) stillhält, bekommt statt des Freihandstrichs eine Gerade, ein Rechteck, Dreieck/Viereck oder eine Ellipse. Erkennung in `features/annotations/shape-snap.ts` (`recognizeShape`, rein rechnerisch, Test `test/unit/shape-snap.test.ts`), Zeitgeber `armHold` und Feld `snapped` der Geste `ink` in `PageOverlay.tsx`. Das Ergebnis bleibt eine normale Freihandzeichnung. Danach weiterziehen: Eine Gerade folgt mit ihrem Endpunkt dem Stift, andere Formen wachsen, schrumpfen und drehen sich um ihre Mitte (`transformShape`, Felder `shape` und `grab` der Geste; fast gerade Drehungen rasten auf 90°-Schritte ein).
- **Punkte und Linienart beim Stift:** Ein Klick ohne Ziehen setzt einen Punkt (`dotPath`: zwei fast gleiche Punkte, denn ein Pfad mit nur einem Punkt wird von PDFium nicht gezeichnet; die runden Enden `1 J` machen daraus den Punkt). `InkAnnotation.dash` (`solid`/`dotted`/`dashed`, fehlt = durchgehend) wird mit `dashPattern(style, width)` (`shared/annotations.ts`) zum Strichmuster, abhängig von der Linienstärke: im PDF `/BS /S /D` + `/D [..]` (`#setInkBorder` in `engine.ts`, PDFium schreibt das Muster in die Darstellung), in der Anzeige `stroke-dasharray`. Beim Einlesen ordnet `lineStyleOf` ein fremdes Muster der nächsten Art zu. Auswahl „Linienart“ in der Stift-Leiste (wirkt auch auf die ausgewählte Zeichnung); Stärken 1 bis 24 pt.
- **Radierer** (Werkzeug `eraser`, wie in GoodNotes): drei Arten (`pixel` kürzt Freihandstriche, `stroke` entfernt berührte Striche, `highlighter` nur durchscheinende Striche und Hervorhebungen) in drei Größen (Bildschirmpunkte, unabhängig vom Zoom). Rechnen in `src/shared/eraser.ts`, Geste `erase` in `PageOverlay.tsx`, ein Wisch ist ein Schritt (`Command` `batch`, `applyErase`).
- **Markieren** (eigener Modus, Ton `mark`, `ui.markToolsVisible`, Befehl `tools.highlight`): Leiste `features/annotations/MarkToolbar.tsx` (Hervorheben, Unterstreichen, Durchstreichen, Farbpalette mit Favoriten, Löschen). Nur in diesem Modus (und im Kommentieren mit Markierungswerkzeug) wird ausgewählter Text markiert; neue Markierungen bleiben unausgewählt. Ein Klick auf eine Markierung wählt sie aus (`markupAt` in `AnnotationLayer.tsx`); Anfasser an ihren Enden (`MarkupHandles` in `PageOverlay.tsx`) kürzen oder verlängern sie entlang des Textes (`text-caret.ts`, `rangeTextRects`); das Ziehen läuft über Fenster-Ereignisse, weil pdf.js Seitenteile umhängt und das Festhalten des Zeigers sonst verloren geht.
- **Speichern:** `computeChanges` (`features/annotations/changes.ts`) ermittelt neue, geänderte und gelöschte Kommentare; PDFium schreibt sie inkrementell; danach lädt der Tab die Datei neu. Drucken mit ungespeicherten Kommentaren nutzt denselben Weg im Speicher.
- **Seiten organisieren** ([ADR 0006](docs/entscheidungen/0006-seiten-organisieren.md)): Auch Ersetzen (Einfügen + Löschen) und Zuschneiden (`crop`, CropBox, Ränder wie angezeigt über `marginsToUser`). Jede Seitenoperation erzeugt PDFium sofort als neuen Stand im Arbeitsspeicher (`applyPageOperations` in `session.ts`), der Tab lädt ihn neu (`showState`); die Datei ändert sich erst beim Speichern. Ungespeicherte Kommentare werden dabei eingearbeitet.
- **Verlauf:** `src/renderer/state/history-store.ts` hält je Tab die Dokumentstände (Bytes oder `null` = Datei, Kommentarzustand, Seite, Auswahl), höchstens 768 MB. Rückgängig nimmt erst Kommentarbefehle zurück, dann Stände (`undoTab`/`redoTab`). Seitenoperationen, Rückgängig und Wiederholen laufen je Tab in einer Warteschlange (`enqueue`); solange sie läuft, ist `TabState.working` gesetzt. „Ungespeichert“ nur über `src/renderer/state/dirty.ts`.
- Vor Seitenoperationen, Speichern, Drucken und Schließen übernimmt `commitPendingEdits` offene Texteingaben.
- **Formulare ausfüllen** ([ADR 0007](docs/entscheidungen/0007-formulare.md)): pdf.js zeigt Felder als Eingabefelder (`AnnotationMode.ENABLE_FORMS`). `computeFormChanges` (`src/shared/forms.ts`) vergleicht seinen Anmerkungsspeicher mit der Datei (`forms-store`, `features/forms/form-sync.ts`). Beim Speichern übernimmt PDFium die Werte (`workers/pdfium/forms.ts`).
- **Formular bearbeiten:** `TabState.formEditing`, Ebene `features/form-edit/FormEditOverlay.tsx` über der Seite (pdf.js-Felder und Kommentare sind dann nicht bedienbar), Zustand in `form-edit-store`. Jede Änderung ist eine `FieldOperation` und damit ein neuer Dokumentstand (`applyFieldOperations` in `session.ts`, Scrollposition bleibt über `rememberScroll`).
- **Unterschrift:** Stempel mit PNG (`SignatureAnnotation`); gespeicherte Unterschriften im Profil (`src/main/files/signatures.ts`, IPC `signatures*`).
- **Schwärzen** ([ADR 0008](docs/entscheidungen/0008-schwaerzen.md)): Markierungen sind Kommentare der Art `redact` (Leiste `features/redaction/`, `ui.redactToolsVisible`). Anwenden (`applyRedactionMarks` in `session.ts`, `planRedaction`) ruft im Worker `redactDocument` auf: geteilte Bilder trennen (`sanitize.ts`), Inhalte entfernen (`redact.ts`, PDFium), Reste und ältere Stände verwerfen, vollständig neu schreiben. Suchen und schwärzen nutzt die PDFium-Textsuche (`text-search.ts`).
- **Dokument bereinigen** (Nachtrag ADR 0008): `workers/pdfium/clean.ts` (pdf-lib) entfernt wahlweise Metadaten, Anhänge, JavaScript/ausführende Aktionen (Sprünge und Weblinks bleiben) und Lesezeichen, verwirft Unerreichbares, schreibt vollständig neu; neuer Dokumentstand (`applyCleaning`), Dialog `features/clean/` bietet nur Vorhandenes an (`findCleanable`).
- **Wasserzeichen, Kopf-/Fußzeilen, Seitenzahlen** ([ADR 0009](docs/entscheidungen/0009-wasserzeichen.md)): `StampOperation` (`src/shared/stamping.ts`), Dialoge in `features/stamping/`, eigene Inhaltsströme mit Kennung `/BlattwerkArtifact`.
- **Inhalt bearbeiten** ([ADR 0010](docs/entscheidungen/0010-inhalt-bearbeiten.md)): `TabState.contentEditing`, Ebene `features/content-edit/ContentEditOverlay.tsx`, Zustand `content-edit-store`. Objekte listet PDFium je Seite (`listObjects`, Index gilt nur für einen Stand); Textstücke einer Zeile und Zeilen eines Absatzes fasst `editUnits` zu einer Einheit zusammen (Absätze setzt der Worker mit `editParagraph` neu um, auch mit neuer Breite `box` oder Gestaltung `style`; selbst gesetzte Texte tragen die Kennzeichnung `/BlattwerkText` mit Absatz, Breite und harten Umbrüchen); Änderungen sind `ContentOperation` (`content.ts`, PDFium schreibt den Seiteninhalt neu). Neue Texte auch in Schriften des Rechners ([ADR 0024](docs/entscheidungen/0024-schriften-des-rechners.md): `src/main/files/system-fonts.ts`, `src/shared/fonts.ts`, Kennung `sys:<familie>:<schnitt>`, eingebettet per `FPDFText_LoadFont`). Werkzeug „Fließtext“ (`tool: 'flow'`): Eingabe über die Breite zwischen den Seitenrändern (`flowMargins`), Zeilen unterhalb des unteren Rands kommen auf neue Seiten direkt dahinter (`FPDFPage_New`), nur auf ungedrehten Seiten. **Gemischte Gestaltung wie in Word:** Neuer und von Blattwerk gesetzter Text wird in `RichTextEditor.tsx` bearbeitet (Modell `src/shared/rich-text.ts`, Stücke `TextRun`; ohne Auswahl gilt eine neue Größe/Schrift/Farbe nur für das Folgende, Leiste über `applyToRichEditor`, Anzeige über `caret` im Store), gesetzt mit `addRichText` (je Stück ein Textobjekt, Zeilenhöhe nach der größten Schrift, `replace` zum Neusetzen an derselben Stelle, `source` behält die Schrift eines Objekts); `markedUnits` liefert dafür `runs` und `origin`. Fremder Text nutzt weiter das einfache Textfeld.
- **Kennwortschutz** ([ADR 0011](docs/entscheidungen/0011-kennwortschutz.md)): PDFium entfernt den Schutz (`FPDF_REMOVE_SECURITY`), pdf-lib verschlüsselt neu (AES-256, `protection.ts`). Neuer Dokumentstand; jeder Stand merkt sich sein Kennwort (`DocState.password`). `TabState.ownerAccess` (PDFium erkennt das Berechtigungskennwort) hebt Einschränkungen auf. Nur ASCII-Kennwörter (Apple Vorschau).
- **Export** ([ADR 0012](docs/entscheidungen/0012-export.md)): PDFium-Sitzungen im Worker (`render.ts`, `openSession`/`renderPage`/`pageText` im Client), Bilder Seite für Seite über `export:write-image` in einen gewählten Ordner, Text über `export:save-text`. Kein Word-Export (begründet im ADR).
- **Komprimieren** ([ADR 0013](docs/entscheidungen/0013-komprimieren.md)): PDFium schreibt vollständig, pdf-lib verkleinert Bilder (JPEG über `ImageCodec`, im Worker der Browser, in Tests `jpeg-js`), packt Ströme, verwirft Unerreichbares (`compress.ts`).
- **Vergleichen** ([ADR 0014](docs/entscheidungen/0014-vergleichen.md)): Wörter mit Lage aus PDFium-Sitzungen, Myers-Vergleich je Seite (`src/shared/compare.ts`), Bericht als neues PDF mit pdf-lib (`workers/pdfium/compare.ts`).
- **Texterkennung** ([ADR 0015](docs/entscheidungen/0015-texterkennung.md)): tesseract.js im Renderer (`engine/ocr-client.ts`), Worker, Kern und Sprachdaten aus `public/ocr` (beim Build kopiert, kein Netz). Seiten mit 300 dpi als PGM, Wörter als unsichtbare Textobjekte (`ocrText`, `FPDF_DeviceToPage`). Unsichtbarer Text erscheint nicht beim Bearbeiten des Inhalts. „Text im Bild bearbeitbar machen“ (`features/content-edit/scan-text.ts`): Zeilen eines Bildes erkennen, mit Flächen in Hintergrundfarbe abdecken und als echten Text setzen.
- **Live-Text** ([ADR 0031](docs/entscheidungen/0031-live-text.md)): Sichtbare Seiten ohne (genug) echten Text oder mit großen Bildern werden im Hintergrund erkannt, ohne die Datei zu ändern (`features/live-text/`, eingebunden über `useLiveText` in `AnnotationLayer`). Ergebnis als zweite `div.textLayer[data-live-text]` hinter der von pdf.js: Auswählen, Kopieren und Markieren laufen über den normalen Weg. `caretAt` nimmt mehrere Ebenen. Hervorheben ohne Text darunter malt einen Freihand-Textmarker (`MARKER_WIDTH`, `MARKER_OPACITY`).
- **Zeichnen am Seitenrand:** Stift und Freihand-Textmarker enden an der Kante (`clipPath`, `pageRect` in `geometry.ts`, in Vorschau und Ergebnis; hinaus und wieder hinein ergibt mehrere Striche derselben Zeichnung), Linien und Rechtecke bleiben auf der Seite (`clampToRect`).
- **Lesemodus** (`view.readMode`, Umschalt+Cmd+L, `features/read-mode/`): Leisten weg (`data-read-chrome`), Vollbild, ganze Seite; nur `READ_MODE_COMMANDS` wirken (`executeCommand`), Kommentare schreibgeschützt (`canAnnotate` in `AnnotationLayer`), Formularfelder gesperrt (`ReadModeBar`). Der Knopf sitzt in der bunten Werkzeuggruppe und wirkt aus jedem Arbeitsbereich (die Modi werden dabei beendet). Esc oder Knopf beenden, Zoom und Vollbildzustand kommen zurück; ein Tabwechsel beendet ihn.
- **Teile zusammenführen:** Jede PDF-Zeile im Dialog hat ein Feld „Seiten“ (`SourceFile.selection`, `pageSelection` in `shared/pages.ts`; leer = alle). Seiten kommen in aufsteigender Reihenfolge; dieselbe Datei lässt sich mehrmals mit anderen Bereichen hinzufügen.
- **Energie** ([ADR 0022](docs/entscheidungen/0022-liquid-glass-lichtbrechung.md), Nachtrag): Der Lichtschein der Glasflächen setzt `--pointer-x/-y` nur an Glasflächen in Reichweite (260 px), nie am Wurzelelement (sonst Neuberechnung des ganzen Fensters bei jeder Mausbewegung). Stromsparen (`watchEnergy`, Attribut `data-energy-saving`): im Akkubetrieb oder bei „Transparenz reduzieren“ ruht der Lichtschein, Glas ohne SVG-Lichtbrechung (nur Unschärfe).
- **Umbenennen** (`file.rename`, Menü „Umbenennen …“, Doppelklick auf den Tab, `features/rename/`): im selben Ordner, `.pdf` wird ergänzt (`renameTarget`). Geöffnete Dokumente erkennt das `FileRegistry` an Laufwerk und Dateinummer (`dev`/`ino`): Es beobachtet ihre Ordner (`fs.watch`) und sucht eine umbenannte Datei im selben Ordner, unter macOS auch anderswo über das offene Handle (`lsof`); in den Papierkorb folgt es nicht. `onRenamed` aktualisiert Tab, Fenstertitel, „Zuletzt geöffnet“ (`RecentFiles.rename`) und die gemerkte Fensterlage. Vor dem Speichern sucht es ebenfalls.
- **Lasche für die Seitenleiste:** `app/SidebarToggle.tsx` am linken Rand des Dokuments, Befehl `view.toggleSidebar` wie der Knopf in der Werkzeugleiste; in der Kompaktansicht ausgeblendet.
- **Textauswahl über mehrere Zeilen:** `features/annotations/selection-drag.ts`: Über Text wählt der Browser aus, in Lücken folgt die Auswahl der nächsten Textstelle (`selection.extend`, nur beim Ziehen mit Maus oder Stift). Live-Text bekommt beim Ziehen dieselbe Abdeckung wie die Ebene von pdf.js (`selecting`, `.endOfContent`); beginnt das Ziehen bis 24 px neben Live-Text, läuft die Auswahl ganz hier. `repairTextOrder` (Regel in `text-order.ts`) stellt nach `textlayerrendered` Fuß- und Kopfzeilen, die im PDF an falscher Stelle stehen, an ihren sichtbaren Platz (sonst klappt die Auswahl um); Zwei-Spalten-Text bleibt unberührt.
- **Digitale Signaturen** ([ADR 0016](docs/entscheidungen/0016-digitale-signaturen.md)): `signing.ts` (eigener Platzhalter, CMS mit pkijs, PAdES B-B), `signatures.ts` (prüfen), `identity.ts` (eigene ID); Oberfläche `features/certify/`. Nach dem Unterschreiben wird sofort gespeichert.
- **PDF/A** ([ADR 0017](docs/entscheidungen/0017-pdfa.md)): `pdfa.ts` (umwandeln, prüfen), `cff.ts` (Breiten aus CFF), `icc.ts` (sRGB-Profil), `font-tables.ts`; nicht eingebettete Schriften zuerst mit der passenden Schrift des Rechners (`systemFontFor`, TrueType mit Breiten über fontkit), sonst Standardschriften aus PDFium (`standardFontProgram`). Immer neue Datei. Oberfläche `features/pdfa/`.
- **Barrierefreiheit** ([ADR 0018](docs/entscheidungen/0018-barrierefreiheit.md)): `accessibility.ts` (Tags lesen, prüfen, Sprache/Titel/Tab-Reihenfolge setzen, Alternativ-/Ersatztext einzelner Elemente über `TagNode.id`); Seitenleiste „Tags“ (Stift an Abbildungen) und Prüfdialog in `features/accessibility/`, Ergebnis je Stand in `report.ts`. Automatisches Taggen bewusst nicht.
- **Textdokumente → PDF** ([ADR 0019](docs/entscheidungen/0019-textdokumente-umwandeln.md)): im Hauptprozess, `src/main/convert/` (eigene Leser für DOCX, ODT, RTF, Text, Markdown → `model.ts` → `html.ts`; `pdf.ts` setzt mit `printToPDF` in einem unsichtbaren Fenster mit eigener Sitzung ohne Netz und ohne JavaScript). IPC `convert:pick`, `convert:dropped`; abgelegte Textdokumente erkennt `isDocumentFileName` (`src/shared/convert.ts`).
- **Startseite und Vorlagen** ([ADR 0028](docs/entscheidungen/0028-startseite-und-vorlagen.md)): `app/StartScreen.tsx` (Vorlagen-Galerie mit Vorschaubildern, weitere Wege, Zuletzt geöffnet mit Anheften, Suche). Home-Knopf am Anfang der Tableiste (`TabBar.tsx`, `app.home`, ⇧⌘H; nicht in der Werkzeugleiste, sonst klappt sie unter macOS in der Standardgröße zusammen) zeigt sie mit offenen Dokumenten als Überlagerung (`ui.homeOpen`). Mitgelieferte Vorlagen als HTML (`src/main/templates/builtin.ts`, Texte unter `templates.content`) → `htmlToPdf`, geöffnet als unbenannte Kopie (`createUntitledDocument`); eigene Vorlagen („Als Vorlage sichern …“, `features/start/SaveTemplateDialog.tsx`) in `userData/Vorlagen` (`user-templates.ts`); Kennungen nur über `parseTemplateId` (`src/shared/templates.ts`). Vorschaubilder (`src/main/files/thumbnails.ts`, `userData/Vorschaubilder`) zeichnet der Renderer (`features/start/thumbnails.ts`). Anheften: `RecentFile.pinned`, `RecentFiles.setPinned`.
- **Leeres Dokument** („Unbenannt“, ⌘N, Startseite): `src/main/files/blank-document.ts` legt eine A4-Seite im temporären Ordner an (wird beim Beenden gelöscht, nicht in „Zuletzt geöffnet“). `TabState.untitled`: Sichern wird zu Sichern unter (Vorschlag im Ordner Dokumente); danach normales Dokument. Öffnet gleich im Modus „Text und Bilder bearbeiten“.
- **Updates** ([ADR 0025](docs/entscheidungen/0025-updates.md)): ohne Internet aus einem Update-Ordner (`userData/Updates`, optional eigener Ordner `updateFolder`). macOS: `Blattwerk.app` (App-ID, höhere Version, gültige Signatur), Windows: `Blattwerk-Setup-<Version>.exe`. `src/main/update/` (prüfen, beim `will-quit` Hilfsskript starten), Leiste `features/update/`. `dist:mac:local` legt die neue App in den Update-Ordner.
- **Updates aus dem Netz** ([ADR 0027](docs/entscheidungen/0027-updates-aus-dem-netz.md)): CI-Job „Veröffentlichen“ stellt jede neue Version (`package.json`) als Release in das öffentliche Projekt `limax240z/Blattwerk-Downloads` (Secret `DOWNLOADS_TOKEN`). „Nach Updates suchen …“ und still im Hintergrund (bei jedem Start, neuen Dokument, nach mindestens 10 Minuten Abwesenheit und alle 3 Stunden, mit 2 Minuten Mindestabstand; `update/schedule.ts`) lädt `src/main/update/online.ts` die passende Datei in den Update-Ordner (macOS `-mac.zip`, entpackt mit `ditto`), dann weiter wie oben. Windows: Die App startet beim Beenden das Installationsprogramm direkt (`/S --updated --force-run`, wie electron-updater; ein PowerShell-Hilfsskript startete dort nicht), Aufräumen beim nächsten Start, Protokoll `update.log` im Update-Ordner, CI prüft das mit `scripts/smoke-update-win.mjs`. **Für jede Auslieferung die Version erhöhen.**
- Es ist immer höchstens ein Bearbeitungsmodus aktiv (Kommentieren, Schwärzen, Formular bearbeiten, Inhalt bearbeiten, Seiten organisieren).
- Dieses Verfahren (Snapshot der Dokumentbytes) gilt für Seiten-, Feld-, Wasserzeichen- und Inhaltsänderungen sowie für das Schwärzen. Nach dem Speichern beginnt der Verlauf neu.

### iPad-App ([ADR 0029](docs/entscheidungen/0029-ipad-app.md))

- Eigene Hülle in Swift (`ios/`, Xcode-Projekt mit synchronisiertem Ordner `ios/Blattwerk/`, kein Paket aus dem Netz): `WKWebView` zeigt dieselbe Oberfläche, Dateien über `app://bundle/` (`SchemeHandler.swift`, CSP aus `web/csp.txt`, das `vite.ios.config.ts` aus `CONTENT_SECURITY_POLICY` erzeugt). Einstieg `src/ios/entry.ts`: erst `install.ts` (setzt `window.blattwerk` und `data-platform="ipad"`), dann `renderer/main`.
- `src/ios/api.ts` setzt `BlattwerkApi` auf Bausteine der Hülle (`AppHost.swift`): kleine Werte über `call` (`WKScriptMessageHandlerWithReply`, `Bridge.swift`), Bytes lesen über `fetch` an `app://bundle/__native/…` (`file`, `store`, `font`); Bytes schreiben (`save`, `stage`, `folder`, `store`) gehen stückweise über die Brücke (`upload.chunk`, Base64), die Anfrage trägt nur `upload=<Kennung>&len=<Länge>`: Auf dem echten Gerät reicht WebKit den Rumpf von `fetch` nicht an den Schema-Handler weiter (im Simulator schon). **Rumpf als `Uint8Array` senden, nie als `Blob`**: Einen Blob reicht WebKit an Schema-Handler ohne Inhalt weiter. Auf dem Gerät kommt der Rumpf als Strom (`httpBodyStream`): bis `read == 0` lesen, nicht nach `hasBytesAvailable` (sonst leer), und nicht im Hauptthread. Geschrieben wird nur, wenn die mitgeschickte Länge (`len`) stimmt (`NativeRequest.completeBody`).
- Dateien an Ort und Stelle (`FileRegistry.swift`: Sicherheitsbereich, Lesezeichen für „Zuletzt geöffnet“, `NSFileCoordinator`; Schreiben erst atomar, sonst direkt). Sichern unter, neue Dokumente und Exporte über den Sichern-Dialog der Dateien-App (`forExporting`), mehrere Dateien über einen gewählten Ordner. HTML → PDF (Vorlagen, Textdokumente) mit `UIPrintPageRenderer` in einer WebView ohne JavaScript und Netz (`HtmlToPdf.swift`; Seitengröße und Ränder kommen als Werte, `@page` wirkt dort nicht).
- Wiederverwendet aus dem Hauptprozess: `buildMenuTemplate` (`src/main/menu-template.ts`, `platform: 'ios'` lässt Mac-Einträge weg) → Menüleiste von iPadOS (`src/ios/menu.ts`, `MenuBar.swift`), `detectAndConvert` (`src/main/convert/`, ZIP mit fflate), `templateHtml`, `blankPdf` (`src/shared/blank-pdf.ts`). Neue Methoden in `BlattwerkApi` brauchen eine Umsetzung in `src/ios/api.ts` (`tsconfig.ios.json` prüft das).
- Pinch-Zoom: `src/ios/touch.ts` übersetzt die Geste von WebKit in Strg + Mausrad. Schriften für neuen Text: `src/ios/fonts.ts` (PostScript-Namen, nur einzelne TTF/OTF von iPadOS).
- Nicht auf dem iPad: mehrere Fenster, Updates (SideStore), Standardprogramm, natives Liquid Glass.
- **iPhone und Kompaktansicht** ([ADR 0030](docs/entscheidungen/0030-kompaktansicht-iphone.md)): dieselbe App (`TARGETED_DEVICE_FAMILY = 1,2`). Unter 600 Punkt Breite (`src/renderer/app/compact.ts`, `useCompact`, `data-compact`) zeigt die Werkzeugleiste „Alle Befehle“ (`CommandSheet.tsx`, Inhalt aus `buildMenuTemplate`), Seitenleisten liegen über dem Dokument und schließen sich nach einem Seitenwechsel. Die Mac-App erreicht diese Breite nie (`minWidth: 760`). Auf iPad und iPhone haben Dialoge einen festen Hintergrund (WebKit zeichnet die Unschärfe hinter `<dialog>` nicht), sichere Ränder über `env(safe-area-inset-*)`. Zeichnen mit dem Finger: WebKit beachtet `touch-action` an SVG nicht, `installTouchDrawing` (`src/ios/touch.ts`) hält das Scrollen über `[data-touch-draw]` und `[data-handle]` an; ein Finger malt, zwei Finger schieben (der angefangene Strich wird per `pointercancel` verworfen).
- Entwicklung: `npm run build:ios`, dann `scripts/run-ios-sim.sh` (baut, startet im Simulator ohne Fenster, gibt Fehler der Oberfläche aus `Library/Caches/oberflaeche.log` aus und legt ein Bildschirmfoto nach `$TMPDIR/blattwerk-ipad.png`). Nur in Debug-Builds: `BLATTWERK_OPEN=<Pfad>` öffnet eine Datei, `BLATTWERK_EVAL=<Pfad zu .js>` führt ein Prüfskript in der Oberfläche aus.

### Speichern (Grundregeln aus der Spezifikation, ab Phase 2)

1. PDFium erzeugt die neuen Bytes, standardmäßig **inkrementell** (`FPDF_INCREMENTAL`).
2. **Vollständig neu geschrieben** wird nur, wenn es nötig ist: Schwärzen, Bereinigen, Verschlüsselung ändern, Komprimieren, „Speichern unter → optimiert“. Haben Signaturen im Dokument, fragt die App vorher nach.
3. Prüfen: Die neuen Bytes werden in PDFium als neues Dokument geöffnet (dieselbe WASM-Instanz, siehe ADR 0005). Schlägt das fehl, wird nicht gespeichert.
   Neue Dokumente (Zusammenführen, Extrahieren, Teilen, Bilder → PDF) werden vollständig geschrieben, an einen im Systemdialog gewählten Ort (`files:save-new`, `files:save-to-folder`; Namen nur über `sanitizeFileName`).
4. Hauptprozess: Prüfen, ob die Datei auf der Platte noch dem Stand beim Öffnen entspricht. Sonst nachfragen.
5. **Atomar schreiben** mit `src/main/files/atomic-write.ts`: temporäre Datei im *selben* Ordner, `fsync`, `rename` über das Original, unter Windows mit Wiederholungen bei `EPERM`/`EBUSY`. Die Originaldatei wird nie direkt beschrieben.

### Sicherheit

- `BrowserWindow`: `contextIsolation`, `sandbox`, `webSecurity` an, `nodeIntegration` aus. Navigation und `window.open` gesperrt (`src/main/security.ts`).
- Alle App-Dateien kommen über `app://bundle/` (`src/main/protocol.ts`). Die CSP (`script-src 'self' 'wasm-unsafe-eval'`, `default-src 'none'`) steht in **jeder** Antwort, damit sie auch für Worker gilt. **Netzwerk ist im Renderer komplett gesperrt** (`session.webRequest`), nur `app:`, `blob:`, `data:` sind erlaubt. Einzige Ausnahme im Hauptprozess: Updates von GitHub (ADR 0027, nur HTTPS, feste Hosts, jede Weiterleitung geprüft).
- **JavaScript in PDFs wird nie ausgeführt:** pdf.js bekommt keinen Scripting-Manager (ohne ihn läuft kein PDF-JavaScript), `enableXfa: false`. Die frühere Option `isEvalSupported` gibt es in pdf.js 6 nicht mehr; pdf.js nutzt kein `eval`.
- Externe Links: nur `http`, `https`, `mailto`, keine Zugangsdaten im Host-Teil, nur nach Rückfrage mit angezeigtem Zielserver (Punycode).
- IPC: feste Kanalliste (`src/shared/ipc.ts`), Absender wird geprüft, Argumente validiert (`src/shared/validate.ts`). Drop-Pfade nur absolut und lokal (keine UNC-Pfade). Quelldateien (PDF, JPEG, PNG) werden am Inhalt erkannt (`file-registry.ts`), Bilder über 100 Megapixel abgelehnt. Gespeicherte Unterschriften prüft der Hauptprozess (PNG, höchstens 2 MB und 4000 px, höchstens 20).
- Testschalter (`BLATTWERK_E2E`, `BLATTWERK_E2E_PRINT_DIR`, `BLATTWERK_E2E_SHOW`) wirken nur in der unpaketierten App. `BLATTWERK_USER_DATA` (Profilordner) und `BLATTWERK_HIDDEN=1` (Fenster und Dock-Symbol verborgen, nur Anzeige) wirken immer, beide nutzt der Rauchtest der fertigen App.
- Electron-Fuses in `electron-builder.yml`: `RunAsNode` aus, `NODE_OPTIONS` aus, Inspect-Argumente aus, ASAR-Integrität an, `OnlyLoadAppFromAsar` an.

### Performance-Regeln

- Hauptansicht: `PDFViewer` von pdf.js rendert nur sichtbare Seiten und hält einen begrenzten Seiten-Cache; bei hohem Zoom zeichnet es einen Detailausschnitt statt riesiger Canvas.
- Miniaturen: virtualisierte Liste (`@tanstack/react-virtual`), Rendern erst bei Sichtbarkeit und im Leerlauf, Abbruch beim Herausscrollen, LRU-Cache mit höchstens 400 Einträgen (je etwa 240 px breit). Bereits gerenderte Seiten der Hauptansicht liefern Miniaturen ohne erneutes Rendern.
- Zoom: pdf.js skaliert sofort per CSS und rendert verzögert scharf nach.
- Suche: pdf.js extrahiert den Text seitenweise im Hintergrund; die Ergebnisliste lädt Textausschnitte nur für angezeigte Zeilen (höchstens 500).
- Referenz für Messungen: `test/fixtures/generated/gross-600-seiten.pdf` (114 MB). Ziel: Öffnen unter 15 s, keine Blockade über 500 ms (gemessen: etwa 0,5 s und unter 150 ms).

## Ordnerstruktur

```
docs/
  spezifikation.md          Projektvorgabe (unverändert)
  entscheidungen/           Architekturentscheidungen (ADR 0001–0030)
  phasen/                   Abschlussbericht je Phase
src/
  main/                     Hauptprozess: index (Fenster je Dokument), window, window-layout, menu, ipc, security, protocol(+paths), print,
                            default-app, i18n, tab-ghost, files/ (file-registry, recent-files, json-store, atomic-write, signatures, window-positions,
                            thumbnails, blank-document), templates/ (Vorlagen), update/, convert/
  preload/                  contextBridge-API (index.ts) und ihr Typ (api-types.ts)
  shared/                   Typen, IPC-Vertrag, Befehle, Tastenkürzel, Validierung, product.ts. Keine Node- oder DOM-Imports
  locales/de/               translation.json (alle UI-Texte, Renderer und Menü), pdfjs-viewer.ftl (Texte der pdf.js-Bausteine)
  renderer/
    app/                    Shell: Layout, Werkzeugleiste, Tabs, Seitenleisten, Startbildschirm, globale Tasten, Drag & Drop
    features/               viewer, thumbnails, outline, search, properties, print, password, goto,
                            annotations (Kommentare), prompt (Rückfragen), settings,
                            pages (Seitenraster, Seiten-Dialoge, Abläufe für Seiten und neue Dokumente),
                            forms (Ausfüllen), form-edit (Formular bearbeiten), signatures (Unterschrift),
                            redaction (Schwärzen), stamping (Wasserzeichen, Kopf-/Fußzeilen), content-edit (Inhalt bearbeiten),
                            security (Kennwortschutz), export (Bilder, Text), compress, compare, ocr, progress (Fortschritt mit Abbrechen)
    components/             generische UI-Bausteine (IconButton, Dialog, ModeBadge, Tooltip, glass/liquid-glass)
    state/                  zustand-Stores (documents, ui, annotations, history, forms, form-edit, content-edit), dirty.ts
    engine/                 pdf.js-Einrichtung, Laden, Range-Transport, Laufzeit je Dokument, Befehle (session.ts),
                            coords.ts, pdfium-client.ts
    styles/                 Design-Tokens, hell/dunkel
    public/                 beim Build kopierte pdf.js- und OCR-Ressourcen (nicht eingecheckt)
  ios/                      iPad-App (ADR 0029): window.blattwerk über die Swift-Hülle (api, native, menu, accelerator, touch, fonts, entry)
  workers/pdfium/           Bearbeitungs- und Speicher-Engine (engine, pages, forms, redact, text-search, content, render, memory,
                            protocol, worker), mit pdf-lib: fields, imported, sanitize + redaction, stamping, protection, compress, compare
resources/icon.svg          eigenes App-Symbol (Quelle); icon-ios.svg randlos für das iPad (gerendert mit qlmanage, ohne Alphakanal)
ios/                        Xcode-Projekt der iPad-App (Swift-Hülle, Info.plist, App-Symbol)
build/                      icon.png (aus resources/icon.svg erzeugt), after-pack.cjs
native/macos-glass/        native Erweiterung für Apples Liquid Glass (Objective-C++, Node-API), gebaut von scripts/build-native.mjs
scripts/                    build, build-native, dev, generate-fixtures, check-licenses, dist-mac-local, smoke-packaged, smoke-update, smoke-update-win, make-icon, dev-env.sh
test/
  fixtures/pdfs/            kleine Test-PDFs (eingecheckt), expectations.ts mit den erwarteten Eigenschaften
  fixtures/images/          Testbilder (JPEG, PNG, PNG mit Transparenz; eingecheckt)
  fixtures/generated/       große Datei (nicht eingecheckt, `npm run fixtures -- --large`)
  unit/  integration/  e2e/
.github/workflows/build.yml
```

## Technik und Versionen

Stand 2026-10-12. Vor dem Installieren erneut prüfen und die aktuelle stabile Version nehmen.

| Zweck | Paket | Version | Lizenz |
|---|---|---|---|
| Laufzeit | electron | 44.7.0 (Chromium 152, Node 24.21) | MIT |
| Tooling | Node.js LTS | 24.21.0 | MIT |
| Build | vite, @vitejs/plugin-react | 8.3.4, 6.1.2 | MIT |
| UI | react, react-dom | 19.3.0 | MIT |
| Sprache | typescript | **6.0.3** | Apache-2.0 |
| Rendering | pdfjs-dist | 6.4.299 | Apache-2.0 |
| Bearbeiten/Speichern | @embedpdf/pdfium | 2.15.1 | MIT + BSD-3 |
| Formularstruktur, Schwärzen, Wasserzeichen, Test-PDFs | @cantoo/pdf-lib | 2.11.1 | MIT |
| Teilschriften (Wasserzeichen, PDF/A), Tests | @cantoo/fontkit | 2.0.12 | MIT |
| Tests (JPEG) | jpeg-js | 0.4.4 (nur Entwicklung) | BSD-3-Clause |
| Texterkennung | tesseract.js (+ tesseract.js-core 7.0.0), @tesseract.js-data/deu, /eng | 7.0.0, 1.0.0 | Apache-2.0, MIT |
| Signaturen | pkijs, asn1js, @libpdf/core (nur Schlüssel aus .p12) | 3.4.1, 3.0.10, 0.5.2 | BSD-3-Clause, BSD-3-Clause, MIT |
| Zustand | zustand | 5.0.15 | MIT |
| Virtualisierung | @tanstack/react-virtual | 3.14.15 | MIT |
| i18n | i18next, react-i18next | 26.4.4, 17.0.16 | MIT |
| Icons | lucide-react | 1.55.0 | ISC |
| Tests | vitest, @playwright/test | 5.0.4, 1.64.0 | MIT, Apache-2.0 |
| Lint | eslint, typescript-eslint | 10.12.0, 8.71.1 | MIT |
| Packaging | electron-builder | 26.15.3 | MIT |

- **TypeScript 6 statt 7:** typescript-eslint 8.71 unterstützt nur TypeScript unter 6.1. Umstieg auf 7, sobald typescript-eslint so weit ist.
- **Kein electron-vite:** Version 5.0.0 unterstützt Vite 8 nicht und hatte seit 12/2025 kein Release. Stattdessen drei schlanke Vite-Konfigurationen (main, preload, renderer) und ein kleines Dev-Skript.
- pdf.js-Schriften: Die Liberation-Schriften (GPL) werden nicht mitkopiert (`copy-pdfjs-assets.mjs`); die App nutzt Systemschriften, pdf.js lädt sie nur ohne diese.
- **Lizenzen:** nur MIT, Apache-2.0, BSD-2/3, ISC und 0BSD. CI prüft das automatisch. AGPL (MuPDF, iText) und GPL nur nach Rücksprache.

## Konventionen

- TypeScript `strict`, kein `any` (Ausnahme: dokumentierter Grund im Kommentar). Benannte Exporte.
- Dateinamen: React-Komponenten `PascalCase.tsx`, alles andere `kebab-case.ts`.
- **Keine UI-Texte im Code:** immer `t('bereich.schluessel')`. Neue Schlüssel zuerst in `src/locales/de/`. ESLint erzwingt das.
- Icons nur aus `lucide-react`. Styling mit CSS Modules und Design-Tokens (CSS-Variablen) für hell und dunkel nach `prefers-color-scheme`.
- **Gestaltung** (Farben [ADR 0020](docs/entscheidungen/0020-gestaltung.md), Formen [ADR 0021](docs/entscheidungen/0021-liquid-glass.md)): wie eine native macOS-26-App mit Liquid Glass (CSS-Variablen `--glass-*`; Lichtbrechung, Glanzkanten und federnde Bewegung über `useLiquidGlass` und `.liquid`, [ADR 0022](docs/entscheidungen/0022-liquid-glass-lichtbrechung.md); unter macOS 26+ zusätzlich Apples echtes Glas `NSGlassEffectView` unter durchsichtigen Fensterbereichen über die native Erweiterung `native/macos-glass` ([ADR 0023](docs/entscheidungen/0023-natives-liquid-glass.md), `src/main/native-glass.ts`, `src/renderer/app/native-glass.ts`)), Systemschrift, konzentrische Rundungen, Kapseln für Leistenknöpfe und Tabs, keine umrahmten Karten und keine Großbuchstaben-Beschriftungen. Farben: Papierton, Flaschengrün (`--color-brand`), je Arbeitsbereich ein Ton (`data-tone`, `IconButton tone`, `ModeBadge`); neue Modi bekommen einen Ton und ein Namensschild. Unter macOS ist die Werkzeugleiste zugleich Titelleiste (`hiddenInset`, `data-drag-region`).
- Tastenkürzel nur über die zentrale Tabelle in `src/shared/shortcuts.ts` (`CmdOrCtrl`). Menü und Renderer lesen dieselbe Tabelle.
- Fehler aus Engines als typisierte Ergebnisse, nicht als nackte Exceptions über Prozessgrenzen. Meldungen an Nutzer immer übersetzt.
- Commits: `typ(bereich): Beschreibung auf Deutsch`, z. B. `feat(viewer): Miniaturen erst bei Sichtbarkeit rendern`. Am Phasenende ein Commit `Phase N abgeschlossen`.

## Tests

- **Unit/Integration (Vitest):** reine Logik und die Test-PDFs mit der Node-Variante von pdf.js; PDFium-WASM und pdf-lib laufen ebenfalls in Node (`test/integration/pdfium-*.test.ts`, `fields.test.ts`, `redaction.test.ts`, `stamping.test.ts`, `content.test.ts`). Das Test-PDF zum Schwärzen erzeugt `test/fixtures/redaction.ts` im Test (Geheimnisse an allen bekannten Verstecken).
- **E2E (Playwright mit Electron):** `test/e2e/viewer.spec.ts` (Phase 1), `test/e2e/comments.spec.ts` (Phase 2, arbeitet auf Kopien der Test-PDFs), `test/e2e/pages.spec.ts` (Phase 3; Öffnen-, Ordner- und Sichern-Dialoge per `stubDialogs` ersetzt), `test/e2e/forms.spec.ts` (Phase 4), `test/e2e/edit.spec.ts` (Phase 5), `test/e2e/tools.spec.ts` (Phase 6), `test/e2e/pro.spec.ts` (Phase 7; getaggtes Test-PDF aus `test/fixtures/tagged.ts`), `test/e2e/windows.spec.ts` (Fenster je Dokument, Tabs herausziehen und zusammenführen), `test/e2e/start.spec.ts` (Startseite, Vorlagen, Home-Knopf, Anheften) und `test/e2e/regressions.spec.ts` (behobene Fehler). Mehrere Dateien beim Start öffnen mehrere Fenster: `expectWindowCount`, `windowWithTitle`, `mergeAllWindows` in `test/e2e/app.ts`; Menübefehle gehen an das vordere (zuletzt geöffnete) Fenster. Beim Schließen beantwortet der Test-Helfer die Rückfrage „Nicht speichern“. **Unsichtbar:** Im Testmodus bleibt das Fenster verborgen (ohne Drosselung) und die App ohne Dock-Symbol, damit die Tests den Auftraggeber nicht stören; `BLATTWERK_E2E_SHOW=1` zeigt das Fenster zum Zuschauen. **Verbindlich (Auftraggeber, 2026-10-15): Alle Tests laufen unsichtbar, auch der Rauchtest der fertigen App. Nichts darf ein Fenster öffnen oder den Fokus nehmen; der Auftraggeber arbeitet nebenher am Mac.** Systemdialoge werden im Hauptprozess per `app.evaluate` ersetzt; Drucken landet im Testmodus als PDF in einem Ordner.
- **Fertige App:** `node scripts/smoke-packaged.mjs <Pfad zur .app>` startet das Paket, prüft die Anzeige und speichert einen Kommentar (PDFium aus dem Paket). `node scripts/smoke-update.mjs <Pfad zur .app>` spielt in einem Testordner ein Update (Version 99.0.0) ein.
- **Ausgabeprüfung für jede gespeicherte Datei:** `qpdf --check` (in CI installiert, lokal übersprungen, wenn nicht vorhanden), Öffnen mit pdf.js, PDFium und `@cantoo/pdf-lib`, Annotationen haben /AP. Unter macOS zusätzlich mit PDFKit (die Engine von Apple Vorschau): `test/e2e/pdfkit.ts` (JavaScript for Automation). Acrobat Reader: manuelle Checkliste im Phasenbericht.
- **Test-PDFs** (`test/fixtures/pdfs/`): Text, Scan (nur Bild), Formular (AcroForm), verschlüsselt (Benutzer- und Besitzerpasswort), eingeschränkt, beschädigt (kaputte xref, abgeschnitten), mit Links und Lesezeichen, mit Kommentaren (`kommentare.pdf`: Antwort, Prüfstatus). Signiert folgt mit PAdES in Phase 7. „Sehr groß“ (600 Seiten, mehr als 100 MB) erzeugt `scripts/generate-fixtures.ts` nach `test/fixtures/generated/`.

## Befehle

Node.js liegt projektlokal in `.tools/node` (nicht eingecheckt). Vor jedem Befehl: `source scripts/dev-env.sh` (setzt `PATH`, legt alle Caches nach `.tools/cache`, beachtet einen gesetzten Proxy).

| Befehl | Zweck |
|---|---|
| `npm run dev` | Entwicklungsstart mit Vite-Server und eigenem Profil (`.tools/dev-profile`) |
| `npm run build` | Haupt-, Preload- und Renderer-Bundle nach `out/` |
| `npm run typecheck`, `npm run lint` | Typprüfung, ESLint |
| `npm test` | Unit- und Integrationstests |
| `npm run test:e2e` | Build und Oberflächentests mit der echten App |
| `npm run fixtures -- --large` | Test-PDFs neu erzeugen (unter macOS inklusive Scan); `-- --only=name.pdf` erzeugt nur eine Datei (verschlüsselte ändern sich sonst bei jedem Lauf) |
| `npm run licenses` | Lizenzprüfung der eingebündelten Pakete |
| `npm run dist:mac:local` | Mac-App (Apple Silicon) bauen, `.dmg` nach `release/` |
| `npm run dist:mac`, `npm run dist:win` | Pakete für CI (beide Mac-Architekturen bzw. Windows) |
| `npm run build:ios` | Oberfläche der iPad-App nach `out/ios/web` |
| `npm run dist:ios` | iPad-App als unsignierte `.ipa` nach `release/` (SideStore signiert beim Installieren) |
| `npm run publish:mac` | Mac-Pakete auf diesem Mac bauen und einzeln mit Wiederholungen ins Release der aktuellen Version laden; ein neues Release bleibt bis zum Ende Entwurf (nur von `main`; nur noch nötig, wenn CI ohne Mac läuft, `MAC_IN_CI = false`) |

**In der Claude-Sandbox:** Electron, Playwright-Oberflächentests, `npm run fixtures` (wegen `sips`) und Packaging laufen nur außerhalb der Sandbox. **In der Cloud (Linux):** `node node_modules/electron/install.js` lädt Electron, danach laufen die Oberflächentests mit `BLATTWERK_E2E_SHOW=1 xvfb-run -a -s "-screen 0 1920x1200x24" npx playwright test` (sichtbar auf dem virtuellen Bildschirm; verborgen dauert dort jede Mausbewegung etwa 1 s und Tests mit Ziehen laufen in die Zeitgrenze). Unter Linux wird „Liste leeren … Liste des Systems“ übersprungen (gibt es nur unter macOS und Windows), PDFKit-Prüfungen laufen nur auf dem Mac. Mit Node 22 scheitert zudem ein Umwandlungstest (Windows-1252), das Projekt braucht Node 24. Kein Packaging.

## Packaging

- iPad: `npm run dist:ios` (Xcode, Release, ohne Signatur), Installation mit SideStore nach [docs/ipad-installieren.md](docs/ipad-installieren.md). Unter iPadOS ab 18.

- electron-builder: `.dmg` getrennt für arm64 und x64, Windows-Installer `.exe` (NSIS, x64).
- Dateizuordnung `.pdf` (macOS `CFBundleDocumentTypes`, Windows ProgID). Standardprogramm festlegen ([ADR 0004](docs/entscheidungen/0004-standardprogramm.md)): unter macOS über Launch Services per JavaScript for Automation (nur in der installierten App), unter Windows öffnet die App die Einstellungsseite.
- Signatur: lokal ad-hoc (`identity: '-'`, `hardenedRuntime: false`). Für Weitergabe an andere: Apple-Developer-Zertifikat, `identity` setzen, `hardenedRuntime: true`, Notarisierung.
- `npm run dist:mac:local` baut im temporären Ordner des Systems und kopiert nur die `.dmg` nach `release/`. `build/after-pack.cjs` entfernt vor dem Signieren alle erweiterten Dateiattribute (an denen `codesign` sonst scheitern kann).
- GitHub Actions: Matrix `macos-15-intel` (baut arm64 und x64; Apple-Silicon-Rechner teilt GitHub dem Konto nicht zu, Probelauf 2026-11-05) und `windows-latest`. Seit 2026-11-05 wieder mit Mac (`MAC_IN_CI = true`): Die Mac-Pakete kommen wie Windows automatisch ins Release. Unter Windows laufen die Oberflächentests mit sichtbaren Fenstern (`BLATTWERK_E2E_SHOW`, verborgene zeichnen dort kaum) und 1920 × 1080 (sonst klappt die Werkzeugleiste zusammen); Zeitgrenze 30 Minuten, ältere Läufe eines Zweigs werden abgebrochen. Signieren und Notarisieren optional über Secrets. Ohne Zertifikate signiert CI die Mac-App ad hoc (auch in Pull-Requests: `CSC_FOR_PULL_REQUEST`, sonst ist die Signatur nach dem Setzen der Fuses ungültig und macOS beendet die App beim Start) und prüft sie mit `codesign --verify`. Heruntergeladene Apps meldet Gatekeeper trotzdem als „beschädigt“ (Quarantäne-Attribut, `xattr -cr`), Windows zeigt SmartScreen.

## Bekannte Stolpersteine

- Pinch auf dem Trackpad kommt als `wheel`-Event mit `ctrlKey`. Browser-Zoom per `setVisualZoomLevelLimits(1, 1)` abschalten und selbst zoomen.
- `File.path` gibt es in Electron nicht mehr. Für Drag & Drop `webUtils.getPathForFile` im Preload nutzen.
- macOS öffnet Dateien per `open-file`-Event, auch vor `ready`. Windows übergibt sie über `argv` und `second-instance`.
- Schließen des letzten Fensters beendet die App auch unter macOS (Wunsch des Auftraggebers, 2026-10-14); die Rückfrage zum Speichern kommt vorher.
- Pfad des Projekts enthält Leerzeichen. In Skripten Pfade immer quoten.
- iCloud-Ordner (z. B. `~/Documents`) sind ungeeignet: Konfliktkopien in generierten Ordnern und Attribute, an denen `codesign` scheitert.
- `.tools/package.json` mit `"type": "commonjs"` (legt `dev-env.sh` an): Sonst liest Node die heruntergeladenen Hilfsprogramme von electron-builder als ES-Module.
- pdf.js 6: `getPermissions()` liefert ein `Set`, `getFieldObjects()` eine `Map`. `PDFDocumentProxy.destroy()` gibt es nicht mehr, abgebaut wird über die Lade-Aufgabe.
- pdf.js-Treffer (`pageMatches`) zählen Positionen im aneinandergehängten Text **ohne** Zeichen für Zeilenenden (siehe `src/renderer/features/search/snippet.ts`).
- pdf.js rechnet den Zoom-Anker relativ zum `offsetParent` des Containers (`containerTopLeft`), nicht zum Fenster.
- `pdf_viewer.mjs` erwartet `globalThis.pdfjsLib`; deshalb `src/renderer/engine/pdfjs-global.ts` vor dem Import.
- Playwright erzwingt sonst den hellen Modus; in `test/e2e/app.ts` steht deshalb `colorScheme: null`.
- React lauscht auch an Portal-Containern. Native Listener am Viewer-Container laufen deshalb **nach** React-Handlern in der Kommentarebene (siehe Auswahl aufheben in `AnnotationLayer.tsx`).
- pdf.js leert eine Seite bei `reset()` komplett; eigene Elemente in der Seite müssen wieder eingehängt werden (`MutationObserver`). `mix-blend-mode` wirkt nur ohne eigenen Stapelkontext (kein `z-index` an der Kommentarebene).
- pdf.js liefert `State`/`StateModel` als rohe PDF-Zeichenketten (UTF-16 mit BOM möglich) und den `/Name` von Stempeln gar nicht.
- `python3` ist auf diesem Mac nicht nutzbar (Xcode-Lizenz nicht bestätigt). Für Skripte Node verwenden.
- pdf.js gibt den Puffer von `getDocument({ data })` an seinen Worker ab (danach leer). Bytes, die man behalten will, als Kopie übergeben (`document-loader.ts`).
- PDFium: `FPDF_MovePages` erwartet als Ziel den Index in der Liste **ohne** die verschobenen Seiten (`moveTarget` in `src/shared/pages.ts`). `EPDFImageObj_SetJpeg/SetPng(0, 0, Bildobjekt, Datenzeiger, Länge)`.
- pdf.js zeichnet unter `ENABLE_FORMS` den Anmerkungsspeicher nicht mit; `combineFormsWithStorage` (`runtime.ts`) ergänzt die Speicher-Absicht, sonst erscheinen ausgeblendete Kommentare wieder.
- pdf.js liest die QuickInfo (`/TU`) nur am Widget, nicht am Feld; die App schreibt sie an beide. pdf-lib vergrößert neue Felder um die Rahmenbreite; `fields.ts` setzt das Rechteck danach exakt.
- PDFium passt `/Parent` beim Kopieren von Seiten nicht an (Formularfelder, Popups). Deshalb nach jedem Zusammensetzen und jeder Einfügung aus einer Datei `imported.ts`.
- PDFium kopiert beim Schwärzen Bildpunkte im Bildobjekt selbst um (auch die Transparenzmaske); geteilte Bilder würden auf allen Seiten geschwärzt. Deshalb vorher `isolateSharedXObjects`. Vektorpfade lässt PDFium unangetastet; ganz verdeckte entfernt `redact.ts`.
- `FPDFPage_GenerateContent` schreibt den ganzen Seiteninhalt neu. Für reine Ergänzungen (Wasserzeichen) deshalb pdf-lib mit eigenem Strom.
- pdf-lib ersetzt nicht darstellbare Zeichen in Standardschriften stillschweigend durch „?“ (`getCharacterSet` prüfen) und fasst Seiteninhalt bei jeder Bearbeitung in q … Q (`autoNormalizeCTM` abschalten).
- `FPDFFont_GetBaseFontName` liefert Namen ohne Teilschrift-Präfix; fehlende Zeichen erkennt man am Ersatzzeichen (gleicher Glyphenpfad wie U+F8FF).
- PDFium: `FPDFText_SetText` mit leerem Text auf einem per `FPDFPageObj_CreateTextObj` angelegten Objekt bricht die WASM-Instanz ab (`unreachable`). Seiten nicht ein zweites Mal laden, während sie offen sind (Schrift-Handles werden ungültig): `listPageObjects` vorher aufrufen.
- In Tests nach einer Dokumentänderung oder dem Speichern `waitForDocument` abwarten, bevor der nächste Menübefehl kommt (während des Neuladens sind Befehle wirkungslos).
- Native Menü-Kürzel (z. B. Cmd+A mit `role: selectAll`) erreichen den Renderer auf dem Mac nicht als Tastendruck.
- iPadOS 26+: Die Menüleiste baut `UIMainMenuSystem.shared.setBuildConfiguration` (`MenuBar.configure`); `UIMenuSystem.main.setNeedsRebuild` wirkt dort nicht. Doppelte Tastenkürzel lehnt iPadOS ab und fügt dann **keins** der Menüs ein (nur eine Meldung „MenuBuilder … conflict“ im Systemprotokoll). ⌘, gehört dem App-Menü („Einstellungen“), deshalb kommen `app.settings` und `help.about` dort hinein (`system: 'preferences' | 'about'`). Prüfen: `xcrun simctl spawn <Gerät> log show --last 1m --predicate 'process == "Blattwerk"' | grep -i conflict`.
- iPad installieren: Die Anmeldung in SideStore scheitert seit 2026-10 mit -80045; iloader („Import IPA“, Anisette „Jkcoxson (Mac)“) funktioniert ([docs/ipad-installieren.md](docs/ipad-installieren.md)).
- Große parallele Prüf-Workflows mit vielen Agenten haben das Nutzungslimit des Auftraggebers zweimal ausgeschöpft. Nur sparsam einsetzen.
