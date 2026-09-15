import type { PreparedExecution } from '@epoch-protocol/epoch-intents-sdk';
import type { TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

import { getEnvironmentConfig } from '../../config/environments';
import { expect, test } from '../../fixtures/two-wallets';
import { suspendScreenCapture } from '../../harness/screen-capture';
import { FakeEpochAllocator } from '../../helpers/fake-epoch-allocator';
import { FakeEpochPositions } from '../../helpers/fake-epoch-positions';
import { type AccountAxis, guardianAxis, offChainAxis } from '../../helpers/money-path';
import { ChromeWalletPage, type ChromeWalletPageApi } from '../../helpers/wallet-page';
import { AnvilInstance } from '../../ios/helpers/anvil';
import { installEpoch7702Delegation, installMockCompact, installMockUsdc } from '../../ios/helpers/evm-doubles';

// The actual SDK constructs and signs the withdrawal against local Anvil reads.
// Only the allocator/relay and positions endpoints are controlled doubles; the
// returned Miden note and its completed consume are real local-chain operations.
const ANVIL_PORT = 8545;
const ALLOCATOR_PORT = 8548;
const POSITIONS_PORT = 8549;
const CHAIN_ID = 11155111;
const MIDEN_CHAIN_ID = 999999999;
const NOTE_AMOUNT = 10_000_000n;
const WITHDRAW_AMOUNT = '10';
const SUGGESTED_NONCES = ['101', '102', '11', '103', '22'];

interface PreparedWithdrawal extends PreparedExecution {
  attemptId: string;
  delivery: {
    allocationIndex: number;
    owner: string;
    nonce: string;
    destinationChainId: number;
    recipientAccountId: string;
    destinationFaucetId: string;
  };
}

interface EarnWithdrawView {
  id: string;
  phase?: string;
  displayMessage?: string;
  submissionState?: 'preparing' | 'prepared' | 'accepted';
  withdrawIntentNonce?: string;
  preparedExecution?: PreparedWithdrawal;
  midenNoteId?: string;
  receipts: Array<{
    id: string;
    status: number;
    transactionId?: string;
    noteIds: string[];
    intentOwner?: string;
    intentNonce?: string;
    attemptId?: string;
    midenNoteId?: string;
  }>;
}

// Each page reads its own page-realm Repo, including before the relay can answer.
const withdrawState = (wallet: ChromeWalletPageApi, txId?: string): Promise<EarnWithdrawView | null> =>
  wallet.page.evaluate(async id => {
    const record = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value);
    const requiredText = (value: unknown): string => {
      if (typeof value !== 'string' || value.length === 0) throw new Error('Expected nonempty withdrawal field');
      return value;
    };
    const optionalText = (value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string') throw new Error('Expected optional withdrawal text');
      return value;
    };
    const integer = (value: unknown): number => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('Expected withdrawal integer');
      return value;
    };
    const hook: unknown = Reflect.get(
      globalThis,
      id === null ? '__TEST_LATEST_EARN_WITHDRAW__' : '__TEST_EARN_WITHDRAW_STATE__'
    );
    if (typeof hook !== 'function') throw new Error('Earn withdrawal read hook is unavailable');
    const row: unknown = await Reflect.apply(hook, globalThis, id === null ? [] : [id]);
    if (row === null) return null;
    if (!record(row)) throw new Error('Invalid earn withdrawal row');
    const state = row.submissionState;
    if (state !== undefined && state !== 'preparing' && state !== 'prepared' && state !== 'accepted') {
      throw new Error('Invalid withdrawal submission state');
    }
    let preparedExecution: PreparedWithdrawal | undefined;
    if (row.preparedExecution !== undefined) {
      const prepared = row.preparedExecution;
      if (!record(prepared) || !record(prepared.delivery) || !Array.isArray(prepared.allocations)) {
        throw new Error('Invalid prepared withdrawal execution');
      }
      const delivery = prepared.delivery;
      const allocations = prepared.allocations.map((allocation: unknown) => {
        if (!record(allocation)) throw new Error('Invalid prepared allocation');
        return {
          sponsor: requiredText(allocation.sponsor),
          nonce: requiredText(allocation.nonce),
          expires: requiredText(allocation.expires),
          requestJson: requiredText(allocation.requestJson)
        };
      });
      preparedExecution = {
        chainId: integer(prepared.chainId),
        attemptId: requiredText(prepared.attemptId),
        allocations,
        delivery: {
          allocationIndex: integer(delivery.allocationIndex),
          owner: requiredText(delivery.owner),
          nonce: requiredText(delivery.nonce),
          destinationChainId: integer(delivery.destinationChainId),
          recipientAccountId: requiredText(delivery.recipientAccountId),
          destinationFaucetId: requiredText(delivery.destinationFaucetId)
        }
      };
    }
    if (!Array.isArray(row.receipts)) throw new Error('Invalid withdrawal receipts');
    const receipts = row.receipts.map((receipt: unknown) => {
      if (!record(receipt) || !Array.isArray(receipt.noteIds)) throw new Error('Invalid withdrawal receipt');
      return {
        id: requiredText(receipt.id),
        status: integer(receipt.status),
        transactionId: optionalText(receipt.transactionId),
        noteIds: receipt.noteIds.map(requiredText),
        intentOwner: optionalText(receipt.intentOwner),
        intentNonce: optionalText(receipt.intentNonce),
        attemptId: optionalText(receipt.attemptId),
        midenNoteId: optionalText(receipt.midenNoteId)
      };
    });
    return {
      id: requiredText(row.id),
      phase: optionalText(row.phase),
      displayMessage: optionalText(row.displayMessage),
      submissionState: state,
      withdrawIntentNonce: optionalText(row.withdrawIntentNonce),
      preparedExecution,
      midenNoteId: optionalText(row.midenNoteId),
      receipts
    };
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

async function captureWithdrawalScreen(wallet: ChromeWalletPageApi, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  const screenshot = await wallet.page.screenshot({ path });
  await sharp(screenshot).resize(1800, 1800, { fit: 'inside', withoutEnlargement: true }).toFile(path);
  await info.attach(name, { path, contentType: 'image/png' });
}

const noteKey = (id: string) => id.replace(/^0x/i, '').toLowerCase();
const parseRequest = (json: string): unknown => JSON.parse(json);

function expectPreparedWithdrawal(row: EarnWithdrawView, owner: string): PreparedWithdrawal {
  const prepared = row.preparedExecution;
  if (!prepared) throw new Error('Withdrawal was sent without a durable prepared execution');
  expect(row.submissionState).toBe('prepared');
  expect(row.withdrawIntentNonce).toBe('22');
  expect(prepared.chainId).toBe(CHAIN_ID);
  expect(prepared.attemptId).not.toBe('');
  expect(prepared.allocations.map(allocation => allocation.nonce)).toEqual(['11', '22']);
  expect(prepared.delivery).toMatchObject({
    allocationIndex: 1,
    nonce: row.withdrawIntentNonce,
    destinationChainId: MIDEN_CHAIN_ID
  });
  expect(prepared.delivery.owner.toLowerCase()).toBe(owner.toLowerCase());
  for (const allocation of prepared.allocations) {
    expect(allocation.sponsor.toLowerCase()).toBe(owner.toLowerCase());
    expect(parseRequest(allocation.requestJson)).toMatchObject({
      chainId: String(CHAIN_ID),
      compact: { sponsor: allocation.sponsor, nonce: allocation.nonce, expires: allocation.expires },
      isRegisteredOnchain: true,
      sponsorSignature: '0x'
    });
  }
  const selected = prepared.allocations[prepared.delivery.allocationIndex];
  if (!selected) throw new Error('Prepared delivery points outside the saved allocations');
  expect(parseRequest(selected.requestJson)).toMatchObject({
    compact: {
      mandate: {
        destinationChainId: String(MIDEN_CHAIN_ID),
        midenRecipientAccount: prepared.delivery.recipientAccountId,
        midenFaucetId: prepared.delivery.destinationFaucetId
      }
    }
  });
  return prepared;
}

function defineEarnWithdrawSuite(axis: AccountAxis): void {
  test.describe(`earn: withdrawal recovery - ${axis.label} account`, () => {
    test.describe.configure({ mode: 'serial' });
    let anvil: AnvilInstance;
    const allocator = new FakeEpochAllocator(ALLOCATOR_PORT);
    const positions = new FakeEpochPositions(POSITIONS_PORT);

    test.beforeAll(async () => {
      anvil = await AnvilInstance.start({ port: ANVIL_PORT, chainId: CHAIN_ID, args: ['--block-time', '1'] });
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

    test('recovers exact allocations after the submitting owner closes before the relay answers', async ({
      walletA,
      midenCli
    }, testInfo) => {
      // This includes an intentional capped allocation backoff after a real consume.
      test.setTimeout(900_000);
      await axis.create(walletA);
      const addressA = await walletA.getAccountAddress();
      const evmOwner = await walletA.getEvmAddress();
      await installEpoch7702Delegation(anvil.rpcUrl, evmOwner);
      // The withdrawal uses the SDK's 18-decimal EVM amount convention.
      positions.seedDummyLending(evmOwner, { depositAmount: WITHDRAW_AMOUNT, decimals: 18 });
      allocator.setSuggestedNonces(SUGGESTED_NONCES);
      allocator.setWithdrawNonce('unrelated-relay-nonce');
      allocator.setAllocationOutcome(evmOwner, '11', 'reject');
      await midenCli.init();

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

      const statusPath = (nonce: string) => `/intentStatus/${evmOwner}/${nonce}`.toLowerCase();
      const compactRequests = () =>
        allocator.requests.filter(request => request.method === 'POST' && request.path === '/compact');
      const relayRequests = () =>
        allocator.requests.filter(request => request.method === 'POST' && request.path === '/relay-execute');
      const nonceRequests = () => allocator.requests.filter(request => request.path.startsWith('/suggested-nonce/'));
      const observeTraffic = (wallet: ChromeWalletPageApi) => {
        const statuses: string[] = [];
        const compacts: string[] = [];
        const events: Array<{ at: number; method: string; path: string; bodyHash: string }> = [];
        wallet.page.on('request', request => {
          const url = new URL(request.url());
          if (url.origin !== allocator.baseUrl) return;
          events.push({
            at: Date.now(),
            method: request.method(),
            path: url.pathname,
            bodyHash: createHash('sha256')
              .update(request.postData() ?? '')
              .digest('hex')
          });
          if (request.method() === 'GET' && url.pathname.startsWith('/intentStatus/'))
            statuses.push(url.pathname.toLowerCase());
          if (request.method() === 'POST' && url.pathname === '/compact') compacts.push(request.postData() ?? '');
        });
        return { statuses, compacts, events };
      };
      const originalTraffic = observeTraffic(walletA);

      const relayGate = allocator.parkRelayResponse();
      let relayParked = false;
      void relayGate.accepted.then(() => {
        relayParked = true;
      });
      const proof: Record<string, unknown> = { originalPageEvents: originalTraffic.events };

      try {
        await confirm.click();
        await expect.poll(() => relayParked, { timeout: 120_000, intervals: [1000] }).toBe(true);
        const original = await withdrawState(walletA);
        if (!original) throw new Error('Earn withdrawal tracking row is missing');
        const txId = original.id;
        const prepared = expectPreparedWithdrawal(original, evmOwner);
        proof.prepared = prepared;
        expect(relayRequests(), 'source was accepted once while its response is parked').toHaveLength(1);
        expect(compactRequests(), 'SDK cannot allocate until the parked relay answers').toHaveLength(0);
        expect(nonceRequests(), 'three quote nonces and two final allocation nonces').toHaveLength(5);

        const submissionLocks = (await heldEarnLocks(walletA)).filter(lock => lock.name.startsWith('earn-submit:'));
        expect(submissionLocks, 'one native submission owner').toHaveLength(1);
        const submissionLock = submissionLocks[0];
        if (!submissionLock) throw new Error('Submission lock is missing');
        proof.submissionLock = submissionLock;

        const survivorPage = await walletA.page.context().newPage();
        const survivor = new ChromeWalletPage(survivorPage, walletA.extensionId, walletA.userDataDir);
        const survivorTraffic = observeTraffic(survivor);
        proof.survivorPageEvents = survivorTraffic.events;
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

        // A different module realm must read the complete durable payload before
        // either closing the owner or allowing the accepted relay response back.
        const durable = await withdrawState(survivor, txId);
        if (!durable) throw new Error('Surviving page cannot read the pending withdrawal');
        expect(expectPreparedWithdrawal(durable, evmOwner)).toEqual(prepared);
        proof.durableFromSurvivor = durable;
        expect((await withdrawState(survivor))?.preparedExecution).toEqual(prepared);
        const recoveryWindowStarted = Date.now();
        let remainedPrepared = true;
        await expect
          .poll(
            async () => {
              const row = await withdrawState(survivor, txId);
              remainedPrepared =
                remainedPrepared &&
                row?.phase === 'redeeming' &&
                row.submissionState === 'prepared' &&
                row.withdrawIntentNonce === prepared.delivery.nonce &&
                JSON.stringify(row.preparedExecution) === JSON.stringify(prepared) &&
                compactRequests().length === 0;
              return Date.now() - recoveryWindowStarted;
            },
            { timeout: 35_000, intervals: [1000] }
          )
          .toBeGreaterThanOrEqual(17_000);
        expect(remainedPrepared, 'the held attempt retains its durable preparation across a root recovery tick').toBe(
          true
        );

        await captureWithdrawalScreen(survivor, testInfo, 'withdrawal-prepared');
        await suspendScreenCapture(walletA.page);
        proof.ownerClosedAt = Date.now();
        await walletA.page.close();
        relayGate.release();
        expect(relayRequests(), 'one real relay HTTP request after the submitting document closes').toHaveLength(1);
        await survivorPage.bringToFront();
        const pollLockName = `earn-poll:earn-withdraw:${evmOwner.toLowerCase()}:${prepared.delivery.nonce}`;
        await expect
          .poll(
            async () => {
              const locks = (await heldEarnLocks(survivor)).filter(lock => lock.name === pollLockName);
              return locks.length === 1 && locks[0]?.clientId !== submissionLock.clientId;
            },
            { timeout: 60_000, intervals: [1000] }
          )
          .toBe(true);
        await expect
          .poll(() => compactRequests().length, { timeout: 60_000, intervals: [1000] })
          .toBeGreaterThanOrEqual(2);
        expect(originalTraffic.compacts, 'the closed source owner never reached allocation').toHaveLength(0);
        const requests = prepared.allocations.map(allocation => parseRequest(allocation.requestJson));
        expect(
          compactRequests()
            .slice(0, 2)
            .map(request => request.body)
        ).toEqual(expect.arrayContaining(requests));
        expect(survivorTraffic.compacts.slice(0, 2)).toEqual(
          expect.arrayContaining(prepared.allocations.map(allocation => allocation.requestJson))
        );
        await expect
          .poll(() => survivorTraffic.statuses.filter(path => path === statusPath('22')).length, {
            timeout: 45_000,
            intervals: [1000]
          })
          .toBeGreaterThanOrEqual(2);
        expect(
          (await withdrawState(survivor, txId))?.submissionState,
          'one rejected sibling keeps acceptance incomplete'
        ).toBe('prepared');

        allocator.setIntentStatus(evmOwner, '22', [{ status: 'failed', chainId: MIDEN_CHAIN_ID, transactionHash: '' }]);
        await expect
          .poll(async () => (await withdrawState(survivor, txId))?.phase, { timeout: 45_000, intervals: [1000] })
          .toBe('failed');
        await survivor.navigateTo(`/history-details/${txId}`);
        const retryDelivery = survivorPage.getByRole('button', { name: 'Retry delivery', exact: true });
        await expect(retryDelivery).toBeVisible({ timeout: 30_000 });
        await expect(survivorPage.getByText(/Max network fee/)).toHaveCount(0);
        await retryDelivery.scrollIntoViewIfNeeded();
        await captureWithdrawalScreen(survivor, testInfo, 'withdrawal-retry-delivery');
        allocator.setIntentStatus(evmOwner, '22', [
          { status: 'pending', chainId: MIDEN_CHAIN_ID, transactionHash: '' }
        ]);
        const deliveryRequest = prepared.allocations[1];
        if (!deliveryRequest) throw new Error('Selected delivery allocation is missing');
        const deliveryPosts = () =>
          compactRequests().filter(request => JSON.stringify(request.body) === deliveryRequest.requestJson);
        const deliveryPostsBeforeRetry = deliveryPosts().length;
        proof.retryClickedAt = Date.now();
        await retryDelivery.click();
        await expect
          .poll(() => deliveryPosts().length, { timeout: 45_000, intervals: [1000] })
          .toBe(deliveryPostsBeforeRetry + 1);
        await expect.poll(async () => (await withdrawState(survivor, txId))?.phase).toBe('redeeming');
        expect((await withdrawState(survivor, txId))?.preparedExecution).toEqual(prepared);
        expect(relayRequests(), 'Retry delivery cannot submit the source again').toHaveLength(1);
        expect(nonceRequests(), 'recovery cannot construct a new intent').toHaveLength(5);

        const nativeDelivery = await midenCli.transferNativeFromFunder(addressA, NOTE_AMOUNT);
        expect(nativeDelivery.faucetId).toBe(prepared.delivery.destinationFaucetId);
        proof.nativeDelivery = nativeDelivery;
        const { noteId } = nativeDelivery;
        allocator.setMidenNoteId(noteId, { owner: evmOwner, nonce: prepared.delivery.nonce });
        await midenCli.sync();
        await expect
          .poll(async () => (await withdrawState(survivor, txId))?.phase, { timeout: 180_000, intervals: [3000] })
          .toMatch(/^(delivering|received)$/);
        await survivor.claimAllNotes(420_000);
        await expect
          .poll(async () => (await withdrawState(survivor, txId))?.phase, { timeout: 180_000, intervals: [3000] })
          .toBe('received');
        const received = await withdrawState(survivor, txId);
        if (!received?.midenNoteId) throw new Error('Received withdrawal is missing its delivered note');
        expect(noteKey(received.midenNoteId)).toBe(noteKey(noteId));
        expect(received.submissionState, 'received delivery must not acknowledge the rejected sibling').toBe(
          'prepared'
        );
        const receipt = received.receipts.find(candidate =>
          candidate.noteIds.some(id => noteKey(id) === noteKey(noteId))
        );
        if (!receipt?.transactionId || !receipt.midenNoteId)
          throw new Error('Real completed consume receipt is missing');
        expect(receipt.status, 'consume transaction is Completed').toBe(2);
        expect(noteKey(receipt.midenNoteId)).toBe(noteKey(noteId));
        expect(receipt.intentOwner?.toLowerCase()).toBe(evmOwner.toLowerCase());
        expect(receipt.intentNonce).toBe(prepared.delivery.nonce);
        expect(receipt.attemptId).toBe(prepared.attemptId);
        proof.receipt = receipt;

        allocator.setAllocationOutcome(evmOwner, '11', 'accept');
        let stayedReceived = true;
        await expect
          .poll(
            async () => {
              const row = await withdrawState(survivor, txId);
              stayedReceived =
                stayedReceived &&
                row?.phase === 'received' &&
                JSON.stringify(row.preparedExecution) === JSON.stringify(prepared);
              return row?.submissionState;
            },
            { timeout: 330_000, intervals: [3000] }
          )
          .toBe('accepted');
        expect(stayedReceived, 'repairing the unavailable sibling preserves the received delivery').toBe(true);
        proof.finalRow = await withdrawState(survivor, txId);
        for (const request of compactRequests()) {
          expect(
            prepared.allocations.some(allocation => allocation.requestJson === JSON.stringify(request.body)),
            'every repair preserves its original complete payload'
          ).toBe(true);
        }
        expect(deliveryPosts().length, 'accepted delivery receives only its one explicit retry').toBe(
          deliveryPostsBeforeRetry + 1
        );
        expect(relayRequests()).toHaveLength(1);
        expect(nonceRequests()).toHaveLength(5);
        expect(positions.requests.some(request => request.path === '/positions')).toBe(true);
        await survivor.navigateTo(`/history-details/${txId}`);
        await expect(survivorPage.getByText('Received', { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(survivorPage.getByRole('button', { name: 'Retry delivery', exact: true })).toHaveCount(0);
        await captureWithdrawalScreen(survivor, testInfo, 'withdrawal-received');
        await survivor.navigateTo(`/history-details/${receipt.id}`);
        const receiptHash = survivorPage.getByTestId('history-detail-tx-id');
        await expect(receiptHash).toBeVisible({ timeout: 30_000 });
        await receiptHash.scrollIntoViewIfNeeded();
        await captureWithdrawalScreen(survivor, testInfo, 'withdrawal-consume-receipt');
      } finally {
        relayGate.release();
        await testInfo.attach('withdrawal-recovery-evidence', {
          contentType: 'application/json',
          body: JSON.stringify(
            {
              ...proof,
              requests: allocator.requests.map(request => ({
                method: request.method,
                path: request.path,
                receivedAt: request.receivedAt,
                bodyHash: createHash('sha256')
                  .update(JSON.stringify(request.body) ?? '')
                  .digest('hex')
              }))
            },
            null,
            2
          )
        });
      }
    });
  });
}

defineEarnWithdrawSuite(offChainAxis);
defineEarnWithdrawSuite(guardianAxis(getEnvironmentConfig().guardianUrl));
