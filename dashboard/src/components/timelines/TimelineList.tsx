import { Link } from "react-router";
import { REASON_LABELS, formatDateTime, formatRelative, urlPath } from "../../format";
import type { SessionRow } from "../../types";
import { SERIES_COLORS } from "../charts/series";
import { Swatch } from "../ui";
import { TagChips } from "./TagChips";

export function TimelineList({
  orgId,
  projectId,
  sessions,
}: {
  orgId: string;
  projectId: string;
  sessions: SessionRow[];
}) {
  if (sessions.length === 0) {
    return <p className="text-sm text-muted">No sessions match these filters.</p>;
  }
  return (
    <ul className="-mx-3 divide-y divide-border/70">
      {sessions.map((s) => {
        // The report type is a colored dot; the reason is in the tooltip (and the
        // label for screen readers). The detail page has the full story.
        const reasonTitle =
          s.reasonTypes.length === 0 ? "No captures" : s.reasonTypes.map((t) => REASON_LABELS[t]).join(", ");
        return (
          <li key={s.sessionId}>
            <Link
              to={`/orgs/${orgId}/projects/${projectId}/timelines/${encodeURIComponent(s.sessionId)}`}
              className="flex items-center gap-3 overflow-hidden rounded-lg px-3 py-2 transition hover:bg-raised"
            >
              <time dateTime={s.lastSeenAt} title={formatDateTime(s.lastSeenAt)} className="w-24 shrink-0 text-xs text-muted">
                {formatRelative(s.lastSeenAt)}
              </time>
              <span className="flex shrink-0 items-center gap-1" role="img" title={reasonTitle} aria-label={reasonTitle}>
                {s.reasonTypes.length === 0 ? (
                  <span aria-hidden="true" className="size-2.5 rounded-full bg-border" />
                ) : (
                  s.reasonTypes.map((type) => <Swatch key={type} color={SERIES_COLORS[type]} />)
                )}
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                <span
                  className="min-w-0 max-w-[18rem] flex-1 truncate font-mono text-xs text-amber/80"
                  title={s.url ?? undefined}
                >
                  {s.url ? urlPath(s.url) : "—"}
                </span>
                <TagChips tags={s.tags} />
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="max-w-[8rem] truncate font-mono text-xs text-muted" title={s.sessionId}>
                  {s.sessionId}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted">
                  {s.eventCount} {s.eventCount === 1 ? "event" : "events"} · {s.captureCount}{" "}
                  {s.captureCount === 1 ? "capture" : "captures"}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
