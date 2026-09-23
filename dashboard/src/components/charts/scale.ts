/**
 * Round y-axis ticks from 0 up to at least `max`, in steps of 1, 2 or 5 × 10ⁿ,
 * never below 1 because counts are whole. Aims for about `target` steps.
 */
export function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) {
    return [0, 1];
  }
  const rough = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const candidate = [1, 2, 5, 10].map((m) => m * magnitude).find((step) => step >= rough) ?? 10 * magnitude;
  const step = Math.max(1, candidate);
  const ticks: number[] = [];
  for (let value = 0; ; value += step) {
    ticks.push(value);
    if (value >= max) {
      return ticks;
    }
  }
}
