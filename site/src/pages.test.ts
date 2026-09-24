import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
// URL path → source file. Every internal link must land on one of these.
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/beta/": "beta/index.html",
  "/privacy/": "privacy/index.html",
};

function html(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

describe("site pages", () => {
  for (const [url, file] of Object.entries(PAGES)) {
    describe(url, () => {
      const source = html(file);

      it("has a title and a description", () => {
        expect(source).toMatch(/<title>[^<]+<\/title>/);
        expect(source).toMatch(/<meta\s+name="description"\s+content="[^"]+"/);
      });

      it("links only to pages and anchors that exist", () => {
        for (const [, href] of source.matchAll(/href="(\/[^"]*)"/g)) {
          if (href.startsWith("/favicon") || href.startsWith("/src/")) continue;
          const [pathname, anchor] = href.split("#");
          const target = PAGES[pathname];
          expect(target, `${file} links to ${href}`).toBeDefined();
          if (anchor) {
            expect(html(target), `${href} anchor`).toContain(`id="${anchor}"`);
          }
        }
      });

      it("has no placeholders left", () => {
        expect(source).not.toMatch(/TODO|TBD|\[region\]/);
      });

      it("loads no third-party scripts or analytics", () => {
        for (const [, src] of source.matchAll(/<script[^>]*src="([^"]+)"/g)) {
          expect(src.startsWith("/")).toBe(true);
        }
      });
    });
  }

  it("publishes the custom domain", () => {
    expect(readFileSync(path.join(ROOT, "public", "CNAME"), "utf8").trim()).toBe("tripcord.dev");
    expect(existsSync(path.join(ROOT, "public", "favicon.svg"))).toBe(true);
  });
});
