import { defineConfig, type Plugin } from "vite";

/**
 * Die WASM-Laufzeit von onnxruntime-web (14 MB) gehoert zum optionalen Laya-Modellpaket (laya.rs laedt sie mit,
 * der Worker uebergibt sie als wasmBinary). Vite wuerde sie sonst in jede Installation packen.
 */
const dropOrtWasm = (): Plugin => ({
  name: "arena-drop-ort-wasm",
  apply: "build",
  generateBundle(_, bundle) {
    for (const k of Object.keys(bundle)) if (/ort-wasm-.*\.wasm$/.test(k)) delete bundle[k];
  },
});

export default defineConfig(() => ({
  clearScreen: false,
  plugins: [dropOrtWasm()],
  // Laya-Worker laedt Teile von laya-ts dynamisch nach: dafuer braucht der Worker ES-Module
  worker: { format: "es" as const },
  server: { port: 1434, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
}));
