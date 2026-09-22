import { describe, it, expect } from "vitest";
import { createBuffer } from "./buffer";

describe("createBuffer", () => {
  it("returns pushed events in insertion order", () => {
    const buffer = createBuffer(50);
    buffer.push({ timestamp: 1, type: "custom", name: "a" });
    buffer.push({ timestamp: 2, type: "custom", name: "b" });
    expect(buffer.getAll()).toEqual([
      { timestamp: 1, type: "custom", name: "a" },
      { timestamp: 2, type: "custom", name: "b" },
    ]);
  });

  it("drops the oldest event once maxEvents is exceeded", () => {
    const buffer = createBuffer(2);
    buffer.push({ timestamp: 1, type: "custom", name: "a" });
    buffer.push({ timestamp: 2, type: "custom", name: "b" });
    buffer.push({ timestamp: 3, type: "custom", name: "c" });
    expect(buffer.getAll()).toEqual([
      { timestamp: 2, type: "custom", name: "b" },
      { timestamp: 3, type: "custom", name: "c" },
    ]);
  });

  it("trims seedEvents to maxEvents on creation", () => {
    const seed = [
      { timestamp: 1, type: "custom" as const, name: "a" },
      { timestamp: 2, type: "custom" as const, name: "b" },
      { timestamp: 3, type: "custom" as const, name: "c" },
    ];
    const buffer = createBuffer(2, seed);
    expect(buffer.getAll()).toEqual([seed[1], seed[2]]);
  });
});
