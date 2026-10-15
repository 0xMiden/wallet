/**
 * @jest-environment node
 */
import type { FailureEvidence } from './dapp-cells';
import { KNOWN_BUGS, knownBugRegistry, type KnownBug } from './dapp-known-bugs';
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

  it('scopes the Guardian-only bugs to the Guardian axis', () => {
    expect(knownBugRegistry.bugsFor('G2a', 'offchain').map(entry => entry.id)).toEqual([]);
    expect(knownBugRegistry.bugsFor('G2a', 'guardian').map(entry => entry.id)).toEqual(['K8']);
  });

  it('K1 matches a provider that moved while the adapter kept the old address', () => {
    expect(bug('K1').signature(hard('M1', { providerAddress: 'b', adapterAddress: 'a', previousAddress: 'a' }))).toBe(
      true
    );
    expect(bug('K1').signature(hard('M1', { providerAddress: 'b', adapterAddress: 'b', previousAddress: 'a' }))).toBe(
      false
    );
  });

  it('judges W6 on the fixed consume of carried noteBytes, with K2 (#1413) gone', () => {
    expect(KNOWN_BUGS.filter(entry => entry.cells.W6 !== undefined).map(entry => entry.id)).toEqual([]);
    expect(KNOWN_BUGS.map(entry => entry.id)).not.toContain('K2');
  });

  it('K5 matches a locked-wallet refusal before any popup', () => {
    const locked = { name: 'WalletTransactionError', message: 'INVALID_PARAMS: Error: Wallet is locked' };
    expect(bug('K5').signature(hard('S9', { popupOpened: false, dappError: locked }))).toBe(true);
    expect(bug('K5').signature(hard('S9', { popupOpened: true, dappError: locked }))).toBe(false);
  });

  it('judges M7 on the origin gate, with K7 (#1416) gone', () => {
    expect(KNOWN_BUGS.filter(entry => entry.cells.M7 !== undefined).map(entry => entry.id)).toEqual([]);
    expect(KNOWN_BUGS.map(entry => entry.id)).not.toContain('K7');
  });

  it('K8 matches the opaque keystore miss after approval, and not another refusal', () => {
    const miss = {
      name: 'WalletTransactionError',
      message: `INVALID_PARAMS: Error: ${pinned.texts.G2.guardian.error}`,
      causeName: 'InvalidParamsMidenWalletError'
    };
    expect(bug('K8').signature(hard('G2a', { popupOpened: true, dappError: miss }))).toBe(true);
    const declined = {
      name: 'WalletTransactionError',
      message: 'NOT_GRANTED',
      causeName: 'NotGrantedMidenWalletError'
    };
    expect(bug('K8').signature(hard('G2a', { popupOpened: true, dappError: declined }))).toBe(false);
    expect(bug('K8').signature(hard('G2a', { popupOpened: false, dappError: miss }))).toBe(false);
    expect(bug('K8').signature(soft('G2a', { popupOpened: true, dappError: miss }))).toBe(false);
    for (const dappError of [
      { ...miss, causeName: 'MidenWalletError' },
      { ...miss, message: 'INVALID_PARAMS: Error: Wallet is locked' }
    ]) {
      expect(bug('K8').signature(hard('G2b', { popupOpened: true, dappError }))).toBe(false);
    }
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
});
