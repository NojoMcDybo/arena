# Laya-Modellpaket

Optionales KI-Modell, das Schlagzeilen einordnet (Transfer fix, Gerücht, Verlängerung, Verletzung, Spiel).
Quelle: [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) bzw. Hugging Face `convaiinnovations/laya`
(Apache-2.0). Arena lädt das Paket nur, wenn man es will (Installer-Haken oder Einstellungen › KI-Einordnung).

## Aufbau

| Teil | Wo |
|---|---|
| Paket bauen | `tools/laya/build_model.py` (Export → 4 Bit → Paket, gibt die `FILES`-Zeilen für `laya.rs` aus) |
| Laden, prüfen, löschen | `src-tauri/src/laya.rs` (SHA-256 je Datei fest im Code, Range-Fortsetzung) |
| Installer-Haken | `src-tauri/installer-hooks.nsh` (Willkommensseite, Vorgabe an; Deinstallation löscht das Modell) |
| Einordnung | `src/laya/worker.ts` (Web Worker, onnxruntime-web WASM), `src/laya/client.ts` (Warteschlange, Zwischenspeicher) |
| laya-ts | `src/laya/vendor/` (eingebettete Kopie, nicht auf npm; Anpassungen in `vendor/README.md`) |

Das Paket (306 MB) liegt als sechs Dateien am GitHub-Release **`laya-model-1`** von `NojoMcDybo/arena`:
`laya-en-int4.{encoder.onnx, head.onnx, tokenizer.json, rl_agent_config.json, ort-1.30.0.wasm, LICENSE.txt}`.
Die WASM-Laufzeit gehört zum Paket (nicht in jede Installation): `vite.config.ts` wirft sie aus dem App-Bundle,
der Worker prüft, dass `onnxruntime-web` genau die Version des Pakets hat (package.json: exakt gepinnt).

## Messung (Oktober 2026, 40 echte ESPN-Schlagzeilen, Frage aus `src/laya/questions.ts`)

| Variante | Größe | gleiche Antwort wie fp32 | Zeit je Schlagzeile |
|---|---|---|---|
| fp32 | 1,7 GB | – | 305 ms (nativ, 8 Threads) |
| INT8 dynamisch | 442 MB | 27/40 | 206 ms (nativ) |
| **INT4 (Block 32)** | **291 MB** | **39/40** | 398 ms nativ · **~1,2 s WASM, 1 Thread** |

Transfergerüchte erkennt das Modell sicher (0,8–0,9). Themen außerhalb der Kategorien (Urteile, Politik)
landen mit niedriger Sicherheit – Arena zeigt ein Etikett deshalb erst ab 45 % (`MIN_P`).
Die Basismodelle sind auf eigene Fragen nicht trainiert; die Einordnung ist Hilfe, keine Wahrheit.

## Neues Paket veröffentlichen

1. Eigene venv mit `torch` (CPU), `transformers`, `onnx`, `onnxruntime`, `onnxscript`, `huggingface_hub`;
   Laya klonen und `pip install -e <klon> --no-deps`.
2. `python tools/laya/build_model.py --laya-repo <klon> --work <ordner>` (Windows-Konsole: `PYTHONUTF8=1`).
3. Ausgegebene `PACKAGE`/`FILES`-Zeilen in `src-tauri/src/laya.rs` übernehmen; bei neuem Inhalt die Release-Kennung
   (`laya-model-N` in `BASE`) erhöhen, damit alte App-Versionen ihr Paket behalten.
4. Hochladen – **mit `--latest=false`**: sonst wird das Modell-Release „Latest“, und der Updater
   (`releases/latest/download/latest.json`) findet keine App-Updates mehr. PowerShell löst `*` für `gh` nicht auf:
   ```powershell
   gh release create laya-model-1 --repo NojoMcDybo/arena --latest=false --title "Laya-Modell 1" --notes "Optionales KI-Modell für Arena (Apache-2.0)" (Get-ChildItem <ordner>\pkg).FullName
   ```

Lokal testen ohne Release: `node tools/laya/serve-pkg.mjs <ordner>/pkg` (wie ein Release, mit Range) und
`ARENA_LAYA_BASE=http://127.0.0.1:8767 cargo test --lib laya_download -- --ignored --nocapture`;
die App selbst liest `ARENA_LAYA_BASE` ebenso.
