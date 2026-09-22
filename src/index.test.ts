import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const trackMock = vi.fn();
const captureMock = vi.fn();
const disposeMock = vi.fn();
const createTracerMock = vi.fn(() => ({
  track: trackMock,
  capture: captureMock,
  dispose: disposeMock,
}));

vi.mock("./browser/createTracer", () => ({
  createTracer: createTracerMock,
}));

describe("public entry point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns and no-ops if track()/capture() are called before init()", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { track, capture } = await import("./index");

    track("checkout.step");
    capture("payment-declined");

    expect(trackMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("delegates track()/capture() to the created tracer after init()", async () => {
    const { init, track, capture } = await import("./index");

    init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    track("checkout.step", { step: "shipping" });
    capture("payment-declined");

    expect(trackMock).toHaveBeenCalledWith("checkout.step", { step: "shipping" });
    expect(captureMock).toHaveBeenCalledWith("payment-declined", undefined);
  });

  it("disposes the previous instance and warns when init() is called twice", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { init } = await import("./index");

    init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-456" });

    expect(disposeMock).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(createTracerMock).toHaveBeenCalledTimes(2);
  });

  it("init() returns a dispose() that tears down the instance", async () => {
    const { init, track } = await import("./index");

    const handle = init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    handle.dispose();

    expect(disposeMock).toHaveBeenCalledOnce();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    track("checkout.step");
    expect(trackMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
