import { expect, test } from '../../fixtures/two-wallets';
import { FakeEpochAllocator } from '../../helpers/fake-epoch-allocator';
import { FakeEpochPositions } from '../../helpers/fake-epoch-positions';
import type { ChromeWalletPageApi } from '../../helpers/wallet-page';
import { AnvilInstance } from '../../ios/helpers/anvil';
import { installEpoch7702Delegation, installMockCompact, installMockUsdc } from '../../ios/helpers/evm-doubles';

/**
 * Epoch "Earn" WITHDRAW ("Smart Withdraw") happy path — drives the REAL /earn UI
 * (Chrome extension). Companion to earn-deposit.spec.ts; starts from a SEEDED
 * funded position (no deposit run) and asserts the gasless EIP-7702 redeem +
 * bridge-back reaches terminal `received`.
 *
 * The withdraw uses the wallet's OWN vault-derived EVM account (NO external
 * wallet / WalletConnect): `gaslessEarnWithdrawalToMiden` runs page-side, signs
 * the 7702 authorization + delegation through the vault, and submits via the
 * relay. Three hermetic doubles:
 *
 *   - FakeEpochPositions (:8549) — `seedDummyLending(evmOwner, {depositAmount})`
 *     serves a funded, withdrawable DUMMY_LENDING position for THIS wallet's EVM
 *     owner, so the earn UI renders a withdrawable position with no deposit.
 *   - FakeEpochAllocator (:8548) — the gasless relay (`/gasless-status`,
 *     `/relay-enable-delegation`, `/relay-execute` → nonce) plus the delivery
 *     poll (`/intentStatus`, whose Miden leg (chainId 999999999) reports the
 *     programmed `midenNoteId`).
 *   - Anvil (:8545) + MockUsdc/MockCompact — the on-chain reads the Epoch SDK
 *     makes (delegation `getCode`, USDC/Compact) while building the batch.
 *     Nothing is broadcast to Anvil (the submit is gasless via the relay).
 *
 * Reaching `received` needs the ACTUAL bridged note delivered + auto-consumed —
 * the allocator poll alone only reaches `delivering`. The miden-cli "solver"
 * mints a P2ID note to the wallet, its exact id is programmed into the allocator
 * (`setMidenNoteId`), and the wallet's real Claim-All + note-id reconcile
 * (`takeBridgeInInfoForNotes`) flips the row to `received`. Same handoff as
 * `bridge-in-deposit-epoch.ios.spec.ts`.
 *
 * EPOCH_ALLOCATOR_URL / EPOCH_POSITIONS_URL / E2E_EVM_RPC_URL are baked into the
 * bundle at BUILD time by the pr-e2e-earn workflow, so the ports here MUST match.
 * The earn `__TEST_*` hooks are `MIDEN_E2E_TEST`-gated + dead-stripped from prod.
 */

const ANVIL_PORT = 8545;
const ALLOCATOR_PORT = 8548;
const POSITIONS_PORT = 8549;
const CHAIN_ID = 11155111;

/** USDC-on-Miden faucet the bridged note carries (the reconcile is note-id-only). */
const USDC_DECIMALS = 6;
/** Arbitrary bridged-note amount — NOT part of the note-id reconcile match. */
const NOTE_AMOUNT = 10_000_000n;
/** Human USDC amount of the seeded, withdrawable position. */
const WITHDRAW_AMOUNT = '10';

interface EarnWithdrawView {
  id: string;
  phase?: string;
  displayMessage?: string;
}

// Earn-withdraw rows are created + advanced PAGE-side, so read the PAGE-realm
// hooks (installed in src/lib/store/index.ts), NOT the SW-side earn-test-hooks —
// the SW's Repo view never sees the page-written row.

/** Read the newest earn-withdraw row from the page-realm hook. */
const latestWithdraw = (wallet: ChromeWalletPageApi) =>
  wallet.page.evaluate(() =>
    (
      globalThis as unknown as { __TEST_LATEST_EARN_WITHDRAW__: () => Promise<EarnWithdrawView | null> }
    ).__TEST_LATEST_EARN_WITHDRAW__()
  ) as Promise<EarnWithdrawView | null>;

/** Read a specific earn-withdraw row's phase by id (page realm). */
const withdrawState = (wallet: ChromeWalletPageApi, txId: string) =>
  wallet.page.evaluate(
    (id: string) =>
      (
        globalThis as unknown as {
          __TEST_EARN_WITHDRAW_STATE__: (t: string) => Promise<EarnWithdrawView | null>;
        }
      ).__TEST_EARN_WITHDRAW_STATE__(id),
    txId
  ) as Promise<EarnWithdrawView | null>;

test.describe('earn: withdraw happy path', () => {
  test.describe.configure({ mode: 'serial' });

  let anvil: AnvilInstance;
  const allocator = new FakeEpochAllocator(ALLOCATOR_PORT);
  const positions = new FakeEpochPositions(POSITIONS_PORT);

  test.beforeAll(async () => {
    // --block-time 1 keeps blocks advancing for any SDK receipt/nonce reads.
    anvil = await AnvilInstance.start({ port: ANVIL_PORT, chainId: CHAIN_ID, args: ['--block-time', '1'] });
    // The gasless withdraw batch reads USDC + The Compact while building the
    // intent; stub both so the reads don't hit public Sepolia. Nothing is
    // broadcast to Anvil (relay-execute is faked).
    await installMockUsdc(anvil.rpcUrl);
    await installMockCompact(anvil.rpcUrl);
    await allocator.start();
    await positions.start();
  });

  test.afterAll(async () => {
    anvil?.stop();
    await allocator.stop();
    await positions.stop();
  });

  test('withdraw a seeded position → earn-withdraw row bridges back and reaches received', async ({
    walletA,
    midenCli
  }) => {
    // DIAGNOSTIC (temporary): surface a submit failure in the CI log — the harness
    // saves the trace to test-results, whose artifact upload is broken by a ':' in
    // the checkpoint filename, so console errors never reach us otherwise.
    const consoleErrors: string[] = [];
    walletA.page.on('console', m => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
    });
    walletA.page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`));

    // 1. Create the wallet and read its Miden address + vault-derived EVM owner.
    await walletA.createNewWallet();
    const addressA = await walletA.getAccountAddress();
    const evmOwner = await walletA.getEvmAddress();

    // Pre-activate the vault owner's EIP-7702 delegation on Anvil so the gasless
    // withdraw's `ensureEpochSmartAccount` sees `delegation === 'epoch'` and skips
    // the relay enable — the fake relay can only ack `/relay-enable-delegation`, it
    // can't broadcast the real 7702 authorization tx that sets the delegation code.
    await installEpoch7702Delegation(anvil.rpcUrl, evmOwner);

    // 2. Seed a funded, withdrawable DUMMY_LENDING position for THIS wallet's EVM
    //    owner. `EarnWithdrawReview` aborts (`earnWithdrawNotOwned`) unless
    //    `account.evmAddress === position.owner`, so it MUST be the wallet's own
    //    address — no deposit run needed to materialize the position.
    // decimals:18 — the withdraw validation requires underlyingDecimals ===
    // BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS (18, Epoch's convention), not USDC's 6.
    positions.seedDummyLending(evmOwner, { depositAmount: WITHDRAW_AMOUNT, decimals: 18 });

    // 3. Deploy the "solver" faucet for the bridged-back USDC note.
    await midenCli.init();
    const faucetHex = await midenCli.createFaucet('USDC', USDC_DECIMALS);

    // 4. Drive the real Earn UI: positions → position detail → Withdraw → review →
    //    Confirm. Withdrawals are always the FULL withdrawable (no amount screen).
    //    Derive the position id from the card testid rather than hardcoding it.
    await walletA.navigateTo('/earn');
    const positionCard = walletA.page.locator('[data-testid^="earn-position-card-"]').first();
    await expect(positionCard).toBeVisible({ timeout: 30_000 });
    await positionCard.click();

    await expect(walletA.page.getByTestId('earn-position-detail-page')).toBeVisible({ timeout: 30_000 });
    const withdrawBtn = walletA.page.getByTestId('earn-withdraw-btn');
    await expect(withdrawBtn).toBeEnabled({ timeout: 30_000 });
    await withdrawBtn.click();

    await expect(walletA.page.getByTestId('earn-withdraw-review-page')).toBeVisible({ timeout: 30_000 });
    const confirm = walletA.page.getByTestId('earn-withdraw-review-confirm');
    await expect(confirm).toBeEnabled({ timeout: 30_000 });
    await confirm.click();

    // DIAGNOSTIC (temporary): the gasless submit stores its error in
    // extraInputs.error and flips the row to phase 'failed' — surface it and FAIL
    // FAST rather than waiting out the phase polls.
    await walletA.page.waitForTimeout(8000);
    const url = walletA.page.url();
    const urlTxId = decodeURIComponent(url.match(/withdraw-status\/([^/?#]+)/)?.[1] ?? '');
    const dump = ((await walletA.page.evaluate(() =>
      (globalThis as unknown as { __TEST_DUMP_TX__?: () => Promise<unknown[]> }).__TEST_DUMP_TX__?.()
    )) ?? []) as Array<{ id: string; type: string; phase?: string; error?: string }>;
    console.log('[withdraw-diag] url:', url, 'urlTxId:', urlTxId, 'dump:', JSON.stringify(dump));
    console.log('[withdraw-diag] console errors:', JSON.stringify(consoleErrors.slice(-6)));
    const failedRow = dump.find(t => t.type === 'earn-withdraw' && t.phase === 'failed');
    if (failedRow) throw new Error(`earn-withdraw submit FAILED -> ${failedRow.error}`);

    // 5. The earn-withdraw row is created page-side (born `redeeming`) and driven
    //    by the gasless submit; the UI routes to /earn/withdraw-status/:txId but we
    //    key off the tracking row's phase via the SW hook (reads shared IndexedDB).
    let txId = '';
    await expect
      .poll(
        async () => {
          const row = await latestWithdraw(walletA);
          txId = row?.id ?? '';
          return row?.phase ?? null;
        },
        { timeout: 120_000, intervals: [2000] }
      )
      .not.toBeNull();
    expect(txId, 'earn-withdraw row id').not.toBe('');

    // 6. Solver delivers the bridged note: mint a P2ID note to the wallet and
    //    program its exact id into the allocator so the /intentStatus Miden leg
    //    (chainId 999999999) reports it — the withdraw poll advances to
    //    `delivering`.
    const { noteId } = await midenCli.mint(faucetHex, addressA, NOTE_AMOUNT, 'public');
    allocator.setMidenNoteId(noteId);
    await midenCli.sync();

    await expect
      .poll(async () => (await withdrawState(walletA, txId))?.phase ?? null, {
        timeout: 180_000,
        intervals: [3000]
      })
      .toBe('delivering');

    // 7. The wallet consumes the delivered note; the note-id reconcile matches the
    //    parked intent and flips the row to terminal `received`. (The Chrome
    //    Claim-All has no faucet filter — the wallet holds only this bridged note.)
    await walletA.claimAllNotes(420_000);

    await expect
      .poll(async () => (await withdrawState(walletA, txId))?.phase ?? null, {
        timeout: 180_000,
        intervals: [3000]
      })
      .toBe('received');

    // 8. The withdraw exercised the gasless relay path + read the seeded position.
    expect(
      allocator.requests.some(r => r.path === '/relay-execute'),
      'allocator saw /relay-execute'
    ).toBe(true);
    expect(
      positions.requests.some(r => r.path === '/positions'),
      'positions were fetched'
    ).toBe(true);
  });
});
