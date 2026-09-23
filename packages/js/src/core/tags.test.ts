import { describe, it, expect, vi, afterEach } from "vitest";
import { MAX_TAGS, normalizeTags } from "./tags";

describe("normalizeTags", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("trims, lowercases and de-duplicates, keeping first-seen order", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeTags([" Checkout ", "video_player", "checkout"])).toEqual(["checkout", "video_player"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts the documented punctuation", () => {
    expect(normalizeTags(["a:b", "v1.2", "a-b_c", "9lives"])).toEqual(["a:b", "v1.2", "a-b_c", "9lives"]);
  });

  it("drops invalid tags with one warning each", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeTags(["ok", "has space", "", "-lead", "x".repeat(51), 42])).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it(`keeps the first ${MAX_TAGS} tags and warns once`, () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tags = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(normalizeTags(tags)).toEqual(tags.slice(0, MAX_TAGS));
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns [] with a warning for a non-array", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeTags("checkout")).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
