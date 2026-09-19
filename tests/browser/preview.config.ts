import { defineConfig } from "vite";
import config from "../../vite.config.ts";

// A browser fixture must never forward an unmocked API request to a running hive.
export default defineConfig({
  ...config,
  preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy: {} },
});
