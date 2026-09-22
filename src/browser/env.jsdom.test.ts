/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { isBrowserEnvironment } from "./env";

describe("isBrowserEnvironment (jsdom)", () => {
  it("returns true when window/document are available", () => {
    expect(isBrowserEnvironment()).toBe(true);
  });
});
