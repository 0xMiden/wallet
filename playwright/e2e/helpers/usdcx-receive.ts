/**
 * The receive leg both bridge-in specs share (usdcx-roundtrip.spec.ts and usdcx-in-l2.spec.ts): the wallet's tracking
 * rows sampled from the moment they exist, then the service worker's own claim of the mint, the row's adoption and the
 * vault.
 */
import { expect } from '@playwright/test';
import type { Hex } from 'viem';

import { bridgeReceiveState, enText } from './bridge';
import { describeTransactionRow, openHistoryDetails, readTransactionRow } from './history';
import { DEPOSIT_UNITS } from './usdcx-constants';
import { consumeFeeAndVault, historyPill, waitForConsumeOf, type UsdcxWalletIds } from './usdcx-legs';
import {
  jsonObject,
  jsonString,
  PhaseTimeline,
  pollUntil,
  sampleInBackground,
  type FeeTerm,
  type NamedStep,
  type RunEvidence,
  type StepContext
} from './usdcx-run';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

export interface ReceivedDeposit {
  positiveId: string;
  tracker: ReceiveTracker;
  /** When the harness first saw Circle's xReserve attestation. */
  attestedAt: number;
  mintNoteId: Hex;
}

export interface ReceiveOptions {
  vaultBefore: bigint;
  terms: ReadonlyArray<readonly [string, bigint]>;
  where: StepContext;
  onGuardian: StepContext;
  evidence: RunEvidence;
  budgetMs: number;
  /** How soon after `attestedAt` the row must read `ready` or `received`. */
  readyWithinMs: number;
}

export interface ReceiveTracker {
  positive: PhaseTimeline;
  negative: { id: string; timeline: PhaseTimeline; error(): string | undefined } | null;
  stop(): Promise<void>;
}

/**
 * Samples both tracking rows every 2 s from the moment they exist. The mint lands ~30 s after the attestation and the
 * receive step starts only then, so a POSITIVE row can pass through `ready` long before anything else looks at it.
 */
export function trackReceiveRows(
  wallet: GuardianAwareWalletPage,
  positiveId: string,
  negativeId: string | undefined
): ReceiveTracker {
  const positive = new PhaseTimeline('POSITIVE bridged-receive', ['delivering', 'ready', 'received']);
  const negative = new PhaseTimeline('NEGATIVE bridged-receive', ['delivering', 'failed']);
  const negativeState: { error?: string } = {};
  const sampler = sampleInBackground(async () => {
    const at = Date.now();
    positive.record((await bridgeReceiveState(wallet, positiveId)).phase, at);
    const foreign = negativeId === undefined ? undefined : await bridgeReceiveState(wallet, negativeId);
    negative.record(foreign?.phase, at);
    negativeState.error = foreign?.error ?? negativeState.error;
    return positive.last() === 'received' && (negativeId === undefined || negative.last() === 'failed');
  }, 2_000);
  return {
    positive,
    negative:
      negativeId === undefined ? null : { id: negativeId, timeline: negative, error: () => negativeState.error },
    stop: () => sampler.stop()
  };
}

/** Spec 5 step 14: the service worker consumes the mint by itself, and the POSITIVE row ends `received` on that consume. */
export async function receiveLeg(
  step: NamedStep,
  wallet: GuardianAwareWalletPage,
  ids: UsdcxWalletIds,
  deposit: ReceivedDeposit,
  opts: ReceiveOptions
): Promise<{ consumeId: string; fee: FeeTerm; vault: bigint }> {
  return step(
    'receive',
    opts.budgetMs,
    async () => {
      const page = wallet.page;
      // A row sampled at `ready` must read Confirmed, or Completed once a re-read shows it already `received`.
      const readyPill = deposit.tracker.positive.saw('ready') ? await historyPill(wallet, deposit.positiveId) : null;
      const phaseAfterPill = readyPill === null ? null : (await bridgeReceiveState(wallet, deposit.positiveId)).phase;
      if (
        readyPill !== null &&
        readyPill !== enText('confirmed') &&
        !(readyPill === enText('completed') && phaseAfterPill === 'received')
      ) {
        throw new Error(
          `the ready POSITIVE row's details read "${readyPill}" (phase now ${phaseAfterPill ?? 'unread'})`
        );
      }
      opts.evidence.notes.push(
        readyPill === null ? 'POSITIVE was not sampled at ready' : `ready POSITIVE details read "${readyPill}"`
      );
      await wallet.navigateHome();

      // The service worker consumes the mint by itself; a claim call would add a second consume row.
      const consume = await waitForConsumeOf(page, deposit.mintNoteId, 'mint', opts.budgetMs - 120_000, opts.where);
      expect(
        (consume.noteIds ?? []).map(id => id.toLowerCase()),
        'the mint consume carries nothing but the mint note'
      ).toEqual([deposit.mintNoteId.toLowerCase()]);
      // The adoption writes the consume's `bridgeIn` and the POSITIVE's `received` right after the consume completes.
      const adopted = await pollUntil(
        'the mint consume adopting the POSITIVE row',
        async () => ({
          consume: await readTransactionRow(page, consume.id),
          positive: await bridgeReceiveState(wallet, deposit.positiveId)
        }),
        ({ consume: row, positive }) =>
          jsonObject(row?.extraInputs?.bridgeIn) !== undefined && positive.phase === 'received',
        {
          timeoutMs: 60_000,
          intervalMs: 3_000,
          describe: async last =>
            `consume ${last?.consume ? describeTransactionRow(last.consume) : 'missing'}, ` +
            `POSITIVE ${last?.positive.phase ?? 'unread'}; ${await opts.where()}`
        }
      );
      const consumeRow = adopted.consume;
      if (!consumeRow) throw new Error(`consume ${consume.id} disappeared`);
      expect({
        displayMessage: consumeRow.displayMessage,
        bridgeReceiveTxId: jsonString(jsonObject(consumeRow.extraInputs?.bridgeIn)?.bridgeReceiveTxId)
      }).toEqual({ displayMessage: 'Bridged from EVM', bridgeReceiveTxId: deposit.positiveId });

      const { fee, vault } = await consumeFeeAndVault(page, ids, consumeRow, {
        fee: 'f2',
        vaultBefore: opts.vaultBefore,
        credit: DEPOSIT_UNITS,
        terms: [...opts.terms, ['M', DEPOSIT_UNITS]]
      });
      opts.evidence.notes.push(
        `mint consume ${consumeRow.id} completed ${fee.kind === 'exact' ? 'with its result' : 'through a landed path'}`
      );

      const positiveRow = await readTransactionRow(page, deposit.positiveId);
      expect({
        phase: adopted.positive.phase,
        midenNoteId: adopted.positive.midenNoteId?.toLowerCase(),
        amount: adopted.positive.amount,
        error: adopted.positive.error,
        transactionId: positiveRow?.transactionId
      }).toEqual({
        phase: 'received',
        midenNoteId: deposit.mintNoteId.toLowerCase(),
        amount: DEPOSIT_UNITS.toString(),
        error: undefined,
        transactionId: consumeRow.transactionId
      });

      await deposit.tracker.stop();
      const positive = deposit.tracker.positive;
      positive.assertMonotone();
      opts.evidence.phases.positive = positive.samples();
      opts.evidence.notes.push(`POSITIVE ready ${positive.saw('ready') ? 'was' : 'was not'} sampled`);
      // The watcher reconciles within one 8 s tick of the attestation, give or take Circle's API.
      const settledAt = Math.min(positive.firstAt('ready') ?? Infinity, positive.firstAt('received') ?? Infinity);
      expect(
        settledAt,
        `POSITIVE stayed delivering ${opts.readyWithinMs / 1000} s after the attestation: ${positive.describe()}`
      ).toBeLessThanOrEqual(deposit.attestedAt + opts.readyWithinMs);

      await openHistoryDetails(wallet, deposit.positiveId);
      await expect(page.getByTestId('history-status-pill')).toHaveText(enText('completed'));
      await wallet.navigateHome();
      return { consumeId: consumeRow.id, fee, vault };
    },
    opts.onGuardian
  );
}
