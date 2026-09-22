import { describe, it, expect } from "vitest";
import { VERSION } from "./index";

describe("server toolchain smoke test", () => {
  it("exports a version string", () => {
    expect(VERSION).toBe("0.0.1");
  });
});
