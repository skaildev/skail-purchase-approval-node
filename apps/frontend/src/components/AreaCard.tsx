import { useState } from "react";
import type { LevelView } from "@skail-purchase-approval/contracts";
import { LEVEL_LABELS, STATUS_LABELS } from "../labels";

interface Props {
  level: string;
  view: LevelView | undefined;
  /** The order is still active (the controls only make sense while it is). */
  active: boolean;
  busy: boolean;
  now: number;
  onDecide: (approved: boolean, by: string, reason: string) => void;
}

/** Seconds left to the level's deadline, for the (visual only) countdown. */
function remainingSeconds(view: LevelView, now: number): number | null {
  if (!view.requestedAt) return null;
  return Math.max(0, Math.ceil(view.deadlineSeconds - (now - new Date(view.requestedAt).getTime()) / 1000));
}

export function AreaCard({ level, view, active, busy, now, onDecide }: Props) {
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const status = view?.status ?? "NotRequested";
  const pending = active && status === "Pending";
  const canDecide = pending && !busy;

  const seconds = pending && view ? remainingSeconds(view, now) : null;
  const countdown = seconds === null ? "" : seconds > 0 ? `Deadline in ${seconds}s` : "Deadline reached…";
  const time = (iso: string) => new Date(iso).toLocaleTimeString();
  const who = view?.by ? `${view.by}${view.at ? " · " + time(view.at) : ""}` : "";
  const detail = [who, view?.reason ? `“${view.reason}”` : ""].filter(Boolean).join(" · ");

  return (
    <article className="area" data-level={level} aria-label={LEVEL_LABELS[level]}>
      <h2>
        {LEVEL_LABELS[level]} <span className={`pill ${status}`}>{STATUS_LABELS[status]}</span>
      </h2>
      <p className="countdown">{countdown}</p>
      <p className="detail">{detail}</p>
      <input
        type="text"
        placeholder="Decided by"
        maxLength={60}
        value={by}
        disabled={!canDecide}
        onChange={(e) => setBy(e.target.value)}
      />
      <input
        type="text"
        placeholder="Reason (if rejecting)"
        maxLength={200}
        value={reason}
        disabled={!canDecide}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="buttons">
        <button type="button" disabled={!canDecide} onClick={() => onDecide(true, by, reason)}>
          Approve
        </button>
        <button type="button" className="danger" disabled={!canDecide} onClick={() => onDecide(false, by, reason)}>
          Reject
        </button>
      </div>
    </article>
  );
}
