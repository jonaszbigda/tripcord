# repro — dashboard: timeline viewer & tags design

Status: draft
Date: 2026-09-23
Scope: sub-project 4b — error tags end to end (`@repro/js` → ingest → storage), a
read API for timelines, and the dashboard's timeline viewer: a filterable list, a
volume chart, a top-reasons table and a timeline detail page. Builds on 4a
(`2026-09-23-repro-dashboard-accounts-design.md`) for auth, orgs and the SPA shell.

## Problem & concept

After 4a, a member can create a project, mint a key and start sending timelines, but
nothing in the dashboard shows what arrived. The project page has a placeholder
where timelines should be. Until developers can read their timelines, there's no way
to find out whether opt-in breadcrumbs actually help reproduce bugs, which is the
question the whole project exists to answer.

4b adds:

- **Tags.** Developers label the area of their app a timeline came from
  (`checkout`, `shopping_cart`, `video_player`). Tags are set in the client and
  stored per timeline, and the dashboard filters by them. Reason type and message say
  *what* went wrong. Tags say *where*, which neither of those can.
- **A read API** under `/api/orgs/:orgId/projects/:projectId/timelines`, scoped
  like every other 4a route.
- **The viewer.** The list of timelines, newest first, filtered by time range,
  reason type and tags. A volume chart (bars or lines), a top-reasons table, and a
  detail page that shows one timeline and links to the others from the same session.

The viewer stays close to the raw data. One row is one captured timeline. There's
no grouping into "issues", no merging of a session's overlapping timelines, and no
text search. Each of those is a real feature to add later, once there's usage to
show which one matters.

## Decisions

| Question | Decision |
| --- | --- |
| What is one row in the list? | One raw timeline, newest first |
| Overlapping timelines from one session | The detail shows one timeline, with a sidebar linking its siblings. Nothing is merged. |
| Charts | A volume chart (stacked bars or lines, toggleable) and a top-reasons table |
| Top-reasons grouping | Exact `(reason type, name, message)`. Clicking a row filters the list to it. |
| List filters | Time range, reason type, tags |
| Deleting timelines | Not in 4b. Retention (`RETENTION_DAYS`) is the only way data leaves. |
| Chart rendering | Hand-rolled SVG: one shared frame and two mark layers. No chart library. |
| Where tags attach | Scoped tags (`setTags`) plus per-capture tags. Tags mean "where the error happened". |
| Tag source | Dynamic. Any valid tag is accepted, and the filter lists tags actually seen. |
| Several tags selected | Any of them (OR) |

## Tags

### Client API (`@repro/js`)

```ts
import { init, setTags, clearTags, capture } from "@repro/js";

setTags(["checkout"]);                          // replaces the active scope
capture("payment-declined", { code }, { tags: ["payments"] });
clearTags();                                    // leaving the area
```

- `setTags(tags)` replaces the tracer's **scope tags**. `clearTags()` empties them.
  Both are also on the object `createTracer()` returns. Calling them before `init()`
  is a no-op with a console warning, like `track()` and `capture()`.
- `capture(name?, data?, options?)` gains an optional third argument,
  `{ tags?: string[] }`. The existing two-argument form is unchanged.
- When a timeline is flushed, whether by an auto-captured error, an unhandled
  rejection or a manual `capture()`, its tags are **scope tags ∪ capture tags**.
  This is why the model is scoped: most timelines come from `window.onerror`, which
  has no call site to pass tags to.
- Scope tags live only in memory. They aren't written to `sessionStorage`, because
  the app sets them again when it loads. An error thrown before the app calls
  `setTags` is sent without tags.
- React: `ErrorBoundary` gains a `tags?: string[]` prop, passed to its `capture()`
  call. For a route-level scope, apps call `setTags` from their router, e.g. in an
  effect on the route component.

### Tag rules

- After trimming and lowercasing, a tag must match `^[a-z0-9][a-z0-9_.:-]{0,49}$`.
- At most **10** tags per timeline, with duplicates removed.
- The client lowercases and trims tags. It drops invalid ones with a `console.warn`,
  and past 10 it keeps the first 10 and warns. This follows the existing
  anonymization guardrail: it warns and never throws. So a real client never sends
  tags the server would reject. That matters because the transport is
  fire-and-forget, and a rejected payload is a lost error report.
- `tags` is sent as a top-level payload field **only when non-empty**:

```ts
export interface TimelinePayload {
  sessionId: string;
  reason: TimelineReason;
  events: TimelineEvent[];
  meta: TimelineMeta;
  tags?: string[];   // new; omitted when empty
}
```

### Ingest

- The `POST /v1/timeline` schema adds an optional
  `tags: { type: "array", maxItems: 10, uniqueItems: true, items: { type: "string", pattern } }`.
  A payload that breaks these rules is a `400`, as for any other schema violation.
- **Upgrade order:** the ingest schema has `additionalProperties: false`, so an
  older server rejects a payload that carries `tags`. Upgrade the server before
  shipping a client that calls `setTags`. Clients that never set tags omit the field
  and keep working with any server. The client README and the release notes for
  `@repro/js` 0.2.0 say this.

### Storage

- `timelines.tags`: `text[] NOT NULL DEFAULT '{}'`. The migration adds the column,
  and existing rows get `{}`.
- A GIN index on `tags`. The list query combines it with the existing
  `(project_id, received_at)` index.
- Tags are dynamic, so there's no tags table. The filter's options come from the
  data (see `GET .../timelines/tags`).

## Data model changes (Postgres, via Drizzle)

| Change | Why |
| --- | --- |
| `timelines.tags text[] NOT NULL DEFAULT '{}'` | Tags |
| `timelines_tags_idx`: GIN on `tags` | Tag filter |
| `timelines_project_session_idx`: `(project_id, session_id)` | Detail page sibling lookup |

One generated drizzle-kit migration.

## Read API

All routes are `GET`, sit behind the 4a `requireUser` + `requireMembership`
preValidation hooks, and work for owners and members alike. The project is always
looked up together with `org_id`, and each timeline together with `project_id`. A
timeline in another project, a project in another org, or a malformed id is a
`404 { error: "Not Found" }`. The tenant-isolation test (`routes/isolation.test.ts`)
checks that its `CASES` table matches every registered org-scoped route, so it fails
until each new route is added there. Its fixture gains a `timelineId`.

Base path: `/api/orgs/:orgId/projects/:projectId/timelines`.

### Common filter parameters

| Param | Values | Default |
| --- | --- | --- |
| `range` | `24h`, `7d`, `30d` | `7d` |
| `reasonType` | any of `error`, `unhandledrejection`, `manual`; repeatable | all |
| `tag` | a tag; repeatable, matched as **any of** (`tags && $1`) | none |
| `reason` | a top-reasons key (see below) | none |

An unknown `range` or `reasonType`, a malformed `tag`, or a malformed `reason` key is
a `400`. A well-formed key that matches nothing isn't an error. It returns an empty
list.

### `GET …/timelines` — the list

Extra params: `cursor` (opaque) and `limit` (1–100, default 50).

```json
{
  "timelines": [
    {
      "id": "…",
      "receivedAt": "2026-09-23T10:15:02.123456Z",
      "sessionId": "…",
      "reasonType": "error",
      "reasonName": "TypeError",
      "reasonMessage": "Cannot read properties of undefined (reading 'price')",
      "url": "https://shop.example.com/checkout",
      "tags": ["checkout"],
      "eventCount": 23
    }
  ],
  "nextCursor": "…"
}
```

- Ordered by `received_at DESC, id DESC`, with keyset pagination on that pair.
  `nextCursor` is `null` on the last page.
- **The cursor holds `received_at` as Postgres text**, e.g. `received_at::text`,
  not as a JS `Date`. The column has microsecond precision and `Date` has only
  milliseconds, so a round-trip through `Date` would skip or repeat rows on a page
  boundary.
- `reasonMessage` is truncated to 300 characters for the list. The detail returns
  it in full.
- `eventCount` is `jsonb_array_length(events)`. The list never returns `events`.

### `GET …/timelines/summary` — chart and top reasons

Same filters as the list, plus `tz`, an IANA zone name such as `Europe/Warsaw`,
default `UTC`, checked against `Intl.supportedValuesOf("timeZone")`.

```json
{
  "bucket": "hour",
  "buckets": [
    { "start": "2026-09-23T10:00:00+02:00", "error": 4, "unhandledrejection": 1, "manual": 0 }
  ],
  "topReasons": [
    { "key": "9b1d…", "type": "error", "name": "TypeError", "message": "…", "count": 17, "lastSeen": "…" }
  ]
}
```

- Buckets are hourly for `24h` and daily for `7d` and `30d`, truncated in `tz`, so
  "a day" is the viewer's day. Empty buckets are filled with zeros using
  `generate_series`, so the chart never has gaps.
- `topReasons` returns the 10 largest groups of `(reason_type, reason->>'name',
  reason->>'message')`, with `message` truncated to 300 characters.
- **The reason key** is `md5(jsonb_build_array(reason_type, reason->'name',
  reason->'message')::text)`, computed in SQL both when grouping and when filtering
  by `reason`. It's a fixed-length hash, so a URL with a long error message in it
  can't get too long. There's no index on it, and none is needed: the filter runs
  within one project and at most 30 days of data.

### `GET …/timelines/tags` — filter options

Params: `range` only.

```json
{ "tags": [{ "tag": "checkout", "count": 41 }, { "tag": "video_player", "count": 3 }] }
```

The distinct tags in the range (`unnest(tags)`), with counts, sorted by count. It
deliberately ignores the other filters, so choosing a tag never hides the rest.

### `GET …/timelines/:timelineId` — detail

```json
{
  "timeline": {
    "id": "…", "receivedAt": "…", "sessionId": "…", "tags": ["checkout"],
    "reason": { "type": "error", "name": "TypeError", "message": "…", "data": {} },
    "events": [{ "timestamp": 1700000000000, "type": "trace", "name": "Pay button", "data": {} }],
    "meta": { "url": "…", "userAgent": "…", "capturedAt": 1700000000000 }
  },
  "siblings": [{ "id": "…", "receivedAt": "…", "reasonType": "manual", "reasonName": "payment-declined" }]
}
```

`siblings` holds up to 20 other timelines with the same `project_id` and
`session_id`, ordered by `received_at`, and doesn't include this timeline.

## Dashboard

### Routes

| Path | Page |
| --- | --- |
| `/orgs/:orgId/projects/:projectId` | **Timelines** tab (default): filters, chart, top reasons, list |
| `/orgs/:orgId/projects/:projectId/keys` | **Keys** tab: the 4a key management and ingest endpoint, moved here unchanged |
| `/orgs/:orgId/projects/:projectId/timelines/:timelineId` | Timeline detail |

The project page gets two tabs, Timelines and Keys. The 4a placeholder goes away.

### Timelines tab

- **Filter row**, one row above everything else: a time-range segmented control
  (24h / 7d / 30d), reason-type toggles, and a tag multi-select filled from
  `…/timelines/tags`. When a top reason is selected, it shows as a removable chip.
  All filters live in the URL's search params, so a filtered view survives a reload
  and can be shared as a link.
- **Volume chart**: counts per bucket by reason type, with a **Bars | Lines**
  toggle. The choice is remembered per viewer in `localStorage`, wrapped in
  try/catch, and defaults to Bars.
- **Top reasons**: a table of type, name, message (clamped to one line, with the
  full text in a tooltip), count and last seen. Clicking a row sets `reason=<key>`.
- **List**: one row per timeline, showing time (relative, with the absolute time in
  a tooltip), reason type, name and message, URL path, tag chips and event count.
  A "Load more" button pages with the cursor. A row links to the detail page.
- **Empty state**: when the project has no timelines at all, instead of empty charts
  the page shows the ingest endpoint and a copyable `init({ endpoint, apiKey })`
  snippet with a `setTags` line, plus a link to the Keys tab.

### Timeline detail

- **Header**: reason type, name, full message, tags, received time.
- **Events**: a vertical timeline, oldest first. Each event shows its time relative
  to `meta.capturedAt` (e.g. `−12.4s`), its type, and its name. `data` is
  collapsible, pretty-printed JSON. The captured reason is the last entry, and it's
  highlighted.
- **Meta**: URL, user agent, captured at, session id.
- **Sidebar**: "Same session", listing the siblings. Each one links to its own detail
  page.
- **Everything client-supplied is rendered as text.** Payloads come from browsers
  and are untrusted. `meta.url` becomes a link only if it's `http:` or `https:`. No
  `dangerouslySetInnerHTML` anywhere.

### Charts

Hand-rolled SVG, in `dashboard/src/components/charts/`:

- **`ChartFrame`** holds the shared parts: the time x-scale over the buckets, a
  linear y-scale from zero with "nice" ticks, a recessive grid and axis in
  `--color-border` and `--color-muted`, a legend, a hover layer, and a **table
  view** toggle that renders the same data as an HTML table. It measures its width
  with a `ResizeObserver` and redraws at any width, down to a phone.
- **`StackedBars`**: one stacked column per bucket. Bar tops have a 4px rounded
  corner, bars stand on the baseline, and each segment is separated by a 2px gap in
  the surface color. Hovering a column shows a tooltip with each type's count and
  the total.
- **`Lines`**: one 2px line per reason type. Hovering shows a vertical crosshair, a
  tooltip for that bucket, and a marker of at least 8px on each line, with a 2px
  ring in the surface color.
- Tooltip text, the legend and axis labels use the text tokens (`--color-fg`,
  `--color-muted`), never the series colors. A small colored swatch next to each
  label carries the identity.
- Colors are new tokens in `index.css`, with light and dark values, following the
  existing `@theme` and `prefers-color-scheme` pattern:

| Token | Series | Light | Dark |
| --- | --- | --- | --- |
| `--color-series-error` | error | `#4f46e5` | `#7c83f5` |
| `--color-series-rejection` | unhandledrejection | `#eb6834` | `#d95926` |
| `--color-series-manual` | manual | `#1baf7a` | `#199e70` |

  These were checked with the dataviz palette validator against the dashboard's
  surfaces (`#ffffff` light, `#16161a` dark), comparing **all pairs**. Every
  lightness, chroma, colorblind-separation and normal-vision check passes in both
  modes. The worst colorblind ΔE is 9.2 in light mode and 9.4 in dark. Series 1 is
  the brand accent. In dark mode it's one step deeper than `--color-accent`
  (`#818cf8` falls outside the dark lightness band). Light-mode aqua is 2.82:1
  against white, under 3:1, so the chart **must** always show a legend and offer the
  table view. It does both. `--color-danger` isn't used for "error": status colors
  are kept for status.
- The series order and colors are fixed per reason type. They follow the entity,
  so filtering out a type never repaints the others.

## Testing

**`packages/js`**

- The tag rules: lowercasing, trimming, dropping invalid tags with a warning,
  dedupe, capping at 10 with a warning, and omitting the field when empty.
- Scope ∪ capture tags on manual capture, on an auto-captured error and on an
  unhandled rejection. `clearTags()` empties the scope.
- `setTags` or `clearTags` before `init()` warns and does nothing.
- `ErrorBoundary` passes its `tags` prop to `capture()`.

**`server`**

- Ingest: tags are stored; a payload without tags stores `{}`; an invalid tag, 11
  tags or a duplicate tag is a `400`.
- The migration adds the column to existing rows as `{}`.
- List: each filter alone and combined; tag OR semantics; reason-key filtering;
  keyset pagination across a page boundary where rows share a millisecond but not a
  microsecond; `limit` bounds; `400` for each malformed parameter.
- Summary: hourly and daily buckets with zero-fill, bucketing in a non-UTC `tz`
  across a day boundary, the top-reasons key round-trips into the list filter, and
  messages are truncated.
- Tags endpoint: counts, and it ignores the other filters.
- Detail: the full payload, siblings limited to the same project and session, and
  a `404` for a timeline in another project of the same org.
- The tenant-isolation test gets a case for each of the four new routes. A
  non-member gets `404` on each one, and the owner's positive control reaches them.

**`dashboard`**

- Filters read from and write to the URL. Clicking a top reason filters the list.
  "Load more" appends a page.
- Both chart layers render the right number of marks for a fixture. The table view
  shows the same numbers. Tooltip content on hover.
- Detail: relative event times, collapsible data, siblings link out, and a
  `javascript:` URL in `meta.url` is not rendered as a link.
- The empty state shows the setup snippet.

**Manual**: a docker-compose smoke test. Send timelines with and without tags from
a small page that uses the built `@repro/js`. Filter by tag, switch the chart
between bars and lines, open a detail page and move to a sibling, and check light
and dark mode.

## Docs

- `packages/js/README.md`: `setTags`, `clearTags`, `capture`'s options, the
  `ErrorBoundary` `tags` prop, the tag rules, and the note about upgrading the server
  first. Bump the version to `0.2.0`.
- `2026-09-22-repro-client-library-design.md` and
  `2026-09-22-repro-ingest-api-design.md`: short "Extended by" notes pointing to
  this spec's tags section. The original text stays as it is, following the
  "superseded notes, not rewrites" convention from the API keys work.
- `server/README.md`: the `/api` section mentions the timeline read routes.

## Explicitly out of scope

- Tags on individual events (`track(name, data, { tags })`), and tags on
  `data-trace` elements.
- Managing tags in project settings: predefined lists, allowlists, descriptions,
  hiding tags.
- AND matching for tags, saved views, and any text search over messages or URLs.
- Charting by tag. The number of tags is unbounded, which the categorical palette
  can't color; the top-reasons table and filters cover this.
- Grouping timelines into issues, normalizing messages, and merging a session's
  timelines into one stream.
- Deleting timelines, and exporting them.
- Auto-refresh or live updates. The page refreshes on navigation and when filters
  change.
- Alerts and notifications.
