# Anydrop — Windows desktop app (Tauri)

Wraps the `/web` PWA in a native window, bundles the `/coordinator` service
as a sidecar, and adds a system tray icon, native Explorer drag-and-drop
(`dragDropEnabled` in `tauri.conf.json`), and auto-launch on boot
(`tauri-plugin-autostart`).

## Status: scaffolded, not build-verified

This environment has no Rust/Cargo toolchain installed, so none of
`src-tauri/` has been compiled or run. Everything here is structurally
correct against the documented Tauri v2 APIs (config schema, plugin APIs,
tray/menu builders) but needs a first real build to shake out the usual
"docs vs. actual API surface" mismatches. Before relying on it:

```bash
# 1. Install Rust: https://rustup.rs
# 2. From the repo root:
npm install
cargo install tauri-cli --version "^2"
```

## Building the coordinator sidecar

Tauri sidecars must be a single platform-specific executable — the config
(`tauri.conf.json` → `bundle.externalBin`) expects
`desktop/src-tauri/binaries/anydrop-coordinator-<target-triple>.exe` to exist
before `tauri build`/`tauri dev` runs. The coordinator itself is plain
TypeScript/Node (see `/coordinator`), so it needs a packaging step to become
that standalone binary — not yet wired up here. Two reasonable options:

1. **Bundle Node + the compiled JS** with a packager like
   [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) (an actively maintained
   fork of the archived `vercel/pkg`) — keeps the coordinator in TypeScript,
   adds a `pkg` build step and a larger sidecar binary (~40-80MB, bundled
   Node runtime).
2. **Port the coordinator to Go**, per the spec's explicit "Go is an
   acceptable swap" note — much smaller static binary, no bundled runtime,
   but means maintaining the signaling logic in two languages if the Node
   version stays canonical for testing.

Given the project is otherwise all TypeScript, option 1 is the lower-friction
default — pick it up as the next concrete step here.

## Local HTTPS (mkcert)

iOS Safari gates several PWA APIs (and secure-context requirements) behind
HTTPS. `mkcert` isn't installed in this environment either. Once on a
machine with it available:

```bash
mkcert -install
mkcert anydrop.local localhost 127.0.0.1
```

Point Vite's dev server config (`web/vite.config.ts`) at the resulting
`anydrop.local.pem` / `anydrop.local-key.pem` — left as plain HTTP for now
since it's simpler to iterate on before the Tauri/sidecar build is real.

## Tauri fs writer

`transfer-engine`'s `TauriFsWriter` (in
`transfer-engine/src/diskWriters/tauriFsWriter.ts`) is written against the
`@tauri-apps/plugin-fs` v2 API surface via an injected `openFile` function,
so it doesn't hard-depend on the plugin package at the transfer-engine
level. Wiring it up here means adding `@tauri-apps/plugin-fs` to
`web`'s dependencies (only reachable when running inside the Tauri webview,
where `window.__TAURI__` is defined) and passing its `open()` through to
`TauriFsWriter`'s constructor — not yet done, since it can't be exercised
without a real Tauri build to test against.
