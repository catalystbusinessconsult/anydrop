import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { buildQrTargetUrl } from "../lib/discovery";

/**
 * Lets a laptop show a QR code a phone can scan to open this app already
 * pointed at the right coordinator — the spec's alternative to typing in
 * cbcshare.local by hand. Only meaningful when this page itself was loaded
 * via a LAN-reachable address (a phone can't resolve "localhost").
 */
export function QrPairingPanel() {
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const hostname = window.location.hostname;
  const isLanReachable = hostname !== "localhost" && hostname !== "127.0.0.1";

  useEffect(() => {
    if (!open || !isLanReachable) return;
    setError(false);
    const target = buildQrTargetUrl(window.location.origin, hostname);
    QRCode.toDataURL(target, { width: 240, margin: 1, color: { dark: "#0f172a", light: "#f8fafc" } })
      .then(setDataUrl)
      .catch((err) => {
        console.error("failed to generate QR code:", err);
        setError(true);
      });
  }, [open, isLanReachable, hostname]);

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
              <img className="qr-pairing__image" src={dataUrl} alt="QR code to open CBC LAN Share on a phone" width={180} height={180} />
              <p className="qr-pairing__hint">Scan with a phone on the same wifi.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
