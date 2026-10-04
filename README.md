# Arena

Live-Sport, Spielplan, Tabellen und deine Teams – die große Sportansicht im Nojo-Ökosystem. Die Notch zeigt den Spielstand nebenbei; Arena ist der Ort, den man dafür öffnet.

## Ansichten

- **Live** – alle Spiele von heute (Wappen 2:1 Wappen; laufende tragen ihre Spielzeit als Lichtstrich in den Teamfarben). Im Fenster als Leiste oben, breit/im Vollbild als Spalte links, nach Wettbewerb. Daneben das gewählte Spiel groß, in zwei Spalten:
  - links **Ballverlauf** (Spielfeld mit Ballaktionen und Rückennummern) bzw. beim Basketball das **Wurfbild** (Treffer ● und Fehlwürfe × beider Teams auf dem ganzen Feld, der letzte Wurf leuchtet auf; darunter je Team Würfe mit Quote, Dreier, Freiwürfe), **Druckphasen** (Torschüsse und Ecken über die Spielzeit, geglättet; Heim nach oben, Gast nach unten, Tore als Lichtpunkte) und **Statistik** (Ballbesitz, Schüsse, Pass-/Zweikampfquote … als geteilter Balken in den Teamfarben),
  - rechts **Ticker**, **Aufstellung** mit Formation und Wechseln, **Spielort** (Stadion, Schiedsrichter, Zuschauer).
  - Vor dem Anpfiff stattdessen **Prognose** (aus den Quoten), **Form** der letzten fünf, Saisonwerte, **direkter Vergleich** und die voraussichtliche Aufstellung. Läuft nichts, steht das nächste Spiel mit Countdown da.
- Neue Daten ändern nur, was neu ist (`src/morph.ts`, identisch in der Notch): Stand und Minute wechseln als Text, neue Tickerzeilen laufen oben ein, Wappen, Spielfeld und Karten bleiben stehen – nichts blinkt.
- **Spielplan** – eine Woche zurück bis drei Wochen voraus, nach Tagen; je Tag stehen die Wettbewerbe als Karten **nebeneinander** (Fußball neben NBA neben NFL …). Filter: *Alle*/*Meine Teams*, Sportarten, Wettbewerbe.
- **Ligen** – Sportart wählen, dann den Wettbewerb: **Tabelle | Spielplan | Schlagzeilen** nebeneinander (im Fenster zwei Spalten, Schlagzeilen darunter; kompakt untereinander). Der Spielplan scrollt für sich und steht bei „Heute“. Schlagzeilen von ESPN (englisch) mit Filter *Transfers*; bei US-Ligen zusätzlich **Kaderbewegungen** (Verpflichtungen, Entlassungen, Verlängerungen).
- **Teams** – je Lieblingsteam das nächste Spiel und die Form. Das Blatt zeigt **Spiele** (nächste, letzte Ergebnisse) und den **Kader** (nach Position, Rückennummer, Alter, Nation, verletzt).

Überall **Wappen statt Vereinsnamen** (Name im Tooltip), Gestaltung nach der gemeinsamen Designsprache (`D:\Dev\nojo-design`, Kopie unter `src/nojo/`): Folio-Grau, Liquid Glass für alles Schwebende, Licht als Information. Ein Kartenaufbau überall (Augenbraue links, Hinweis rechts), drei Radien. Breiten: kompakt < 960 px, Fenster, breit ≥ 1400 px, xl ≥ 1800 px.

Tastatur: Strg+1–4 wechselt die Ansicht, **F11** Vollbild (die Fensterknöpfe verschwinden dort), Esc schließt das Seitenblatt bzw. verlässt das Vollbild.

**Nicht frei verfügbar:** Marktwerte und Fußball-Transferlisten. Marktwerte gibt es praktisch nur bei Transfermarkt (keine offene Schnittstelle, Scraping verstößt gegen die Nutzungsbedingungen); ESPN liefert im Fußball keine Transaktionen. Kommerzielle Wege: API-Football (Transfers, Schlüssel nötig), Sportmonks.

## Bedienung und Extras

- **Schnellsuche** (Strg+K oder Lupe oben): Teams (aus Spielen, Tabellen, Favoriten), Ligen, laufende Spiele, Ansichten, Vollbild, Einstellungen – tippen, ↑/↓, Enter.
- **Live:** ←/→ wechselt das Spiel. Alle Karten stehen immer da, ohne Daten leer (Spielfeld ohne Spieler, leeres Netz, „–“).
  Hinter Stand und Uhr die **Wappen als Punkteraster** (Canvas, Farbe und Größe der Punkte aus dem Wappen, zur Mitte hin auslaufend).
  **Stadion** von oben (echter Grundriss aus OpenStreetMap, massstabsgetreu mit Spielfeld) und von der Seite (Ränge nach Kapazität, Dach), Platzzahl aus Wikidata, ein Punkt je 1.000 Plätze. **Teamvergleich** als Radar (Ballbesitz, Schüsse, aufs Tor, Pass- und Zweikampfquote, Ecken).
- **Spielplan:** jeder Tag des Zeitraums (spielfreie Tage schmal), je Tag die Ligen ohne Rahmen nebeneinander, jede in ihrer **Ligafarbe** (aus dem Logo gelesen); an der Spaltengrenze fließen die Farben ineinander (CSS-Verlauf in OKLCH). Spieltage rasten beim Scrollen in der Mitte ein; **Heute** (Knopf oder H) springt zum aktuellen Spieltag.
- **Karten anordnen** (Knopf mit dem Raster-Symbol im Spielkopf): Die Standard-Anordnung hängt von der Spielphase ab – vor dem Spiel Prognose, Form und direkter Vergleich oben, während des Spiels Spielfeld, Statistik und Ticker, danach Statistik und Analyse (`src/layout.ts`). Karten am Griff ziehen (SortableJS) oder mit den Pfeilen verschieben, in die andere Spalte setzen, ausblenden und über die Leiste zurückholen; **Standard** nimmt die eigene Anordnung zurück. Gespeichert je Sportart und Phase, Esc beendet das Anordnen.
- **An der Notch ausgerichtet** (`src/notch-align.ts`, Lage aus `notch_rect`): Läuft die Notch, steht der Spielstand genau unter ihr und die Grenze der beiden Kartenspalten auf ihrer Mittelachse; liegt sie über dem Kopf, rücken die Reiter neben die Marke. Seitlich angedockt hält der Inhalt Abstand. Ohne Notch bleibt alles mittig.
- **Hintergrund:** Nebel in den Farben aller gewählten Ligen, dazwischen dunkle Schwaden (`src/fog.ts`, Canvas in 1/10 Größe, 20 Bilder/s, steht bei „Bewegung reduzieren“).
- **Spiel antippen** (Spielplan, Teams): öffnet es in Live, auch wenn es vorbei ist oder erst in Tagen beginnt – mit Ballverlauf bzw. **Wurfbild** des ganzen Spiels (NBA-Spiele laufen nachts; so sieht man sie am nächsten Tag). Das Spiel steht dann vorn in der Spielleiste.
- **Testspiele** kommen von selbst dazu: Freundschaftsspiele (ESPN `club.friendly`) der Vereine aus den gewählten Ligen und der Lieblingsteams – keine eigene Auswahl, die Spalte „Testspiele“ erscheint, sobald es welche gibt. Länderspiel-Tests laufen über „Länderspiele Deutschland“.
- **Ligen:** Spielplan der Liga als Kalender mit allen Tagen, Spieltage rasten in der Mitte ein. Liga-Logos überall (Chips, Spaltenköpfe, Spielleiste).
- **Lieblingsteams in Vereinsfarbe** (Spielzeilen, Tabelle, Kacheln, Team-Karten); Team-Karten mit **Tabellenplatz**.
- **Kader-Radar** (Team-Blatt › Kader, Fußball): Stärken des Kaders aus den Saisonwerten aller Spieler (Torgefahr, Chancen, Kreativität, Passspiel, Zweikampf, Defensive, Abwehr hält); Spieler antippen = **Spieler-Radar** je 90 Minuten im Vergleich zum Besten im Kader (Torhüter eigene Achsen).
- **In den Kalender** (Team-Blatt): kommende Spiele als .ics nach `Downloads\Arena`, öffnet die Kalender-App.
- Menüleiste: im Vollbild und maximiert rücken die Reiter neben die Marke (oben in der Mitte sitzt die Notch). Symbole aus der Bibliothek (`nojo-design`).

## KI-Einordnung der Schlagzeilen (Laya, optional)

Ein kleines lokales Modell ([Laya](https://github.com/NandhaKishorM/laya), Apache-2.0) ordnet die ESPN-Schlagzeilen in **Ligen** ein: *Transfer fix*, *Gerücht*, *Verlängerung*, *Verletzung*, *Spiel*. Es läuft auf dem eigenen Rechner (Web Worker, ONNX Runtime WASM, etwa 1 s je Schlagzeile, jede nur einmal), ohne Konto und ohne Daten nach außen. Etiketten erscheinen erst ab 45 % Sicherheit; der Tooltip zeigt den Wert. Ohne Modell bleibt es bei der Stichwortsuche.

- **Installer:** Haken auf der Willkommensseite, standardmäßig gesetzt. Arena lädt das Modell (306 MB, jede Datei per SHA-256 geprüft, abgebrochene Downloads setzen fort) beim ersten Start im Hintergrund. Updates ändern die Wahl nicht.
- **Einstellungen › KI-Einordnung:** installieren, Download abbrechen, deinstallieren (löscht den Ordner `%LOCALAPPDATA%\de.nojo.arena\laya`). Die Deinstallation von Arena entfernt ihn ebenfalls.
- Paket bauen, messen, veröffentlichen: `tools/laya/README.md`.

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
| ESPN `sports.core.api.espn.com` | Ballaktionen mit Feldposition (Spielfeld), Würfe mit Ort (Basketball) |
| ESPN `…/summary?event=` | Spielanalyse: Statistik, Kommentar (Druckphasen), Aufstellungen, Spielort, Quoten, Form, direkter Vergleich (`src-tauri/src/info.rs`) |
| ESPN `…/teams/{id}/roster` | Kader |
| ESPN `…/news`, `…/transactions` | Schlagzeilen, Kaderbewegungen (US-Ligen) |
| Wikidata (`wbsearchentities`, `EntityData`) | Stadion: Kapazität, Koordinaten, Eröffnung |
| OpenStreetMap Overpass | Stadion-Grundriss und Spielfeld von oben |
| ESPN Core `athletes/{id}/statistics` | Saisonwerte der Spieler (Kader- und Spieler-Radar) |
| GitHub-Release `laya-model-1` | optionales Laya-Modell (nur auf Wunsch, einmalig) |
| OpenLigaDB `api.openligadb.de` | 3. Liga, Frauen-Bundesliga (Spiele, Tabelle, Team-Spiele), Ersatz bei ESPN-Ausfall |

Abgefragtes wird zwischengespeichert (vergangene Tage 6 h, kommende 30 min, heute 1 min, Tabellen 10 min, Spielanalyse live 25 s / vorher 10 min / danach 1 h, Kader 6 h, Schlagzeilen 15 min).

## Updates

Arena aktualisiert sich selbst wie die Notch: 20 s nach dem Start und dann alle 6 h fragt sie `https://github.com/NojoMcDybo/arena/releases/latest/download/latest.json`. Gibt es eine neue Version, leuchtet ein Punkt am Zahnrad; Einstellungen › App › **Installieren** lädt sie, prüft die Signatur (öffentlicher Schlüssel in `tauri.conf.json`, derselbe wie bei der Notch) und startet Arena neu.

Veröffentlichen: Version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml` und `src-tauri/tauri.conf.json` erhöhen, committen, Tag `v<version>` pushen. `.github/workflows/release.yml` baut, signiert (Secret `TAURI_SIGNING_PRIVATE_KEY`; der private Schlüssel liegt nur unter `%USERPROFILE%\.tauri\nojo-updater.key`) und hängt Installer und `latest.json` an das Release.

## Bauen

```powershell
npm install
npx tauri dev                       # Entwicklung (Port 1434)
npx tauri build --bundles nsis      # Installer unter src-tauri\target\release\bundle\nsis
cd src-tauri; cargo test --lib      # Tests (Laya-Download lokal: tools/laya/README.md); gegen die echten Quellen: cargo test --lib quellen -- --ignored --nocapture  (bzw. info_quellen)
```

Installer per `explorer.exe` starten (die Claude-App läuft virtualisiert).
