import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const trackMock = vi.fn();
const captureMock = vi.fn();
const disposeMock = vi.fn();
const setTagsMock = vi.fn();
const clearTagsMock = vi.fn();
const createTracerMock = vi.fn(() => ({
  track: trackMock,
  capture: captureMock,
  setTags: setTagsMock,
  clearTags: clearTagsMock,
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
    expect(captureMock).toHaveBeenCalledWith("payment-declined", undefined, undefined);
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

  it("disposing a stale handle from an earlier init() does not tear down the current instance", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { init, track } = await import("./index");

    const firstHandle = init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    const secondHandle = init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-456" });
    void secondHandle;

    vi.clearAllMocks();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Disposing the FIRST (now-stale) handle must not tear down the currently
    // active (second) instance.
    firstHandle.dispose();

    track("checkout.step");

    expect(trackMock).toHaveBeenCalledWith("checkout.step", undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and no-ops if setTags()/clearTags() are called before init()", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { setTags, clearTags } = await import("./index");

    setTags(["checkout"]);
    clearTags();

    expect(setTagsMock).not.toHaveBeenCalled();
    expect(clearTagsMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("delegates setTags()/clearTags() and capture options after init()", async () => {
    const { init, setTags, clearTags, capture } = await import("./index");

    init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    setTags(["checkout"]);
    capture("payment-declined", { code: "x" }, { tags: ["payments"] });
    clearTags();

    expect(setTagsMock).toHaveBeenCalledWith(["checkout"]);
    expect(captureMock).toHaveBeenCalledWith("payment-declined", { code: "x" }, { tags: ["payments"] });
    expect(clearTagsMock).toHaveBeenCalledOnce();
  });
});
