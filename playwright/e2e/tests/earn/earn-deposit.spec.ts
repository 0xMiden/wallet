import { expect, test } from '../../fixtures/two-wallets';
import { FakeEpochAllocator } from '../../helpers/fake-epoch-allocator';
import { FakeEpochPositions } from '../../helpers/fake-epoch-positions';
import { swOf } from '../../helpers/swap';
import { AnvilInstance } from '../../ios/helpers/anvil';
import { installMockCompact } from '../../ios/helpers/evm-doubles';

/**
 * Epoch "Earn" DEPOSIT happy path — drives the REAL /earn UI (Chrome extension).
 *
 * Structurally a Miden→EVM lending deposit: the collateral is a recallable
 * P2IDE note the wallet mints on the LOCAL Miden node, and the EVM lending leg
 * is solver-fulfilled (nothing is signed on EVM). The three hermetic doubles:
 *
 *   - FakeEpochAllocator (:8548) — stands in for EPOCH_ALLOCATOR_URL: quote
 *     (`/checkIfDepositNeeded`), collateral config (`/miden-recipient`),
 *     allocation (`/compact`), and the intent-status poll (`/intentStatus`).
 *   - FakeEpochPositions (:8549) — stands in for EPOCH_POSITIONS_URL: serves the
 *     DUMMY_LENDING vault catalog the Earn tab renders.
 *   - Anvil (:8545) + MockCompact — the deposit's ONE EVM read is
 *     `getForcedWithdrawalStatus` on The Compact (COMPACT_ADDRESS[999999999]);
 *     `solveIntent` requires it to report "Disabled" before it mints the note.
 *     Without this the read hits public Sepolia (fragile) or reverts (no code).
 *
 * All three URLs are baked into the bundle at BUILD time (vite defines read
 * EPOCH_ALLOCATOR_URL / EPOCH_POSITIONS_URL / E2E_EVM_RPC_URL), so the ports
 * here MUST match the build-time env the pr-e2e-earn workflow sets.
 *
 * The earn `__TEST_*` hooks are `MIDEN_E2E_TEST`-gated and dead-stripped from
 * production builds.
 */

/** ITransactionStatus.Completed — Queued(0) → GeneratingTransaction(1) → Completed(2) / Failed(3). */
const COMPLETED = 2;

const ANVIL_PORT = 8545;
const ALLOCATOR_PORT = 8548;
const POSITIONS_PORT = 8549;

/** Collateral faucet: 6dp, mirrors MIDEN_USDC_DECIMALS. */
const COLLATERAL_DECIMALS = 6;
/** Base units minted to walletA = 1000 USDC @ 6dp (>> the 10 USDC deposit). */
const COLLATERAL_MINT = 1_000_000_000;
/** Human USDC amount typed into the deposit review route. */
const DEPOSIT_AMOUNT = '10';

interface EarnDepositView {
  id: string;
  status: number;
  epochStatus?: string;
  displayMessage?: string;
}

test.describe('earn: deposit happy path', () => {
  test.describe.configure({ mode: 'serial' });

  let anvil: AnvilInstance;
  const allocator = new FakeEpochAllocator(ALLOCATOR_PORT);
  const positions = new FakeEpochPositions(POSITIONS_PORT);

  test.beforeAll(async () => {
    anvil = await AnvilInstance.start({ port: ANVIL_PORT });
    // The Compact stub: getForcedWithdrawalStatus → (Disabled, 0). The deposit
    // path does NOT broadcast an EVM tx (Miden collateral), so the AggLayer /
    // USDC doubles the bridge-in harness installs are NOT needed here.
    await installMockCompact(anvil.rpcUrl);
    await allocator.start();
    await positions.start();
  });

  test.afterAll(async () => {
    anvil?.stop();
    await allocator.stop();
    await positions.stop();
  });

  test('deposit USDC collateral → earn-deposit row completes and epoch confirms', async ({
    walletA,
    midenCli,
    timeline
  }) => {
    // 1. Create the wallet and fund it with the collateral token on the local node.
    await walletA.createNewWallet();
    const addressA = await walletA.getAccountAddress();

    await midenCli.init();
    const faucetHex = await midenCli.createFaucet('EUSDC', COLLATERAL_DECIMALS);
    await midenCli.mint(faucetHex, addressA, COLLATERAL_MINT, 'public');
    await midenCli.sync();

    await walletA.waitForBalanceAbove(0, 150_000, timeline);
    await walletA.claimAllNotes(150_000);

    // The earn collateral-faucet override (`__TEST_SET_EARN_FAUCET__`, page realm —
    // see src/lib/store/index.ts) is applied just before confirming the deposit
    // (below), NOT here: `openEarnPosition` runs page-side and every `navigateTo`
    // is a full `page.goto` reload that resets page-module state, so the override
    // has to be set AFTER the last navigation. The fixed MIDEN_USDC_FAUCET testnet
    // id can't exist on the local node, so the wallet holds the CLI faucet instead.
    const setEarnFaucet = (h: string): void => {
      (globalThis as unknown as { __TEST_SET_EARN_FAUCET__?: (hex: string) => void }).__TEST_SET_EARN_FAUCET__?.(h);
    };

    // 2. Program the fakes.
    //    - Collateral recipient defaults to 0x2458…9ce1 (identical to the shipped
    //      MIDEN_USDC_FAUCET constant, a valid AccountId) — no override needed.
    //    - The Sepolia (destination, 11155111) leg reports "completed" so
    //      pollEarnIntentStatus flips the row's epochStatus pending → confirmed.
    //    - The positions fake serves a zero-balance DUMMY_LENDING vault to any
    //      un-seeded owner by default, so the Earn catalog renders a vault row.
    allocator.setEarnDepositOutcome('completed');

    // 3. Drive the real Earn UI: catalog → vault detail → deposit CTA. Capture
    //    the vault id from the row testid (the slug is derived downstream as
    //    `lenderChainSlug('DUMMY_LENDING','11155111')` — do NOT hardcode it).
    await walletA.navigateTo('/earn');
    const vaultRow = walletA.page.locator('[data-testid^="earn-vault-row-"]').first();
    await expect(vaultRow).toBeVisible({ timeout: 30_000 });
    const rowTestId = await vaultRow.getAttribute('data-testid');
    const vaultId = (rowTestId ?? '').replace('earn-vault-row-', '');
    expect(vaultId, 'derived vault id').not.toBe('');

    await vaultRow.click();
    const depositBtn = walletA.page.getByTestId('earn-vault-deposit-btn');
    await expect(depositBtn).toBeVisible({ timeout: 30_000 });
    await depositBtn.click();

    // The deposit CTA lands on the amount screen (proves routing). Its
    // SelectAmount confirm is balance-gated on the STATIC MIDEN_USDC_FAUCET,
    // which the wallet never holds under a CLI-minted faucet — so we deep-link
    // to the review route (whose confirm is gated only on amount>0 && vault.id)
    // to actually place the deposit. See report item (b).
    await expect(walletA.page.getByTestId('earn-deposit-amount-page')).toBeVisible({ timeout: 30_000 });

    await walletA.navigateTo(`/earn/vaults/${vaultId}/deposit/review?amount=${DEPOSIT_AMOUNT}`);
    // Set the collateral-faucet override in the freshly-loaded review page realm —
    // `openEarnPosition` reads it (page-side) on confirm.
    await walletA.page.evaluate(setEarnFaucet, faucetHex);
    const confirm = walletA.page.getByTestId('earn-deposit-review-confirm');
    await expect(confirm).toBeEnabled({ timeout: 30_000 });
    await confirm.click();

    // 4. The earn-deposit tracking row is created (Queued) by the collateral-note
    //    callback and driven to Completed by the SW send pipeline. The deposit UI
    //    never hands the txId to the DOM, so read it from the SW hook.
    let txId = '';
    await expect
      .poll(
        async () => {
          const row = (await swOf(walletA).evaluate(() =>
            (
              globalThis as unknown as { __TEST_LATEST_EARN_DEPOSIT__: () => Promise<EarnDepositView | null> }
            ).__TEST_LATEST_EARN_DEPOSIT__()
          )) as EarnDepositView | null;
          txId = row?.id ?? '';
          return row?.status ?? null;
        },
        { timeout: 180_000, intervals: [3000] }
      )
      .toBe(COMPLETED);
    expect(txId, 'earn-deposit row id').not.toBe('');

    // 5. Epoch settlement: pollEarnIntentStatus reads the completed Sepolia leg
    //    from the fake allocator and flips epochStatus to 'confirmed'.
    await expect
      .poll(
        async () => {
          const row = (await swOf(walletA).evaluate(
            (id: string) =>
              (
                globalThis as unknown as {
                  __TEST_EARN_DEPOSIT_STATE__: (txId: string) => Promise<EarnDepositView | null>;
                }
              ).__TEST_EARN_DEPOSIT_STATE__(id),
            txId
          )) as EarnDepositView | null;
          return row?.epochStatus ?? null;
        },
        { timeout: 180_000, intervals: [3000] }
      )
      .toBe('confirmed');

    // 6. The allocator observed the deposit's collateral-config fetch and the
    //    on-chain allocation registration.
    expect(
      allocator.requests.some(r => r.path === '/miden-recipient'),
      'allocator saw /miden-recipient'
    ).toBe(true);
    expect(
      allocator.requests.some(r => r.path === '/compact'),
      'allocator saw /compact'
    ).toBe(true);
  });
});
