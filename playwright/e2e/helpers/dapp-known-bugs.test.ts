/**
 * @jest-environment node
 */
import type { FailureEvidence } from './dapp-cells';
import { KNOWN_BUGS, type KnownBug } from './dapp-known-bugs';
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

  it('K1 matches a provider that moved while the adapter kept the old address', () => {
    expect(bug('K1').signature(hard('M1', { providerAddress: 'b', adapterAddress: 'a', previousAddress: 'a' }))).toBe(
      true
    );
    expect(bug('K1').signature(hard('M1', { providerAddress: 'b', adapterAddress: 'b', previousAddress: 'a' }))).toBe(
      false
    );
  });

  it('K1 matches a React context left on the old account after a switch or a revoke, and nothing else', () => {
    expect(bug('K1').cells).toEqual(
      expect.objectContaining({ 'WP7-switch': ['offchain', 'guardian'], 'WP7-revoke': ['offchain', 'guardian'] })
    );
    const stayed = { previousAddress: 'a', reactAddress: 'a', reactConnected: true };
    expect(bug('K1').signature(hard('WP7-switch', { ...stayed, providerAddress: 'b' }))).toBe(true);
    expect(bug('K1').signature(hard('WP7-revoke', { ...stayed, providerAddress: null }))).toBe(true);
    // The context followed, or the provider never moved: not K1.
    expect(bug('K1').signature(hard('WP7-switch', { ...stayed, reactAddress: 'b', providerAddress: 'b' }))).toBe(false);
    expect(
      bug('K1').signature(
        hard('WP7-revoke', { previousAddress: 'a', providerAddress: null, reactAddress: null, reactConnected: false })
      )
    ).toBe(false);
    expect(bug('K1').signature(hard('WP7-revoke', { ...stayed, reactConnected: false, providerAddress: null }))).toBe(
      false
    );
    expect(bug('K1').signature(hard('WP7-switch', { ...stayed, providerAddress: 'a' }))).toBe(false);
    // The adapter's fact alone does not explain a React cell.
    expect(
      bug('K1').signature(hard('WP7-switch', { previousAddress: 'a', providerAddress: 'b', adapterAddress: 'a' }))
    ).toBe(false);
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

  it('K10 matches a consume by the returned id refused before any popup, and an N4 miss by that id', () => {
    expect(bug('K10').tracking).toContain('0xMiden/wallet#1389');
    expect(bug('K10').cells).toEqual({
      W5b: ['offchain', 'guardian'],
      W5c: ['offchain', 'guardian'],
      N4: ['offchain', 'guardian']
    });
    const unresolved = {
      name: 'WalletTransactionError',
      message: 'INVALID_PARAMS: Error: Note 0x0e5a could not be resolved'
    };
    expect(bug('K10').signature(hard('W5b', { popupOpened: false, dappError: unresolved }))).toBe(true);
    expect(bug('K10').signature(soft('W5b', { popupOpened: false, dappError: unresolved }))).toBe(false);
    expect(bug('K10').signature(hard('W5c', { popupOpened: true, dappError: unresolved }))).toBe(false);
    for (const message of ['INVALID_PARAMS: Error: Wallet is locked', 'Note 0x0e5a could not be resolved']) {
      expect(bug('K10').signature(hard('W5c', { popupOpened: false, dappError: { ...unresolved, message } }))).toBe(
        false
      );
    }
    expect(bug('K10').signature(hard('N4', { returnedIdUnlisted: true }))).toBe(true);
    expect(bug('K10').signature(hard('N4', { returnedIdUnlisted: false }))).toBe(false);
    expect(bug('K10').signature(hard('N4', { popupOpened: false, dappError: unresolved }))).toBe(false);
  });

  it('K11 matches an undecodable custom request that opened a popup, and not a refusal or a deadline', () => {
    expect(bug('K11').cells).toEqual({ 'R3-customUndecodable': ['offchain', 'guardian'] });
    expect(bug('K11').signature(hard('R3-customUndecodable', { popupOpened: true }))).toBe(true);
    expect(bug('K11').signature(soft('R3-customUndecodable', { popupOpened: true }))).toBe(false);
    const refused = { name: 'InvalidParamsMidenWalletError', message: 'INVALID_PARAMS: Error: unexpected end of file' };
    expect(bug('K11').signature(hard('R3-customUndecodable', { popupOpened: false, dappError: refused }))).toBe(false);
    expect(bug('K11').signature(hard('R3-customUndecodable', {}, 'CellDeadlineExceeded: dApp one raw'))).toBe(false);
  });

  it('K13 matches the signer setup error MF3 settled on, and no other', () => {
    expect(bug('K13').tracking).toContain('0xMiden/web-sdk#400');
    expect([...(bug('K13').cells.MF3 ?? [])].sort()).toEqual(Object.keys(pinned.texts.MF3).sort());
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
});
