/**
 * Laya im eigenen Thread (Web Worker): laedt das Modell aus dem lokalen Ordner (Asset-Protokoll) und ordnet
 * Schlagzeilen ein. Die Oberflaeche bleibt fluessig; ist der Worker eine Weile unbeschaeftigt, beendet ihn
 * client.ts — das gibt den Speicher (~600 MB mit Modell) wieder frei.
 *
 * Nachrichten: { type: "load", base } -> { type: "ready" } | { type: "error", message }
 *              { type: "classify", items: { id, text }[] } -> je Eintrag { type: "result", id, kind, p, probs },
 *              danach { type: "done" }
 */

import * as ort from "onnxruntime-web/wasm";
import { useWebOrt } from "./vendor/providers";
import { Agent, type ChoiceAnswer } from "./vendor/agent";
import { QUESTIONS } from "./questions";

// laya-ts waehlt den Browser-Weg, wenn es `window` gibt; im Worker heisst das globale Objekt `self`
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

const ORT_VERSION = "1.30.0";
let agent: Agent | null = null;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      // ein Thread genuegt (ohne Cross-Origin-Isolation gibt es ohnehin keine WASM-Threads); WASM liegt im Paket
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      // die WASM-Datei im Paket gehoert zu genau dieser Version (package.json: exakt gepinnt, laya.rs: Paketkennung)
      if (ort.env.versions.web !== ORT_VERSION) throw new Error(`Modellpaket passt nicht zur App (ONNX Runtime ${ort.env.versions.web}, Paket ${ORT_VERSION})`);
      const res = await fetch(`${m.base}/ort.wasm`);
      if (!res.ok) throw new Error(`ort.wasm: ${res.status}`);
      ort.env.wasm.wasmBinary = await res.arrayBuffer();
      useWebOrt(ort);
      agent = await Agent.load(m.base);
      post({ type: "ready" });
    } else if (m.type === "classify") {
      if (!agent) throw new Error("Modell nicht geladen");
      // in kleinen Gruppen: Ergebnisse erscheinen nach und nach
      const items: { id: string; text: string }[] = m.items;
      for (let i = 0; i < items.length; i += 4) {
        const chunk = items.slice(i, i + 4);
        const out = await agent.predictBatch(chunk.map((x) => x.text), QUESTIONS, { batchSize: 4 });
        out.forEach((o, j) => {
          const a = o.answers.kind as ChoiceAnswer;
          post({ type: "result", id: chunk[j].id, kind: a.choice, p: a.probabilities[a.choice] ?? 0, probs: a.probabilities });
        });
      }
      post({ type: "done" });
    }
  } catch (err) {
    post({ type: "error", message: String((err as Error)?.message ?? err) });
  }
};
