const COORDINATOR_PORT = 47811;
const MANUAL_HOST_KEY = "cbc-lan-share:manualHost";

/**
 * Resolves the coordinator's WebSocket URL. Priority order:
 * 1. `?host=` query param (what a QR code shown on a laptop's screen encodes).
 * 2. A manually-entered host, remembered from a previous session.
 * 3. The default `cbcshare.local` mDNS hostname (relies on the OS-level
 *    mDNS resolver — Bonjour on macOS/iOS, built-in on Android/Windows).
 */
export function resolveCoordinatorUrl(secure: boolean): string {
  const params = new URLSearchParams(window.location.search);
  const fromQr = params.get("host");
  if (fromQr) {
    localStorage.setItem(MANUAL_HOST_KEY, fromQr);
  }
  const host = fromQr ?? localStorage.getItem(MANUAL_HOST_KEY) ?? "cbcshare.local";
  const protocol = secure ? "wss" : "ws";
  return `${protocol}://${host}:${COORDINATOR_PORT}`;
}

export function setManualHost(host: string): void {
  localStorage.setItem(MANUAL_HOST_KEY, host);
}

export function clearManualHost(): void {
  localStorage.removeItem(MANUAL_HOST_KEY);
}

/** What a laptop's "pair a phone" screen encodes into the QR code it displays. */
export function buildQrTargetUrl(appOrigin: string, lanHost: string): string {
  const url = new URL(appOrigin);
  url.searchParams.set("host", lanHost);
  return url.toString();
}
