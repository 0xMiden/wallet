/**
 * @jest-environment node
 */
import { KNOWN_BUGS, registryOf, type KnownBug } from './dapp-known-bugs';

describe('known-bug registry', () => {
  it('has unique ids, a tracking issue or pull request and at least one cell each', () => {
    expect(new Set(KNOWN_BUGS.map(entry => entry.id)).size).toBe(KNOWN_BUGS.length);
    for (const entry of KNOWN_BUGS) {
      expect(entry.tracking).toMatch(/^[\w.-]+\/[\w.-]+#\d+ /);
      expect(Object.keys(entry.cells)).not.toHaveLength(0);
    }
  });

  it.each(['S7', 'M1', 'WP7-switch', 'WP7-revoke', 'WP9', 'MF3'])('requires the fixed cell %s to pass', cell => {
    const registry = registryOf(KNOWN_BUGS);
    expect(registry.bugsFor(cell, 'extension', 'offchain')).toEqual([]);
    expect(registry.bugsFor(cell, 'extension', 'guardian')).toEqual([]);
    expect(registry.bugsFor(cell, 'ios', 'offchain')).toEqual([]);
    expect(registry.bugsFor(cell, 'ios', 'guardian')).toEqual([]);
    expect(registry.bugsFor(cell, 'android', 'offchain')).toEqual([]);
    expect(registry.bugsFor(cell, 'android', 'guardian')).toEqual([]);
  });

  it('judges W6 on the fixed consume of carried noteBytes, with K2 (#1413) gone', () => {
    expect(KNOWN_BUGS.filter(entry => entry.cells.W6 !== undefined).map(entry => entry.id)).toEqual([]);
    expect(KNOWN_BUGS.map(entry => entry.id)).not.toContain('K2');
  });

  it('judges S9 on the fixed locked-wallet prompt, with K5 (#1414) gone', () => {
    expect(KNOWN_BUGS.filter(entry => entry.cells.S9 !== undefined).map(entry => entry.id)).toEqual([]);
    expect(KNOWN_BUGS.map(entry => entry.id)).not.toContain('K5');
  });

  it('judges M7 on the origin gate, with K7 (#1416) gone', () => {
    expect(KNOWN_BUGS.filter(entry => entry.cells.M7 !== undefined).map(entry => entry.id)).toEqual([]);
    expect(KNOWN_BUGS.map(entry => entry.id)).not.toContain('K7');
  });

  it('judges N4 without an import-id lookup exception (#1536)', () => {
    expect(KNOWN_BUGS.filter(entry => entry.cells.N4 !== undefined).map(entry => entry.id)).toEqual([]);
  });

  it('explains a cell only on the surface and axis an entry names', () => {
    const entry: KnownBug = {
      id: 'KT',
      title: 'test',
      tracking: 'none',
      cells: { M1: [{ axis: 'guardian', surface: 'extension' }] },
      signature: () => true
    };
    const registry = registryOf([entry]);
    expect(registry.bugsFor('M1', 'extension', 'guardian').map(bug => bug.id)).toEqual(['KT']);
    expect(registry.bugsFor('M1', 'ios', 'guardian')).toEqual([]);
    expect(registry.bugsFor('M1', 'android', 'guardian')).toEqual([]);
    expect(registry.bugsFor('M1', 'extension', 'offchain')).toEqual([]);
  });

  // A mobile exception needs the run that demonstrated its signature on that surface.
  const unproven = (bugs: readonly KnownBug[]): string[] =>
    bugs
      .filter(entry => Object.values(entry.cells).some(placements => placements.some(at => at.surface !== 'extension')))
      .filter(entry => !/^\d+$/.test(entry.mobileEvidenceRun ?? ''))
      .map(entry => entry.id);

  it('places an entry on a mobile surface only with the run that showed its signature there', () => {
    const mobile: KnownBug = {
      id: 'KM',
      title: 'test',
      tracking: 'none',
      cells: { S11: [{ axis: 'guardian', surface: 'ios' }] },
      signature: () => true
    };
    expect(unproven([mobile])).toEqual(['KM']);
    expect(unproven([{ ...mobile, mobileEvidenceRun: '18700000001' }])).toEqual([]);
    expect(unproven(KNOWN_BUGS)).toEqual([]);
  });
});
