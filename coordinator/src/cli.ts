#!/usr/bin/env node
import { runElection } from "./election.js";

async function main() {
  const handle = await runElection();
  console.log(`[cbc-coordinator] role=${handle.role()} epoch=${handle.currentEpoch()}`);

  const shutdown = async () => {
    console.log("[cbc-coordinator] shutting down…");
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[cbc-coordinator] fatal:", err);
  process.exit(1);
});
