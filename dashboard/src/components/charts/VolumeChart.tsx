import { useLayoutEffect, useRef, useState } from "react";
import type { TimelineSummary, VolumeBucket } from "../../types";
import { Button, Segmented, Swatch } from "../ui";
import { ChartFrame, MARGIN, chartGeometry } from "./ChartFrame";
import { Lines } from "./Lines";
import { niceTicks } from "./scale";
import type { SeriesDef } from "./series";
import { StackedBars } from "./StackedBars";

type Mode = "bars" | "lines";
const MODE_KEY = "repro.chartMode";
const FALLBACK_WIDTH = 640;

// The chart type is a per-viewer convenience: storage may be blocked, and the
// chart must render either way.
function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "lines" ? "lines" : "bars";
  } catch {
    return "bars";
  }
}

function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.clientWidth > 0) setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function bucketLabel(start: string, unit: "hour" | "day"): string {
  const date = new Date(start);
  return unit === "hour"
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function bucketTitle(start: string, unit: "hour" | "day"): string {
  const date = new Date(start);
  return unit === "hour"
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function total(bucket: VolumeBucket, series: SeriesDef[]): number {
  return series.reduce((sum, s) => sum + bucket[s.key], 0);
}

export function VolumeChart({ summary, series }: { summary: TimelineSummary; series: SeriesDef[] }) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [showTable, setShowTable] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();
  const { buckets, bucket: unit } = summary;

  const peak = Math.max(
    0,
    ...buckets.map((b) => (mode === "bars" ? total(b, series) : Math.max(0, ...series.map((s) => b[s.key]))))
  );
  const ticks = niceTicks(peak);
  const g = chartGeometry(width, buckets.length, ticks[ticks.length - 1]);
  const hoveredBucket = hovered === null ? undefined : buckets[hovered];
  // Keep the tooltip inside the chart near either edge.
  const align =
    hovered === null || hovered < buckets.length / 5
      ? ""
      : hovered >= (buckets.length * 4) / 5
        ? "-translate-x-full"
        : "-translate-x-1/2";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ul aria-label="Legend" className="flex flex-wrap gap-4 text-sm text-muted">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <Swatch color={s.color} />
              {s.label}
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <Segmented
            label="Chart type"
            options={[
              ["bars", "Bars"],
              ["lines", "Lines"],
            ]}
            value={mode}
            onChange={(next) => {
              setMode(next);
              saveMode(next);
            }}
          />
          <Button variant="secondary" aria-pressed={showTable} onClick={() => setShowTable((shown) => !shown)}>
            {showTable ? "Show chart" : "Show table"}
          </Button>
        </div>
      </div>

      {/* Kept mounted while the table shows, so its width stays measured. */}
      <div ref={ref} className={showTable ? "hidden" : "relative"}>
        <ChartFrame
          width={width}
          geometry={g}
          ticks={ticks}
          labels={buckets.map((b) => bucketLabel(b.start, unit))}
          label={`Timelines per ${unit}`}
          onHover={setHovered}
        >
          {mode === "bars" ? (
            <StackedBars g={g} buckets={buckets} series={series} />
          ) : (
            <Lines g={g} buckets={buckets} series={series} hovered={hovered} />
          )}
        </ChartFrame>
        {hoveredBucket && hovered !== null && (
          <div
            role="tooltip"
            className={`pointer-events-none absolute top-0 z-10 min-w-40 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-sm ${align}`}
            style={{ left: MARGIN.left + g.cx(hovered) }}
          >
            <p className="mb-1 font-medium text-fg">{bucketTitle(hoveredBucket.start, unit)}</p>
            {series.map((s) => (
              <p key={s.key} className="flex items-center gap-2 text-muted">
                <Swatch color={s.color} />
                <span className="whitespace-nowrap">{s.label}</span>
                <span className="ml-auto pl-3 font-medium tabular-nums text-fg">{hoveredBucket[s.key]}</span>
              </p>
            ))}
            {series.length > 1 && (
              <p className="mt-1 flex border-t border-border pt-1 text-muted">
                <span>Total</span>
                <span className="ml-auto pl-3 font-medium tabular-nums text-fg">{total(hoveredBucket, series)}</span>
              </p>
            )}
          </div>
        )}
      </div>

      {showTable && (
        <table className="w-full text-sm">
          <caption className="sr-only">Timelines per {unit}</caption>
          <thead>
            <tr className="text-left text-muted">
              <th className="py-2 font-medium">{unit === "hour" ? "Hour" : "Day"}</th>
              {series.map((s) => (
                <th key={s.key} className="text-right font-medium">
                  {s.label}
                </th>
              ))}
              <th className="text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.start} className="border-t border-border">
                <td className="py-1.5">{bucketTitle(b.start, unit)}</td>
                {series.map((s) => (
                  <td key={s.key} className="text-right tabular-nums">
                    {b[s.key]}
                  </td>
                ))}
                <td className="text-right tabular-nums">{total(b, series)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
