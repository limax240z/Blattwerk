# Blattwerk auf das iPad bringen

Blattwerk für das iPad wird nicht im App Store veröffentlicht. Du installierst es mit **SideStore**, einem kostenlosen Programm, das Apps mit deiner eigenen Apple-ID auf dein iPad bringt. Apple lässt solche Apps nur **7 Tage** laufen. SideStore verlängert sie aber selbst, auch ohne Mac, sobald es einmal eingerichtet ist.

Gut zu wissen:

- Mit einer kostenlosen Apple-ID dürfen höchstens **3 solcher Apps** gleichzeitig drauf sein. SideStore selbst zählt als eine davon.
- SideStore und das Hilfsprogramm iloader stammen nicht von Apple. Sie melden sich mit deiner Apple-ID bei Apple an, um die App zu signieren. Du kannst dafür auch eine zweite, eigene Apple-ID nehmen.
- Deine PDFs bleiben auf dem iPad. Blattwerk schickt nichts ins Internet.

## Einmalig einrichten (etwa 20 Minuten)

Du brauchst: das iPad mit Code-Sperre, deinen Mac, ein USB-Kabel und WLAN.

1. **Auf dem iPad:** Lade aus dem App Store die App **LocalDevVPN** und öffne sie. Tippe auf „Connect“ und erlaube das VPN. Diese App muss immer verbunden sein, wenn SideStore Apps installiert oder verlängert.
2. **Auf dem Mac:** Lade **iloader** von der Seite <https://github.com/nab138/iloader/releases> (Datei `iloader-darwin-universal.dmg`). Öffne die Datei und zieh iloader in den Ordner „Programme“.
3. Verbinde das iPad mit dem Kabel. Tippe auf dem iPad auf „Vertrauen“ und gib den Code ein.
4. Öffne iloader und melde dich mit deiner Apple-ID an. Achte auf Groß- und Kleinschreibung.
5. Wähle dein iPad aus und klicke auf **„Install SideStore (Stable)“**.
6. **Auf dem iPad:** Öffne „Einstellungen → Allgemein → VPN & Geräteverwaltung“. Tippe unter „Entwickler-App“ auf deine Apple-ID und dann auf „Vertrauen“.
7. Schalte den **Entwicklermodus** ein: „Einstellungen → Datenschutz & Sicherheit → Entwicklermodus“. Das iPad startet neu, danach bestätigst du mit „Einschalten“.
8. Öffne LocalDevVPN und tippe auf „Connect“. Öffne dann **SideStore** und melde dich mit derselben Apple-ID an.
9. Tippe in SideStore unter „My Apps“ auf den Zähler „7 DAYS“ neben SideStore. Fragt SideStore nach einem neuen Zertifikat, tippe auf „Yes“ bzw. „Refresh Now“.

Klemmt etwas, hilft die offizielle Anleitung: <https://docs.sidestore.io/docs/installation/prerequisites>.

## Blattwerk installieren

1. Auf dem Mac liegt die App im Projektordner unter `release/`, zum Beispiel `Blattwerk-0.17.0-iPad.ipa`.
2. Schick die Datei per **AirDrop** an das iPad. Sie landet in der Dateien-App unter „Downloads“.
3. Verbinde LocalDevVPN, öffne SideStore, tippe unter „My Apps“ oben auf **„+“** und wähle die `.ipa`-Datei.
4. Nach einem Moment erscheint Blattwerk auf dem Home-Bildschirm.

## Verlängern

- SideStore zeigt bei jeder App, wie viele Tage sie noch läuft. Ein Tipp auf den Zähler verlängert sie wieder um 7 Tage. LocalDevVPN muss dabei verbunden sein.
- Damit du nicht daran denken musst: Schalte in SideStore unter „Settings“ das Verlängern im Hintergrund ein, falls angeboten. Sicherer ist eine Automation in der Kurzbefehle-App: „Täglich“ → Aktion von SideStore zum Verlängern aller Apps.
- Läuft eine App doch einmal ab, startet sie nicht mehr. Deine Daten bleiben erhalten. Einfach in SideStore verlängern.

## Neue Version

Für eine neue Version bekommst du eine neue `.ipa`. Installiere sie wie oben über „+“ in SideStore. Die alte Version wird ersetzt, deine Unterschriften, eigenen Vorlagen und die Liste „Zuletzt geöffnet“ bleiben erhalten.

## So arbeitest du mit Blattwerk auf dem iPad

- **Öffnen:** In Blattwerk über „PDF öffnen“, oder in der Dateien-App ein PDF lange drücken → „Teilen“ → Blattwerk. Dateien aus iCloud Drive und „Auf meinem iPad“ werden **an Ort und Stelle** bearbeitet: Sichern speichert direkt in die Datei.
- **Menüleiste:** Wisch vom oberen Bildschirmrand nach unten, oder halte mit Tastatur die Befehlstaste ⌘ gedrückt. Dort stehen dieselben Befehle wie auf dem Mac (Ablage, Bearbeiten, Anzeige, Dokument, Werkzeuge …). Mit Tastatur gelten dieselben Kürzel wie auf dem Mac.
- **Zoomen:** mit zwei Fingern auseinander- oder zusammenziehen.
- **Sichern unter, Exportieren, neue Dokumente:** Es öffnet sich der Dialog der Dateien-App, in dem du den Ort auswählst.
- **Drucken:** über AirPrint, oder im Druckdialog „Teilen“ → „Als PDF sichern“.

Was es auf dem iPad nicht gibt: mehrere Fenster (Tabs gibt es), Updates aus Blattwerk heraus (die kommen über SideStore) und „Als Standardprogramm festlegen“.
