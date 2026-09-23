import type { ReactNode } from "react";

export const CHART_HEIGHT = 220;
export const MARGIN = { top: 8, right: 12, bottom: 24, left: 40 };

/** Plot-area coordinates; (0, 0) is the plot's top-left corner. */
export interface ChartGeometry {
  width: number;
  height: number;
  bandWidth: number;
  /** Left edge of bucket i's band. */
  x(i: number): number;
  /** Center of bucket i's band. */
  cx(i: number): number;
  y(value: number): number;
}

export function chartGeometry(width: number, count: number, yMax: number): ChartGeometry {
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const bandWidth = count > 0 ? plotWidth / count : plotWidth;
  return {
    width: plotWidth,
    height: plotHeight,
    bandWidth,
    x: (i) => i * bandWidth,
    cx: (i) => i * bandWidth + bandWidth / 2,
    y: (value) => plotHeight - (value / yMax) * plotHeight,
  };
}

interface ChartFrameProps {
  width: number;
  geometry: ChartGeometry;
  ticks: number[];
  labels: string[];
  label: string;
  onHover: (index: number | null) => void;
  children: ReactNode;
}

// What both chart types share: a recessive grid with y ticks, sparse x labels,
// and one full-height hover target per bucket (larger than any mark). Marks are
// drawn by the children, in plot coordinates.
export function ChartFrame({ width, geometry: g, ticks, labels, label, onHover, children }: ChartFrameProps) {
  // At most 6 x labels, and fewer on narrow screens: about 72px per label.
  const maxLabels = Math.max(2, Math.min(6, Math.floor(g.width / 72)));
  const every = Math.max(1, Math.ceil(labels.length / maxLabels));
  return (
    <svg width={width} height={CHART_HEIGHT} role="img" aria-label={label} className="block">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={0} x2={g.width} y1={g.y(tick)} y2={g.y(tick)} stroke="var(--color-border)" />
            <text x={-8} y={g.y(tick)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--color-muted)">
              {tick}
            </text>
          </g>
        ))}
        {children}
        {labels.map((text, i) =>
          i % every === 0 ? (
            <text key={i} x={g.cx(i)} y={g.height + 16} textAnchor="middle" fontSize={11} fill="var(--color-muted)">
              {text}
            </text>
          ) : null
        )}
        <g onMouseLeave={() => onHover(null)}>
          {labels.map((_, i) => (
            <rect
              key={i}
              data-testid="chart-hover-target"
              x={g.x(i)}
              y={0}
              width={g.bandWidth}
              height={g.height}
              fill="transparent"
              onMouseEnter={() => onHover(i)}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}
