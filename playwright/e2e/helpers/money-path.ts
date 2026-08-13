import { expect } from '@playwright/test';

import { toBaseUnits, waitForPendingNoteTotal, waitForVaultBalance, waitForVaultDebit } from './balance-truth';
import type { MidenCli } from './miden-cli';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import type { TestStepRunner } from '../harness/test-step';
import type { TimelineRecorder } from '../harness/timeline-recorder';

/**
 * The core money journeys, written once and run against every account type.
 *
 * WHY THIS IS A MODULE AND NOT COPY-PASTE. `send-public`, `send-private` and
 * `send-public-local-prove` are near-identical files, and all three shipped the
 * SAME defect — reading the sender's balance once, with no wait, so a healthy
 * transfer reported `debited 0` (#650). One bug, fixed in three places, because
 * the journey lived in three places. Production can only create Guardian
 * accounts, so covering that axis means running these journeys twice; doing it
 * by copying the files would have made that same bug a five-place fix.
 *
 * The account type is injected as a factory, so a spec chooses the axis and
 * nothing else differs between the legs.
 */

/** The faucet the harness deploys (miden-cli.ts createFaucet defaults). */
export const TOKEN = 'TST';
export const TOKEN_DECIMALS = 8;

/** Creates the wallets a journey runs against — the ONLY difference between legs. */
export interface AccountAxis {
  /** Appears in step names and timeline messages so a failure names its leg. */
  readonly label: string;
  create(wallet: GuardianAwareWalletPage): Promise<{ address: string }>;
}

/**
 * Fully-private (OffChain) accounts — what the test bypass creates by default.
 * Note this is NOT a configuration production can reach: `ChooseGuardian` always
 * emits an operator endpoint. It is kept as a leg because the offchain path is
 * still the cheaper signal and runs without a guardian container.
 */
export const offChainAxis: AccountAxis = {
  label: 'offchain',
  create: async wallet => wallet.createNewWallet()
};

/** Guardian (co-signed) accounts — the ONLY type production onboarding creates. */
export function guardianAxis(guardianUrl: string): AccountAxis {
  return {
    label: 'guardian',
    create: async wallet => wallet.createGuardianWallet(guardianUrl)
  };
}

interface JourneyContext {
  walletA: GuardianAwareWalletPage;
  walletB: GuardianAwareWalletPage;
  midenCli: MidenCli;
  steps: TestStepRunner;
  timeline: TimelineRecorder;
  axis: AccountAxis;
}

/**
 * Mint N notes to one account, claim them in one pass, and pin the result.
 *
 * The claim is the point. `multi-claim.spec.ts` was named "Multi-Note Claiming"
 * and titled "mint multiple notes and claim all" but never claimed — it asserted
 * the PENDING total and stopped, so the batching path it advertised had no
 * coverage on any account type. Claiming and then pinning the vault to the exact
 * sum is what distinguishes "all three notes were consumed" from "one was, and
 * the other two are still sitting there".
 */
export async function runMultiNoteClaimJourney(ctx: JourneyContext, mintsBaseUnits: readonly bigint[]): Promise<void> {
  const { walletA, walletB, midenCli, steps, timeline, axis } = ctx;
  const total = mintsBaseUnits.reduce((sum, amount) => sum + amount, 0n);
  let addressA = '';
  let faucetId = '';

  await steps.step(`create_wallets_${axis.label}`, async () => {
    const a = await axis.create(walletA);
    // The fixture requires both instances to be provisioned.
    await axis.create(walletB);
    addressA = a.address;
    expect(addressA, 'the created wallet must report an account address').toMatch(
      /^m[a-z]{1,4}1[a-z0-9]+(_[a-z0-9]+)?$/i
    );
  });

  await steps.step('deploy_faucet', async () => {
    await midenCli.init();
    faucetId = await midenCli.createFaucet();
  });

  await steps.step(`mint_${mintsBaseUnits.length}_notes`, async () => {
    for (const amount of mintsBaseUnits) {
      await midenCli.mint(faucetId, addressA, Number(amount), 'public');
    }
    await midenCli.sync();
  });

  await steps.step(
    'discover_every_note_before_claiming',
    async () => {
      // Wait for the FULL sum, not "something arrived": claiming while only one
      // of the notes has synced consumes that one and leaves the rest stranded,
      // which is precisely the multi-note bug this journey exists to catch (and
      // the same discovery race fixed in #645).
      await waitForPendingNoteTotal(walletA.page, TOKEN, total, { timeoutMs: 180_000, decimals: TOKEN_DECIMALS });
    },
    { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
  );

  await steps.step(
    'claim_all_notes',
    async () => {
      await walletA.claimAllNotes(180_000);

      // Every note consumed, none left behind: the vault holds the exact sum AND
      // nothing is still pending. Either half alone is satisfiable by a partial
      // claim.
      await waitForVaultBalance(walletA.page, TOKEN, total, { timeoutMs: 180_000, decimals: TOKEN_DECIMALS });
      await waitForPendingNoteTotal(walletA.page, TOKEN, 0n, { timeoutMs: 120_000, decimals: TOKEN_DECIMALS });

      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `[${axis.label}] claimed ${mintsBaseUnits.length} notes into a vault of exactly ${total} base units`,
        data: { axis: axis.label, notes: mintsBaseUnits.length, totalBaseUnits: total.toString() }
      });
    },
    {
      captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
      screenshotWallets: [{ target: walletA.page, label: 'A' }]
    }
  );
}

/**
 * Fund A, send PRIVATELY to B, and assert both sides of the transfer.
 *
 * Private notes travel via the note-transport layer rather than the chain's
 * public note list, so the recipient half is a genuinely different code path
 * from a public send — and one with a history of silent non-delivery
 * (the block-hint overshoot fixed in wallet #502).
 */
export async function runPrivateSendJourney(
  ctx: JourneyContext,
  opts: { mintBaseUnits: bigint; sendAmount: string }
): Promise<void> {
  const { walletA, walletB, midenCli, steps, timeline, axis } = ctx;
  const sendBaseUnits = toBaseUnits(opts.sendAmount, TOKEN_DECIMALS);
  let addressA = '';
  let addressB = '';
  let faucetId = '';

  await steps.step(`create_wallets_${axis.label}`, async () => {
    const a = await axis.create(walletA);
    const b = await axis.create(walletB);
    addressA = a.address;
    addressB = b.address;
    expect(addressA).not.toBe(addressB);
  });

  await steps.step('deploy_and_fund', async () => {
    await midenCli.init();
    faucetId = await midenCli.createFaucet();
    await midenCli.mint(faucetId, addressA, Number(opts.mintBaseUnits), 'public');
    await midenCli.sync();
  });

  await steps.step('claim_funding_note', async () => {
    await waitForPendingNoteTotal(walletA.page, TOKEN, opts.mintBaseUnits, {
      timeoutMs: 180_000,
      decimals: TOKEN_DECIMALS
    });
    await walletA.claimAllNotes(180_000);
    // The send below can only be asserted exactly once A's SPENDABLE vault has
    // settled at the full claimed amount.
    await waitForVaultBalance(walletA.page, TOKEN, opts.mintBaseUnits, {
      timeoutMs: 180_000,
      decimals: TOKEN_DECIMALS
    });
  });

  await steps.step(
    'send_private_a_to_b',
    async () => {
      await walletA.sendTokens({
        recipientAddress: addressB,
        amount: opts.sendAmount,
        // The native MIDEN row (0 balance) sorts above the CLI faucet's row, so
        // the default first-row click would pick the wrong token.
        tokenSymbol: TOKEN,
        isPrivate: true
      });
    },
    { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
  );

  await steps.step(
    'verify_both_sides_of_the_transfer',
    async () => {
      // B DISCOVERS the private note but does not claim it — auto-consume only
      // covers native MIDEN notes, so a TST note stays unconsumed. The delivery
      // assertion is therefore an exact PENDING total; asserting B's vault would
      // fail on a perfectly healthy wallet.
      await waitForPendingNoteTotal(walletB.page, TOKEN, sendBaseUnits, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });

      // The other half: A must actually have paid. Waited, not read once — the
      // recipient's total moving says nothing about when the SENDER's balances
      // projection catches up (#650).
      const debited = await waitForVaultDebit(walletA.page, TOKEN, opts.mintBaseUnits, sendBaseUnits, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });

      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `[${axis.label}] private send delivered ${sendBaseUnits} base units to B; A debited ${debited}`,
        data: { axis: axis.label, sentBaseUnits: sendBaseUnits.toString(), debitedBaseUnits: debited.toString() }
      });
    },
    {
      captureStateFrom: [
        { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
        { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
      ],
      screenshotWallets: [
        { target: walletA.page, label: 'A' },
        { target: walletB.page, label: 'B' }
      ]
    }
  );
}
