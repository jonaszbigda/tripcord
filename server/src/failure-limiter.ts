// Counts failures per key (e.g. client IP) in a fixed window shared by all keys.
// Unlike @fastify/rate-limit, which counts every request, only recorded
// failures count, so a well-behaved caller is never slowed down.
//
// The whole map is dropped when the window rolls over, which bounds memory to
// the keys seen in one window. In-process only, like the other rate limits: with
// several server instances each keeps its own counts.
export class FailureLimiter {
  private windowStart: number;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {
    this.windowStart = now();
  }

  /** Milliseconds until `key` may try again, or 0 if it isn't blocked. */
  blockedFor(key: string): number {
    this.roll();
    if ((this.counts.get(key) ?? 0) < this.max) {
      return 0;
    }
    return this.windowStart + this.windowMs - this.now();
  }

  recordFailure(key: string): void {
    this.roll();
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  private roll(): void {
    const now = this.now();
    if (now - this.windowStart >= this.windowMs) {
      this.counts.clear();
      this.windowStart = now;
    }
  }
}
