/**
 * @jest-environment node
 */
import type { FailureEvidence } from './dapp-cells';
import { KNOWN_BUGS, registryOf, type KnownBug } from './dapp-known-bugs';
import pinned from './dapp-pinned.json';

const bug = (id: string): KnownBug => {
  const found = KNOWN_BUGS.find(candidate => candidate.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};
const hard = (cellId: string, evidence: FailureEvidence, text = 'failure') => ({
  cellId,
  source: 'hard' as const,
  text,
  evidence
});
const soft = (cellId: string, evidence: FailureEvidence, text = 'preview-verified: declared') => ({
  cellId,
  source: 'soft' as const,
  text,
  evidence
});
describe('known-bug registry', () => {
  it('has unique ids, a tracking issue or pull request and at least one cell each', () => {
    expect(new Set(KNOWN_BUGS.map(entry => entry.id)).size).toBe(KNOWN_BUGS.length);
    for (const entry of KNOWN_BUGS) {
      expect(entry.tracking).toMatch(/^[\w.-]+\/[\w.-]+#\d+ /);
      expect(Object.keys(entry.cells)).not.toHaveLength(0);
    }
  });

  it.each(['S7', 'M1', 'WP7-switch', 'WP7-revoke', 'WP9'])('requires the SDK 0.18 fixed cell %s to pass', cell => {
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

  it('K13 matches the signer setup error MF3 settled on, and no other', () => {
    expect(bug('K13').tracking).toContain('0xMiden/web-sdk#400');
    expect((bug('K13').cells.MF3 ?? []).map(at => at.axis).sort()).toEqual(Object.keys(pinned.texts.MF3).sort());
    const texts = Object.values(pinned.texts.MF3);
    expect(texts.length > 0 && texts.every(({ error, reason }) => error.length > 0 && reason.length > 0)).toBe(true);
    expect(
      texts.map(({ error, reason }) =>
        bug('K13').signature(hard('MF3', { signerInitError: `${error} 0x01 ${reason}` }))
      )
    ).toEqual(texts.map(() => true));
    // As the testnet run settled it on both axes, where only the private account's id differed.
    const observed =
      'Error: failed to import public account: account 0x2c0814e4ff753ac154d7d0659362d3 is private and its details ' +
      'cannot be retrieved from the network';
    expect(bug('K13').signature(hard('MF3', { signerInitError: observed }))).toBe(true);
    expect(bug('K13').signature(hard('MF3', { signerInitError: 'Error: network unreachable' }))).toBe(false);
    // The same import failing for another reason is another bug.
    expect(
      bug('K13').signature(
        hard('MF3', { signerInitError: 'Error: failed to import public account: account 0x01 could not be fetched' })
      )
    ).toBe(false);
    expect(bug('K13').signature(hard('MF3', {}))).toBe(false);
    expect(bug('K13').signature(soft('MF3', { signerInitError: observed }))).toBe(false);
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
