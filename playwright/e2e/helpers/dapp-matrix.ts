import type { AxisLabel, JourneyId } from './dapp-cells';

/** The spec's matrix as data: which cells each journey runs on which axis (spec section 3). */

export const JOURNEY_TITLES: Record<JourneyId, string> = {
  S: 'dApp session, reconnect and reads',
  W: 'dApp wallet writes and notes',
  R: 'dApp signing and refusals',
  X: 'dApp custom requests',
  XL: 'dApp custom request across the account history window',
  M: 'dApp accounts and multiple dApps'
};

/**
 * Re-sized from the spike's unit costs measured on testnet (spec section 6): each is the larger of 2x the journey's
 * estimate and the estimate plus 9 min, three public-faucet grants each waiting out the helper's 180 s 429 budget.
 * A part's journeys sum to 90 min, under the workflow's 140-min run step.
 */
export const JOURNEY_TIMEOUT_MS: Record<JourneyId, number> = {
  S: 20 * 60_000,
  R: 30 * 60_000,
  W: 40 * 60_000,
  X: 30 * 60_000,
  XL: 20 * 60_000,
  M: 40 * 60_000
};

/** The axis suffix is what the workflow's `--grep " - <axis> account"` selects a leg by. */
export const journeyTitle = (journey: JourneyId, axis: AxisLabel): string =>
  `${JOURNEY_TITLES[journey]} - ${axis} account`;

type CellList = ReadonlyArray<{ id: string; axes: readonly AxisLabel[] }>;
const BOTH: readonly AxisLabel[] = ['offchain', 'guardian'];
const both = (...ids: string[]): CellList => ids.map(id => ({ id, axes: BOTH }));

/** In run order. An empty list is a journey with no spec yet, which the axis coverage test does not look for. */
export const DAPP_JOURNEY_CELLS: Record<JourneyId, CellList> = {
  S: both('S1', 'S2'),
  W: [],
  R: [],
  X: [],
  XL: [],
  M: []
};

export const cellIdsFor = (journey: JourneyId, axis: AxisLabel): string[] =>
  DAPP_JOURNEY_CELLS[journey].filter(cell => cell.axes.includes(axis)).map(cell => cell.id);
