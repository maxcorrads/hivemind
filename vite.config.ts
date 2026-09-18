import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const hive = process.env.HIVEMIND_URL ?? "http://127.0.0.1:7420";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 7421,
    strictPort: true,
    proxy: {
      "/api": hive,
      "/ws": { target: hive.replace("http", "ws"), ws: true },
    },
  },
  build: {
    // Preserve Vite 7's baseline rather than silently dropping older browsers.
    target: ["chrome107", "edge107", "firefox104", "safari16"],
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
