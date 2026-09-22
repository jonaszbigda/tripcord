import { describe, it, expect } from "vitest";
import { createTracer } from "./createTracer";

describe("browser createTracer (non-browser environment)", () => {
  it("returns a no-op tracer instead of throwing", () => {
    const tracer = createTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    expect(() => tracer.track("checkout.step")).not.toThrow();
    expect(() => tracer.capture("payment-declined")).not.toThrow();
    expect(() => tracer.dispose()).not.toThrow();
  });
});
