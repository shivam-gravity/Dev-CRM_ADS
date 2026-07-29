import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Where the dev server proxies /api, /ws and /objects. Defaults to a local gateway on :4000
// (the normal "run the whole stack locally" flow). Set API_PROXY_TARGET to a remote gateway to
// point the local UI at another backend — e.g. API_PROXY_TARGET=http://198.244.141.77:4000 makes
// localhost:5173 talk to the LIVE server, so you see exactly what a logged-in live account sees
// without running the API/DB/Redis locally. changeOrigin rewrites the Host header to the target,
// which a remote gateway behind a vhost/proxy needs.
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? "http://localhost:4000";
const WS_PROXY_TARGET = API_PROXY_TARGET.replace(/^http/, "ws");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Pin to 5173 and fail loudly if it's taken, rather than silently drifting to 5174/5175.
    // OAuth callbacks and WEB_APP_URL assume 5173, so a drifted port breaks those flows — a
    // hard error tells you to kill the stale dev server instead of quietly landing elsewhere.
    strictPort: true,
    proxy: {
      "/api": { target: API_PROXY_TARGET, changeOrigin: true },
      // Real-time WebSocket (campaign progress, live insights). The frontend connects to
      // ws://<vite-host>/ws (useRealtime.ts), but the WS server lives on the gateway (:4000, path
      // "/ws" — websocketServer.ts). Without `ws: true` here, Vite doesn't forward the upgrade
      // request and the handshake TIMES OUT — which killed all live progress streaming (the
      // "WebSocket opening handshake timed out" console errors, and why campaign generation
      // appeared to hang/not update). Proxying the upgrade to :4000 restores the live stream.
      "/ws": { target: WS_PROXY_TARGET, ws: true, changeOrigin: true },
      // Serves blobs written by LocalFileObjectStorage (apps/api/src/infra/objectStorage.ts) —
      // Asset/Creative URLs are relative ("/objects/...") since the API doesn't know its own
      // public origin; proxying here keeps them resolvable in dev without hardcoding a host.
      "/objects": { target: API_PROXY_TARGET, changeOrigin: true },
    },
  },
});
