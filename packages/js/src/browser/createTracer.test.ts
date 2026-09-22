/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTracer } from "./createTracer";

describe("browser createTracer", () => {
  let tracers: ReturnType<typeof createTracer>[] = [];

  function trackedCreateTracer(config: Parameters<typeof createTracer>[0]) {
    const tracer = createTracer(config);
    tracers.push(tracer);
    return tracer;
  }

  beforeEach(() => {
    sessionStorage.clear();
    tracers = [];
  });

  afterEach(() => {
    tracers.forEach((t) => t.dispose());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("generates and persists a session id on creation", () => {
    trackedCreateTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    expect(sessionStorage.getItem("__repro_session_id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("track() then capture() sends a payload via fetch", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const tracer = trackedCreateTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    tracer.track("checkout.step", { step: "shipping" });
    tracer.capture("payment-declined");

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reason).toEqual({ type: "manual", name: "payment-declined" });
    expect(body.events).toEqual([
      expect.objectContaining({ type: "custom", name: "checkout.step" }),
    ]);
  });

  it("auto-flushes on a window error event by default", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    trackedCreateTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not auto-flush on error when captureErrors is false", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    trackedCreateTracer({
      endpoint: "https://ingest.example.com/timeline",
      apiKey: "key-123",
      captureErrors: false,
    });
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dispose() stops the auto error hook", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const tracer = trackedCreateTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    tracer.dispose();
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists tracked events to sessionStorage for reload rehydration", () => {
    const tracer = trackedCreateTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    tracer.track("checkout.step", { step: "shipping" });

    const persisted = JSON.parse(sessionStorage.getItem("__repro_buffer")!);
    expect(persisted).toEqual([expect.objectContaining({ type: "custom", name: "checkout.step" })]);
  });
});
