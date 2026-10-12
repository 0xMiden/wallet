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
    expect(missing).toEqual([]);
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
