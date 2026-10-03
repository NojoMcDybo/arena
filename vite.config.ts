import { defineConfig } from "vite";

export default defineConfig(() => ({
  clearScreen: false,
  server: { port: 1434, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
}));
