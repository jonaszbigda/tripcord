import { describe, it, expect, vi, afterEach } from "vitest";
import { pageUrl, stripQueryAndHash } from "./url";

const PAGE = "https://shop.example.com/checkout/pay?token=abc&email=a%40b.c#step-2";

describe("stripQueryAndHash", () => {
  it("keeps the origin and path only", () => {
    expect(stripQueryAndHash(new URL(PAGE))).toBe("https://shop.example.com/checkout/pay");
  });
});

describe("pageUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips the query and fragment by default", () => {
    expect(pageUrl(PAGE)).toBe("https://shop.example.com/checkout/pay");
  });

  it("uses the developer's sanitizer when given one", () => {
    const keepStep = (url: URL) => `${url.origin}${url.pathname}?step=${url.hash.slice(1)}`;
    expect(pageUrl(PAGE, keepStep)).toBe("https://shop.example.com/checkout/pay?step=step-2");
  });

  it("falls back to the default, with a warning, when the sanitizer throws or returns a non-string", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwing = () => {
      throw new Error("oops");
    };
    expect(pageUrl(PAGE, throwing)).toBe("https://shop.example.com/checkout/pay");
    expect(pageUrl(PAGE, () => 42 as unknown as string)).toBe("https://shop.example.com/checkout/pay");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
