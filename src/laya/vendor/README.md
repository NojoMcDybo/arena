# laya-ts (eingebettet)

Aus [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) `laya-ts/src` @ fa9a2a7, Apache-2.0 (`LICENSE`).
Nur die Dateien, die `Agent` im Browser braucht. `laya-ts` ist nicht auf npm, deshalb hier als Kopie.

Anpassungen (nur `providers.ts`, mit „Arena:“ markiert):

1. `useWebOrt(ort)`: onnxruntime-web wird übergeben statt per `import("onnxruntime-" + "web")` geladen (für Vite unsichtbar).
2. `fetchArrayBuffer` ohne CacheStorage (das Modell liegt lokal; ein Cache legte ~300 MB doppelt ab).

Alle Dateien tragen `// @ts-nocheck`: sie sind für Node-Typen geschrieben; geprüft wird upstream.
Aktualisieren: Dateien neu kopieren, die beiden Stellen wieder einsetzen, Modellpaket gegenprüfen (`tools/laya/`).
