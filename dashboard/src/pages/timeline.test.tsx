import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp, type MockHandler } from "../test/utils";
import type { TimelineDetail } from "../types";

const PAGE = `/orgs/${ORG_ID}/projects/proj-1/timelines/t1`;
const API = `/api/orgs/${ORG_ID}/projects/proj-1/timelines/t1`;
const CAPTURED_AT = 1_790_000_000_000;

const DETAIL: TimelineDetail = {
  timeline: {
    id: "t1",
    receivedAt: "2026-09-22T10:00:00.000000Z",
    sessionId: "s1",
    tags: ["checkout"],
    reason: { type: "error", name: "TypeError", message: "Cannot read properties of undefined", data: { orderId: 7 } },
    events: [
      { timestamp: CAPTURED_AT - 12_400, type: "trace", name: "Pay button" },
      { timestamp: CAPTURED_AT - 2_000, type: "custom", name: "checkout.step", data: { step: "payment" } },
    ],
    meta: { url: "https://shop.example.com/checkout", userAgent: "Mozilla/5.0 test", capturedAt: CAPTURED_AT },
  },
  siblings: [{ id: "t0", receivedAt: "2026-09-22T09:59:00.000000Z", reasonType: "manual", reasonName: "payment-declined" }],
};

function handlers(detail: MockHandler = { body: DETAIL }): Record<string, MockHandler> {
  return { "GET /api/me": { body: ME }, [`GET ${API}`]: detail };
}

describe("timeline detail", () => {
  it("shows the reason, tags and events timed from the capture", async () => {
    mockApi(handlers());
    renderApp(PAGE);

    expect(await screen.findByRole("heading", { name: "TypeError" })).toBeInTheDocument();
    expect(screen.getByText("Cannot read properties of undefined")).toBeInTheDocument();
    expect(screen.getByText("checkout")).toBeInTheDocument();

    const events = within(screen.getByRole("list", { name: "Events" }));
    expect(events.getByText("−12.4s")).toBeInTheDocument();
    expect(events.getByText("Pay button")).toBeInTheDocument();
    expect(events.getByText("−2.0s")).toBeInTheDocument();
    expect(events.getByText("0.0s")).toBeInTheDocument();
  });

  it("keeps event data collapsed until opened", async () => {
    mockApi(handlers());
    renderApp(PAGE);

    const data = await screen.findByText(/"step": "payment"/);
    expect(data).not.toBeVisible();
    expect(data.closest("details")).not.toHaveAttribute("open");
  });

  it("links the captured URL only when it's http(s)", async () => {
    mockApi(handlers());
    renderApp(PAGE);
    expect(await screen.findByRole("link", { name: "https://shop.example.com/checkout" })).toHaveAttribute(
      "href",
      "https://shop.example.com/checkout"
    );
  });

  it("never links a javascript: URL", async () => {
    const hostile = { ...DETAIL, timeline: { ...DETAIL.timeline, meta: { ...DETAIL.timeline.meta, url: "javascript:alert(1)" } } };
    mockApi(handlers({ body: hostile }));
    renderApp(PAGE);

    expect(await screen.findByText("javascript:alert(1)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "javascript:alert(1)" })).not.toBeInTheDocument();
  });

  it("links the other timelines from the same session", async () => {
    mockApi(handlers());
    renderApp(PAGE);
    expect(await screen.findByRole("link", { name: /payment-declined/ })).toHaveAttribute(
      "href",
      `/orgs/${ORG_ID}/projects/proj-1/timelines/t0`
    );
  });

  it("says so when the timeline doesn't exist", async () => {
    mockApi(handlers({ status: 404, body: { error: "Not Found" } }));
    renderApp(PAGE);
    expect(await screen.findByRole("heading", { name: "Timeline not found" })).toBeInTheDocument();
  });
});
