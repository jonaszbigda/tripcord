import type { ReasonType } from "./types";

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export const REASON_LABELS: Record<ReasonType, string> = {
  error: "Error",
  unhandledrejection: "Unhandled rejection",
  manual: "Manual",
};

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 minutes ago", "yesterday"; the absolute time belongs in a title. */
export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86400), "day");
}

/** An event's time relative to the capture: "−12.4s", "−3m 05s", "−1h 02m". */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? "−" : ms > 0 ? "+" : "";
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(1)}s`;
  const seconds = Math.floor(abs / 1000);
  if (abs < 3_600_000) return `${sign}${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${sign}${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

/** Path and query of a captured http(s) URL; anything else is shown whole. */
export function urlPath(url: string | null): string {
  if (url === null) return "";
  try {
    const parsed = new URL(url);
    // A javascript: or data: "path" would hide what the URL really is.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

/** An href only for http(s) URLs. Captured URLs come from browsers and are untrusted. */
export function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
