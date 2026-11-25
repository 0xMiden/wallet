import type { TransactionRowSnapshot } from './history';
import {
  activationModeOfRow,
  activationRows,
  amountOf,
  feePaidBy,
  generatingTransactionIdOf,
  isActivationRow,
  isTerminalRow,
  revokedCommitmentOf,
  sameEndpoint,
  toGuardedAccount
} from './multi-device-roles';
import { isGuardianSyncBlocked, isHotKeyRotatedOut } from '../../../src/lib/miden/guardian/sync-guard';

// The helper's browser-facing imports load Playwright, the dApp server and the wallet page object. The pure
// functions under test need none of them, so each is replaced with an empty module.
jest.mock('@playwright/test', () => ({ expect: () => undefined }));
jest.mock('./balance-truth', () => ({}));
jest.mock('./dapp-cells', () => ({}));
jest.mock('./dapp-pinned.json', () => ({ accountNotFound: '0x00' }));
jest.mock('./fee-funding', () => ({}));
jest.mock('./history', () => ({
  TxStatus: { Queued: 0, GeneratingTransaction: 1, Completed: 2, Failed: 3, Unconfirmed: 4 },
  describeTransactionRow: () => '',
  readTransactionRows: () => Promise.resolve([])
}));
jest.mock('./multi-device', () => ({}));
jest.mock('./signature-recovery', () => ({}));
jest.mock('./test-dapp', () => ({}));
jest.mock('./wallet-page', () => ({ PASSWORD: 'unused' }));

const row = (fields: Partial<TransactionRowSnapshot>): TransactionRowSnapshot => ({ id: 'row', ...fields });

describe('activation rows', () => {
  it('keeps replace-hot-key rows that revoke no device', () => {
    const add = row({ id: 'add', type: 'replace-hot-key', extraInputs: { mode: 'add' } });
    const replace = row({ id: 'replace', type: 'replace-hot-key' });
    const revoke = row({ id: 'revoke', type: 'replace-hot-key', extraInputs: { revokedSignerCommitment: '0xab' } });
    const send = row({ id: 'send', type: 'send' });
    expect(activationRows([add, replace, revoke, send]).map(entry => entry.id)).toEqual(['add', 'replace']);
    expect(isActivationRow(revoke)).toBe(false);
  });

  it('reads a row without a mode as a replace, as the product does', () => {
    expect(activationModeOfRow(row({ type: 'replace-hot-key', extraInputs: { mode: 'add' } }))).toBe('add');
    expect(activationModeOfRow(row({ type: 'replace-hot-key', extraInputs: { mode: 'replace' } }))).toBe('replace');
    expect(activationModeOfRow(row({ type: 'replace-hot-key' }))).toBe('replace');
  });

  it('names the revoked commitment only on a revocation', () => {
    expect(revokedCommitmentOf(row({ extraInputs: { revokedSignerCommitment: '0xab' } }))).toBe('0xab');
    expect(revokedCommitmentOf(row({ extraInputs: { revokedSignerCommitment: 7 } }))).toBeUndefined();
    expect(revokedCommitmentOf(row({}))).toBeUndefined();
  });
});

describe('row values', () => {
  it('reads a missing fee as zero and an amount as base units', () => {
    expect(feePaidBy(row({ feeAmount: '1500' }))).toBe(1500n);
    expect(feePaidBy(row({}))).toBe(0n);
    expect(amountOf(row({ amount: '42' }))).toBe(42n);
    expect(() => amountOf(row({ id: 'x', type: 'consume' }))).toThrow('row x (consume) carries no amount');
  });

  it('treats only Completed and Failed as terminal', () => {
    expect([0, 1, 2, 3, 4].map(status => isTerminalRow(row({ status })))).toEqual([false, false, true, true, false]);
    expect(isTerminalRow(row({}))).toBe(false);
  });
});

describe('generatingTransactionIdOf', () => {
  it('reads the row id from both in-progress routes', () => {
    expect(generatingTransactionIdOf('chrome-extension://x/fullpage.html#/generating-transaction-full/abc-1')).toBe(
      'abc-1'
    );
    expect(generatingTransactionIdOf('chrome-extension://x/fullpage.html#/generating-transaction/a%2Fb?x=1')).toBe(
      'a/b'
    );
    expect(generatingTransactionIdOf('chrome-extension://x/fullpage.html#/settings/devices')).toBeNull();
  });
});

describe('sameEndpoint', () => {
  it('ignores case and a trailing slash', () => {
    expect(sameEndpoint('https://Guardian.example.com/', 'https://guardian.example.com')).toBe(true);
    expect(sameEndpoint('https://a.example.com', 'https://b.example.com')).toBe(false);
  });
});

describe('toGuardedAccount', () => {
  const verdict = { hotPublicKey: '0xhot', onChainHotCommitment: '0xother', detectedAt: 1 };

  it('gives the product guard a rotated-out account', () => {
    const guarded = toGuardedAccount({
      hotPublicKey: '0xhot',
      hotKeyRotatedOut: verdict,
      guardianSyncStatus: 'in-sync'
    });
    expect(isHotKeyRotatedOut(guarded)).toBe(true);
    expect(isGuardianSyncBlocked(guarded)).toBe(true);
  });

  it('keeps a verdict about another key inert, as the product does', () => {
    const guarded = toGuardedAccount({ hotPublicKey: '0xnew', hotKeyRotatedOut: verdict });
    expect(isHotKeyRotatedOut(guarded)).toBe(false);
    expect(isGuardianSyncBlocked(guarded)).toBe(false);
  });

  it('drops a malformed verdict and an unknown sync status', () => {
    const guarded = toGuardedAccount({
      hotPublicKey: '0xhot',
      hotKeyRotatedOut: { hotPublicKey: '0xhot' },
      guardianSyncStatus: 'unknown'
    });
    expect(guarded).toEqual({ guardianSyncStatus: undefined, hotPublicKey: '0xhot', hotKeyRotatedOut: undefined });
  });

  it('blocks a known non-in-sync status', () => {
    expect(isGuardianSyncBlocked(toGuardedAccount({ hotPublicKey: '0xhot', guardianSyncStatus: 'resolving' }))).toBe(
      true
    );
  });
});
