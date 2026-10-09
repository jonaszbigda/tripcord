import { Link, useParams } from "react-router";
import { ApiError } from "../api";
import { SERIES_COLORS } from "../components/charts/series";
import { TagChips } from "../components/timelines/TagChips";
import { Card, ErrorText, Swatch } from "../components/ui";
import { REASON_LABELS, formatDateTime, formatOffset, formatRelative, safeHref } from "../format";
import { useSession } from "../queries";
import type { SessionCapture, TimelineEvent } from "../types";

const EVENT_LABELS: Record<TimelineEvent["type"], string> = {
  custom: "Track",
  trace: "Click",
  error: "Error",
  unhandledrejection: "Unhandled rejection",
};

function sourceLabel(source: string | undefined): string {
  if (source === "browser" || source === "server") return source === "browser" ? "Browser" : "Server";
  return "Unknown";
}

function sourceColor(source: string | undefined): string {
  if (source === "browser") return "var(--color-source-browser)";
  if (source === "server") return "var(--color-source-server)";
  return "var(--color-muted)";
}

function SourceChip({ source }: { source: string | undefined }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <Swatch color={sourceColor(source)} />
      {sourceLabel(source)}
    </span>
  );
}

function DataBlock({ data }: { data: Record<string, unknown> | undefined }) {
  if (!data || Object.keys(data).length === 0) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-muted hover:text-fg">Data</summary>
      <pre className="mt-1.5 overflow-x-auto rounded-lg border border-border bg-bg p-2.5 font-mono text-xs text-amber/90">{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

type Row = { at: number; event: TimelineEvent } | { at: number; capture: SessionCapture };

// Everything shown here comes from captured payloads: it's rendered as text, and
// the URL becomes a link only when it's http(s).
export function TimelinePage() {
  const { orgId = "", projectId = "", sessionId = "" } = useParams();
  const query = useSession(orgId, projectId, sessionId);
  const back = `/orgs/${orgId}/projects/${projectId}`;
  const backLink = (
    <Link to={back} className="text-sm text-muted hover:text-fg">
      ← Sessions
    </Link>
  );

  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <Card className="space-y-2">
        <h1 className="text-lg font-semibold">Session not found</h1>
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

  const { session, captures } = query.data;
  const rows: Row[] = [
    ...session.events.map((event) => ({ at: event.timestamp, event }) as Row),
    ...captures.map((capture) => ({ at: Date.parse(capture.occurredAt), capture }) as Row),
  ].sort((a, b) => a.at - b.at);
  const base = rows.length > 0 ? rows[rows.length - 1].at : Date.now();
  const latest = captures[captures.length - 1];
  const href = safeHref(session.url ?? "");

  return (
    <div className="space-y-6">
      {backLink}
      <header className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>Session</span>
          <span aria-hidden="true">·</span>
          <time dateTime={session.lastSeenAt} title={formatDateTime(session.lastSeenAt)}>
            {formatRelative(session.lastSeenAt)}
          </time>
          <span aria-hidden="true">·</span>
          <span>
            {captures.length} {captures.length === 1 ? "capture" : "captures"}
          </span>
        </p>
        <h1 className="break-words font-mono text-2xl font-semibold tracking-tight">{session.sessionId}</h1>
        <TagChips tags={session.tags} />
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="space-y-4">
          <h2 className="font-medium">Timeline</h2>
          {rows.length === 0 && <p className="text-sm text-muted">No events were recorded in this session.</p>}
          <ol
            aria-label="Events"
            className="relative space-y-4 pl-6 before:absolute before:top-2 before:bottom-3 before:left-[5px] before:w-0.5 before:rounded-full before:bg-[linear-gradient(180deg,var(--color-border),var(--color-accent)_85%,var(--color-amber))]"
          >
            {rows.map((row, i) =>
              "event" in row ? (
                <li
                  key={`e${i}`}
                  className="relative text-sm before:absolute before:top-1.5 before:-left-6 before:size-3 before:rounded-full before:border-2 before:border-accent/70 before:bg-bg"
                >
                  <p className="flex flex-wrap items-baseline gap-x-3">
                    <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-muted">
                      {formatOffset(row.at - base)}
                    </span>
                    <SourceChip source={row.event.source} />
                    <span className="text-xs text-muted">{EVENT_LABELS[row.event.type]}</span>
                    <span className="break-words font-medium">{row.event.name}</span>
                  </p>
                  <DataBlock data={row.event.data} />
                </li>
              ) : (
                <li
                  key={`c${row.capture.id}`}
                  className="relative rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm before:absolute before:top-3.5 before:-left-[1.625rem] before:size-3.5 before:rounded-full before:bg-cord before:shadow-[0_0_0_4px_rgb(255_122_26/0.2),0_0_18px_rgb(255_150_60/0.8)]"
                >
                  <p className="flex flex-wrap items-baseline gap-x-3">
                    <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-muted">
                      {formatOffset(row.at - base)}
                    </span>
                    <Swatch color={SERIES_COLORS[row.capture.reasonType]} />
                    <span className="text-xs font-medium text-accent">Captured · {REASON_LABELS[row.capture.reasonType]}</span>
                    <span className="break-words font-medium">
                      {[row.capture.reason.name, row.capture.reason.message].filter(Boolean).join(": ") ||
                        REASON_LABELS[row.capture.reasonType]}
                    </span>
                  </p>
                  <DataBlock data={row.capture.reason.data} />
                </li>
              )
            )}
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
                      {session.url}
                    </a>
                  ) : (
                    session.url || "—"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted">User agent</dt>
                <dd className="break-words">{latest?.meta.userAgent || "—"}</dd>
              </div>
              <div>
                <dt className="text-muted">First seen</dt>
                <dd>{formatDateTime(session.firstSeenAt)}</dd>
              </div>
              <div>
                <dt className="text-muted">Session</dt>
                <dd className="break-all font-mono text-xs">{session.sessionId}</dd>
              </div>
            </dl>
          </Card>

          <Card className="space-y-3">
            <h2 className="font-medium">Captures</h2>
            {captures.length === 0 ? (
              <p className="text-sm text-muted">This session has no captures.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {captures.map((capture) => (
                  <li key={capture.id} className="flex items-center gap-2">
                    <Swatch color={SERIES_COLORS[capture.reasonType]} />
                    <span className="min-w-0 flex-1 truncate">
                      {[capture.reason.name, capture.reason.message].filter(Boolean).join(": ") ||
                        REASON_LABELS[capture.reasonType]}
                    </span>
                    <time dateTime={capture.receivedAt} className="shrink-0 text-xs text-muted">
                      {formatRelative(capture.receivedAt)}
                    </time>
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
