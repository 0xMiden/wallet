import type { AxisLabel, JourneyId, Surface } from './dapp-cells';

/** The spec's matrix as data: which cells each journey runs on which axis (spec section 3). */

export const JOURNEY_TITLES: Record<JourneyId, string> = {
  S: 'dApp session, reconnect and reads',
  W: 'dApp wallet writes and notes',
  R: 'dApp signing and refusals',
  X: 'dApp custom requests',
  XL: 'dApp custom request across the account history window',
  M: 'dApp accounts and multiple dApps',
  RA: 'dApp React adapter',
  PL: 'dApp in the in-app browser'
};

/**
 * Each is the higher of the spec's initial testnet value (about 2x its estimate, section 6) and the spike's value
 * recomputed from measured unit costs. None recomputed higher, and reads and refusals went unmeasured, so these are
 * the initial values; RA (phase 2) is about twice its 15-minute estimate. A part's journeys stay under the workflow's
 * 170-min run step: core 155 min, writes 130 min. PL runs alone in each mobile leg, under that leg's 95-min run step
 * (spec 3.9).
 */
export const JOURNEY_TIMEOUT_MS: Record<JourneyId, number> = {
  S: 20 * 60_000,
  R: 45 * 60_000,
  W: 60 * 60_000,
  X: 45 * 60_000,
  XL: 25 * 60_000,
  M: 60 * 60_000,
  RA: 30 * 60_000,
  PL: 85 * 60_000
};

/** The platform a mobile journey's title names, so no two surfaces share a title (spec 3.8). */
const MOBILE_SURFACE_NAMES: Record<Exclude<Surface, 'extension'>, string> = { ios: 'iOS', android: 'Android' };

/** The axis suffix is what the workflow's `--grep " - <axis> account"` selects a leg by. */
export const journeyTitle = (journey: JourneyId, axis: AxisLabel, surface: Surface = 'extension'): string =>
  surface === 'extension'
    ? `${JOURNEY_TITLES[journey]} - ${axis} account`
    : `${JOURNEY_TITLES[journey]} on ${MOBILE_SURFACE_NAMES[surface]} - ${axis} account`;

type CellList = ReadonlyArray<{ id: string; axes: readonly AxisLabel[] }>;
const BOTH: readonly AxisLabel[] = ['offchain', 'guardian'];
const GUARDIAN: readonly AxisLabel[] = ['guardian'];
const OFFCHAIN: readonly AxisLabel[] = ['offchain'];
const both = (...ids: string[]): CellList => ids.map(id => ({ id, axes: BOTH }));
// The request types M3 and M9 issue once an authorization went stale or names an account that is not current.
const STALE = ['send', 'transaction', 'consume', 'consumeBytes', 'custom'] as const;

/** The journeys the Chrome legs run; PL runs on the mobile legs only. */
export type ExtensionJourneyId = Exclude<JourneyId, 'PL'>;

/** In run order. An empty list is a journey with no spec yet, which the axis coverage test does not look for. */
export const DAPP_JOURNEY_CELLS: Record<ExtensionJourneyId, CellList> = {
  S: both('S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S8', 'S9', 'S10', 'S11', 'S14', 'N1'),
  W: both(
    'N1-before-writes',
    'N2',
    'W1',
    'W2',
    'W3',
    'W3-wire',
    'N6',
    'W4',
    'W8',
    'N3a',
    'N3b',
    'N3c',
    'N4',
    'W5a',
    'W5b',
    'W5c',
    'W6',
    'W4f',
    'N1-after-writes'
  ),
  R: both(
    'G1',
    'G2a',
    'G2b',
    'G2c',
    'G3',
    'G4',
    'R1-send',
    'R1-consume',
    'R1-custom',
    'R1-assets',
    'R1-consumableNotes',
    'R1-privateNotes',
    'R1-importPrivateNote',
    'R2',
    'R3-noteType',
    'R3-recallBlocks',
    'R3-sender',
    'R3-customAddress',
    'R3-customPayload',
    'R3-customUndecodable',
    'R3-consumeBytes',
    'R3-consumeUnresolved',
    'R3-network',
    'R4',
    'R5',
    'R8',
    'R9',
    'R10',
    'R6',
    'R11'
  ),
  X: [
    ...both('X1', 'X2', 'X3', 'X4', 'X5'),
    { id: 'X5f', axes: OFFCHAIN },
    { id: 'X7', axes: GUARDIAN },
    ...both('X11', 'X8a', 'X8b', 'X8c')
  ],
  XL: both('X6'),
  M: [
    ...both(
      'S7',
      'M1',
      'M2',
      ...STALE.flatMap(request => [`M3-${request}-switch`, `M3-${request}-revoke`]),
      ...STALE.map(request => `M9-${request}`),
      'M4-reads',
      'M4',
      'M7'
    ),
    // The switch between kinds starts from a Guardian account, which only the Guardian leg has (spec M8).
    { id: 'M8-single', axes: GUARDIAN },
    { id: 'M8-guardian', axes: GUARDIAN },
    ...both('M10', 'N5')
  ],
  // Phase 2, Q5 (spec section 4): WP7 splits into a switch and a revoke row, as S7 and M1 do on the adapter.
  RA: both(
    'WP1',
    'WP2',
    'WP3',
    'WP4',
    'WP5',
    'WP6',
    'WP7-switch',
    'WP7-revoke',
    'WP8',
    'WP9',
    'MF1',
    'MF2',
    'MF3',
    'MF4'
  )
};

/**
 * The mobile slim set (spec 3.6, D2) in run order, on both account kinds. Each id keeps its extension meaning; R1 and
 * R3 run the requests spec 3.6 names, and R7 splits per sheet kind.
 */
export const MOBILE_JOURNEY_CELLS: CellList = both(
  'S1',
  'S2',
  'S3',
  'S6',
  'S10',
  'S11',
  'N1',
  'G1',
  'G2a',
  'M1',
  'N3a',
  'W1',
  'W4',
  'X1',
  'R5',
  'R1-send',
  'R1-custom',
  'R3-noteType',
  'R3-customPayload',
  'R3-customUndecodable',
  'R7-connect',
  'R7-send',
  'R7-consume',
  'R7-custom'
);

export const cellIdsFor = (journey: JourneyId, axis: AxisLabel): string[] =>
  (journey === 'PL' ? MOBILE_JOURNEY_CELLS : DAPP_JOURNEY_CELLS[journey])
    .filter(cell => cell.axes.includes(axis))
    .map(cell => cell.id);
