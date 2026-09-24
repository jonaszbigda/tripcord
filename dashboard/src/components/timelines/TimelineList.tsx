import { Link } from "react-router";
import { REASON_LABELS, formatDateTime, formatRelative, urlPath } from "../../format";
import type { TimelineRow } from "../../types";
import { SERIES_COLORS } from "../charts/series";
import { Swatch } from "../ui";
import { TagChips } from "./TagChips";
import { reasonText } from "./TopReasons";

export function TimelineList({ orgId, projectId, timelines }: { orgId: string; projectId: string; timelines: TimelineRow[] }) {
  if (timelines.length === 0) {
    return <p className="text-sm text-muted">No timelines match these filters.</p>;
  }
  return (
    <ul className="-mx-3 divide-y divide-border/70">
      {timelines.map((t) => (
        <li key={t.id}>
          <Link
            to={`/orgs/${orgId}/projects/${projectId}/timelines/${t.id}`}
            className="grid gap-1 rounded-lg px-3 py-3 transition hover:bg-raised sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-baseline sm:gap-4"
          >
            <time dateTime={t.receivedAt} title={formatDateTime(t.receivedAt)} className="text-sm text-muted">
              {formatRelative(t.receivedAt)}
            </time>
            <span className="min-w-0 space-y-1">
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <Swatch color={SERIES_COLORS[t.reasonType]} />
                <span className="shrink-0 text-muted">{REASON_LABELS[t.reasonType]}</span>
                <span className="truncate font-medium">{reasonText({ name: t.reasonName, message: t.reasonMessage })}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="truncate font-mono text-amber/80">{urlPath(t.url)}</span>
                <TagChips tags={t.tags} />
              </span>
            </span>
            <span className="text-xs tabular-nums text-muted">
              {t.eventCount} {t.eventCount === 1 ? "event" : "events"}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
