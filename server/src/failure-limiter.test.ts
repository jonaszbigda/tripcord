import { describe, it, expect } from "vitest";
import { FailureLimiter } from "./failure-limiter";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("FailureLimiter", () => {
  it("blocks a key once it reaches max failures, until the window rolls over", () => {
    const time = clock();
    const limiter = new FailureLimiter(2, 60_000, time.now);

    limiter.recordFailure("a");
    expect(limiter.blockedFor("a")).toBe(0);
    limiter.recordFailure("a");
    time.advance(15_000);
    expect(limiter.blockedFor("a")).toBe(45_000);

    time.advance(45_000);
    expect(limiter.blockedFor("a")).toBe(0);
  });

  it("counts each key separately", () => {
    const limiter = new FailureLimiter(1, 60_000, clock().now);
    limiter.recordFailure("a");
    expect(limiter.blockedFor("a")).toBeGreaterThan(0);
    expect(limiter.blockedFor("b")).toBe(0);
  });
});
