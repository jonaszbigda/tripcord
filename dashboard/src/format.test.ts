import { describe, it, expect } from "vitest";
import { formatOffset, safeHref, urlPath } from "./format";

describe("formatOffset", () => {
  it.each([
    [0, "0.0s"],
    [-12_400, "−12.4s"],
    [-185_000, "−3m 05s"],
    [-3_720_000, "−1h 02m"],
    [1_500, "+1.5s"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatOffset(ms)).toBe(text);
  });
});

describe("safeHref", () => {
  it("links http and https only", () => {
    expect(safeHref("https://shop.example.com/a?b=1")).toBe("https://shop.example.com/a?b=1");
    expect(safeHref("http://localhost:3000/")).toBe("http://localhost:3000/");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html,hi")).toBeUndefined();
    expect(safeHref("not a url")).toBeUndefined();
  });
});

describe("urlPath", () => {
  it("shows the path and query, or the raw value if it isn't a URL", () => {
    expect(urlPath("https://shop.example.com/cart?step=2")).toBe("/cart?step=2");
    expect(urlPath("weird")).toBe("weird");
    expect(urlPath(null)).toBe("");
  });
});
