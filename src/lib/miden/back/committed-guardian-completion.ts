import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { assertWalletAccessAllowed, ensureWalletAccessAllowed } from 'lib/remote-config/wallet-access';
import type { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { getAccountsWriteQueue } from './accounts-write-queue';
import { accountsUpdated, assertUnlocked, store } from './store';
import { ITransactionStatus, type ITransaction } from '../db/types';
import {
  committedGuardianOperationBinding,
  finishCommittedGuardianIntent,
  issueCommittedGuardianIntent,
  type CommittedGuardianEvidence
} from '../guardian/committed-completion';
import { readChainAccountCommitment, readLastSyncedVerdict } from '../guardian/direct-switch';
import * as Repo from '../repo';
import { sameWalletAccountId } from '../sdk/helpers';
import { isRealmKeystoreInstalled } from '../sdk/miden-client';
import { currentGuardianWriteGeneration } from '../sync-backoff';

type StructuralTarget =
  | { readonly type: 'replace-hot-key'; readonly value: string }
  | { readonly type: 'switch-guardian'; readonly value: string };

function targetOf(row: ITransaction): StructuralTarget {
  const extra: unknown = row.extraInputs;
  if (!extra || typeof extra !== 'object') throw new Error('Guardian completion has no structural target');
  const value: unknown =
    row.type === 'replace-hot-key' ? Reflect.get(extra, 'newHotPublicKey') : Reflect.get(extra, 'newGuardianEndpoint');
  if ((row.type !== 'replace-hot-key' && row.type !== 'switch-guardian') || typeof value !== 'string' || !value) {
    throw new Error('Guardian completion has no structural target');
  }
  return { type: row.type, value };
}

function scope(): string {
  return `${getEffectiveNetworkName()}|${getEffectiveRpcUrl()}`;
}

function bindingOf(account: WalletAccount): string {
  return JSON.stringify([
    account.publicKey,
    account.type,
    account.hotPublicKey ?? null,
    account.guardianEndpoint ?? null,
    account.guardianEpoch ?? 0
  ]);
}

/** Prepare the exact active operation while ordinary private access is still allowed. */
export async function prepareCommittedGuardianCompletion(rowId: string): Promise<string> {
  await ensureWalletAccessAllowed();
  if (typeof rowId !== 'string' || !rowId) throw new Error('Invalid Guardian completion row');
  const initial = store.getState();
  assertUnlocked(initial);
  const vault = initial.vault;
  const network = scope();
  const generation = currentGuardianWriteGeneration();
  // A candidate Vault can replace the realm sink before the store adopts it.
  // Store identity alone would let that retired Vault keep writing.
  const assertCurrent = () => {
    const state = store.getState();
    assertUnlocked(state);
    if (
      state.vault !== vault ||
      !isRealmKeystoreInstalled({ insertKey: vault.insertKeySink }) ||
      scope() !== network ||
      currentGuardianWriteGeneration() !== generation
    ) {
      throw new Error('Guardian completion belongs to a retired wallet or network');
    }
  };
  const row = await Repo.transactions.get(rowId);
  assertCurrent();
  if (
    !row ||
    row.id !== rowId ||
    row.status !== ITransactionStatus.GeneratingTransaction ||
    !row.attemptId ||
    row.restoredFromBackup ||
    row.recovered
  ) {
    throw new Error('Guardian completion is not an active local attempt');
  }
  // These primitives survive later row edits without adopting a different action.
  const target = targetOf(row);
  const operationBinding = committedGuardianOperationBinding(row);
  if (!operationBinding) throw new Error('Guardian completion has no structural binding');
  const attemptId = row.attemptId;
  const accountId = row.accountId;
  const accounts = await vault.fetchAccounts();
  assertCurrent();
  const account = accounts.find(item => sameWalletAccountId(item.publicKey, accountId));
  if (!account || account.type !== WalletType.Guardian) throw new Error('Guardian completion account is unavailable');
  const accountBinding = bindingOf(account);
  const assertAccountCurrent = (storedAccount?: WalletAccount) => {
    if (storedAccount && bindingOf(storedAccount) !== accountBinding) {
      throw new Error('Guardian completion stored account changed');
    }
    assertCurrent();
    const current = store.getState().accounts.find(item => item.publicKey === account.publicKey);
    if (!current || bindingOf(current) !== accountBinding) throw new Error('Guardian completion account changed');
  };
  assertAccountCurrent();
  assertWalletAccessAllowed();
  return issueCommittedGuardianIntent(
    rowId,
    attemptId,
    operationBinding,
    async (evidence: CommittedGuardianEvidence, assertIntentCurrent, deadlineMs) => {
      const assertCompletionCurrent = (storedAccount?: WalletAccount) => {
        assertIntentCurrent();
        assertAccountCurrent(storedAccount);
      };
      // The same attempt can be retired while its node proof or queue turn waits.
      const assertRowCurrent = async () => {
        assertCompletionCurrent();
        const currentRow = await Repo.transactions.get(rowId);
        assertCompletionCurrent();
        if (
          !currentRow ||
          currentRow.attemptId !== attemptId ||
          currentRow.accountId !== accountId ||
          currentRow.restoredFromBackup ||
          currentRow.recovered ||
          targetOf(currentRow).type !== target.type ||
          targetOf(currentRow).value !== target.value
        ) {
          throw new Error('Guardian completion no longer matches its admitted operation');
        }
      };
      await assertRowCurrent();
      const verdict = await readLastSyncedVerdict(evidence.transactionId, {
        watchdogMs: Math.max(1, Math.min(15_000, deadlineMs - Date.now())),
        label: 'guardian-completion-verdict'
      });
      assertCompletionCurrent();
      if (verdict === false) throw new Error('Guardian completion transaction was discarded');
      // Apply can fail before the local transaction record is saved. The exact
      // executed final commitment, observed on the node, still proves landing.
      const commitment = await readChainAccountCommitment(
        account.publicKey,
        Math.max(1, Math.min(15_000, deadlineMs - Date.now()))
      );
      assertCompletionCurrent();
      if (commitment?.toLowerCase() !== evidence.finalCommitment) {
        throw new Error('Guardian completion does not match current chain state');
      }
      await getAccountsWriteQueue().add(async () => {
        await assertRowCurrent();
        const currentAccounts = await vault.fetchAccounts();
        assertCompletionCurrent();
        const currentAccount = currentAccounts.find(item => item.publicKey === account.publicKey);
        if (!currentAccount || bindingOf(currentAccount) !== accountBinding) {
          throw new Error('Guardian completion account changed before its write');
        }
        // Vault rechecks the actual stored binding; encryption repeats the lifetime
        // assertion immediately before its irreversible storage call.
        const updated =
          target.type === 'replace-hot-key'
            ? await vault.swapHotKey(
                account.publicKey,
                target.value,
                account.hotPublicKey ?? null,
                assertCompletionCurrent
              )
            : await vault.setGuardianEndpoint(
                account.publicKey,
                target.value,
                assertCompletionCurrent,
                account.guardianEpoch ?? 0
              );
        assertCompletionCurrent();
        accountsUpdated({ accounts: updated.accounts });
      });
    }
  );
}

/** This command performs only a previously admitted, committed operation's local bookkeeping. */
export const completeCommittedGuardianCompletion = finishCommittedGuardianIntent;
