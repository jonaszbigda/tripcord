import { describe, it, expect, vi, afterEach } from "vitest";
import { createSend } from "./transport";
import type { TimelinePayload } from "../core/types";

const payload: TimelinePayload = {
  sessionId: "session-1",
  reason: { type: "manual", name: "payment-declined" },
  events: [],
  meta: { url: "https://example.com", userAgent: "test-agent", capturedAt: 1 },
};

describe("createSend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("POSTs the payload with keepalive and the api key header", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const send = createSend("https://ingest.example.com/timeline", "key-123");
    send(payload);

    expect(fetchMock).toHaveBeenCalledWith("https://ingest.example.com/timeline", {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-Repro-Key": "key-123",
      },
      body: JSON.stringify(payload),
    });
  });

  it("warns via console.warn instead of throwing when fetch rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error"))
    );

    const send = createSend("https://ingest.example.com/timeline", "key-123");
    expect(() => send(payload)).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
  });
});
