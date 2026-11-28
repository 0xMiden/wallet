import { useEffect, useState } from 'react';

import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import type { IOneClickPhase, IOneClickTrackingData, ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { depositDeadlineMs, nearIntentsTrackingOf } from 'screens/near-intents-flow/deposit-status';

/** A NEAR Intents deposit into Miden of one account: its tracking row id, its start time and its tracking data. */
export interface NearDepositRecord {
  id: string;
  /** The time the row started, in Unix milliseconds (`ITransaction.initiatedAt` is in whole seconds). */
  startedAt: number;
  tracking: IOneClickTrackingData;
}

/**
 * Where a NEAR Intents deposit stands for Home and for the arrival notice:
 * - `waiting`: 1Click did not see a deposit yet (the address takes one until its deadline).
 * - `seen`: 1Click saw the deposit; the bridge to Miden is in progress or done.
 * - `closed`: 1Click refunded it, failed it, or the address expired.
 */
export type NearDepositStage = 'waiting' | 'seen' | 'closed';

export function nearDepositStageOf(phase: IOneClickPhase): NearDepositStage {
  switch (phase) {
    case 'depositing':
    case 'pending-deposit':
    case 'incomplete-deposit':
      return 'waiting';
    case 'known-deposit-tx':
    case 'processing':
    case 'arriving':
    case 'delivered':
      return 'seen';
    case 'refunded':
    case 'failed':
    case 'expired':
      return 'closed';
  }
}

/**
 * The state of the Home row of a NEAR Intents deposit at `now`, or null when Home does not show it:
 * - `waiting`: the address waits for the deposit and its deadline did not pass.
 * - `received`: 1Click saw the deposit and the bridge is in progress (`known-deposit-tx`, `processing`).
 * Home does not show a deposit that arrived on Miden, that closed, or whose address expired.
 */
export function nearDepositHomeStateOf(tracking: IOneClickTrackingData, now: number): 'waiting' | 'received' | null {
  switch (tracking.phase) {
    case 'depositing':
    case 'pending-deposit':
    case 'incomplete-deposit': {
      const deadline = depositDeadlineMs(tracking);
      // An incomplete deposit can wait past the deadline: 1Click refunds it. Home shows it only before the deadline.
      return Number.isFinite(deadline) && now < deadline ? 'waiting' : null;
    }
    case 'known-deposit-tx':
    case 'processing':
      return 'received';
    case 'arriving':
    case 'delivered':
    case 'refunded':
    case 'failed':
    case 'expired':
      return null;
  }
}

/**
 * The NEAR Intents deposits into Miden of the account, newest first: `bridged-receive` rows with 1Click tracking and
 * a deposit address. A row restored from a backup is left out: nothing reconciles it.
 */
export async function readNearDeposits(accountPublicKey: string): Promise<NearDepositRecord[]> {
  const rows = await Repo.transactions
    .where('type')
    .equals('bridged-receive')
    .filter(row => row.accountId === accountPublicKey && row.restoredFromBackup !== true)
    .toArray();
  return rows
    .flatMap((row: ITransaction): NearDepositRecord[] => {
      const tracking = nearIntentsTrackingOf(row);
      if (!tracking || tracking.direction !== 'evm-to-miden') return [];
      return [{ id: row.id, startedAt: row.initiatedAt * 1000, tracking }];
    })
    .sort((left, right) => right.startedAt - left.startedAt);
}

/**
 * The NEAR Intents deposits of the account (`readNearDeposits`), through a Dexie live query: a phase that the tracking
 * loop writes in any realm shows at once. It reads only while `enabled` and keeps the last answer while it is off.
 * Empty until the first read lands and for no account.
 */
export function useNearDeposits(accountPublicKey: string | undefined, enabled: boolean): NearDepositRecord[] {
  const [deposits, setDeposits] = useState<NearDepositRecord[]>([]);
  useEffect(() => {
    if (accountPublicKey === undefined) {
      setDeposits([]);
      return undefined;
    }
    if (!enabled) return undefined;
    return subscribeToLiveQuery(() => readNearDeposits(accountPublicKey), {
      next: setDeposits,
      // A failed read keeps the last answer.
      error: error => console.warn('[deposit-flow] the NEAR Intents deposit read failed', error)
    });
  }, [accountPublicKey, enabled]);
  return deposits;
}

/**
 * The current time, set again when the next deadline of `deadlines` passes (one timer, not one each second), so a
 * waiting row leaves Home when its address expires. NaN deadlines and past deadlines set no timer.
 */
export function useNowAtDeadlines(deadlines: readonly number[]): number {
  const [now, setNow] = useState(() => Date.now());
  const next = deadlines.filter(deadline => Number.isFinite(deadline) && deadline > now).sort((a, b) => a - b)[0];
  useEffect(() => {
    if (next === undefined) return undefined;
    // A timer that fires before the deadline (or a deadline past the longest timer) sets a new `now`, and this runs again.
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(next - Date.now(), MAX_TIMER_MS)) + 1
    );
    return () => window.clearTimeout(timer);
  }, [next, now]);
  return now;
}

/** The longest delay that a browser timer holds. */
const MAX_TIMER_MS = 2_147_483_647;
