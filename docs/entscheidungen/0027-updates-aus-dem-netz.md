# 0027 Updates aus dem Netz (GitHub)

Stand: 2026-10-18 · Wunsch des Auftraggebers: neue Versionen aus der App heraus holen, ohne jedes Mal auf GitHub zu
gehen. Ergänzt [0025](0025-updates.md), das neue Versionen nur aus einem Ordner einspielt.

## Entscheidung

- **Quelle:** ein öffentliches GitHub-Projekt nur für die fertigen Apps, `limax240z/Blattwerk-Downloads`
  (`UPDATE_REPOSITORY` in `src/shared/product.ts`). Der Quelltext bleibt im privaten Projekt. Der Auftraggeber hat diesen
  Weg gewählt (Alternativen unten). Bis 0.16.1 lag beides beim Konto `MythicLimax`; es wurde im Oktober 2026 von GitHub
  gesperrt. Ab 0.16.2 gilt das neue Konto `limax240z`. Ältere Installationen finden dort nichts und brauchen die erste
  Version vom neuen Konto einmal von Hand.
- **Mac ohne CI (seit 0.16.2):** Das neue Konto bekam von GitHub keine Mac-Rechner (jeder Mac-Auftrag brach nach
  15 Minuten Warten ab, Windows lief). Mit der Projektvariable `MAC_IN_CI = false` laufen in CI nur die Windows-Teile. Nachtrag 2026-11-05: Intel-Macs (`macos-15-intel`) teilt GitHub sofort zu, Apple-Silicon-Macs weiterhin nicht; CI baut die Mac-Pakete deshalb auf Intel für beide Mac-Arten, `MAC_IN_CI = true`.
  Die Mac-Tests laufen dann vor jeder Version auf dem eigenen Mac (vollständige Testreihe), und
  `npm run publish:mac` baut die Mac-Pakete dort, prüft die Signatur wie die CI und legt sie in das Release
  (legt es an, falls der CI-Job noch nicht so weit ist; der Job ergänzt dann nur die Windows-Datei). Bekommt das Konto
  wieder Mac-Rechner, die Variable löschen.
- **Veröffentlichen:** Der CI-Job „Veröffentlichen“ läuft nach jedem Build auf `main`. Gibt es zur Version aus
  `package.json` noch kein Release `v<Version>`, legt er es mit allen Paketen an (macOS `.dmg` und `-mac.zip` je
  Prozessor, Windows `Setup.exe`). Er braucht das Secret `DOWNLOADS_TOKEN` (fein abgestufter Schlüssel, Schreibrecht nur
  für die Inhalte des Download-Projekts); fehlt es, warnt er nur. Eine neue Version entsteht also nur, wenn die
  Versionsnummer steigt.
- **Mac-Archiv:** electron-builder baut zusätzlich `Blattwerk-<Version>-<arm64|x64>-mac.zip` (unter macOS mit dem
  System-`zip`, symbolische Verweise bleiben erhalten). CI entpackt es wie die App mit `ditto` und prüft die Signatur.
- **In der App** (`src/main/update/online.ts`): „Nach Updates suchen …“ prüft erst den Update-Ordner (0025), dann
  `GET https://api.github.com/repos/<Projekt>/releases/latest`. Ist die Version neuer, lädt der Hauptprozess die passende
  Datei (`updateAssetName`) mit Fortschritt in den eigenen Update-Ordner, entpackt unter macOS mit `ditto` und prüft
  App-ID und Version. Danach übernimmt der Updater aus 0025 (Signatur prüfen, Leiste „Jetzt aktualisieren“, Austausch
  beim Beenden). Beim Start sucht die installierte App jedes Mal still (bis 2026-10-19 höchstens alle 12 Stunden;
  auf Wunsch des Auftraggebers geändert, eine Anfrage je Start ist für GitHub unbedenklich); Testläufe nie.
- **Windows:** Beim Beenden startet die App das Installationsprogramm direkt und losgelöst (`/S --updated --force-run`,
  wie electron-updater). Es wartet selbst auf das Ende der App, installiert still an den bisherigen Ort und startet sie
  neu. Bis 0.15.0 lief das über ein PowerShell-Hilfsskript, das unter Windows gar nicht erst startete: Die App ging zu,
  sonst geschah nichts (vom Auftraggeber gemeldet, in CI nachgestellt). Eingespielte Installationsprogramme löscht die
  App beim nächsten Start. Jeder Schritt steht in `update.log` im Update-Ordner. CI spielt das fertige
  Installationsprogramm als Update ein (`scripts/smoke-update-win.mjs`).
- **Netz nur hier:** Nur der Hauptprozess spricht mit dem Netz (Node `fetch`, nicht die Sitzung des Renderers), nur über
  HTTPS, nur mit `api.github.com`, `github.com` und den Speichern für Release-Dateien. Weiterleitungen folgt die App selbst
  und prüft jede Station (`fetchChecked`, `isAllowedUpdateUrl`). Höchstens 800 MB, Größe muss zur Angabe von GitHub
  passen. Der Renderer bleibt ohne Netz (`session.webRequest` unverändert). Abweichung von der Spezifikation auf Wunsch
  des Auftraggebers.
- **Ohne Quarantäne:** Vom Hauptprozess geladene Dateien tragen unter macOS kein Quarantäne-Attribut; die Meldung
  „beschädigt“ wie beim Herunterladen im Browser entfällt.

## Nachtrag 2026-11-04: Wann gesucht wird

Bisher nur einmal beim Start. Auf Wunsch des Auftraggebers still im Hintergrund (`src/main/update/schedule.ts`): bei
jedem Start, bei jedem neuen Dokument, bei der Rückkehr in die App nach mindestens 10 Minuten im Hintergrund und
spätestens alle 3 Stunden. Zwischen zwei Suchen liegen mindestens 2 Minuten, weil GitHub ohne Anmeldung nur 60 Anfragen
je Stunde und Internetanschluss erlaubt. Der Zeitgeber prüft alle 5 Minuten, ob die Zeit um ist, damit die Suche nach
dem Ruhezustand nicht ausfällt. Weggeklickte Hinweise bleiben für diese Version weg (`dismissed`); nur die Suche von
Hand zeigt sie wieder.

## Verworfen

- **Privates Projekt direkt:** Releases privater Projekte gibt GitHub nur mit Zugangsdaten heraus.
- **Projekt öffentlich machen:** einfacher, aber dann ist der Quelltext für alle sichtbar.
- **Schlüssel in der App:** müsste auf jedem Rechner eingegeben werden und läuft ab.
- **electron-updater:** braucht unter macOS eine kostenpflichtige Apple-Signatur für Squirrel.

## Grenzen

- Die erste Version mit dieser Suche (0.12.0) muss einmal von Hand installiert werden.
- Ohne Apple-Developer-Zertifikat sind die Apps nur ad hoc signiert. Die Prüfung schützt vor kaputten Dateien, nicht
  vor einer gefälschten App im Download-Projekt; geschützt ist das über den Schlüssel, mit dem nur CI dort schreibt.
