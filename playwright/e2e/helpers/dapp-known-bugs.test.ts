/**
 * @jest-environment node
 */
import type { FailureEvidence } from './dapp-cells';
import { KNOWN_BUGS, knownBugRegistry, type KnownBug } from './dapp-known-bugs';

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
  it('has unique ids, a tracking note and at least one cell each', () => {
    expect(new Set(KNOWN_BUGS.map(entry => entry.id)).size).toBe(KNOWN_BUGS.length);
    for (const entry of KNOWN_BUGS) {
      expect(entry.tracking.length).toBeGreaterThan(3);
      expect(Object.keys(entry.cells)).not.toHaveLength(0);
    }
  });

  it('scopes the Guardian-only bugs to the Guardian axis', () => {
    expect(knownBugRegistry.bugsFor('X1', 'offchain').map(entry => entry.id)).toEqual([]);
    expect(knownBugRegistry.bugsFor('X1', 'guardian').map(entry => entry.id)).toEqual(['K3', 'K4']);
  });

  it('K1 matches a provider that moved while the adapter kept the old address', () => {
    expect(bug('K1').signature(hard('M1', { providerAddress: 'b', adapterAddress: 'a', previousAddress: 'a' }))).toBe(
      true
    );
    expect(bug('K1').signature(hard('M1', { providerAddress: 'b', adapterAddress: 'b', previousAddress: 'a' }))).toBe(
      false
    );
  });

  it('K2 matches an approved consume refused as INVALID_PARAMS not found', () => {
    const refused = { name: 'WalletTransactionError', message: 'INVALID_PARAMS: Error: Note with id 0x12 not found' };
    expect(bug('K2').signature(hard('W6', { popupOpened: true, dappError: refused }))).toBe(true);
    expect(
      bug('K2').signature(hard('W6', { popupOpened: true, dappError: { ...refused, message: 'NOT_GRANTED' } }))
    ).toBe(false);
  });

  it('K3 matches a proposal-stage anchor mismatch and nothing else', () => {
    const anchor = { rowStatus: 3, stage: 'creating-proposal', rowError: 'SummaryAnchorMismatchError: anchor 9 != 6' };
    expect(bug('K3').signature(hard('X1', anchor))).toBe(true);
    expect(bug('K3').signature(hard('X1', { ...anchor, stage: 'sending' }))).toBe(false);
    expect(bug('K3').signature(hard('X1', { ...anchor, rowError: 'FeeConversionInfoRequired' }))).toBe(false);
  });

  it('K4 matches the declared preview softly, and the R8 pre-popup refusal hard', () => {
    expect(bug('K4').signature(soft('X1', { previewSimulationFailed: true }))).toBe(true);
    expect(bug('K4').signature(hard('X1', { previewSimulationFailed: true }))).toBe(false);
    const refused = { name: 'WalletTransactionError', message: 'NOT_GRANTED' };
    expect(bug('K4').signature(hard('R8', { popupOpened: false, dappError: refused }))).toBe(true);
    expect(bug('K4').signature(hard('R8', { popupOpened: true, dappError: refused }))).toBe(false);
  });

  it('K5 matches a locked-wallet refusal before any popup', () => {
    const locked = { name: 'WalletTransactionError', message: 'INVALID_PARAMS: Error: Wallet is locked' };
    expect(bug('K5').signature(hard('S9', { popupOpened: false, dappError: locked }))).toBe(true);
    expect(bug('K5').signature(hard('S9', { popupOpened: true, dappError: locked }))).toBe(false);
  });

  it('K6 and K7 match only their recorded facts', () => {
    expect(bug('K6').signature(hard('M3-consume-switch', { staleConsumeExecuted: true }))).toBe(true);
    expect(bug('K6').signature(hard('M3-consume-switch', {}))).toBe(false);
    expect(bug('K7').signature(hard('M7', { crossOriginWaitServed: true }))).toBe(true);
    expect(bug('K7').signature(hard('M7', { crossOriginWaitServed: false }))).toBe(false);
  });

  it('K9 matches a non-current session that prompted, and never a leak', () => {
    const refused = { name: 'NotGrantedMidenWalletError', message: 'NOT_GRANTED' };
    expect(bug('K9').signature(hard('M9-send', { nonCurrentPrompted: true, dappError: refused }))).toBe(true);
    expect(bug('K9').signature(hard('M9-send', { nonCurrentPrompted: false, dappError: refused }))).toBe(false);
    expect(bug('K9').signature(hard('M9-send', { nonCurrentPrompted: true, staleConsumeExecuted: true }))).toBe(false);
    expect(bug('K9').signature(hard('M9-consume', { nonCurrentPrompted: true, staleConsumeExecuted: true }))).toBe(
      true
    );
    expect(bug('K9').signature(hard('M4-reads', { nonCurrentPrompted: true, nonCurrentReadLeaked: false }))).toBe(true);
    expect(bug('K9').signature(hard('M4-reads', { nonCurrentPrompted: true, nonCurrentReadLeaked: true }))).toBe(false);
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
});
