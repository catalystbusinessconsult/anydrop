/**
 * Full-screen takeover shown only for the very first connection attempt
 * (connectionState === "connecting") — later reconnects keep the normal
 * layout with its own small status pill instead, since by then the user
 * already has a peer list and context worth not yanking away.
 */
export function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="loading-screen__mark" aria-hidden>
        ⇄
      </div>
      <h1 className="loading-screen__name">Anydrop</h1>
      <div className="loading-screen__spinner" aria-hidden />
      <p className="loading-screen__status">Looking for devices on this network…</p>
    </div>
  );
}
