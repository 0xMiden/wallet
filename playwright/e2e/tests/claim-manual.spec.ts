import { expect, test } from '../fixtures/two-wallets';
import { pendingNoteTotal, vaultBalance, waitForPendingNoteTotal } from '../helpers/balance-truth';
import {
  claimGroupAndExpectQueued,
  openAssetGroupDetail,
  openPendingNotesFromHomePrompt,
  readDetailNoteAmounts,
  waitForClaimSettled
} from '../helpers/claim-manual';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;

// Two mints from ONE faucet, in base units. Amounts are chosen so the rendered
// strings are distinctive: 1234 exercises thousands grouping, 560.5 exercises a
// fractional part, and their sum is neither of them.
const MINT_WHOLE_BASE_UNITS = 123_400_000_000n; // 1234 TST
const MINT_FRACTIONAL_BASE_UNITS = 56_050_000_000n; // 560.5 TST
const MINTED_TOTAL_BASE_UNITS = MINT_WHOLE_BASE_UNITS + MINT_FRACTIONAL_BASE_UNITS; // 1794.5 TST

// What the wallet must RENDER for those amounts. Written out literally rather
// than computed with the product's own formatter: re-deriving the expectation
// from `formatBigInt`/`groupNumber` would move both sides of the assertion
// together and could not catch a formatting regression at all.
//
// The two shapes differ on purpose, and both are asserted as-is:
//   summary row  (PendingTab AssetSummaryRow) — `{formattedTotal} {symbol}`, grouped, space-separated
//   per-note row (PendingTab DetailNoteRow)   — `{formattedAmount}{symbol}`, ungrouped, NO space
// If the team unifies them, this spec fails and names the new string — which is
// the point of asserting on rendered text.
const EXPECTED_SUMMARY_TEXT = '1,794.5 TST';
const EXPECTED_DETAIL_TEXTS = ['1234TST', '560.5TST'].sort();

/**
 * The MANUAL claim journey for a non-native token, asserted on what the user is
 * actually shown.
 *
 * Two things here are covered nowhere else in the suite:
 *
 *   1. THE RENDERED TOKEN IDENTITY. Every other claim assertion (mint-and-balance,
 *      multi-claim, group-claim, the send specs) reads the Zustand store or
 *      chrome.storage via helpers/balance-truth. Those stay green if the pending
 *      screen renders `UNKNOWN` and a 6-decimal fallback — PendingTab's fallback
 *      when metadata is missing — because the store still holds the right number.
 *      This spec asserts the symbol and the amount as text, so the wallet's own
 *      faucet-metadata resolution is what is being graded. That makes it a second,
 *      louder gate on the miden-assembly compat issue documented in
 *      playwright/e2e/local-stack/README.md (a faucet the client cannot read
 *      degrades to symbol 'Unknown', which drops the note from the list entirely):
 *      if that drift returns, this fails on the text instead of silently claiming
 *      an unnamed token.
 *
 *   2. THE PENDING INDICATOR. A non-native token is NEVER auto-consumed —
 *      auto-consume is native-only in both implementations (Explore.tsx gates on
 *      `note.faucetId === midenFaucetId`; the service worker's sync-manager skips
 *      anything but the native faucet), regardless of the auto-consume setting. So
 *      the Home prompt is the only thing that tells a user their tokens are sitting
 *      unclaimed, and it had no coverage at all.
 *
 * NOT re-tested here (already covered): the mechanics of the two-level claim UI
 * (group-claim.spec.ts), Claim-All draining (multi-claim.spec.ts), and the exact
 * pending TOTAL by symbol from the store (mint-and-balance.spec.ts). This spec
 * deliberately mints its own notes rather than sharing that state — the suite has
 * no cross-spec wallet — but its assertions are the rendered-text ones those
 * specs cannot make.
 *
 * The claim itself runs WITHOUT the harness's fabricated faucet metadata (see
 * helpers/claim-manual.ts): asserting a symbol the harness wrote would be
 * circular.
 */
test.describe('Manual claim — the pending screen shows the token the user received', () => {
  test.describe.configure({ mode: 'serial' });

  test('renders the received symbol and amounts, then claims exactly that much', async ({
    walletA,
    midenCli,
    steps,
    timeline
  }) => {
    test.setTimeout(420_000);
    let addressA: string;
    let beforeClaim: { vault: bigint; pending: bigint };

    await steps.step('create_wallet', async () => {
      const a = await walletA.createNewWallet();
      addressA = a.address;
    });

    await steps.step('deploy_and_mint', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      // One faucet, two notes → one summary row holding both, so the summary
      // total and the per-note amounts are different numbers and a spec that
      // confused them could not pass.
      await midenCli.mint(faucetId, addressA!, MINT_WHOLE_BASE_UNITS, 'public');
      await midenCli.mint(faucetId, addressA!, MINT_FRACTIONAL_BASE_UNITS, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'discover_notes',
      async () => {
        // Store-level precondition for the DOM assertions below: both notes are
        // present and unconsumed. Nothing has been claimed yet, so this must be
        // the full minted total, exactly.
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
      'see_pending_prompt_and_open_pending_notes',
      async () => {
        // The notes are non-native, so they are still sitting there: no
        // auto-consume ran, and the user has to be told. Home prompt → CTA →
        // /pending-notes is that journey.
        await openPendingNotesFromHomePrompt(walletA);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'assert_rendered_summary_row',
      async () => {
        // Both notes come from one faucet, so they must collapse into exactly
        // one row — two rows would mean the grouping key regressed.
        await expect(
          walletA.page.getByTestId('pending-asset-row'),
          'both notes are from one faucet and must group into a single pending row'
        ).toHaveCount(1);
        // The user-visible claim: symbol and grouped total, as text.
        await expect(
          walletA.page.getByTestId('pending-asset-amount'),
          `the pending row must name the token and its total as "${EXPECTED_SUMMARY_TEXT}" — ` +
            'a store-level check stays green when this renders "UNKNOWN"'
        ).toHaveText(EXPECTED_SUMMARY_TEXT);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('assert_rendered_note_rows', async () => {
      await openAssetGroupDetail(walletA.page);
      const rendered = await readDetailNoteAmounts(walletA.page, 2);
      // Per-note amounts, not the total: this is what distinguishes "two notes
      // of the right sizes" from "one row showing the sum twice".
      expect(rendered, 'each pending note must render its own amount and the token symbol').toEqual(
        EXPECTED_DETAIL_TEXTS
      );
    });

    await steps.step(
      'claim_group',
      async () => {
        beforeClaim = {
          vault: await vaultBalance(walletA.page, TOKEN),
          pending: await pendingNoteTotal(walletA.page, TOKEN)
        };
        // A fresh wallet holds none of this token, so the post-claim vault
        // assertion below is an absolute total, not just a delta.
        expect(beforeClaim.vault, 'a freshly created wallet must hold no TST before claiming').toBe(0n);
        await claimGroupAndExpectQueued(walletA);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('verify_claim_settled', async () => {
      // Vault UP by exactly the minted total AND unconsumed DOWN by the same —
      // a claim that leaves the notes pending moves no spendable money.
      await waitForClaimSettled(walletA, {
        symbol: TOKEN,
        decimals: TOKEN_DECIMALS,
        before: beforeClaim!,
        amountBaseUnits: MINTED_TOTAL_BASE_UNITS,
        timeoutMs: 240_000
      });
    });
  });
});
