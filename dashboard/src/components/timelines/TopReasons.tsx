import { REASON_LABELS, formatDateTime, formatRelative } from "../../format";
import type { TopReason } from "../../types";
import { SERIES_COLORS } from "../charts/series";
import { Swatch } from "../ui";

export function reasonText(reason: { name: string | null; message: string | null }): string {
  return [reason.name, reason.message].filter(Boolean).join(": ") || "(no message)";
}

export function TopReasons({
  reasons,
  selected,
  onSelect,
}: {
  reasons: TopReason[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  if (reasons.length === 0) {
    return <p className="text-sm text-muted">Nothing in this range.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] table-fixed text-sm">
        <thead>
          <tr className="text-left text-muted">
            <th className="w-44 py-2 font-medium">Type</th>
            <th className="font-medium">Reason</th>
            <th className="w-16 text-right font-medium">Count</th>
            <th className="w-32 text-right font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {reasons.map((reason) => (
            <tr key={reason.key} className={`border-t border-border ${reason.key === selected ? "bg-bg" : ""}`}>
              <td className="py-2">
                <span className="inline-flex items-center gap-2">
                  <Swatch color={SERIES_COLORS[reason.type]} />
                  {REASON_LABELS[reason.type]}
                </span>
              </td>
              <td>
                <button
                  type="button"
                  title={reasonText(reason)}
                  onClick={() => onSelect(reason.key)}
                  className="block w-full truncate text-left hover:underline"
                >
                  {reasonText(reason)}
                </button>
              </td>
              <td className="text-right tabular-nums">{reason.count}</td>
              <td className="text-right text-muted" title={formatDateTime(reason.lastSeen)}>
                {formatRelative(reason.lastSeen)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
