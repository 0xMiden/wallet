import { useEffect } from 'react';

import { IEarnDepositExtraInputs, IEarnWithdrawExtraInputs, ITransactionStatus } from 'lib/miden/db/types';

import { hasEarnWithdrawRecoveryWork } from './earn-withdraw-policy';
import { isEvmAddress } from './evm-address';
import { isEarnWithdrawalStale } from './intent-key';
import { earnDepositPollKey, earnWithdrawPollKey, isPollActive } from './poll-registry';

const POLL_INTERVAL_MS = 15_000;

/** Recover document-lifetime earn polling from any ready wallet surface. */
export function EarnIntentWatcher(): null {
  useEffect(() => {
    let disposed = false;
    let scanning = false;
    let depositsRunning = false;
    let withdrawalsRunning = false;

    const runDeposits = async () => {
      if (disposed || depositsRunning) return;
      depositsRunning = true;
      try {
        const { reconcileEarnDeposits } = await import('./earn');
        if (!disposed) await reconcileEarnDeposits();
      } catch (error) {
        console.warn('[earn-intent-watcher] deposits failed', error);
      } finally {
        depositsRunning = false;
      }
    };
    const runWithdrawals = async () => {
      if (disposed || withdrawalsRunning) return;
      withdrawalsRunning = true;
      try {
        const { reconcileEarnWithdrawals } = await import('./earn-withdraw');
        if (!disposed) await reconcileEarnWithdrawals();
      } catch (error) {
        console.warn('[earn-intent-watcher] withdrawals failed', error);
      } finally {
        withdrawalsRunning = false;
      }
    };
    const tick = async () => {
      if (disposed || scanning || (typeof document !== 'undefined' && document.hidden)) return;
      scanning = true;
      try {
        const { deposits, withdrawals } = await findUncoveredEarnRows();
        if (disposed) return;
        if (deposits) void runDeposits();
        if (withdrawals) void runWithdrawals();
      } catch (error) {
        console.warn('[earn-intent-watcher] scan failed', error);
      } finally {
        scanning = false;
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return null;
}

async function findUncoveredEarnRows(): Promise<{ deposits: boolean; withdrawals: boolean }> {
  const Repo = await import('lib/miden/repo');
  const rows = await Repo.transactions
    .filter(tx => tx.type === 'earn-deposit' || tx.type === 'earn-withdraw')
    .toArray();

  let deposits = false;
  let withdrawals = false;
  for (const row of rows) {
    if (row.type === 'earn-deposit') {
      const inputs: IEarnDepositExtraInputs | undefined = row.extraInputs;
      if (row.restoredFromBackup || row.status !== ITransactionStatus.Completed || !inputs?.intentNonce) continue;
      if (inputs.epochStatus === 'confirmed' || inputs.epochStatus === 'failed') continue;
      if (
        isEvmAddress(inputs.evmRecipient) &&
        !isPollActive(earnDepositPollKey(inputs.evmRecipient, inputs.intentNonce))
      )
        deposits = true;
    } else {
      const inputs: IEarnWithdrawExtraInputs | undefined = row.extraInputs;
      if (!inputs || !hasEarnWithdrawRecoveryWork(row)) continue;
      // Local provenance and TTL repair must run even while an intent has an owner.
      if (
        row.restoredFromBackup ||
        (!inputs.withdrawIntentNonce && isEarnWithdrawalStale(row)) ||
        !inputs.evmOwner ||
        !inputs.withdrawIntentNonce ||
        !isPollActive(earnWithdrawPollKey(inputs.evmOwner, inputs.withdrawIntentNonce))
      )
        withdrawals = true;
    }
    if (deposits && withdrawals) break;
  }
  return { deposits, withdrawals };
}
