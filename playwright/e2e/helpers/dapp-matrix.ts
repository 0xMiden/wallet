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
 * Each is the higher of the spec's initial testnet value (about 2x its estimate, section 6) and the spike's value
 * recomputed from measured unit costs. None recomputed higher, and reads and refusals went unmeasured, so these are
 * the initial values. A part's journeys stay under the workflow's 140-min run step: core 125 min, writes 130 min.
 */
export const JOURNEY_TIMEOUT_MS: Record<JourneyId, number> = {
  S: 20 * 60_000,
  R: 45 * 60_000,
  W: 60 * 60_000,
  X: 45 * 60_000,
  XL: 25 * 60_000,
  M: 60 * 60_000
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
  W: both('W1'),
  R: [],
  X: [],
  XL: [],
  M: []
};

export const cellIdsFor = (journey: JourneyId, axis: AxisLabel): string[] =>
  DAPP_JOURNEY_CELLS[journey].filter(cell => cell.axes.includes(axis)).map(cell => cell.id);
