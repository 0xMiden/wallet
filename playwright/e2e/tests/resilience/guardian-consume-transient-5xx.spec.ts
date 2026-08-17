import { test, expect } from '../../fixtures/two-wallets';
import { waitForPendingNoteTotal, waitForVaultBalance } from '../../helpers/balance-truth';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';

/**
 * Guardian resilience: a co-signed CONSUME survives a transient generic guardian
 * 5xx and still lands.
 *
 * Complements the conflict-retry guard (#16, a SEND under a 409) and the
 * structural-op guard (gap 15, a SWITCH under a 5xx): this covers the third
 * co-signed money path — CONSUME — under a plain transient `500` on the guardian
 * `/delta` round-trips (propose/sign/push). A guardian briefly 5xx-ing mid-claim
 * must not strand the note; the wallet's transaction retry must drive it to
 * Completed once the guardian is back.
 *
 * `failFirstN` faults the first couple of `/delta` calls then clears. The
 * guardian `context.route` seam reaches SW guardian HTTP; `guardianFaultHits()`
 * proves the fault fired (a claim that drained with zero hits would be a false
 * green). If this goes RED, the co-signed consume does not tolerate a transient
 * guardian 5xx and the product needs the fix.
 */
const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';
const MINT_BASE_UNITS = 100_000_000_000n; // 1000 TST

test.describe('infra resilience — transient guardian 5xx during a consume', () => {
  test.describe.configure({ mode: 'serial' });

  test('a co-signed consume survives a transient guardian 5xx and settles the vault', async ({
    walletA,
    midenCli,
    steps,
    timeline
  }) => {
    test.setTimeout(600_000);

    let addressA = '';

    await steps.step('create_and_fund_guardian_wallet', async () => {
      const a = await walletA.createGuardianWallet(GUARDIAN_URL);
      addressA = a.address;
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, MINT_BASE_UNITS, 'public');
      await midenCli.sync();
      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'consume_survives_transient_guardian_5xx',
      async () => {
        // First couple of guardian /delta round-trips 500, then clear.
        walletA.armGuardianFault({ target: 'A', path: 'delta', mode: 'failFirstN', count: 2 });

        // The co-signed consume must still drive the note into the vault.
        await walletA.claimAllNotes(180_000);
        await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });

        // Prove the fault fired during the consume.
        const hits = walletA.guardianFaultHits();
        expect(
          hits,
          'the transient 5xx must have fired on the consume — 0 hits means the fault never reached the co-signed op'
        ).toBeGreaterThanOrEqual(1);

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `[resilience] co-signed consume absorbed a transient guardian 5xx and settled the vault at ${MINT_BASE_UNITS} base units`,
          data: { mintBaseUnits: MINT_BASE_UNITS.toString() }
        });
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step('clear', async () => {
      await walletA.clearFaults();
    });
  });
});
