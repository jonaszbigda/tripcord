import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp, type MockHandler } from "../test/utils";
import type { SessionDetail } from "../types";

const PAGE = `/orgs/${ORG_ID}/projects/proj-1/timelines/s1`;
const API = `/api/orgs/${ORG_ID}/projects/proj-1/timelines/s1`;
const CAPTURED_AT = 1_790_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

const DETAIL: SessionDetail = {
  session: {
    sessionId: "s1",
    firstSeenAt: iso(CAPTURED_AT - 120_000),
    lastSeenAt: iso(CAPTURED_AT),
    url: "https://shop.example.com/checkout",
    tags: ["checkout"],
    events: [
      { id: "e1", source: "browser", timestamp: CAPTURED_AT - 12_400, type: "trace", name: "Pay button" },
      { id: "e2", source: "server", timestamp: CAPTURED_AT - 2_000, type: "custom", name: "checkout.step", data: { step: "payment" } },
    ],
  },
  captures: [
    {
      id: "c0",
      receivedAt: iso(CAPTURED_AT - 60_000),
      occurredAt: iso(CAPTURED_AT - 60_000),
      reasonType: "manual",
      reason: { type: "manual", name: "payment-declined" },
      meta: { url: "https://shop.example.com/checkout", userAgent: "Mozilla/5.0 test", capturedAt: CAPTURED_AT - 60_000 },
      tags: ["checkout"],
    },
    {
      id: "c1",
      receivedAt: iso(CAPTURED_AT),
      occurredAt: iso(CAPTURED_AT),
      reasonType: "error",
      reason: { type: "error", name: "TypeError", message: "Cannot read properties of undefined", data: { orderId: 7 } },
      meta: { url: "https://shop.example.com/checkout", userAgent: "Mozilla/5.0 test", capturedAt: CAPTURED_AT },
      tags: ["checkout"],
    },
  ],
};

function handlers(detail: MockHandler = { body: DETAIL }): Record<string, MockHandler> {
  return { "GET /api/me": { body: ME }, [`GET ${API}`]: detail };
}

describe("session detail", () => {
  it("shows the session, its events timed from the last capture, and the capture reasons", async () => {
    mockApi(handlers());
    renderApp(PAGE);

    expect(await screen.findByRole("heading", { name: "s1" })).toBeInTheDocument();
    expect(screen.getAllByText(/Cannot read properties of undefined/).length).toBeGreaterThan(0);
    expect(screen.getByText("checkout")).toBeInTheDocument();

    const events = within(screen.getByRole("list", { name: "Events" }));
    expect(events.getByText("−12.4s")).toBeInTheDocument();
    expect(events.getByText("Pay button")).toBeInTheDocument();
    expect(events.getByText("−2.0s")).toBeInTheDocument();
    expect(events.getByText("0.0s")).toBeInTheDocument();
  });

  it("labels each event with its source", async () => {
    mockApi(handlers());
    renderApp(PAGE);

    const events = within(await screen.findByRole("list", { name: "Events" }));
    expect(events.getByText("Browser")).toBeInTheDocument();
    expect(events.getByText("Server")).toBeInTheDocument();
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
    const hostile = { ...DETAIL, session: { ...DETAIL.session, url: "javascript:alert(1)" } };
    mockApi(handlers({ body: hostile }));
    renderApp(PAGE);

    expect(await screen.findByText("javascript:alert(1)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "javascript:alert(1)" })).not.toBeInTheDocument();
  });

  it("lists every capture of the session", async () => {
    mockApi(handlers());
    renderApp(PAGE);
    expect((await screen.findAllByText("payment-declined")).length).toBeGreaterThan(0);
  });

  it("says so when the session doesn't exist", async () => {
    mockApi(handlers({ status: 404, body: { error: "Not Found" } }));
    renderApp(PAGE);
    expect(await screen.findByRole("heading", { name: "Session not found" })).toBeInTheDocument();
  });
});
