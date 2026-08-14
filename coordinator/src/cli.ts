#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runElection } from "./election.js";

// Shares the mkcert cert pair generated for the web app (see
// web/vite.config.ts) rather than issuing its own — both need to present a
// cert for the same LAN IP/anydrop.local, and mkcert already trusts one CA
// for the whole machine.
function loadTls(): { cert: Buffer; key: Buffer } | undefined {
  if (process.env.ANYDROP_HTTPS !== "1") return undefined;
  const certsDir = fileURLToPath(new URL("../../web/certs/", import.meta.url));
  return {
    cert: readFileSync(`${certsDir}cert.pem`),
    key: readFileSync(`${certsDir}key.pem`),
  };
}

async function main() {
  const handle = await runElection({ tls: loadTls() });
  console.log(`[anydrop-coordinator] role=${handle.role()} epoch=${handle.currentEpoch()}`);

  const shutdown = async () => {
    console.log("[anydrop-coordinator] shutting down…");
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[anydrop-coordinator] fatal:", err);
  process.exit(1);
});
