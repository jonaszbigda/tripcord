import { useSearchParams } from "react-router";
import type { Range, ReasonType } from "./types";

export const RANGES: Range[] = ["24h", "7d", "30d"];
export const REASON_TYPES: ReasonType[] = ["error", "unhandledrejection", "manual"];
const DEFAULT_RANGE: Range = "7d";
// The server's tag rule. A hand-edited URL with an invalid tag drops the tag
// instead of turning every request into a 400.
const TAG = /^[a-z0-9][a-z0-9_.:-]{0,49}$/;
const REASON_KEY = /^[0-9a-f]{32}$/;

export interface TimelineFilters {
  range: Range;
  /** Empty means every type. */
  reasonTypes: ReasonType[];
  /** Any-of. */
  tags: string[];
  /** A top-reasons key. */
  reason: string | null;
}

export function filtersFromParams(params: URLSearchParams): TimelineFilters {
  const range = params.get("range") as Range | null;
  const reason = params.get("reason");
  return {
    range: range !== null && RANGES.includes(range) ? range : DEFAULT_RANGE,
    // Filtered from REASON_TYPES so the order (and the query key) is stable.
    reasonTypes: REASON_TYPES.filter((type) => params.getAll("reasonType").includes(type)),
    tags: [...new Set(params.getAll("tag").filter((tag) => TAG.test(tag)))].slice(0, 10),
    reason: reason !== null && REASON_KEY.test(reason) ? reason : null,
  };
}

/** Params for the page URL and the API alike. Defaults are left out. */
export function filtersToParams(filters: TimelineFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.range !== DEFAULT_RANGE) {
    params.set("range", filters.range);
  }
  filters.reasonTypes.forEach((type) => params.append("reasonType", type));
  filters.tags.forEach((tag) => params.append("tag", tag));
  if (filters.reason) {
    params.set("reason", filters.reason);
  }
  return params;
}

/** The filters in the URL, and a setter that replaces the history entry. */
export function useTimelineFilters(): [TimelineFilters, (changes: Partial<TimelineFilters>) => void] {
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);
  const update = (changes: Partial<TimelineFilters>) =>
    setParams(filtersToParams({ ...filters, ...changes }), { replace: true });
  return [filters, update];
}
