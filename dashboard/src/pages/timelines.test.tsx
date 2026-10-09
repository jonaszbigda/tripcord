import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp, type ApiCall, type MockHandler } from "../test/utils";
import type { Project, SessionRow, TimelineSummary } from "../types";

const PROJECT: Project = { id: "proj-1", orgId: ORG_ID, name: "web", createdAt: "2026-09-01T00:00:00.000Z", activeKeyCount: 1 };
const PAGE = `/orgs/${ORG_ID}/projects/proj-1`;
const BASE = `/api/orgs/${ORG_ID}/projects/proj-1/timelines`;
const KEY = "a".repeat(32);

function session(sessionId: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId,
    firstSeenAt: new Date(Date.now() - 120_000).toISOString(),
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    reasonTypes: ["error"],
    url: "https://shop.example.com/checkout",
    tags: ["checkout"],
    eventCount: 3,
    captureCount: 1,
    ...overrides,
  };
}

const SUMMARY: TimelineSummary = {
  projectHasTimelines: true,
  bucket: "day",
  buckets: [{ start: "2026-09-22T00:00:00.000Z", error: 2, unhandledrejection: 0, manual: 1 }],
  topReasons: [{ key: KEY, type: "error", name: "TypeError", message: "boom", count: 2, lastSeen: new Date().toISOString() }],
};

function handlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    "GET /api/me": { body: ME },
    [`GET /api/orgs/${ORG_ID}/projects`]: { body: { projects: [PROJECT] } },
    [`GET ${BASE}`]: { body: { sessions: [session("s1"), session("s2")], nextCursor: null } },
    [`GET ${BASE}/summary`]: { body: SUMMARY },
    [`GET ${BASE}/tags`]: { body: { tags: [{ tag: "checkout", count: 2 }, { tag: "video_player", count: 1 }] } },
    ...extra,
  };
}

const location = () => screen.getByTestId("location");
const paths = (calls: ApiCall[]) => calls.map((c) => c.path);

describe("timelines tab", () => {
  it("shows the setup snippet while the project has no timelines", async () => {
    mockApi(handlers({ [`GET ${BASE}/summary`]: { body: { ...SUMMARY, projectHasTimelines: false, topReasons: [] } } }));
    renderApp(PAGE);

    expect(await screen.findByRole("heading", { name: "No timelines yet" })).toBeInTheDocument();
    expect(screen.getByText(/\/v1\/timeline/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Keys tab" })).toHaveAttribute("href", `${PAGE}/keys`);
  });

  it("shows the list, the chart and the top reasons", async () => {
    mockApi(handlers());
    renderApp(PAGE);

    expect(await screen.findByRole("link", { name: /s1/ })).toHaveAttribute("href", `${PAGE}/timelines/s1`);
    expect(screen.getByRole("link", { name: /s2/ })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Timelines per day" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "TypeError: boom" })).toBeInTheDocument();
  });

  it("reads the filters from the URL and sends them to the API", async () => {
    const calls = mockApi(handlers());
    renderApp(`${PAGE}?range=30d&tag=checkout`);
    await screen.findByRole("link", { name: /s1/ });

    expect(paths(calls)).toContain(`${BASE}?range=30d&tag=checkout`);
    expect(paths(calls)).toContain(`${BASE}/tags?range=30d`);
    expect(paths(calls).some((p) => p.startsWith(`${BASE}/summary?range=30d&tag=checkout&tz=`))).toBe(true);
  });

  it("changes the range, reason types and tags through the URL", async () => {
    const calls = mockApi(handlers());
    const user = userEvent.setup();
    renderApp(PAGE);
    await screen.findByRole("link", { name: /s1/ });

    await user.click(within(screen.getByRole("group", { name: "Time range" })).getByRole("button", { name: "24h" }));
    await waitFor(() => expect(location()).toHaveTextContent("range=24h"));

    await user.click(within(screen.getByRole("group", { name: "Reason types" })).getByRole("button", { name: "Manual" }));
    await waitFor(() => expect(location()).toHaveTextContent("reasonType=manual"));

    await user.click(screen.getByText("Tags"));
    await user.click(screen.getByRole("checkbox", { name: /video_player/ }));
    await waitFor(() => expect(location()).toHaveTextContent("tag=video_player"));

    await waitFor(() => expect(paths(calls)).toContain(`${BASE}?range=24h&reasonType=manual&tag=video_player`));
  });

  it("filters by a top reason, and the chip clears it", async () => {
    const calls = mockApi(handlers());
    const user = userEvent.setup();
    renderApp(PAGE);

    await user.click(await screen.findByRole("button", { name: "TypeError: boom" }));
    await waitFor(() => expect(location()).toHaveTextContent(`reason=${KEY}`));
    await waitFor(() => expect(paths(calls)).toContain(`${BASE}?reason=${KEY}`));

    await user.click(screen.getByRole("button", { name: "Clear reason filter" }));
    await waitFor(() => expect(location()).not.toHaveTextContent("reason="));
  });

  it("loads the next page with the cursor", async () => {
    const calls = mockApi(
      handlers({
        [`GET ${BASE}`]: { body: { sessions: [session("s1")], nextCursor: "c1" } },
        [`GET ${BASE}?cursor=c1`]: { body: { sessions: [session("s2")], nextCursor: null } },
      })
    );
    const user = userEvent.setup();
    renderApp(PAGE);

    await user.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("link", { name: /s2/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /s1/ })).toBeInTheDocument();
    expect(paths(calls)).toContain(`${BASE}?cursor=c1`);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("says so when nothing matches the filters", async () => {
    mockApi(handlers({ [`GET ${BASE}`]: { body: { sessions: [], nextCursor: null } } }));
    renderApp(PAGE);
    expect(await screen.findByText("No sessions match these filters.")).toBeInTheDocument();
  });
});
