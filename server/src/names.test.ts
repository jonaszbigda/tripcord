import { describe, it, expect } from "vitest";
import { hasControlChars, stripControlChars } from "./names";

describe("names", () => {
  it.each(["a\nb", "a\tb", "\x1b[31mred", "a\x7fb", "a\u0085b"])("flags %j", (value) => {
    expect(hasControlChars(value)).toBe(true);
  });

  it.each(["Acme", "Zoë's org", "👩‍💻 team", "日本"])("accepts %j", (value) => {
    expect(hasControlChars(value)).toBe(false);
  });

  it("strips control characters and keeps the rest", () => {
    expect(stripControlChars("\x1b[31mAna\n")).toBe("[31mAna");
  });
});
