const positionsStarts: number[] = [];
const POSITIONS_WINDOW_MS = 60_000;
export const POSITIONS_LIMIT = 10;

export function positionsBudgetDelayMs(count: number): number {
  if (!Number.isInteger(count) || count < 1 || count > POSITIONS_LIMIT) {
    throw new RangeError('Positions request count must be between 1 and 10');
  }
  const now = Date.now();
  while (positionsStarts.length && now - positionsStarts[0]! >= POSITIONS_WINDOW_MS) positionsStarts.shift();
  const excess = positionsStarts.length + count - POSITIONS_LIMIT;
  return excess <= 0 ? 0 : Math.max(0, positionsStarts[excess - 1]! + POSITIONS_WINDOW_MS - now);
}

export function notePositionsRequests(count: number): boolean {
  if (positionsBudgetDelayMs(count) > 0) return false;
  positionsStarts.push(...Array<number>(count).fill(Date.now()));
  return true;
}
