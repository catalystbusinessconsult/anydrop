import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Local HTTPS (mkcert) is required for the Web Crypto API (crypto.subtle,
// crypto.randomUUID) to work at all when the app is loaded from a LAN
// address instead of localhost — browsers only expose those APIs in a
// secure context. See root README "Local HTTPS" section for the one-time
// setup. Assumes mkcert-issued certs at ./certs/cert.pem + key.pem when
// ANYDROP_HTTPS=1 is set; plain HTTP otherwise for quick dev.
const useHttps = process.env.ANYDROP_HTTPS === "1";

export default defineConfig({
  // Relative asset paths — required for the built bundle to load correctly
  // over file:// (the Electron desktop app), where absolute "/assets/..."
  // paths resolve against the filesystem root instead of the app bundle.
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // App-shell only: no offline queue for transfers, per project spec §Out of scope.
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg}"],
      },
      manifest: {
        name: "Anydrop",
        short_name: "Anydrop",
        description: "Peer-to-peer local file transfer for the CBC Africa office LAN",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    https: useHttps
      ? {
          cert: readFileSync(new URL("./certs/cert.pem", import.meta.url)),
          key: readFileSync(new URL("./certs/key.pem", import.meta.url)),
        }
      : undefined,
  },
});
