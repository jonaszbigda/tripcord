import { describe, it, expect } from "vitest";
import { filtersFromParams, filtersToParams } from "./timelineFilters";

describe("timeline filters", () => {
  it("defaults to 7 days and everything", () => {
    expect(filtersFromParams(new URLSearchParams())).toEqual({ range: "7d", reasonTypes: [], tags: [], reason: null });
  });

  it("reads repeated params, in a stable order", () => {
    const params = new URLSearchParams("range=24h&reasonType=manual&reasonType=error&tag=checkout&tag=payments&reason=" + "a".repeat(32));
    expect(filtersFromParams(params)).toEqual({
      range: "24h",
      reasonTypes: ["error", "manual"],
      tags: ["checkout", "payments"],
      reason: "a".repeat(32),
    });
  });

  it("drops values the API would reject instead of sending them", () => {
    const params = new URLSearchParams("range=1y&reasonType=fatal&tag=Checkout&tag=ok&tag=ok&reason=nope");
    expect(filtersFromParams(params)).toEqual({ range: "7d", reasonTypes: [], tags: ["ok"], reason: null });
  });

  it("leaves defaults out when writing params", () => {
    expect(filtersToParams({ range: "7d", reasonTypes: [], tags: [], reason: null }).toString()).toBe("");
    expect(filtersToParams({ range: "30d", reasonTypes: ["error"], tags: ["a", "b"], reason: null }).toString()).toBe(
      "range=30d&reasonType=error&tag=a&tag=b"
    );
  });
});
