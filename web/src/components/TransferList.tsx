export interface TransferRecord {
  fileId: string;
  fileName: string;
  direction: "send" | "receive";
  peerNickname: string;
  bytesTransferred: number;
  totalBytes: number;
  status: "in-progress" | "complete" | "error" | "rejected" | "cancelled";
  message?: string;
}

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

export function TransferList({ transfers, onCancel }: { transfers: TransferRecord[]; onCancel: (fileId: string) => void }) {
  if (transfers.length === 0) return null;

  return (
    <ul className="transfer-list">
      {transfers.map((t) => {
        const pct = t.totalBytes > 0 ? Math.round((t.bytesTransferred / t.totalBytes) * 100) : 0;
        return (
          <li key={t.fileId} className={`transfer-row transfer-row--${t.status}`}>
            <div className="transfer-row__head">
              <span className="transfer-row__direction" aria-hidden>
                {t.direction === "send" ? "↑" : "↓"}
              </span>
              <span className="transfer-row__name">{t.fileName}</span>
              <span className="transfer-row__peer">{t.peerNickname}</span>
              {t.status === "in-progress" && (
                <button className="transfer-row__cancel" onClick={() => onCancel(t.fileId)} aria-label="Cancel transfer">
                  Cancel
                </button>
              )}
            </div>
            <div className="transfer-row__bar">
              <div className="transfer-row__bar-fill" style={{ width: `${t.status === "complete" ? 100 : pct}%` }} />
            </div>
            <div className="transfer-row__status">
              {t.status === "in-progress" && `${formatBytes(t.bytesTransferred)} / ${formatBytes(t.totalBytes)}`}
              {t.status === "complete" && "Done"}
              {t.status === "error" && `Failed: ${t.message ?? "unknown error"}`}
              {t.status === "rejected" && "Rejected"}
              {t.status === "cancelled" && "Cancelled"}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
