import { useState } from "react";

export type PinModalState =
  | { mode: "show"; pin: string; senderNickname: string }
  | { mode: "enter"; onSubmit: (pin: string) => void };

export function PinModal({ state }: { state: PinModalState }) {
  const [entered, setEntered] = useState("");

  if (state.mode === "show") {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <h2>Pairing code</h2>
          <p>
            Tell <strong>{state.senderNickname}</strong> this code to allow the transfer:
          </p>
          <p className="pin-display">{state.pin}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Enter pairing code</h2>
        <p>Ask the receiving device what code is shown on their screen.</p>
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            state.onSubmit(entered);
            setEntered("");
          }}
        >
          <input
            className="pin-input"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoFocus
            value={entered}
            onChange={(ev) => setEntered(ev.target.value.replace(/\D/g, ""))}
          />
          <button type="submit" className="button--primary" disabled={entered.length !== 6}>
            Confirm
          </button>
        </form>
      </div>
    </div>
  );
}
