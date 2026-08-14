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

That said, "runs in the main process" isn't quite "no packaging step" —
the coordinator imports real npm packages (`ws`, `bonjour-service`), and a
packaged Electron app's `resources/` folder has no `node_modules` at all
(this bit us: the first installer built from this project ran fine in
every test *inside* the monorepo, where Node's module resolution could
still walk up to the hoisted root `node_modules` — and then failed
immediately on a machine where the app was actually installed, with no
such fallback to find). The fix, same as for `main.cjs` itself: esbuild
bundles both into single dependency-free files (`bundle:main`,
`bundle:coordinator`) before packaging, so nothing in `electron/` ever
needs an external `node_modules` to run.

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

`npm start` bundles `coordinator/dist/index.js` into a standalone
`electron/coordinator.bundle.cjs` first (esbuild — see "Why Electron over
Tauri" below for why this step exists at all), then `electron/main.cjs`
starts it via `require(...).runElection()` and points the window at
`web/dist/index.html?host=...` — the same `?host=` query-param mechanism
the QR-pairing flow uses for phones (`web/src/lib/discovery.ts`), pointed
at whichever address is actually running the coordinator (itself, or
another laptop — see `coordinatorHost()` in `coordinator/src/election.ts`).

## Local HTTPS (mkcert)

The coordinator only speaks `wss://` now (TLS-only), since phones need it
and running two coordinators — one plain, one TLS — would split the peer
list. `main.cjs` reads the same cert pair the web dev server uses, from
`web/certs/cert.pem` / `key.pem`.

**These two files are committed to the repo** (an intentional exception
to the general `*.pem` gitignore rule) — this is a private office-LAN
tool, not internet-facing, and sharing one identity across every laptop
and the CI build means nobody has to generate or copy certs by hand.

### How laptops trust it (no per-machine setup)

Serving that identity is only half of it — the other end has to *trust*
it. The app does that itself, in `installCertificateVerifier`
(`electron/main.cjs`): for private/loopback hosts only, it verifies the
presented certificate was genuinely signed by
`web/public/anydrop-root-ca.pem` (a real signature check against the CA's
public key via `node:crypto`'s `X509Certificate`, plus a validity-window
check) and trusts it on that basis. Anything else defers to Chromium's
normal verification, so ordinary web traffic is untouched.

Two things fall out of that, and both were real recurring failures before:

- **No `certutil` step per laptop.** Trust used to depend on each machine
  having our CA in its Windows store, which realistically only ever
  happened on the machine that ran `mkcert -install`. Every other laptop
  showed a permanent "Offline" that looked exactly like a network fault.
- **The cert's SAN list no longer has to cover every laptop.** Hostname
  matching is deliberately not part of the check, so a coordinator on a
  fresh DHCP address works without reissuing anything. Chasing new IPs
  into the SAN list was a losing game — the client connects to whichever
  laptop won the election, so *any* new machine could break it.

The SAN list still matters for **phones**, which use a real browser doing
real hostname validation and can't be taught our verification logic — so
keep the coordinator laptops' addresses listed, and expect phones to
install the CA once (see "Phone pairing" below):

```bash
mkcert -install   # only needed on a machine that generates certs
mkcert -cert-file web/certs/cert.pem -key-file web/certs/key.pem <laptop-LAN-IPs...> anydrop.local localhost 127.0.0.1 ::1
```

`web/public/anydrop-root-ca.pem` is committed too (same blanket `*.pem`
ignore rule caught it for several releases, so CI-built installers
shipped without it and only local builds worked — worth remembering if
trust ever silently regresses).

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

Phones are the one case still bound to the cert's SAN list and to
installing the CA by hand — a phone browser does its own hostname
validation and can't use `installCertificateVerifier`. Laptop-to-laptop
connections have no such constraint.

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

Runs `bundle:main` + `bundle:coordinator` (esbuild) then
`electron-builder --win` (NSIS installer target). `extraResources` copies
only `web/dist` and `web/certs` into the packaged app's `resources/`
folder — `main.cjs` and the coordinator don't need this treatment since
they're the bundled, dependency-free files described above, always
sitting right next to each other in `electron/` in both dev and packaged
builds, so no `app.isPackaged` path-branching is needed for either.

A few packaging quirks worth knowing if this ever needs touching again:
- **`npmRebuild: false`** — electron-builder's dependency-install step
  doesn't understand npm workspace hoisting and would otherwise try to
  `npm install` fresh into `desktop/`, repeatedly deleting its own
  `app-builder-bin` helper mid-build in the process.
- **`asar: false`** — avoids any ambiguity around dynamic `require()`/
  `import()` reaching into an asar archive for the bundled files; not
  needed for a private internal tool anyway.
- **`signAndEditExecutable`/`verifyUpdateCodeSignature: false`** plus
  `CSC_IDENTITY_AUTO_DISCOVERY=false` (baked into the `dist` script via
  `cross-env`) — without these, electron-builder tries to fetch macOS
  code-signing tools even for an unsigned Windows build, and fails
  extracting them (needs a Windows privilege — symlink creation — this
  environment doesn't have).

This is what CI runs too (plus `--publish always`) — running it locally
is only for testing the installer itself, not for shipping an update.

Not yet done: auto-launch-on-boot / system tray, scoped out of this pass
to get a working window + embedded coordinator + auto-update landed
first.
