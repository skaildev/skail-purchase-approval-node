import type { TimelineEntry } from "@skail-purchase-approval/contracts";

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol id="timeline" className="timeline" aria-label="Timeline">
      {entries.map((e, i) => (
        <li key={i}>{`${new Date(e.at).toLocaleTimeString()}  ${e.text}`}</li>
      ))}
    </ol>
  );
}
