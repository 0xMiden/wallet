import { expect, test } from '../../fixtures/two-wallets';
import { suspendScreenCapture } from '../../harness/screen-capture';
import { FakeEpochAllocator } from '../../helpers/fake-epoch-allocator';
import { FakeEpochPositions } from '../../helpers/fake-epoch-positions';
import { ChromeWalletPage, type ChromeWalletPageApi } from '../../helpers/wallet-page';
import { AnvilInstance } from '../../ios/helpers/anvil';
import { installEpoch7702Delegation, installMockCompact, installMockUsdc } from '../../ios/helpers/evm-doubles';

/**
 * Epoch "Earn" WITHDRAW ("Smart Withdraw") happy path - drives the REAL /earn UI
 * (Chrome extension). Companion to earn-deposit.spec.ts; starts from a SEEDED
 * funded position (no deposit run) and asserts the gasless EIP-7702 redeem +
 * bridge-back reaches terminal `received`.
 *
 * The withdraw uses the wallet's OWN vault-derived EVM account (NO external
 * wallet / WalletConnect): `gaslessEarnWithdrawalToMiden` runs page-side, signs
 * the 7702 authorization + delegation through the vault, and submits via the
 * relay. Three hermetic doubles:
 *
 *   - FakeEpochPositions (:8549) - `seedDummyLending(evmOwner, {depositAmount})`
 *     serves a funded, withdrawable DUMMY_LENDING position for THIS wallet's EVM
 *     owner, so the earn UI renders a withdrawable position with no deposit.
 *   - FakeEpochAllocator (:8548) - the gasless relay (`/gasless-status`,
 *     `/relay-enable-delegation`, `/relay-execute`) plus the delivery
 *     poll (`/intentStatus`, whose Miden leg (chainId 999999999) reports the
 *     programmed `midenNoteId`).
 *   - Anvil (:8545) + MockUsdc/MockCompact - the on-chain reads the Epoch SDK
 *     makes (delegation `getCode`, USDC/Compact) while building the batch.
 *     Nothing is broadcast to Anvil (the submit is gasless via the relay).
 *
 * Reaching `received` needs the ACTUAL bridged note delivered + auto-consumed -
 * the allocator poll alone only reaches `delivering`. The miden-cli "solver"
 * mints a P2ID note to the wallet, its exact id is programmed into the allocator
 * (`setMidenNoteId`), and the wallet's real Claim-All + note-id reconcile
 * (`applyBridgeInInfoForNotes`) flips the row to `received`. Same handoff as
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
/** Arbitrary bridged-note amount - NOT part of the note-id reconcile match. */
const NOTE_AMOUNT = 10_000_000n;
/** Human USDC amount of the seeded, withdrawable position. */
const WITHDRAW_AMOUNT = '10';

interface EarnWithdrawView {
  id: string;
  phase?: string;
  displayMessage?: string;
}

// Earn-withdraw rows are created + advanced PAGE-side, so read the PAGE-realm
// hooks (installed in src/lib/store/index.ts), NOT the SW-side earn-test-hooks -
// the SW's Repo view never sees the page-written row.

/** The second root must read its own hook, not a function captured from the first page. */
const withdrawState = (wallet: ChromeWalletPageApi, txId?: string): Promise<EarnWithdrawView | null> =>
  wallet.page.evaluate(async id => {
    const hook: unknown = Reflect.get(
      globalThis,
      id === null ? '__TEST_LATEST_EARN_WITHDRAW__' : '__TEST_EARN_WITHDRAW_STATE__'
    );
    if (typeof hook !== 'function') throw new Error('Earn withdrawal read hook is unavailable');
    const row: unknown = await Reflect.apply(hook, globalThis, id === null ? [] : [id]);
    if (row === null) return null;
    if (!row || typeof row !== 'object') throw new Error('Invalid earn withdrawal row');
    const rowId: unknown = Reflect.get(row, 'id');
    const phase: unknown = Reflect.get(row, 'phase');
    const displayMessage: unknown = Reflect.get(row, 'displayMessage');
    if (
      typeof rowId !== 'string' ||
      (phase !== undefined && typeof phase !== 'string') ||
      (displayMessage !== undefined && typeof displayMessage !== 'string')
    ) {
      throw new Error('Invalid earn withdrawal row fields');
    }
    return { id: rowId, phase, displayMessage };
  }, txId ?? null);

const heldEarnLocks = (wallet: ChromeWalletPageApi) =>
  wallet.page.evaluate(async () => {
    const { held = [] } = await navigator.locks.query();
    return held.flatMap(({ name, clientId, mode }) => {
      if (!name?.startsWith('earn-')) return [];
      if (!clientId || mode !== 'exclusive') throw new Error('Earn lock must have an exclusive document owner');
      return [{ name, clientId, mode }];
    });
  });

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

  test('withdrawal keeps one owner across two roots and completes after the owner closes', async ({
    walletA,
    midenCli
  }) => {
    // 1. Create the wallet and read its Miden address + vault-derived EVM owner.
    await walletA.createNewWallet();
    const addressA = await walletA.getAccountAddress();
    const evmOwner = await walletA.getEvmAddress();

    // Pre-activate the vault owner's EIP-7702 delegation on Anvil so the gasless
    // withdraw's `ensureEpochSmartAccount` sees `delegation === 'epoch'` and skips
    // the relay enable - the fake relay can only ack `/relay-enable-delegation`, it
    // can't broadcast the real 7702 authorization tx that sets the delegation code.
    await installEpoch7702Delegation(anvil.rpcUrl, evmOwner);

    // 2. Seed a funded, withdrawable DUMMY_LENDING position for THIS wallet's EVM
    //    owner. `EarnWithdrawReview` aborts (`earnWithdrawNotOwned`) unless
    //    `account.evmAddress === position.owner`, so it MUST be the wallet's own
    //    address - no deposit run needed to materialize the position.
    // decimals:18 - the withdraw validation requires underlyingDecimals ===
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

    const statusOwnerPrefix = `/intentStatus/${evmOwner}/`.toLowerCase();
    const isOwnerStatusPath = (path: string) => path.toLowerCase().startsWith(statusOwnerPrefix);
    const ownerStatusRequests = () =>
      allocator.requests.filter(request => request.method === 'GET' && isOwnerStatusPath(request.path));
    const observeStatusRequests = (wallet: ChromeWalletPageApi) => {
      const paths: string[] = [];
      wallet.page.on('request', request => {
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.origin === allocator.baseUrl && isOwnerStatusPath(url.pathname)) {
          paths.push(url.pathname);
        }
      });
      return paths;
    };
    const originalStatuses = observeStatusRequests(walletA);

    // Keep the real relay response pending after the row exists but before its nonce is persisted.
    // Recovery in a second module realm must respect the submitting document's native lock.
    let releaseRelay = () => {};
    const relayReleased = new Promise<void>(resolve => {
      releaseRelay = resolve;
    });
    let relayParked = false;
    const relayUrl = `${allocator.baseUrl}/relay-execute`;
    await walletA.page.route(relayUrl, async route => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      relayParked = true;
      await relayReleased;
      await route.fulfill({ response });
    });

    try {
      await confirm.click();
      await expect.poll(() => relayParked, { timeout: 120_000, intervals: [1000] }).toBe(true);
      await expect.poll(async () => (await withdrawState(walletA))?.phase).toBe('redeeming');
      const row = await withdrawState(walletA);
      if (!row) throw new Error('Earn withdrawal tracking row is missing');
      const txId = row.id;
      expect(txId, 'earn-withdraw row id').not.toBe('');

      const submissionLocks = (await heldEarnLocks(walletA)).filter(lock => lock.name.startsWith('earn-submit:'));
      expect(submissionLocks, 'one held submission attempt').toHaveLength(1);
      const submissionLock = submissionLocks[0];
      if (!submissionLock) throw new Error('Submission lock is missing');

      const survivorPage = await walletA.page.context().newPage();
      const survivor = new ChromeWalletPage(survivorPage, walletA.extensionId, walletA.userDataDir);
      const survivorStatuses = observeStatusRequests(survivor);
      await survivorPage.goto(
        `chrome-extension://${walletA.extensionId}/sidepanel.html#/earn/withdraw-status/${txId}`,
        {
          waitUntil: 'domcontentloaded'
        }
      );
      await survivorPage.bringToFront();
      await expect(survivorPage.getByRole('heading', { name: 'Processing Withdrawal', exact: true })).toBeVisible({
        timeout: 30_000
      });
      expect(await survivorPage.evaluate(() => document.visibilityState)).toBe('visible');
      expect((await heldEarnLocks(survivor)).filter(lock => lock.name === submissionLock.name)).toEqual(
        submissionLocks
      );

      // Observe a complete 15-second recovery interval, checking the persisted phase throughout.
      // A local-only submission guard lets this new root mark the parked attempt failed.
      const recoveryWindowStarted = Date.now();
      let stayedRedeeming = true;
      await expect
        .poll(
          async () => {
            const phases = await Promise.all([withdrawState(walletA, txId), withdrawState(survivor, txId)]);
            stayedRedeeming = stayedRedeeming && phases.every(state => state?.phase === 'redeeming');
            return Date.now() - recoveryWindowStarted;
          },
          { timeout: 35_000, intervals: [1000], message: 'held submission survives another root recovery tick' }
        )
        .toBeGreaterThanOrEqual(17_000);
      expect(stayedRedeeming, 'both documents retain the submitting attempt').toBe(true);
      expect(ownerStatusRequests(), 'no delivery polling before submission completes').toHaveLength(0);
      expect((await heldEarnLocks(survivor)).filter(lock => lock.name === submissionLock.name)).toEqual(
        submissionLocks
      );

      releaseRelay();
      await expect
        .poll(() => ownerStatusRequests().length, { timeout: 60_000, intervals: [1000] })
        .toBeGreaterThanOrEqual(1);
      const firstStatusRequest = ownerStatusRequests()[0];
      if (!firstStatusRequest) throw new Error('Allocator did not receive withdrawal status');
      // The current SDK chooses the nonce itself; the fake relay's legacy nonce field is ignored.
      const nonce = decodeURIComponent(firstStatusRequest.path.slice(statusOwnerPrefix.length));
      expect(nonce, 'submitted intent nonce').not.toBe('');
      const pollLockName = `earn-poll:earn-withdraw:${evmOwner.toLowerCase()}:${nonce}`;
      const isIntentStatusPath = (path: string) =>
        isOwnerStatusPath(path) && decodeURIComponent(path.slice(statusOwnerPrefix.length)) === nonce;
      const intentStatusRequests = () => ownerStatusRequests().filter(request => isIntentStatusPath(request.path));
      const pollLocks = (await heldEarnLocks(walletA)).filter(lock => lock.name === pollLockName);
      expect(pollLocks, 'one native polling owner for this owner and nonce').toHaveLength(1);
      expect(pollLocks[0]?.clientId, 'initiating document owns delivery polling').toBe(submissionLock.clientId);
      expect((await heldEarnLocks(survivor)).filter(lock => lock.name === pollLockName)).toEqual(pollLocks);

      // Match allocator traffic to its issuing document instead of relying on exact timer cadence.
      await expect
        .poll(() => intentStatusRequests().length, { timeout: 45_000, intervals: [1000] })
        .toBeGreaterThanOrEqual(4);
      expect(originalStatuses.filter(isIntentStatusPath).length).toBeGreaterThanOrEqual(intentStatusRequests().length);
      expect(
        survivorStatuses.filter(isIntentStatusPath),
        'second root does not start another status stream'
      ).toHaveLength(0);
      expect((await heldEarnLocks(walletA)).filter(lock => lock.name === pollLockName)).toEqual(pollLocks);
      expect((await heldEarnLocks(survivor)).filter(lock => lock.name === pollLockName)).toEqual(pollLocks);

      // Drain the fixture's capture binding before deliberately closing its original page.
      // The persistent context remains the fixture's responsibility, including failure teardown.
      await suspendScreenCapture(walletA.page);
      await walletA.page.close();
      await survivorPage.bringToFront();
      await expect
        .poll(
          async () => {
            const locks = (await heldEarnLocks(survivor)).filter(lock => lock.name === pollLockName);
            return locks.length === 1 && locks[0]?.clientId !== submissionLock.clientId;
          },
          { timeout: 45_000, intervals: [1000], message: 'surviving root acquires the released intent lock' }
        )
        .toBe(true);
      const requestsBeforeTakeover = intentStatusRequests().length;
      await expect
        .poll(() => intentStatusRequests().length, { timeout: 30_000, intervals: [1000] })
        .toBeGreaterThanOrEqual(requestsBeforeTakeover + 2);
      expect(
        survivorStatuses.filter(isIntentStatusPath).length,
        'surviving root resumes the same intent'
      ).toBeGreaterThanOrEqual(2);
      expect((await withdrawState(survivor, txId))?.phase).toBe('redeeming');

      // Solver delivery and the real Claim-All still have to complete the original tracking row.
      const { noteId } = await midenCli.mint(faucetHex, addressA, NOTE_AMOUNT, 'public');
      allocator.setMidenNoteId(noteId);
      await midenCli.sync();

      await expect
        .poll(async () => (await withdrawState(survivor, txId))?.phase ?? null, {
          timeout: 180_000,
          intervals: [3000]
        })
        .toBe('delivering');
      await survivor.claimAllNotes(420_000);
      await expect
        .poll(async () => (await withdrawState(survivor, txId))?.phase ?? null, {
          timeout: 180_000,
          intervals: [3000]
        })
        .toBe('received');

      expect(
        allocator.requests.filter(request => request.path === '/relay-execute'),
        'one gasless submission'
      ).toHaveLength(1);
      expect(
        positions.requests.some(request => request.path === '/positions'),
        'positions were fetched'
      ).toBe(true);
    } finally {
      releaseRelay();
      if (!walletA.page.isClosed()) await walletA.page.unroute(relayUrl);
    }
  });
});
