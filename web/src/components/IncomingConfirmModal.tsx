import type { FileMeta } from "@cbc-lan-share/transfer-engine";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function IncomingConfirmModal({
  meta,
  onDecision,
}: {
  meta: FileMeta;
  onDecision: (accept: boolean) => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Incoming file</h2>
        <p className="incoming-file__name">{meta.name}</p>
        <p className="incoming-file__meta">
          {formatBytes(meta.size)} · {meta.mimeType || "unknown type"}
        </p>
        <div className="modal__actions">
          <button className="button--secondary" onClick={() => onDecision(false)}>
            Reject
          </button>
          <button className="button--primary" onClick={() => onDecision(true)}>
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
