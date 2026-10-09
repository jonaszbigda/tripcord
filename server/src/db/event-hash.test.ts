import { describe, it, expect } from "vitest";
import type { TimelineEvent } from "@tripcord/js";
import { eventDedupeKey, mergeEvents } from "./event-hash";

const ev = (over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  timestamp: 1,
  type: "custom",
  name: "a",
  ...over,
});

describe("eventDedupeKey", () => {
  it("prefers a client-supplied id", () => {
    expect(eventDedupeKey(ev({ id: "x" }))).toBe("x");
  });

  it("falls back to a content hash that ignores key order", () => {
    expect(eventDedupeKey(ev({ data: { a: 1, b: 2 } }))).toBe(
      eventDedupeKey(ev({ data: { b: 2, a: 1 } }))
    );
  });

  it("is stable across nested objects and arrays", () => {
    expect(eventDedupeKey(ev({ data: { outer: { y: 2, x: 1 }, list: [1, 2] } }))).toBe(
      eventDedupeKey(ev({ data: { list: [1, 2], outer: { x: 1, y: 2 } } }))
    );
  });

  it("changes with the timestamp", () => {
    expect(eventDedupeKey(ev({ timestamp: 1 }))).not.toBe(eventDedupeKey(ev({ timestamp: 2 })));
  });

  it("changes with the name", () => {
    expect(eventDedupeKey(ev({ name: "a" }))).not.toBe(eventDedupeKey(ev({ name: "b" })));
  });
});

describe("mergeEvents", () => {
  it("dedupes by id across lists and sorts by timestamp", () => {
    const merged = mergeEvents([
      [ev({ id: "a", timestamp: 2 }), ev({ id: "b", timestamp: 1 })],
      [ev({ id: "a", timestamp: 2 }), ev({ id: "c", timestamp: 3 })],
    ]);
    expect(merged.map((event) => event.id)).toEqual(["b", "a", "c"]);
  });

  it("drops the oldest past the cap", () => {
    const list = [1, 2, 3, 4].map((timestamp) => ev({ id: `e${timestamp}`, timestamp }));
    expect(mergeEvents([list], 3).map((event) => event.id)).toEqual(["e2", "e3", "e4"]);
  });

  it("keeps the whole set when no cap is given", () => {
    const list = [1, 2, 3].map((timestamp) => ev({ id: `e${timestamp}`, timestamp }));
    expect(mergeEvents([list])).toHaveLength(3);
  });

  it("dedupes content-identical events from different sources", () => {
    const merged = mergeEvents([
      [ev({ timestamp: 5, name: "step", source: "browser" })],
      [ev({ timestamp: 5, name: "step", source: "server" })],
    ]);
    expect(merged).toHaveLength(1);
  });
});
