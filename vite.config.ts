import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// CF_PERSIST_DIR redirects the local binding state directory (used by e2e so
// tests never touch the developer's .wrangler/state database).
const persistDir = process.env.CF_PERSIST_DIR;

export default defineConfig({
  plugins: [
    react(),
    cloudflare({ persistState: persistDir === undefined ? true : { path: persistDir } }),
  ],
});
