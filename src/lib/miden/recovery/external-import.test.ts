import { ITransactionStatus } from '../db/types';
import { mergeExternalRecoveryData } from './external-import';
import type { RecoveryTransactionRow } from './transaction-record';
import type { RecoveryJournalSnapshot } from './types';

const scope = {
  network: 'testnet:https://node.invalid',
  walletGeneration: 'current-wallet',
  sdkGeneration: 'current-sdk'
};
const binding = { scope, accountIds: ['account-a'] };
const row: RecoveryTransactionRow = {
  id: 'external-tx',
  accountId: 'account-a',
  type: 'send',
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: 1,
  displayIcon: 'SEND',
  restoredFromBackup: false,
  restoredFromJournal: true
};
const file = (): RecoveryJournalSnapshot => ({
  version: 1,
  sequence: 7,
  scope: { ...scope, walletGeneration: 'lost-wallet', sdkGeneration: 'lost-sdk' },
  accounts: [{ accountId: 'account-a', nonce: '4', commitment: 'state-4' }],
  entries: [
    {
      kind: 'transaction',
      id: row.id,
      accountId: row.accountId,
      requestBytes: new Uint8Array([1, 2]),
      mayHaveSubmitted: true,
      evidence: { transactionId: 'submitted-chain-id' },
      row
    },
    { kind: 'receipt', id: row.id, accountId: row.accountId, row }
  ]
});

describe('Task5 recovery external provenance', () => {
  it('clamps both transaction and receipt flags before rebinding to current physical stores', () => {
    const imported = mergeExternalRecoveryData(file(), binding);
    expect(imported.scope).toEqual(scope);
    expect(imported.entries).toHaveLength(2);
    for (const entry of imported.entries) {
      expect(entry.kind === 'transaction' || entry.kind === 'receipt').toBe(true);
      if (entry.kind !== 'transaction' && entry.kind !== 'receipt') throw new Error('missing expected row');
      expect(entry.row).toMatchObject({ restoredFromBackup: true });
      expect(entry.row?.restoredFromJournal).toBeUndefined();
    }
  });

  it('keeps stronger local account floors and unresolved local evidence intact', () => {
    const retained: RecoveryJournalSnapshot = {
      version: 1,
      sequence: 20,
      scope,
      accounts: [{ accountId: 'account-a', nonce: '6', commitment: 'state-6' }],
      entries: [
        {
          kind: 'transaction',
          id: 'local-uncertain',
          accountId: 'account-a',
          requestBytes: new Uint8Array([9]),
          mayHaveSubmitted: true,
          evidence: { transactionId: 'local-chain-id' }
        }
      ]
    };
    const merged = mergeExternalRecoveryData(file(), binding, retained);
    expect(merged.accounts).toEqual(retained.accounts);
    expect(merged.entries).toEqual(expect.arrayContaining(retained.entries));
    expect(merged.entries).toHaveLength(3);
  });

  it('does not replace a surviving local row or its local provenance with a file collision', () => {
    const retained = { ...file(), scope, entries: file().entries };
    const changed = file();
    const first = changed.entries[0];
    if (first?.kind !== 'transaction') throw new Error('missing transaction fixture');
    first.requestBytes = new Uint8Array([8, 8]);
    const merged = mergeExternalRecoveryData(changed, binding, retained);
    expect(merged.entries).toEqual(retained.entries);
  });

  it('refuses another network before producing data to persist', () => {
    const incoming = file();
    incoming.scope.network = 'other-network:https://other.invalid';
    expect(() => mergeExternalRecoveryData(incoming, binding)).toThrow('RecoveryDataFile:network');
  });

  it('refuses an account whose signer custody was not restored separately', () => {
    expect(() => mergeExternalRecoveryData(file(), { ...binding, accountIds: ['another-account'] })).toThrow(
      'RecoveryDataFile:account'
    );
  });

  it('refuses conflicting commitments at the same retained nonce', () => {
    const retained = {
      ...file(),
      scope,
      accounts: [{ accountId: 'account-a', nonce: '4', commitment: 'other-state-4' }]
    };
    expect(() => mergeExternalRecoveryData(file(), binding, retained)).toThrow('RecoveryDataFile:account');
  });
});
