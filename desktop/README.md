# Anydrop — Windows desktop app (Electron)

Wraps the `/web` PWA in a native window and runs the `/coordinator` service
directly in the Electron main process — no sidecar binary, no packaging
step for the coordinator, since Electron's main process already is Node.

## Why Electron over Tauri

This project originally scaffolded a Tauri wrapper, but Tauri needs a
Rust + MSVC toolchain (a multi-GB install) before anything compiles, and
still requires packaging the TypeScript coordinator into a standalone
sidecar executable — a real decision (bundle Node via `pkg`, or port to Go)
that was never made. Electron needs neither: it's pure npm, and the
coordinator runs as plain Node code in the main process.

It also sidesteps the HTTPS fight entirely from the app's own point of
view — pages loaded over `file://` are treated as a secure context by
Chromium, so `crypto.subtle`/`crypto.randomUUID` (needed for file hashing
and device IDs, see root README) work with no cert setup for the desktop
window itself. TLS is still required on the coordinator's WebSocket server
because *phones* on the LAN connect to it over `https://`/`wss://` (see
"Local HTTPS" below) — the desktop app just happens to get that for free
rather than needing its own separate setup.

## Running in dev

```bash
# from the repo root
npm run build -w coordinator -w web   # compile both to dist/
npm start -w desktop                  # launches the Electron window
```

`electron/main.cjs` starts the coordinator via `runElection()` (imported
directly from `coordinator/dist/index.js`) and points the window at
`web/dist/index.html?host=localhost` — the same `?host=` query-param
mechanism the QR-pairing flow uses for phones (`web/src/lib/discovery.ts`),
just fixed to `localhost` since the desktop app and coordinator are always
the same machine.

## Local HTTPS (mkcert)

The coordinator only speaks `wss://` now (TLS-only), since phones need it
and running two coordinators — one plain, one TLS — would split the peer
list. `main.cjs` reads the same cert pair the web dev server uses, from
`web/certs/cert.pem` / `key.pem`.

**These two files are committed to the repo** (an intentional exception
to the general `*.pem` gitignore rule) — this is a private office-LAN
tool, not internet-facing, and sharing one identity across every laptop
and the CI build means nobody has to generate or copy certs by hand.

That alone only covers *serving* the identity, though — connecting to it
without a browser/OS security warning also requires *trusting* it, which
is a separate, per-machine step (installing a cert doesn't install trust
in it). Every laptop running the app — not just the one that generated
these files — needs the CA that signed them added to its OS trust store
once:

```powershell
# from an elevated PowerShell, once per laptop
certutil -addstore -f "ROOT" web\public\anydrop-root-ca.pem
```

(`web/public/anydrop-root-ca.pem` is the same CA file phones download and
install when pairing — see the root README's phone-pairing notes.)

**Any laptop whose LAN IP isn't in the cert's SAN list will fail TLS
validation as soon as it tries to become the coordinator** — connections
use the real discovered IP (`election.ts`'s `coordinatorHost()`), not the
`anydrop.local` hostname, so that SAN entry doesn't actually cover a
DHCP-assigned address it wasn't issued for. This has already bitten us
once this session (see the root README's verification notes) and isn't
fully solved yet — the durable fix is either a DHCP reservation per
laptop (so addresses stop drifting) or moving to per-machine dynamic
cert generation at first run. For now, regenerate and recommit whenever
a laptop's actual address isn't already listed:

```bash
mkcert -install
mkcert -cert-file web/certs/cert.pem -key-file web/certs/key.pem <every-laptop-LAN-IP...> anydrop.local localhost 127.0.0.1 ::1
```

## Phone pairing (QR code)

The desktop window loads over `file://`, where `window.location.hostname`
is empty — so `QrPairingPanel` can't infer a LAN address to encode the way
it does for a phone-visited browser tab. `main.cjs` runs a *second* HTTPS
server (`startPhoneServer`, port 5173, same certs as the coordinator) that
serves the same built `web/dist` bundle on the LAN, purely so a phone has
something real to load — the desktop window itself never talks to it.
`createWindow()` passes the LAN IP (`listLanAddresses()`, reused from
`@anydrop/coordinator`) to the page as `?qrOrigin=`, which
`QrPairingPanel.tsx` prefers over `window.location` when present.

Regenerate `web/certs/` (see "Local HTTPS" above) whenever the LAN IP
changes — both this phone server and the coordinator's TLS listener are
bound to whatever address the cert was issued for.

## App icon

`desktop/assets/icon.ico` / `icon.png` are generated from
`web/public/icon.svg` — regenerate after changing the logo with:

```bash
cd .tools/icon-gen && npm install && node generate.cjs
```

(A one-off local script using `sharp` + `png-to-ico`, kept outside the
main dependency tree since it's only needed when the logo changes, not on
every build.) `icon.png` sets the window/taskbar icon at runtime
(`BrowserWindow`'s `icon` option); `icon.ico` is what electron-builder
embeds in the installer and `.exe` itself (`build.win.icon`).

## Auto-update

Wired via `electron-updater` (`desktop/electron/main.cjs`), pointed at
this repo's GitHub Releases (`build.publish` in `package.json`). On every
launch of a *packaged* build, it checks for a newer published release,
downloads it in the background if found, and installs it on the next
restart — no prompt, no button.

`.github/workflows/release-desktop.yml` is the other half: it builds the
Windows installer and publishes it as a GitHub Release automatically on
every push to `main` that touches app code, using GitHub's own built-in
`GITHUB_TOKEN` — no personal access token or manual `electron-builder
--publish` needed. The release version is `0.1.<CI run number>`, so each
one is guaranteed newer than the last without a version bump commit.

**What this means in practice:** each laptop needs the installer run
*once* manually (download the `.exe` from the repo's Releases page, run
it) — after that, every push to `main` reaches it automatically within
one restart, with no further action on any laptop.

One thing to check if the first CI publish fails with a permissions
error: repo **Settings → Actions → General → Workflow permissions** needs
"Read and write permissions" enabled — some orgs default this to
read-only, which would block the release step from creating anything
despite the `permissions: contents: write` already set in the workflow.

## Packaging a real .exe locally

```bash
npm run dist -w desktop
```

Runs `electron-builder --win` (NSIS installer target). `extraResources`
copies `coordinator/dist`, `web/dist`, and `web/certs` into the packaged
app's `resources/` folder, since asar-packed app code can't `require()` a
sibling workspace package the way dev mode does — `main.cjs` branches on
`app.isPackaged` to read from the right location either way. This is what
CI runs too (plus `--publish always`) — running it locally is only for
testing the installer itself, not for shipping an update.

Not yet done: auto-launch-on-boot / system tray, scoped out of this pass
to get a working window + embedded coordinator + auto-update landed
first.
