/**
 * The title chart's axis step (docs/design/dashboard-ui.md "Title chart"):
 * four equal ticks on a 1, 2, or 5 step above the series maximum — the
 * smallest (1|2|5)×10^k whose fourth multiple covers the maximum. Past the
 * table's end the largest step stands, so the axis always has a unit.
 */
export function axisStep(max: number): number {
  for (const magnitude of [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000]) {
    for (const step of [1, 2, 5]) {
      if (4 * step * magnitude >= max) {
        return step * magnitude;
      }
    }
  }
  return 1_000_000;
}
