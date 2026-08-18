import { test, expect } from '../../fixtures/two-wallets';
import { toBaseUnits, waitForPendingNoteTotal, waitForVaultBalance } from '../../helpers/balance-truth';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';

/**
 * Regression guard (design plan guard #16): a transient guardian
 * `conflict_pending_delta` (409) must NOT fail a co-signed transaction — the
 * wallet's `withGuardianConflictRetry` waits it out and the transaction
 * completes.
 *
 * A real guardian returns `409 conflict_pending_delta` while a prior delta is
 * still canonicalizing; it clears on its own moments later. The fault reproduces
 * that exact 409 envelope (so `isGuardianPendingConflict` recognizes it) and
 * self-clears after `count` hits, modelling the transient nature.
 *
 * The guardian HTTP calls run in the extension service worker; this fault uses
 * the `context.route` seam (guardian-fault.ts), which is proven to reach them
 * (guardian-fault.smoke.spec.ts). Falsifiability: if the conflict-retry path
 * regressed, the faulted send would fail and B would never be credited.
 */
const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';
const MINT_BASE_UNITS = 100_000_000_000n; // 1000 TST
const SEND_AMOUNT = '500';

test.describe('infra resilience — transient guardian conflict', () => {
  test.describe.configure({ mode: 'serial' });

  test('a co-signed send survives a transient guardian conflict_pending_delta and still lands', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    test.setTimeout(600_000);

    const sendBaseUnits = toBaseUnits(SEND_AMOUNT, TOKEN_DECIMALS);
    let addressA = '';
    let addressB = '';

    await steps.step('create_wallets', async () => {
      const a = await walletA.createGuardianWallet(GUARDIAN_URL);
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
      expect(addressA).not.toBe(addressB);
    });

    await steps.step('fund_and_consume_unfaulted', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, MINT_BASE_UNITS, 'public');
      await midenCli.sync();
      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
      // Consume with a healthy guardian first, so A holds spendable balance and
      // the faulted step below isolates the SEND's conflict handling.
      await walletA.claimAllNotes(180_000);
      await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'send_survives_transient_guardian_conflict',
      async () => {
        // The next few delta round-trips answer 409 conflict_pending_delta, then
        // clear — exactly a guardian mid-canonicalization.
        walletA.armGuardianFault({ target: 'A', path: 'delta', mode: 'conflictPendingDelta', count: 2 });

        await walletA.sendTokens({
          recipientAddress: addressB,
          amount: SEND_AMOUNT,
          tokenSymbol: TOKEN,
          isPrivate: false
        });

        // The send must have landed despite the transient conflicts: B is credited
        // the exact amount and A is debited by it.
        await waitForPendingNoteTotal(walletB.page, TOKEN, sendBaseUnits, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
        await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS - sendBaseUnits, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });

        // Falsifiability guard: the send only proves conflict-RETRY works if the
        // conflict fault actually fired during it. Zero hits would mean the fault
        // never reached the send's delta calls and the send simply succeeded
        // normally — a false green. (The fault self-clears after `count`, so hits
        // caps there.)
        const hits = walletA.guardianFaultHits();
        expect(
          hits,
          'the guardian conflict fault must have fired during the send — 0 hits means it never reached the co-signed op'
        ).toBeGreaterThanOrEqual(1);

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `[resilience] co-signed send absorbed transient guardian conflicts and delivered ${sendBaseUnits} base units to B`,
          data: { sendBaseUnits: sendBaseUnits.toString() }
        });
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ],
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('clear', async () => {
      await walletA.clearFaults();
    });
  });
});
