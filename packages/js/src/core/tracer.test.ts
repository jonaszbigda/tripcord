import { describe, it, expect, vi, afterEach } from "vitest";
import { createTracer } from "./tracer";
import type { TimelinePayload } from "./types";

function setup() {
  const send = vi.fn<(payload: TimelinePayload) => void>();
  const getMeta = vi.fn(() => ({ url: "https://example.com", userAgent: "test-agent" }));
  const tracer = createTracer({ sessionId: "session-1", send, getMeta });
  return { send, getMeta, tracer };
}

describe("createTracer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("track() appends to the buffer without sending", () => {
    const { send, tracer } = setup();
    tracer.track("checkout.step", { step: "shipping" });
    expect(send).not.toHaveBeenCalled();
  });

  it("capture() flushes the buffer with a manual reason", () => {
    const { send, tracer } = setup();
    tracer.track("checkout.step", { step: "shipping" });
    tracer.capture("payment-declined", { code: "insufficient_funds" });

    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0][0];
    expect(payload.sessionId).toBe("session-1");
    expect(payload.reason).toEqual({
      type: "manual",
      name: "payment-declined",
      data: { code: "insufficient_funds" },
    });
    expect(payload.events).toEqual([
      expect.objectContaining({ type: "custom", name: "checkout.step" }),
    ]);
  });

  it("captureError() flushes with an error reason", () => {
    const { send, tracer } = setup();
    tracer.captureError("Cannot read properties of undefined");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].reason).toEqual({
      type: "error",
      message: "Cannot read properties of undefined",
    });
  });

  it("captureUnhandledRejection() flushes with an unhandledrejection reason", () => {
    const { send, tracer } = setup();
    tracer.captureUnhandledRejection("network request failed");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].reason).toEqual({
      type: "unhandledrejection",
      message: "network request failed",
    });
  });

  it("traceElement() appends a trace-typed event to the buffer without sending", () => {
    const { send, tracer } = setup();
    tracer.traceElement("Sign up form submit");
    expect(send).not.toHaveBeenCalled();

    tracer.capture();
    expect(send.mock.calls[0][0].events).toEqual([
      expect.objectContaining({ type: "trace", name: "Sign up form submit" }),
    ]);
  });

  it("calls onBufferChange with the full buffer after every track() and traceElement()", () => {
    const onBufferChange = vi.fn();
    const tracer = createTracer({
      sessionId: "session-1",
      send: vi.fn(),
      getMeta: () => ({ url: "https://example.com", userAgent: "test-agent" }),
      onBufferChange,
    });

    tracer.track("checkout.step");
    expect(onBufferChange).toHaveBeenCalledOnce();
    expect(onBufferChange.mock.calls[0][0]).toHaveLength(1);

    tracer.traceElement("Sign up button");
    expect(onBufferChange).toHaveBeenCalledTimes(2);
    expect(onBufferChange.mock.calls[1][0]).toHaveLength(2);
  });

  it("warns via console.warn when track() data has a risky key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tracer } = setup();
    tracer.track("login", { password: "hunter2" });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("capture() sends scope tags ∪ capture tags", () => {
    const { send, tracer } = setup();
    tracer.setTags(["checkout"]);
    tracer.capture("payment-declined", undefined, { tags: ["payments", "checkout"] });
    expect(send.mock.calls[0][0].tags).toEqual(["checkout", "payments"]);
  });

  it("auto-captured errors and rejections carry the scope tags", () => {
    const { send, tracer } = setup();
    tracer.setTags(["video_player"]);
    tracer.captureError("boom");
    tracer.captureUnhandledRejection("nope");
    expect(send.mock.calls.map((call) => call[0].tags)).toEqual([["video_player"], ["video_player"]]);
  });

  it("setTags() replaces the scope rather than adding to it", () => {
    const { send, tracer } = setup();
    tracer.setTags(["checkout"]);
    tracer.setTags(["shopping_cart"]);
    tracer.captureError("boom");
    expect(send.mock.calls[0][0].tags).toEqual(["shopping_cart"]);
  });

  it("ignores capture tags that aren't an array, with a warning, instead of splitting a string", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { send, tracer } = setup();
    tracer.setTags(["checkout"]);
    tracer.capture("x", undefined, { tags: "payments" as unknown as string[] });
    expect(send.mock.calls[0][0].tags).toEqual(["checkout"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("clearTags() empties the scope, and an untagged payload has no tags field", () => {
    const { send, tracer } = setup();
    tracer.setTags(["checkout"]);
    tracer.clearTags();
    tracer.capture("payment-declined");
    expect(send.mock.calls[0][0]).not.toHaveProperty("tags");
  });
});
