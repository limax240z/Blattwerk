# 0030: Kompaktansicht und iPhone

Stand: 2026-10-28 · Status: angenommen · Baut auf [ADR 0029](0029-ipad-app.md) auf

## Ausgangslage

Der Auftraggeber möchte Blattwerk auch auf dem iPhone. Die iPad-Hülle läuft dort unverändert, die Oberfläche ist aber für breite Fenster gebaut: Die Seitenleiste nimmt die halbe Breite, fast alle Knöpfe landen im „⋯“, und das iPhone hat keine Menüleiste. Viele Befehle (OCR, Komprimieren, Seiten einfügen …) gibt es auf Mac und iPad nur im Menü.

## Entscheidung

- **Eine App für iPad und iPhone** (`TARGETED_DEVICE_FAMILY = 1,2`), dieselbe Hülle, dieselbe `.ipa`.
- **Kompaktansicht nach Breite**, nicht nach Gerät: unter 600 Punkt Breite (`COMPACT_QUERY` in `src/renderer/app/compact.ts`, Kennzeichen `data-compact` am Dokument). Das trifft das iPhone und das iPad im geteilten Bildschirm. Die Mac-App erreicht das nie (Fenster mindestens 760 breit), ihr Verhalten bleibt gleich.
- In der Kompaktansicht:
  - **Knopf „Befehle“** in der Werkzeugleiste öffnet alle Menüs als Liste (`CommandSheet.tsx`). Inhalt aus derselben Quelle wie Mac- und iPad-Menü (`buildMenuTemplate`, `platform: 'ios'`), damit kein Befehl fehlt und neue automatisch erscheinen.
  - **Seitenleisten als Überlagerung** über dem Dokument statt daneben, beim Wechsel in die Kompaktansicht zu. Nach einem Seitenwechsel schließt sich die linke Leiste von selbst.
  - Dialoge nutzen fast die ganze Breite.
- Sichere Ränder (Notch, Home-Balken) über `env(safe-area-inset-*)`.

## Verworfen

- **Eigene iPhone-Oberfläche:** doppelte Pflege jeder Funktion.
- **Native Leiste in Swift für die Befehle:** müsste Zustand und Texte doppelt halten. Die Liste in der Oberfläche nutzt den vorhandenen Menüaufbau.
