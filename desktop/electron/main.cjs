const { app, BrowserWindow, ipcMain, session } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("node:path");
const fs = require("node:fs");
const https = require("node:https");
const { X509Certificate } = require("node:crypto");

// In dev, web/certs live in the sibling workspace packages' own dist/
// output. In a packaged build, electron-builder copies those into
// resources/ instead (see package.json "build.extraResources") — a
// packaged app can't reach sibling workspace packages the way dev mode
// does. The coordinator doesn't need this branch at all: it's bundled
// (via esbuild, see package.json "bundle:coordinator") into a single
// dependency-free file that always sits right next to this one, in dev
// and packaged alike — that bundling is what actually matters here, since
// the coordinator imports real npm packages (ws, bonjour-service) that
// simply aren't present anywhere in a packaged app's resources otherwise.
const resourcesRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "..");
const coordinatorBundlePath = path.join(__dirname, "coordinator.bundle.cjs");
const webDistDir = app.isPackaged ? path.join(resourcesRoot, "web") : path.join(resourcesRoot, "web", "dist");
const webIndexHtml = path.join(webDistDir, "index.html");
const certsDir = app.isPackaged ? path.join(resourcesRoot, "certs") : path.join(resourcesRoot, "web", "certs");
const iconPath = path.join(__dirname, "..", "assets", "icon.png");
// Shipped as part of web/dist (vite copies web/public/* verbatim), so the
// same path resolution works packaged and in dev.
const rootCaPath = path.join(webDistDir, "anydrop-root-ca.pem");

const PHONE_SERVER_PORT = 5173;

let coordinatorHandle = null;
let phoneServer = null;
let win = null;
let lanOrigin = null; // e.g. "https://192.168.100.11:5173" — where a phone's QR code fetches the UI from (always *this* laptop)
let qrCoordinatorHost = null; // the coordinator's real address for the QR to embed — this laptop's own IP if it won the election, otherwise whichever laptop actually did

async function startCoordinator(tls) {
  const { runElection } = require(coordinatorBundlePath);
  coordinatorHandle = await runElection({
    tls,
    logger: console,
    // A client that finds no coordinator at startup (neither the initial
    // probe nor its own failed bind-and-recheck) ends up with
    // coordinatorHost() === null, and the window it's already showing
    // stays pointed at whatever createWindow() picked at that one moment
    // — this is what lets it notice a coordinator appearing *later* (the
    // ongoing mDNS watch keeps running regardless) and reconnect, instead
    // of sitting offline until the app happens to be restarted.
    onHostChange: (host) => {
      console.log(`[anydrop-desktop] coordinator host changed: ${host ?? "(none)"}`);
      win?.webContents.send("coordinator-host-changed", host);
    },
  });
  console.log(`[anydrop-desktop] coordinator role=${coordinatorHandle.role()} epoch=${coordinatorHandle.currentEpoch()}`);
}

/**
 * Trust a coordinator's TLS certificate based on *who signed it*, rather
 * than on the OS certificate store — which is what made this whole thing
 * so fragile before.
 *
 * The old model needed two things to line up on every single machine:
 * an elevated `certutil -addstore` run to trust our CA (which realistically
 * only ever happened on the machine that generated it), and the winning
 * coordinator's current IP to already be listed in the cert's SAN (which
 * DHCP and every newly-added laptop invalidate). Miss either and the app
 * shows "Offline" forever, with the failure looking identical to a network
 * problem.
 *
 * Since both ends of this connection are our own app on a private LAN, the
 * app can verify the chain itself: check the presented cert was genuinely
 * signed by our CA (a real signature check against the CA's public key,
 * not a name or fingerprint comparison), is currently in its validity
 * window, and that we're talking to a private/loopback address. Hostname
 * matching is deliberately not part of that — it's precisely the SAN
 * coupling we're removing, and it isn't carrying weight here anyway: the
 * signature proves the peer holds a key our CA signed, and the coordinator
 * itself only relays SDP (docs/security.md — transfer authorisation is the
 * pairing PIN, and the server independently refuses non-private remotes).
 *
 * Anything not matching all of that falls through to Chromium's normal
 * verification, so ordinary web traffic is unaffected.
 */
function installCertificateVerifier() {
  let caPublicKey = null;
  try {
    caPublicKey = new X509Certificate(fs.readFileSync(rootCaPath)).publicKey;
  } catch (err) {
    console.error(`[anydrop-desktop] no root CA at ${rootCaPath} — falling back to OS trust store:`, err.message);
    return;
  }

  const { isPrivateOrLoopbackIPv4 } = require(coordinatorBundlePath);
  const isLanHost = (hostname) =>
    hostname === "localhost" || hostname === "anydrop.local" || hostname === "::1" || isPrivateOrLoopbackIPv4(hostname);

  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    // 0 = trust, -3 = defer to Chromium's own result.
    if (!isLanHost(request.hostname)) return callback(-3);
    try {
      const leaf = new X509Certificate(request.certificate.data);
      const now = Date.now();
      const signedByOurCa = leaf.verify(caPublicKey);
      const inValidityWindow = new Date(leaf.validFrom).getTime() <= now && now <= new Date(leaf.validTo).getTime();
      if (signedByOurCa && inValidityWindow) {
        console.log(`[anydrop-desktop] trusted ${request.hostname} via Anydrop CA`);
        return callback(0);
      }
      console.warn(
        `[anydrop-desktop] ${request.hostname} not trusted via Anydrop CA ` +
          `(signed=${signedByOurCa}, valid=${inValidityWindow}) — deferring to OS trust store`,
      );
    } catch (err) {
      console.error("[anydrop-desktop] certificate verification errored:", err.message);
    }
    return callback(-3);
  });
}

function sendUpdateStatus(status) {
  win?.webContents.send("update-status", status);
}

// Wires electron-updater's events to both the log (diagnosable from a
// packaged app with no visible DevTools) and the renderer (the "Check for
// updates" button's status text) — registered once, driving both the
// silent startup check and any later on-demand check from the button.
function setupAutoUpdater() {
  // The repo is private, so the public releases.atom feed 404s for an
  // unauthenticated request — electron-updater's GitHub provider reads
  // GH_TOKEN when build.publish.private is set (package.json), same
  // convention electron-builder's own CI publish step already uses.
  // ANYDROP_UPDATE_TOKEN is inlined at build time (desktop/scripts/
  // bundle-main.cjs via esbuild's define) from a fine-grained PAT scoped
  // read-only to this one repo — it's never in source or git history, but
  // is extractable from the shipped .exe by design/acceptance.
  if (process.env.ANYDROP_UPDATE_TOKEN) process.env.GH_TOKEN = process.env.ANYDROP_UPDATE_TOKEN;
  autoUpdater.logger = console;
  autoUpdater.on("checking-for-update", () => sendUpdateStatus({ state: "checking" }));
  autoUpdater.on("update-available", (info) => sendUpdateStatus({ state: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("update-not-available", () => sendUpdateStatus({ state: "up-to-date" }));
  autoUpdater.on("download-progress", (p) => sendUpdateStatus({ state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[anydrop-desktop] update ${info.version} downloaded — ready to restart`);
    sendUpdateStatus({ state: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    console.error("[anydrop-desktop] update check failed:", err);
    sendUpdateStatus({ state: "error", message: err.message });
  });
}

ipcMain.handle("check-for-updates", async () => {
  if (!app.isPackaged) {
    sendUpdateStatus({ state: "unavailable" });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // Already reported to the renderer via the "error" listener above —
    // caught here only so the IPC call itself doesn't reject/log twice.
  }
});

ipcMain.handle("restart-to-update", () => {
  autoUpdater.quitAndInstall();
});

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".pem": "application/x-x509-ca-cert",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

// Serves the same built web app the desktop window itself loads (over
// file://), but over https:// on the LAN — this is what a phone's browser
// actually connects to. The desktop window doesn't need this server for
// itself; it exists purely so "Pair a phone" has something real to point
// a QR code at (see QrPairingPanel.tsx, which now trusts an explicit
// `?qrOrigin=` param instead of window.location, since that's meaningless
// under file://).
function startPhoneServer(tls) {
  const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const resolved = path.normalize(path.join(webDistDir, relative));
    if (!resolved.startsWith(webDistDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(resolved)] ?? "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PHONE_SERVER_PORT, "0.0.0.0", () => resolve(server));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 760,
    title: "Anydrop",
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // Renderer console/errors don't reach the main-process terminal by
  // default, and a packaged app has no visible DevTools — forward them so
  // a blank/broken window is diagnosable from logs alone.
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on("did-fail-load", (_e, code, description) => {
    console.error(`[renderer] failed to load: ${description} (${code})`);
  });

  // ?host points this window at the actual coordinator — "localhost" if
  // this instance won the election, or the discovered coordinator's real
  // address if it joined an existing one on another laptop as a client
  // (see coordinatorHost() in coordinator/src/election.ts; a client runs
  // no server of its own, so "localhost" would just connect to nothing).
  // ?qrOrigin/?qrHost tell QrPairingPanel what to encode in the QR code —
  // window.location is meaningless for that under file://, and the QR
  // must always point at a real LAN address, never "localhost".
  const query = { host: coordinatorHandle?.coordinatorHost() ?? "localhost" };
  if (lanOrigin) query.qrOrigin = lanOrigin;
  if (qrCoordinatorHost) query.qrHost = qrCoordinatorHost;
  win.loadFile(webIndexHtml, { query });
}

app.whenReady().then(async () => {
  // Must run before the window opens its WebSocket to a coordinator —
  // this is what lets a laptop trust another laptop's coordinator without
  // anyone having installed our CA into that machine's OS trust store.
  installCertificateVerifier();

  try {
    const tls = {
      cert: fs.readFileSync(path.join(certsDir, "cert.pem")),
      key: fs.readFileSync(path.join(certsDir, "key.pem")),
    };
    // Runs TLS-only, same as `ANYDROP_HTTPS=1 npm run dev` in coordinator/
    // — the desktop window itself needs wss:// since file:// is treated as
    // a secure context (see App.tsx), and phones on the LAN need TLS
    // regardless of how the desktop window loads.
    await startCoordinator(tls);
    phoneServer = await startPhoneServer(tls);

    const { listLanAddresses } = require(coordinatorBundlePath);
    const [lanIp] = listLanAddresses();
    if (lanIp) {
      lanOrigin = `https://${lanIp}:${PHONE_SERVER_PORT}`;
      // Own IP if this instance is the coordinator; otherwise
      // coordinatorHost() already holds the *other* laptop's real address
      // (never "localhost" in the client branch — see election.ts).
      qrCoordinatorHost = coordinatorHandle.role() === "coordinator" ? lanIp : coordinatorHandle.coordinatorHost();
    } else {
      console.warn("[anydrop-desktop] no LAN address found — phone pairing QR code will be unavailable");
    }
  } catch (err) {
    console.error("[anydrop-desktop] startup failed:", err);
  }
  createWindow();

  // Checks GitHub Releases (see build.publish in package.json) for a newer
  // version, downloads it in the background if found, and installs it the
  // next time the app quits/relaunches — same setupAutoUpdater() a click
  // on "Check for updates" in the UI later triggers on demand. Only makes
  // sense for a real installed build: electron-updater no-ops in dev (no
  // install directory to update), and there's nothing published to check
  // yet until a release actually gets built — see desktop/README.md for
  // what publishing one requires.
  if (app.isPackaged) {
    setupAutoUpdater();
    autoUpdater.checkForUpdates().catch((err) => console.error("[anydrop-desktop] update check failed:", err));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  if (coordinatorHandle) await coordinatorHandle.stop();
  if (phoneServer) await new Promise((resolve) => phoneServer.close(resolve));
  if (process.platform !== "darwin") app.quit();
});
