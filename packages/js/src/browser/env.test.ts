import { describe, it, expect } from "vitest";
import { isBrowserEnvironment } from "./env";

describe("isBrowserEnvironment (node)", () => {
  it("returns false when window/document are unavailable", () => {
    expect(isBrowserEnvironment()).toBe(false);
  });
});
