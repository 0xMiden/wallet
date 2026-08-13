import { expect, test } from '../fixtures/two-wallets';
import { assertClaimed } from '../helpers/assertions';
import { pendingNoteTotal, vaultBalance, waitForPendingNoteTotal } from '../helpers/balance-truth';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// The two mints this spec sends to wallet A, in base units. One faucet, two
// notes → a single asset group holding both.
const MINT_1_BASE_UNITS = 50_000_000_000n;
const MINT_2_BASE_UNITS = 30_000_000_000n;
const MINTED_TOTAL_BASE_UNITS = MINT_1_BASE_UNITS + MINT_2_BASE_UNITS;

/**
 * Covers the v0-UI two-level Pending-tab claim flow's per-faucet GROUP-claim
 * path: PendingTab summary → open an asset row → asset detail view → the
 * "Claim N/M" group button (handleClaimGroup) / per-note Claim buttons. Every
 * other claim spec (mint-and-balance, send-*, multi-claim) drains via the
 * top-level "Claim All" (claimAllNotes), so this two-level DOM drill-down is
 * otherwise unexercised. Chrome-only by design; mobile page objects cover their
 * React Claim All button path separately.
 */
test.describe('Pending tab — per-faucet group claim', () => {
  test.describe.configure({ mode: 'serial' });

  test('claims minted notes via the asset-group detail view', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    test.setTimeout(420_000);
    let addressA: string;
    let beforeClaim: { vault: bigint; pending: bigint };

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      // The two-wallets fixture provisions both; B is unused here.
      await walletB.createNewWallet();
      addressA = a.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      // Two notes from ONE faucet → a single asset group holding multiple notes,
      // so the group-claim button drains more than one note in a single action.
      await midenCli.mint(faucetId, addressA!, MINT_1_BASE_UNITS, 'public');
      await midenCli.mint(faucetId, addressA!, MINT_2_BASE_UNITS, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'sync_wallet_a',
      async () => {
        // BOTH mints must be discovered as UNCONSUMED notes before the group
        // claim has anything to drain — a group of one note would not exercise
        // the "Claim N/M" path at all. The old `waitForBalanceAbove(0)` passed
        // as soon as a single note of any token showed up.
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINTED_TOTAL_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `Wallet A discovered ${MINTED_TOTAL_BASE_UNITS} base units of ${TOKEN} as unconsumed notes`,
          data: { symbol: TOKEN, expectedBaseUnits: MINTED_TOTAL_BASE_UNITS.toString() }
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }]
      }
    );

    await steps.step(
      'claim_via_asset_group',
      async () => {
        // Baseline for the claim assertion: what is spendable vs. still pending
        // immediately before the group claim runs.
        beforeClaim = {
          vault: await vaultBalance(walletA.page, TOKEN),
          pending: await pendingNoteTotal(walletA.page, TOKEN)
        };
        // Drives PendingTab → asset-row → detail → claim-group-button / claim-button.
        await walletA.claimNotesByGroup(240_000);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('verify_notes_consumed', async () => {
      // The group-claim path must consume every pending note (not just surface
      // them) — the pending list drains to empty as the consumes commit.
      await expect
        .poll(async () => (await walletA.quickBalanceSnapshot()).pendingNotes.length, { timeout: 90_000 })
        .toBe(0);
      // …and the consumed value must land in the VAULT: exactly both mints
      // spendable, with the same amount gone from the unconsumed total. The old
      // `> 0` on a vault+pending sum read identically whether the notes were
      // claimed or merely discovered.
      await walletA.refreshBalances();
      await assertClaimed(
        { page: walletA.page, label: 'A' },
        TOKEN,
        TOKEN_DECIMALS,
        beforeClaim!,
        MINTED_TOTAL_BASE_UNITS,
        {
          timeoutMs: 90_000
        }
      );
    });
  });
});
