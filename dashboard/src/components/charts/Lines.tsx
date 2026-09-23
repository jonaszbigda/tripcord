import type { VolumeBucket } from "../../types";
import type { ChartGeometry } from "./ChartFrame";
import type { SeriesDef } from "./series";

export function Lines({
  g,
  buckets,
  series,
  hovered,
}: {
  g: ChartGeometry;
  buckets: VolumeBucket[];
  series: SeriesDef[];
  hovered: number | null;
}) {
  return (
    <g>
      {series.map((s) => (
        <path
          key={s.key}
          data-series={s.key}
          d={buckets.map((b, i) => `${i === 0 ? "M" : "L"}${g.cx(i)},${g.y(b[s.key])}`).join("")}
          fill="none"
          stroke={s.color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {hovered !== null && (
        <g>
          <line
            x1={g.cx(hovered)}
            x2={g.cx(hovered)}
            y1={0}
            y2={g.height}
            stroke="var(--color-muted)"
            strokeDasharray="3 3"
          />
          {series.map((s) => (
            <circle
              key={s.key}
              cx={g.cx(hovered)}
              cy={g.y(buckets[hovered][s.key])}
              r={4}
              fill={s.color}
              stroke="var(--color-surface)"
              strokeWidth={2}
            />
          ))}
        </g>
      )}
    </g>
  );
}
