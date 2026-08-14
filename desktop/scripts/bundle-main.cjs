// Bundles electron/main.cjs via esbuild's JS API rather than its CLI, so
// the update-check token can be inlined via Node's own process.env (which
// works identically regardless of which shell launched this — the CLI
// equivalent needs $VAR vs %VAR% depending on shell, breaking across
// local Windows dev (cmd.exe) vs GitHub Actions (PowerShell) vs anyone on
// bash). The token itself never appears in source or npm scripts, only in
// this script's own env lookup, and the bundled output is gitignored.
const esbuild = require("esbuild");
const path = require("node:path");

const token = process.env.ANYDROP_UPDATE_TOKEN ?? "";

esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "electron", "main.cjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  define: {
    "process.env.ANYDROP_UPDATE_TOKEN": JSON.stringify(token),
  },
  outfile: path.join(__dirname, "..", "electron", "main.bundle.cjs"),
});

console.log(`bundled main.cjs${token ? " (update token embedded)" : " (no ANYDROP_UPDATE_TOKEN set — auto-update will fail against the private repo)"}`);
