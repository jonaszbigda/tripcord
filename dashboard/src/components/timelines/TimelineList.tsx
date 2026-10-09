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
      {sessions.map((s) => (
        <li key={s.sessionId}>
          <Link
            to={`/orgs/${orgId}/projects/${projectId}/timelines/${encodeURIComponent(s.sessionId)}`}
            className="grid gap-1 rounded-lg px-3 py-3 transition hover:bg-raised sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-baseline sm:gap-4"
          >
            <time dateTime={s.lastSeenAt} title={formatDateTime(s.lastSeenAt)} className="text-sm text-muted">
              {formatRelative(s.lastSeenAt)}
            </time>
            <span className="min-w-0 space-y-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <span className="shrink-0 font-mono text-xs text-muted">{s.sessionId}</span>
                {s.reasonTypes.length === 0 ? (
                  <span className="text-muted">No captures</span>
                ) : (
                  s.reasonTypes.map((type) => (
                    <span key={type} className="flex items-center gap-1.5">
                      <Swatch color={SERIES_COLORS[type]} />
                      <span className="text-muted">{REASON_LABELS[type]}</span>
                    </span>
                  ))
                )}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                {s.url && <span className="truncate font-mono text-amber/80">{urlPath(s.url)}</span>}
                <TagChips tags={s.tags} />
              </span>
            </span>
            <span className="text-xs tabular-nums text-muted">
              {s.eventCount} {s.eventCount === 1 ? "event" : "events"} · {s.captureCount}{" "}
              {s.captureCount === 1 ? "capture" : "captures"}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
