import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { buildQrTargetUrl } from "../lib/discovery";

/**
 * Lets a laptop show a QR code a phone can scan to open this app already
 * pointed at the right coordinator — the spec's alternative to typing in
 * anydrop.local by hand. Normally only meaningful when this page itself
 * was loaded via a LAN-reachable address (a phone can't resolve
 * "localhost"), except in the Electron desktop app: that page always
 * loads over file:// (window.location.hostname is empty there), so
 * main.cjs passes two things explicitly instead — it runs its own
 * phone-facing HTTPS static server the desktop window itself doesn't use
 * (see startPhoneServer in desktop/electron/main.cjs):
 *   ?qrOrigin — where the phone fetches the UI from (always *this*
 *     laptop's own address, since that's the server actually running).
 *   ?qrHost — the coordinator's real address to embed as `?host=` in the
 *     QR link, which is NOT always the same laptop: if this instance
 *     joined another laptop's coordinator as a client, the phone still
 *     needs to be pointed at that other laptop, not this one.
 *   ?caUrl — plain-HTTP address of our CA certificate, shown as a
 *     first-time setup step. Laptops verify each other's certificates
 *     in-app (installCertificateVerifier in main.cjs), but a phone
 *     browser does its own validation and can't be taught that, so it
 *     genuinely needs the CA installed once. Without it the phone gets a
 *     warning on the page and — worse, because there's nothing to tap
 *     through — a silently dead WebSocket that just reads as "Offline".
 */
const QR_OPTIONS = { width: 240, margin: 1, color: { dark: "#0f172a", light: "#f8fafc" } } as const;

export function QrPairingPanel() {
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [caDataUrl, setCaDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const qrOrigin = params.get("qrOrigin");
  const qrHost = params.get("qrHost");
  const caUrl = params.get("caUrl");
  const hostname = qrOrigin ? (qrHost ?? new URL(qrOrigin).hostname) : window.location.hostname;
  const isLanReachable = qrOrigin != null || (hostname !== "localhost" && hostname !== "127.0.0.1");

  useEffect(() => {
    if (!open || !isLanReachable) return;
    setError(false);
    const target = buildQrTargetUrl(qrOrigin ?? window.location.origin, hostname);
    QRCode.toDataURL(target, QR_OPTIONS)
      .then(setDataUrl)
      .catch((err) => {
        console.error("failed to generate QR code:", err);
        setError(true);
      });
  }, [open, isLanReachable, hostname, qrOrigin]);

  useEffect(() => {
    if (!open || !caUrl) return;
    QRCode.toDataURL(caUrl, QR_OPTIONS)
      .then(setCaDataUrl)
      .catch((err) => console.error("failed to generate CA QR code:", err));
  }, [open, caUrl]);

  return (
    <section className="qr-pairing">
      <button className="qr-pairing__toggle button--secondary" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide phone pairing code" : "📱 Pair a phone"}
      </button>
      {open && (
        <div className="qr-pairing__panel">
          {!isLanReachable && (
            <p className="qr-pairing__note">
              Open this app via your laptop's network address (not "localhost") for the code to work from a phone.
            </p>
          )}
          {isLanReachable && error && <p className="qr-pairing__note">Couldn't generate a QR code.</p>}
          {isLanReachable && dataUrl && (
            <>
              <img className="qr-pairing__image" src={dataUrl} alt="QR code to open Anydrop on a phone" width={180} height={180} />
              <p className="qr-pairing__hint">Scan with a phone on the same wifi.</p>
            </>
          )}
          {caDataUrl && (
            <details className="qr-pairing__setup">
              <summary>First time on this phone? Install the certificate</summary>
              <img
                className="qr-pairing__image"
                src={caDataUrl}
                alt="QR code to download the Anydrop certificate"
                width={140}
                height={140}
              />
              <p className="qr-pairing__hint">
                Scan this first and install the downloaded file. On iPhone: Settings → Profile Downloaded → Install, then
                Settings → General → About → Certificate Trust Settings and switch Anydrop on. On Android: Settings →
                Security → Install a certificate → CA certificate. Only needed once per phone.
              </p>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
