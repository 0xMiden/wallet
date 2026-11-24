/**
 * @jest-environment node
 */
import type { JourneyId } from './dapp-cells';
import { KNOWN_BUGS } from './dapp-known-bugs';
import {
  cellIdsFor,
  DAPP_JOURNEY_CELLS,
  JOURNEY_TIMEOUT_MS,
  JOURNEY_TITLES,
  journeyTitle,
  MOBILE_JOURNEY_CELLS,
  type ExtensionJourneyId
} from './dapp-matrix';

describe('dApp matrix data', () => {
  it('declares every cell id once across all journeys', () => {
    const ids = Object.values(DAPP_JOURNEY_CELLS).flatMap(cells => cells.map(cell => cell.id));
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('titles every journey with a distinct name', () => {
    expect(new Set(Object.values(JOURNEY_TITLES)).size).toBe(Object.keys(JOURNEY_TITLES).length);
  });

  it('declares every cell a known bug names, on every surface and axis the bug names', () => {
    const declared = new Set(
      (['offchain', 'guardian'] as const).flatMap(axis => [
        ...EXTENSION_JOURNEYS.flatMap(journey => cellIdsFor(journey, axis).map(id => `${id}@extension/${axis}`)),
        ...(['ios', 'android'] as const).flatMap(surface =>
          cellIdsFor('PL', axis).map(id => `${id}@${surface}/${axis}`)
        )
      ])
    );
    const missing = KNOWN_BUGS.flatMap(bug =>
      Object.entries(bug.cells).flatMap(([cell, placements]) =>
        placements.map(at => `${bug.id}:${cell}@${at.surface}/${at.axis}`)
      )
    ).filter(key => !declared.has(key.slice(key.indexOf(':') + 1)));
    expect(missing).toEqual([]);
  });

  it('keeps every journey timeout at or above its initial testnet value', () => {
    const lowered = (Object.keys(INITIAL_TIMEOUT_MIN) as JourneyId[]).filter(
      journey => JOURNEY_TIMEOUT_MS[journey] < INITIAL_TIMEOUT_MIN[journey] * 60_000
    );
    expect(lowered).toEqual([]);
  });

  it("fits each part's journeys in the workflow's 170-min run step", () => {
    const overrun = Object.entries(PART_JOURNEYS)
      .map(([part, journeys]) => [part, journeys.reduce((sum, j) => sum + JOURNEY_TIMEOUT_MS[j], 0) / 60_000] as const)
      .filter(([, minutes]) => minutes >= 170);
    expect(overrun).toEqual([]);
  });

  it('runs the X8 script cells on both axes, after X11', () => {
    for (const axis of ['offchain', 'guardian'] as const) {
      expect(cellIdsFor('X', axis).slice(-4)).toEqual(['X11', 'X8a', 'X8b', 'X8c']);
    }
  });

  it('runs the slim set of spec 3.6 on both axes of the mobile journey', () => {
    for (const axis of ['offchain', 'guardian'] as const) {
      expect(cellIdsFor('PL', axis)).toEqual(MOBILE_JOURNEY_CELLS.map(cell => cell.id));
    }
    expect(MOBILE_JOURNEY_CELLS.map(cell => cell.id)).toEqual([
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
    ]);
  });

  it('titles the mobile journey per surface, apart from every extension title', () => {
    expect([...EXTENSION_JOURNEYS].sort()).toEqual(Object.keys(DAPP_JOURNEY_CELLS).sort());
    const axes = ['offchain', 'guardian'] as const;
    const extension = EXTENSION_JOURNEYS.flatMap(journey => axes.map(axis => journeyTitle(journey, axis)));
    const mobile = (['ios', 'android'] as const).flatMap(surface =>
      axes.map(axis => journeyTitle('PL', axis, surface))
    );
    expect(mobile).toEqual([
      'dApp in the in-app browser on iOS - offchain account',
      'dApp in the in-app browser on iOS - guardian account',
      'dApp in the in-app browser on Android - offchain account',
      'dApp in the in-app browser on Android - guardian account'
    ]);
    expect(mobile.filter(title => extension.includes(title))).toEqual([]);
  });

  it("fits the mobile journey in the mobile legs' 95-min run step", () => {
    expect(JOURNEY_TIMEOUT_MS.PL / 60_000).toBeLessThan(95);
  });
});

// Spec section 6: a timeout the spike recomputes replaces one of these only when it is higher.
const INITIAL_TIMEOUT_MIN: Record<JourneyId, number> = { S: 20, R: 45, W: 60, X: 45, XL: 25, M: 60, RA: 30, PL: 85 };

const PART_JOURNEYS: Record<'core' | 'writes', JourneyId[]> = {
  core: ['S', 'R', 'M', 'RA'],
  writes: ['W', 'X', 'XL']
};

// The Chrome map's journeys, typed; "titles the mobile journey per surface" checks it lists exactly the map's keys.
const EXTENSION_JOURNEYS: readonly ExtensionJourneyId[] = ['S', 'W', 'R', 'X', 'XL', 'M', 'RA'];
