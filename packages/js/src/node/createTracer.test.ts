import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTracer, createSessionId } from "./createTracer";

type FetchMock = ReturnType<typeof vi.fn>;

function bodies(fetchMock: FetchMock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>);
}

describe("Node createTracer", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stages each track to /v1/events with source server", async () => {
    const tracer = createTracer({ endpoint: "https://x/v1/timeline", apiKey: "k" });
    tracer.track("job.started", { id: 1 });
    await tracer.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://x/v1/events");
    expect((init as { headers: Record<string, string> }).headers["X-Tripcord-Key"]).toBe("k");

    const body = bodies(fetchMock)[0];
    expect(body.sessionId).toBe(tracer.getSessionId());
    expect((body.events as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "job.started",
      type: "custom",
      source: "server",
      data: { id: 1 },
    });
    expect((body.events as Array<Record<string, unknown>>)[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("captures with the reason and no events when staging", async () => {
    const tracer = createTracer({ endpoint: "https://x/v1/timeline", apiKey: "k" });
    tracer.track("a");
    tracer.capture("boom", { code: 1 });
    await tracer.flush();

    const capture = bodies(fetchMock).find((body) => body.reason !== undefined);
    expect(capture?.reason).toEqual({ type: "manual", name: "boom", data: { code: 1 } });
    expect(capture?.events).toEqual([]);
    expect(capture?.meta).toEqual({ url: "", userAgent: "", capturedAt: expect.any(Number) });
  });

  it("ships the buffer on capture when stageEvents is false", async () => {
    const tracer = createTracer({ endpoint: "https://x/v1/timeline", apiKey: "k", stageEvents: false });
    tracer.track("a");
    tracer.capture("boom");
    await tracer.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = bodies(fetchMock)[0];
    expect((body.events as Array<{ name: string }>).map((event) => event.name)).toEqual(["a"]);
  });

  it("adopts a supplied sessionId and exposes tracked events", () => {
    const tracer = createTracer({ endpoint: "https://x/v1/timeline", apiKey: "k", sessionId: "s1" });
    tracer.track("a");
    expect(tracer.getSessionId()).toBe("s1");
    expect(tracer.getEvents().map((event) => event.name)).toEqual(["a"]);
  });

  it("merges scope tags with capture tags", async () => {
    const tracer = createTracer({ endpoint: "https://x/v1/timeline", apiKey: "k" });
    tracer.setTags(["checkout"]);
    tracer.capture("boom", undefined, { tags: ["payments"] });
    await tracer.flush();
    expect(bodies(fetchMock)[0].tags).toEqual(["checkout", "payments"]);
  });

  it("warns on a failed send and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const tracer = createTracer({ endpoint: "https://x/v1/timeline", apiKey: "k" });

    expect(() => tracer.track("a")).not.toThrow();
    await expect(tracer.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("requires eventsEndpoint when the endpoint isn't a /timeline URL", () => {
    expect(() => createTracer({ endpoint: "https://x/ingest", apiKey: "k" })).toThrow(/eventsEndpoint/);
    expect(() => createTracer({ endpoint: "https://x/ingest", apiKey: "k", eventsEndpoint: "https://x/e" })).not.toThrow();
  });

  it("createSessionId returns a v4-shaped id", () => {
    expect(createSessionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
