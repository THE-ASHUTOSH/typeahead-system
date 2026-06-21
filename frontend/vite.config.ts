import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the typeahead UI.
//
// WHY the dev-server proxy:
// The React app served by the Vite dev server runs on http://localhost:5173, while the
// Express API runs on http://localhost:8080 — a DIFFERENT origin. In the browser that
// would trip CORS on every fetch. The backend already sets permissive CORS headers, but
// proxying is cleaner for local dev: the UI just calls same-origin relative paths
// (e.g. `fetch("/suggest?q=ip")`) and Vite forwards them to the API. This means:
//   * no absolute API URL hardcoded in the client (one less thing to change per machine),
//   * the same relative-path code works in production, where the built SPA is served by
//     the SAME Express process (see app.ts static-serving block), so there is no proxy at
//     all and the paths resolve directly.
// We forward exactly the API route prefixes the UI uses; everything else (HMR, assets) is
// handled by Vite itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/suggest": "http://localhost:8080",
      "/search": "http://localhost:8080",
      "/trending": "http://localhost:8080",
      "/cache": "http://localhost:8080",
      "/metrics": "http://localhost:8080",
    },
  },
});
