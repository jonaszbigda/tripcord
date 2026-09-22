import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPayload } from "./payload";

describe("buildPayload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assembles a TimelinePayload with capturedAt set from Date.now()", () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);

    const payload = buildPayload(
      "session-1",
      { type: "manual", name: "payment-declined", data: { code: "insufficient_funds" } },
      [{ timestamp: 1, type: "custom", name: "checkout.step" }],
      { url: "https://example.com/checkout", userAgent: "test-agent" }
    );

    expect(payload).toEqual({
      sessionId: "session-1",
      reason: { type: "manual", name: "payment-declined", data: { code: "insufficient_funds" } },
      events: [{ timestamp: 1, type: "custom", name: "checkout.step" }],
      meta: {
        url: "https://example.com/checkout",
        userAgent: "test-agent",
        capturedAt: 1700000000000,
      },
    });
  });
});
