import { useEffect, useState } from "react";

type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "downloading"; version?: string; percent?: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string }
  | { state: "unavailable" };

interface AnydropDesktopBridge {
  checkForUpdates: () => Promise<void>;
  restartToUpdate: () => Promise<void>;
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
}

declare global {
  interface Window {
    anydropDesktop?: AnydropDesktopBridge;
  }
}

/**
 * Manual "Check for updates" control — the desktop app already checks
 * silently on every launch (see setupAutoUpdater in main.cjs), but a
 * laptop that's kept open for days/weeks would otherwise only pick up a
 * new release the next time it happens to restart. Only rendered inside
 * the Electron app: `window.anydropDesktop` is undefined in a plain
 * browser tab (phones, or the laptop's own browser), where there's no
 * app bundle for electron-updater to update in the first place.
 */
export function UpdateButton() {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });

  useEffect(() => {
    if (!window.anydropDesktop) return;
    return window.anydropDesktop.onUpdateStatus(setStatus);
  }, []);

  if (!window.anydropDesktop) return null;

  const busy = status.state === "checking" || status.state === "downloading";

  return (
    <div className="update-button">
      {status.state === "downloaded" ? (
        <button className="button--primary" onClick={() => window.anydropDesktop!.restartToUpdate()}>
          Restart to install {status.version}
        </button>
      ) : (
        <button className="button--secondary" disabled={busy} onClick={() => window.anydropDesktop!.checkForUpdates()}>
          {status.state === "checking" && "Checking…"}
          {status.state === "downloading" && `Downloading update${status.percent != null ? ` (${status.percent}%)` : "…"}`}
          {(status.state === "idle" || status.state === "up-to-date" || status.state === "error" || status.state === "unavailable") &&
            "Check for updates"}
        </button>
      )}
      {status.state === "up-to-date" && <p className="update-button__hint">You're on the latest version.</p>}
      {status.state === "error" && <p className="update-button__hint">Couldn't check for updates: {status.message}</p>}
    </div>
  );
}
