import { describe, it, expect } from "vitest";
import * as pkg from "../dist/index.js";
import * as reactPkg from "../dist/react.js";

describe("built package exports", () => {
  it("exposes the public API from the built entry point", () => {
    expect(typeof pkg.init).toBe("function");
    expect(typeof pkg.track).toBe("function");
    expect(typeof pkg.capture).toBe("function");
    expect(typeof pkg.createTracer).toBe("function");
    expect(typeof pkg.redact).toBe("function");
    expect(typeof pkg.setTags).toBe("function");
    expect(typeof pkg.clearTags).toBe("function");
  });

  it("exposes ErrorBoundary from the built react entry point", () => {
    expect(typeof reactPkg.ErrorBoundary).toBe("function");
  });
});
