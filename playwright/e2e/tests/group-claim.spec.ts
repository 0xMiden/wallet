import { expect, test } from '../fixtures/two-wallets';
import { assertClaimed } from '../helpers/assertions';
import { pendingNoteTotal, vaultBalance, waitForPendingNoteTotal } from '../helpers/balance-truth';
import {
  openAssetGroupDetail,
  openPendingNotesFromHomePrompt,
  readDetailNoteAmounts
} from '../helpers/pending-notes-ui';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// The two mints this spec sends to wallet A, in base units. One faucet, two
// notes → a single asset group holding both. The amounts are chosen so the
// RENDERED strings are distinctive: 1234 exercises thousands grouping on the
// summary row (and its deliberate absence on the per-note rows), 560.5
// exercises a fractional part and trailing-zero trimming, and their sum is
// neither of them.
const MINT_1_BASE_UNITS = 123_400_000_000n; // 1234 TST
const MINT_2_BASE_UNITS = 56_050_000_000n; // 560.5 TST
const MINTED_TOTAL_BASE_UNITS = MINT_1_BASE_UNITS + MINT_2_BASE_UNITS; // 1794.5 TST

// What the wallet must RENDER for those amounts. Written out literally rather
// than computed with the product's own formatter: re-deriving the expectation
// from `formatBigInt`/`groupNumber` would move both sides of the assertion
// together and could not catch a formatting regression at all.
//
// The two shapes differ on purpose, and both are asserted as-is:
//   summary row  (AssetSummaryRow) — `{groupNumber(total)} {symbol}`, space-separated
//   per-note row (DetailNoteRow)   — `{amount}{symbol}`, ungrouped, NO space
// If the team unifies them, this fails and names the new string — which is the
// point of asserting on rendered text.
const EXPECTED_SUMMARY_TEXT = '1,794.5 TST';
const EXPECTED_DETAIL_TEXTS = ['1234TST', '560.5TST'].sort();

/**
 * Covers the v0-UI two-level Pending-tab claim flow's per-faucet GROUP-claim
 * path: Home pending prompt → PendingTab summary → open an asset row → asset
 * detail view → the "Claim N/M" group button (handleClaimGroup) / per-note
 * Claim buttons. Every other claim spec (mint-and-balance, send-*, multi-claim)
 * drains via the top-level "Claim All" (claimAllNotes), so this two-level DOM
 * drill-down is otherwise unexercised. Chrome-only by design; mobile page
 * objects cover their React Claim All button path separately.
 *
 * Two things on that path are asserted here and nowhere else:
 *
 *   1. WHAT THE SCREEN SAYS. Every other claim assertion reads the store
 *      (helpers/balance-truth). The store cannot see the decimals the row
 *      resolved (PendingTab falls back to 6 when metadata carries none),
 *      thousands grouping, trailing-zero trimming, or the per-note breakdown —
 *      it cannot tell two notes of the right sizes from one row printing the
 *      sum twice. Those are asserted as text, BEFORE `claimNotesByGroup` runs,
 *      because that method injects fabricated faucet metadata into the store
 *      (see helpers/pending-notes-ui.ts) and asserting a symbol the harness
 *      wrote would be circular.
 *
 *   2. THE PENDING INDICATOR. A non-native token is never auto-consumed
 *      (Explore.tsx gates on the native faucet id, and so does the service
 *      worker's sync-manager), regardless of the auto-consume setting, so the
 *      Home prompt is the only thing that tells a user their tokens are sitting
 *      unclaimed. It had no coverage at all. This spec enters the pending
 *      screen through it rather than by navigating to the route.
 */
test.describe('Pending tab — per-faucet group claim', () => {
  test.describe.configure({ mode: 'serial' });

  test('shows the received token, then claims it via the asset-group detail view', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    // Above the sum of the in-page waits this test grants itself, so a leg that
    // overruns fails with its own diagnostic instead of a bare "test timeout":
    //   discover 180s + prompt/render 185s + claimNotesByGroup 240s + drain 90s
    //   + assertClaimed 90s = 785s.
    // The `midenCli` legs (createFaucet's retry ladder, two mints) run on their
    // own timeouts outside this and are not double-budgeted — a faucet deploy
    // that needs its full ladder means the chain is down, which is not the
    // failure this budget exists to keep legible.
    test.setTimeout(840_000);
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
      // so the group-claim button drains more than one note in a single action,
      // and the summary total is a different number from either note's amount.
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
      'see_pending_prompt_and_assert_rendered_amounts',
      async () => {
        // Home prompt → card tap → /pending-notes: the journey a user who never
        // opens the receive screen actually takes.
        await openPendingNotesFromHomePrompt(walletA, { timeoutMs: 45_000 });

        // Both notes come from one faucet, so they must collapse into exactly
        // one row — two rows would mean the grouping key regressed.
        await expect(
          walletA.page.getByTestId('pending-asset-row'),
          'both notes are from one faucet and must group into a single pending row'
        ).toHaveCount(1, { timeout: 20_000 });
        // Grouped total and symbol, as text. Fails on wrong decimals (the `?? 6`
        // fallback renders 17.945), on lost thousands grouping, and on a total
        // that is not the sum of the two notes.
        await expect(
          walletA.page.getByTestId('pending-asset-amount'),
          `the pending row must name the token and its total as "${EXPECTED_SUMMARY_TEXT}"`
        ).toHaveText(EXPECTED_SUMMARY_TEXT, { timeout: 20_000 });

        await openAssetGroupDetail(walletA.page, { timeoutMs: 20_000 });
        const rendered = await readDetailNoteAmounts(walletA.page, 2, { timeoutMs: 20_000 });
        // Per-note amounts, not the total: this is what distinguishes "two notes
        // of the right sizes" from "one row showing the sum twice".
        expect(rendered, 'each pending note must render its own amount and the token symbol').toEqual(
          EXPECTED_DETAIL_TEXTS
        );
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
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
