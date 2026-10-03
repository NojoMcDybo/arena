# Arena

Live-Sport, Spielplan, Tabellen und deine Teams – die große Sportansicht im Nojo-Ökosystem. Die Notch zeigt den Spielstand nebenbei; Arena ist der Ort, den man dafür öffnet.

## Ansichten

- **Live** – alle Spiele von heute als Leiste (Wappen 2:1 Wappen). Laufende Spiele tragen ihre Spielzeit als feinen Lichtstrich in den Teamfarben. Darunter das gewählte Spiel groß: Wappen und Stand, **Spielfeld mit Ballverlauf** (jede Ballaktion mit Feldposition, Rückennummern; die Beschriftung schwebt als Glaspille über dem Feld) und der Ticker. Läuft nichts, steht das nächste Spiel mit Countdown da (deine Teams zuerst).
- **Spielplan** – eine Woche zurück bis drei Wochen voraus, nach Tagen; die Tagesköpfe schweben als Glas, „Heute“ steht beim Öffnen oben. *Alle* oder *Meine Teams*, Wettbewerbe einzeln aus- und einblendbar. Ein laufendes Spiel antippen öffnet es in Live, sonst die Spielseite im Browser.
- **Tabelle** – je gewähltem Wettbewerb (Bundesliga, 2./3. Liga, Frauen-Bundesliga, Europa, US-Ligen). Zonen (Champions League, Abstieg …) als Lichtstrich in ihrer Farbe, deine Teams hervorgehoben. Eine Zeile antippen zeigt das Team: nächste Spiele, letzte Ergebnisse, *Zu meinen Teams*.
- **Teams** – je Lieblingsteam das nächste Spiel und die **Form**: die letzten Ergebnisse als Lichtpunkte (grün Sieg, grau Remis, rot Niederlage; Tooltip mit Gegner und Ergebnis).

Überall **Wappen statt Vereinsnamen** (Name im Tooltip), Gestaltung nach der gemeinsamen Designsprache (`D:\Dev\nojo-design`, Kopie unter `src/nojo/`): Folio-Grau, Liquid Glass für alles Schwebende, Licht als Information. Tastatur: Strg+1–4 wechselt die Ansicht, Esc schließt das Seitenblatt.

## Einstellungen = die der Notch

Zahnrad oben rechts: Lieblingsteams (Wappen-Raster mit Suche), Wettbewerbe und wie sich die Notch verhält (an/aus, alle oder nur deine Spiele, Aufklappen bei Toren …). Es sind **dieselben Einstellungen** wie in der Notch (Einstellungen › Sport) – beide bleiben vollständig, und sie werden abgeglichen:

- Läuft die Notch (ab 0.2.4), ist sie die Quelle: Arena liest alle 4 s `GET http://127.0.0.1:47800/sport/settings` und schickt eigene Änderungen sofort mit `PUT` hin (nur Loopback, bereinigt wie in der Notch).
- Läuft sie nicht, merkt sich Arena die Änderung und schickt sie beim nächsten Kontakt. Die Pille „Notch“ oben leuchtet grün, solange beide verbunden sind.

## Aus der Notch öffnen

Arena meldet das Schema `arena://` an. Die Notch (ab 0.2.4) zeigt dann in der aufgeklappten Sportkarte einen Knopf **In Arena öffnen** (`arena://spiel/<schlüssel>` öffnet genau dieses Spiel) und in Einstellungen › Sport einen Verweis auf Arena. Läuft Arena schon, kommt das Fenster nach vorn.

## Quellen

Dieselben wie in der Notch, alle ohne Konto und Schlüssel (`src-tauri/src/feed.rs` ist aus `notch/src-tauri/src/sport.rs` abgeleitet – Parser dort und hier gleich halten):

| Quelle | Wofür |
|---|---|
| ESPN `site.api.espn.com` (inoffiziell) | Live-Stände, Ticker, Spielplan (Kalender der Spieltage, je Tag abgefragt), Team-Spielpläne |
| ESPN `site.api.espn.com/apis/v2/…/standings` | Tabellen mit Zonen |
| ESPN `sports.core.api.espn.com` | Ballaktionen mit Feldposition (Spielfeld) |
| OpenLigaDB `api.openligadb.de` | 3. Liga, Frauen-Bundesliga (Spiele, Tabelle, Team-Spiele), Ersatz bei ESPN-Ausfall |

Abgefragtes wird zwischengespeichert (vergangene Tage 6 h, kommende 30 min, heute 1 min, Tabellen 10 min).

## Bauen

```powershell
npm install
npx tauri dev                       # Entwicklung (Port 1434)
npx tauri build --bundles nsis      # Installer unter src-tauri\target\release\bundle\nsis
cd src-tauri; cargo test --lib      # Tests; gegen die echten Quellen: cargo test --lib quellen -- --ignored --nocapture
```

Installer per `explorer.exe` starten (die Claude-App läuft virtualisiert).
