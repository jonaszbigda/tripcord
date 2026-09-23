import type { VolumeBucket } from "../../types";
import type { ChartGeometry } from "./ChartFrame";
import type { SeriesDef } from "./series";

const GAP = 2; // surface-colored gap between stacked segments
const RADIUS = 4; // rounded data end; the base stays square on the baseline

function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function StackedBars({ g, buckets, series }: { g: ChartGeometry; buckets: VolumeBucket[]; series: SeriesDef[] }) {
  const barWidth = Math.max(2, Math.min(g.bandWidth - 2, g.bandWidth * 0.7, 40));
  return (
    <g>
      {buckets.map((bucket, i) => {
        const x = g.cx(i) - barWidth / 2;
        const present = series.filter((s) => bucket[s.key] > 0);
        let top = g.height;
        return (
          <g key={bucket.start}>
            {present.map((s, j) => {
              const h = g.height - g.y(bucket[s.key]);
              const y = top - h;
              // The gap comes out of the upper segment, so the stack's total
              // height stays true to the total count.
              const height = Math.max(0, h - (j === 0 ? 0 : GAP));
              top = y;
              return j === present.length - 1 ? (
                <path key={s.key} data-series={s.key} d={roundedTop(x, y, barWidth, height)} fill={s.color} />
              ) : (
                <rect key={s.key} data-series={s.key} x={x} y={y} width={barWidth} height={height} fill={s.color} />
              );
            })}
          </g>
        );
      })}
    </g>
  );
}
