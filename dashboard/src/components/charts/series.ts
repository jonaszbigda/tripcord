import { REASON_LABELS } from "../../format";
import type { ReasonType } from "../../types";

export interface SeriesDef {
  key: ReasonType;
  label: string;
  color: string;
}

export const SERIES_COLORS: Record<ReasonType, string> = {
  error: "var(--color-series-error)",
  unhandledrejection: "var(--color-series-rejection)",
  manual: "var(--color-series-manual)",
};

// A fixed order and color per reason type: filtering one out never repaints
// the others. Bars stack in this order, bottom first.
export const SERIES: SeriesDef[] = (["error", "unhandledrejection", "manual"] as const).map((key) => ({
  key,
  label: REASON_LABELS[key],
  color: SERIES_COLORS[key],
}));
