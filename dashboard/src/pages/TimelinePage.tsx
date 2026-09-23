import { Link, useParams } from "react-router";
import { ApiError } from "../api";
import { SERIES_COLORS } from "../components/charts/series";
import { TagChips } from "../components/timelines/TagChips";
import { Card, ErrorText, Swatch } from "../components/ui";
import { REASON_LABELS, formatDateTime, formatOffset, formatRelative, safeHref } from "../format";
import { useTimeline } from "../queries";
import type { TimelineEvent } from "../types";

const EVENT_LABELS: Record<TimelineEvent["type"], string> = {
  custom: "Track",
  trace: "Click",
  error: "Error",
  unhandledrejection: "Unhandled rejection",
};

function DataBlock({ data }: { data: Record<string, unknown> | undefined }) {
  if (!data || Object.keys(data).length === 0) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-muted hover:text-fg">Data</summary>
      <pre className="mt-1 overflow-x-auto rounded-md bg-bg p-2 font-mono text-xs">{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

// capturedAt comes from the browser; a nonsense value must not crash the page.
function formatEpoch(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? String(ms) : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

// Everything shown here comes from the captured payload: it's rendered as text,
// and the URL becomes a link only when it's http(s).
export function TimelinePage() {
  const { orgId = "", projectId = "", timelineId = "" } = useParams();
  const query = useTimeline(orgId, projectId, timelineId);
  const back = `/orgs/${orgId}/projects/${projectId}`;
  const backLink = (
    <Link to={back} className="text-sm text-muted hover:text-fg">
      ← Timelines
    </Link>
  );

  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <Card className="space-y-2">
        <h1 className="text-lg font-semibold">Timeline not found</h1>
        <p className="text-sm text-muted">It doesn't exist, or it has passed the retention period.</p>
        {backLink}
      </Card>
    );
  }
  if (!query.data) {
    return (
      <div className="space-y-4">
        {backLink}
        <ErrorText error={query.error} />
      </div>
    );
  }

  const { timeline, siblings } = query.data;
  const { reason, meta } = timeline;
  const href = safeHref(meta.url);

  return (
    <div className="space-y-6">
      {backLink}
      <header className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <Swatch color={SERIES_COLORS[reason.type]} />
          <span>{REASON_LABELS[reason.type]}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={timeline.receivedAt} title={formatDateTime(timeline.receivedAt)}>
            {formatRelative(timeline.receivedAt)}
          </time>
        </p>
        <h1 className="break-words text-xl font-semibold">{reason.name ?? REASON_LABELS[reason.type]}</h1>
        {reason.message && <p className="whitespace-pre-wrap break-words font-mono text-sm">{reason.message}</p>}
        <TagChips tags={timeline.tags} />
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="space-y-4">
          <h2 className="font-medium">Events</h2>
          {timeline.events.length === 0 && (
            <p className="text-sm text-muted">No breadcrumbs were recorded before this capture.</p>
          )}
          <ol aria-label="Events" className="space-y-3">
            {timeline.events.map((event, i) => (
              <li key={i} className="border-l border-border pl-3 text-sm">
                <p className="flex flex-wrap items-baseline gap-x-3">
                  <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-muted">
                    {formatOffset(event.timestamp - meta.capturedAt)}
                  </span>
                  <span className="text-xs text-muted">{EVENT_LABELS[event.type]}</span>
                  <span className="break-words font-medium">{event.name}</span>
                </p>
                <DataBlock data={event.data} />
              </li>
            ))}
            <li aria-current="step" className="rounded-md border-l-2 border-accent bg-accent/5 py-1 pl-3 text-sm">
              <p className="flex flex-wrap items-baseline gap-x-3">
                <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-muted">{formatOffset(0)}</span>
                <span className="text-xs text-muted">Captured</span>
                <span className="break-words font-medium">
                  {[reason.name, reason.message].filter(Boolean).join(": ") || REASON_LABELS[reason.type]}
                </span>
              </p>
              <DataBlock data={reason.data} />
            </li>
          </ol>
        </Card>

        <aside className="space-y-6">
          <Card className="space-y-3">
            <h2 className="font-medium">Details</h2>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-muted">URL</dt>
                <dd className="break-all">
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                      {meta.url}
                    </a>
                  ) : (
                    meta.url
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted">User agent</dt>
                <dd className="break-words">{meta.userAgent}</dd>
              </div>
              <div>
                <dt className="text-muted">Captured at</dt>
                <dd>{formatEpoch(meta.capturedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted">Session</dt>
                <dd className="break-all font-mono text-xs">{timeline.sessionId}</dd>
              </div>
            </dl>
          </Card>

          <Card className="space-y-3">
            <h2 className="font-medium">Same session</h2>
            {siblings.length === 0 ? (
              <p className="text-sm text-muted">No other timelines from this session.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {siblings.map((sibling) => (
                  <li key={sibling.id}>
                    <Link to={`${back}/timelines/${sibling.id}`} className="flex items-center gap-2 hover:underline">
                      <Swatch color={SERIES_COLORS[sibling.reasonType]} />
                      <span className="min-w-0 flex-1 truncate">{sibling.reasonName ?? REASON_LABELS[sibling.reasonType]}</span>
                      <time dateTime={sibling.receivedAt} className="shrink-0 text-xs text-muted">
                        {formatRelative(sibling.receivedAt)}
                      </time>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
