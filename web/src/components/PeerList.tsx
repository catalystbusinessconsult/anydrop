import { useRef, type DragEvent } from "react";
import type { PeerInfo } from "../lib/coordinatorClient";

export function PeerList({
  peers,
  onPickFilesFor,
  onDropFilesFor,
  busyPeerIds,
}: {
  peers: PeerInfo[];
  onPickFilesFor: (peer: PeerInfo, files: File[]) => void;
  onDropFilesFor: (peer: PeerInfo, files: File[]) => void;
  busyPeerIds: Set<string>;
}) {
  if (peers.length === 0) {
    return <p className="empty-state">No other devices found on this network yet.</p>;
  }

  return (
    <ul className="peer-list">
      {peers.map((peer) => (
        <PeerTile
          key={peer.deviceId}
          peer={peer}
          busy={busyPeerIds.has(peer.deviceId)}
          onPickFiles={(files) => onPickFilesFor(peer, files)}
          onDropFiles={(files) => onDropFilesFor(peer, files)}
        />
      ))}
    </ul>
  );
}

function PeerTile({
  peer,
  busy,
  onPickFiles,
  onDropFiles,
}: {
  peer: PeerInfo;
  busy: boolean;
  onPickFiles: (files: File[]) => void;
  onDropFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(ev: DragEvent<HTMLLIElement>) {
    ev.preventDefault();
    const files = [...ev.dataTransfer.files];
    if (files.length) onDropFiles(files);
  }

  return (
    <li
      className={`peer-tile ${busy ? "peer-tile--busy" : ""}`}
      style={{ "--avatar-hue": avatarHue(peer.deviceId) } as React.CSSProperties}
      onDragOver={(ev) => ev.preventDefault()}
      onDrop={handleDrop}
      onClick={() => !busy && inputRef.current?.click()}
    >
      <span className="peer-tile__avatar" aria-hidden>
        {peer.deviceType === "phone" ? "📱" : "💻"}
      </span>
      <span className="peer-tile__name">{peer.nickname}</span>
      <span className="peer-tile__hint">{busy ? "sending…" : "click or drop files"}</span>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="peer-tile__file-input"
        onChange={(ev) => {
          const files = [...(ev.target.files ?? [])];
          if (files.length) onPickFiles(files);
          ev.target.value = "";
        }}
      />
    </li>
  );
}

/** Stable per-device hue so each peer's avatar reads as a distinct "color identity". */
function avatarHue(deviceId: string): number {
  let hash = 0;
  for (let i = 0; i < deviceId.length; i++) hash = (hash * 31 + deviceId.charCodeAt(i)) >>> 0;
  return hash % 360;
}
