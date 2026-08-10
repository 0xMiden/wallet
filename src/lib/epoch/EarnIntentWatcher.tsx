import { useEffect, useRef } from 'react';

import { ITransactionStatus } from 'lib/miden/db/types';

import { earnDepositPollKey, earnWithdrawPollKey, isPollActive } from './poll-registry';

/**
 * Headless app-root driver for the Epoch earn pollers. `pollEarnIntentStatus`
 * and `pollEarnWithdrawDelivery` are context-lifetime setIntervals: they used
 * to be kicked from the initiating flow and re-kicked once per session from the
 * Home mount (and again by the history detail page), so a poller that died with
 * its context stayed dead until the user visited the right screen. This watcher
 * owns the restart instead: every tick it runs a cheap Dexie scan for
 * non-terminal `earn-deposit`/`earn-withdraw` rows and, only when one isn't
 * covered by a live poll (poll-registry), dynamic-imports the reconcilers to
 * re-poll and re-kick. Steady state is one IndexedDB scan per tick with zero
 * network and zero heavy imports.
 *
 * Modeled on `DepositAddressWatcher`: `running` ref against overlap, `disposed`
 * flag so a teardown mid-tick can't act, `document.hidden` early-out. Same
 * extension caveat: runs only while the popup/panel is open — parity with the
 * page-mounted pollers it replaces.
 */
const POLL_INTERVAL_MS = 15_000;

export function EarnIntentWatcher(): null {
  const running = useRef(false);

  useEffect(() => {
    let disposed = false;

    const tick = async () => {
      if (disposed || running.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      running.current = true;
      try {
        const { deposits, withdrawals } = await findUncoveredEarnRows();
        if (disposed) return;
        if (deposits) {
          const { reconcileEarnDeposits } = await import('./earn');
          await reconcileEarnDeposits();
        }
        if (disposed) return;
        if (withdrawals) {
          const { reconcileEarnWithdrawals } = await import('./earn-withdraw');
          await reconcileEarnWithdrawals();
        }
      } catch (err) {
        console.warn('[earn-intent-watcher] tick failed', err);
      } finally {
        running.current = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return null;
}

const TERMINAL_DEPOSIT_STATUSES = new Set(['confirmed', 'failed']);
const TERMINAL_WITHDRAW_PHASES = new Set(['received', 'failed']);

/** `extraInputs` is a union across row types — read it defensively, not by cast. */
function pendingDepositNonce(status: ITransactionStatus, extraInputs: unknown): string | undefined {
  if (status !== ITransactionStatus.Completed) return undefined;
  if (!extraInputs || typeof extraInputs !== 'object') return undefined;
  const epochStatus: unknown = Reflect.get(extraInputs, 'epochStatus');
  if (typeof epochStatus === 'string' && TERMINAL_DEPOSIT_STATUSES.has(epochStatus)) return undefined;
  const nonce: unknown = Reflect.get(extraInputs, 'intentNonce');
  return typeof nonce === 'string' && nonce ? nonce : undefined;
}

function pendingWithdrawNonce(extraInputs: unknown): { pending: boolean; nonce?: string } {
  if (!extraInputs || typeof extraInputs !== 'object') return { pending: false };
  const phase: unknown = Reflect.get(extraInputs, 'phase');
  if (typeof phase !== 'string' || TERMINAL_WITHDRAW_PHASES.has(phase)) return { pending: false };
  const nonce: unknown = Reflect.get(extraInputs, 'withdrawIntentNonce');
  return { pending: true, nonce: typeof nonce === 'string' && nonce ? nonce : undefined };
}

/**
 * Cheap gate on the reconcile imports: scan Dexie for non-terminal earn rows and
 * report, per side, whether any of them lacks a live poll. A row with an active
 * registry key is already covered; a non-terminal row WITHOUT a nonce (teardown
 * mid-solve) still counts as uncovered so the reconciler can recover or fail it.
 */
async function findUncoveredEarnRows(): Promise<{ deposits: boolean; withdrawals: boolean }> {
  const Repo = await import('lib/miden/repo');
  const rows = await Repo.transactions
    .filter(tx => tx.type === 'earn-deposit' || tx.type === 'earn-withdraw')
    .toArray();

  let deposits = false;
  let withdrawals = false;
  for (const row of rows) {
    if (row.type === 'earn-deposit') {
      const nonce = pendingDepositNonce(row.status, row.extraInputs);
      if (nonce && !isPollActive(earnDepositPollKey(nonce))) deposits = true;
    } else {
      const { pending, nonce } = pendingWithdrawNonce(row.extraInputs);
      if (pending && (!nonce || !isPollActive(earnWithdrawPollKey(nonce)))) withdrawals = true;
    }
    if (deposits && withdrawals) break;
  }
  return { deposits, withdrawals };
}
