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
    headers: {
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
    },
    proxy: {
      // Preserve the browser authority; never rewrite WS Origin to manufacture
      // trust. The backend uses its socket port (not Host) for cookie names.
      // The separator is essential: /api.ts is a browser module, not an API.
      "^/api(?:[/?]|$)": { target: hive, changeOrigin: false },
      "/ws": { target: hive.replace("http", "ws"), ws: true, changeOrigin: false },
    },
  },
  build: {
    // Preserve Vite 7's baseline rather than silently dropping older browsers.
    target: ["chrome107", "edge107", "firefox104", "safari16"],
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
