const positionsStarts: number[] = [];
const POSITIONS_WINDOW_MS = 60_000;
export const POSITIONS_LIMIT = 10;
export const POSITIONS_REVIEW_RESERVE = 2;
export const POSITIONS_PAGE_LIMIT = POSITIONS_LIMIT - POSITIONS_REVIEW_RESERVE;

export function positionsBudgetDelayMs(count: number, limit = POSITIONS_LIMIT): number {
  if (!Number.isInteger(count) || count < 1 || count > limit) {
    throw new RangeError(`Positions request count must be between 1 and ${limit}`);
  }
  const now = Date.now();
  while (positionsStarts.length && now - positionsStarts[0]! >= POSITIONS_WINDOW_MS) positionsStarts.shift();
  const excess = positionsStarts.length + count - limit;
  return excess <= 0 ? 0 : Math.max(0, positionsStarts[excess - 1]! + POSITIONS_WINDOW_MS - now);
}

export function notePositionsRequests(count: number, limit = POSITIONS_LIMIT): boolean {
  if (positionsBudgetDelayMs(count, limit) > 0) return false;
  positionsStarts.push(...Array<number>(count).fill(Date.now()));
  return true;
}
