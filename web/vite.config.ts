import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Local HTTPS (mkcert) is required for several PWA/File System APIs on iOS
// Safari — see root README "Local HTTPS" section for the one-time setup.
// This config assumes mkcert-issued certs at ./certs/cert.pem + key.pem
// when CBC_LAN_SHARE_HTTPS=1 is set; plain HTTP otherwise for quick dev.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // App-shell only: no offline queue for transfers, per project spec §Out of scope.
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg}"],
      },
      manifest: {
        name: "CBC LAN Share",
        short_name: "LAN Share",
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
  },
});
