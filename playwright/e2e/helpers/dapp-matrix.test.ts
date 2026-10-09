/**
 * @jest-environment node
 */
import type { JourneyId } from './dapp-cells';
import { KNOWN_BUGS } from './dapp-known-bugs';
import { cellIdsFor, DAPP_JOURNEY_CELLS, JOURNEY_TIMEOUT_MS, JOURNEY_TITLES } from './dapp-matrix';

describe('dApp matrix data', () => {
  it('declares every cell id once across all journeys', () => {
    const ids = Object.values(DAPP_JOURNEY_CELLS).flatMap(cells => cells.map(cell => cell.id));
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('titles every journey with a distinct name', () => {
    expect(new Set(Object.values(JOURNEY_TITLES)).size).toBe(Object.keys(JOURNEY_TITLES).length);
  });

  it('declares every cell a known bug names, on every axis the bug names', () => {
    const declared = new Set(
      (Object.keys(DAPP_JOURNEY_CELLS) as (keyof typeof DAPP_JOURNEY_CELLS)[]).flatMap(journey =>
        (['offchain', 'guardian'] as const).flatMap(axis => cellIdsFor(journey, axis).map(id => `${id}@${axis}`))
      )
    );
    const missing = KNOWN_BUGS.flatMap(bug =>
      Object.entries(bug.cells).flatMap(([cell, axes]) => axes.map(axis => `${bug.id}:${cell}@${axis}`))
    ).filter(key => !declared.has(key.slice(key.indexOf(':') + 1)));
    expect(missing).toEqual(KNOWN_BUG_CELLS_NOT_YET_DECLARED);
  });

  it('keeps every journey timeout at or above its initial testnet value', () => {
    const lowered = (Object.keys(INITIAL_TIMEOUT_MIN) as JourneyId[]).filter(
      journey => JOURNEY_TIMEOUT_MS[journey] < INITIAL_TIMEOUT_MIN[journey] * 60_000
    );
    expect(lowered).toEqual([]);
  });

  it("fits each part's journeys in the workflow's 140-min run step", () => {
    const overrun = Object.entries(PART_JOURNEYS)
      .map(([part, journeys]) => [part, journeys.reduce((sum, j) => sum + JOURNEY_TIMEOUT_MS[j], 0) / 60_000] as const)
      .filter(([, minutes]) => minutes >= 140);
    expect(overrun).toEqual([]);
  });
});

// Spec section 6: a timeout the spike recomputes replaces one of these only when it is higher.
const INITIAL_TIMEOUT_MIN: Record<JourneyId, number> = { S: 20, R: 45, W: 60, X: 45, XL: 25, M: 60 };

const PART_JOURNEYS: Record<'core' | 'writes', JourneyId[]> = { core: ['S', 'R', 'M'], writes: ['W', 'X', 'XL'] };

// Shrinks to [] as tasks 7 to 15 declare their journeys; task 15 makes it empty for good.
const KNOWN_BUG_CELLS_NOT_YET_DECLARED: string[] = [
  'K1:S7@offchain',
  'K1:S7@guardian',
  'K1:M1@offchain',
  'K1:M1@guardian',
  'K2:W6@offchain',
  'K2:W6@guardian',
  'K3:X1@guardian',
  'K3:X2@guardian',
  'K3:X3@guardian',
  'K3:X4@guardian',
  'K3:X5@guardian',
  'K3:X6@guardian',
  'K3:X11@guardian',
  'K3:M8-guardian@guardian',
  'K3:R8@guardian',
  'K4:X1@guardian',
  'K4:X2@guardian',
  'K4:X3@guardian',
  'K4:X4@guardian',
  'K4:X5@guardian',
  'K4:X6@guardian',
  'K4:X11@guardian',
  'K4:M8-guardian@guardian',
  'K4:R8@guardian',
  'K5:S9@offchain',
  'K5:S9@guardian',
  'K6:M3-consume-switch@offchain',
  'K6:M3-consume-switch@guardian',
  'K6:M3-consume-revoke@offchain',
  'K6:M3-consume-revoke@guardian',
  'K6:M3-consumeBytes-switch@offchain',
  'K6:M3-consumeBytes-switch@guardian',
  'K6:M3-consumeBytes-revoke@offchain',
  'K6:M3-consumeBytes-revoke@guardian',
  'K6:M9-consume@offchain',
  'K6:M9-consume@guardian',
  'K6:M9-consumeBytes@offchain',
  'K6:M9-consumeBytes@guardian',
  'K7:M7@offchain',
  'K7:M7@guardian',
  'K9:M9-send@offchain',
  'K9:M9-send@guardian',
  'K9:M9-transaction@offchain',
  'K9:M9-transaction@guardian',
  'K9:M9-consume@offchain',
  'K9:M9-consume@guardian',
  'K9:M9-consumeBytes@offchain',
  'K9:M9-consumeBytes@guardian',
  'K9:M9-custom@offchain',
  'K9:M9-custom@guardian',
  'K9:M4-reads@offchain',
  'K9:M4-reads@guardian'
];
