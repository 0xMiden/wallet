import { expect, test, type HermeticOneClickFixture } from '../../fixtures/hermetic-one-click';
import type { GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import { type Page } from '@playwright/test';
import { fundBridgeToken } from '../../helpers/bridge';
import { forgetFixtureConfig } from '../../helpers/feature-eligibility';
import { readTransactionRows, TxStatus } from '../../helpers/history';
import type { MidenCli } from '../../helpers/miden-cli';
import { AnvilInstance } from '../../ios/helpers/anvil';
import { WcCounterparty } from '../../ios/helpers/wc-counterparty';
import { ETH_ASSET_ID, MIDEN_ASSET_ID } from '../../fixtures/hermetic-one-click';

const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';
const ANVIL_PORT = 8545;
const AMOUNT_ETH_INITIAL = '0.01';
const AMOUNT_ETH_REVISED = '0.0002';
const AMOUNT_ETH_REVISED_BASE = 200_000_000_000_000n;
const AMOUNT_MIDEN_OUTPUT = 200n;
const DEPOSIT_TX_HASH = `0x${'ab'.repeat(32)}`;

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', timeout: 900_000 });

let anvil: AnvilInstance | undefined;
let counterparty: WcCounterparty | undefined;

test.beforeAll(async () => {
  anvil = await AnvilInstance.start({ port: ANVIL_PORT, chainId: 1 });
});

test.afterAll(async () => {
  await counterparty?.stop();
  anvil?.stop();
});

async function prepareWallet(
  wallet: GuardianAwareWalletPage,
  midenCli: MidenCli,
  fixture: HermeticOneClickFixture,
  midenDepositAddress?: string
): Promise<{ accountAddress: string; faucetHex: string }> {
  await wallet.createGuardianWallet(GUARDIAN_URL);
  const funded = await fundBridgeToken(midenCli, wallet, { symbol: 'MLOCAL', decimals: 6, amount: 1_000_000_000 });
  const accountAddress = await wallet.getAccountAddress();
  fixture.service.setQuoteBuilder((request, defaults) => {
    if (request.originAsset === ETH_ASSET_ID) {
      const output = (BigInt(request.amount) / 1_000_000_000_000n).toString();
      return { ...defaults, amountOut: output, minAmountOut: output, amountOutFormatted: '0.02' };
    }
    const depositAddress = midenDepositAddress ?? accountAddress;
    return { ...defaults, depositAddress };
  });
  fixture.configureMidenAsset(funded.faucetHex, funded.decimals);
  await forgetFixtureConfig(wallet.page, 'localnet');
  await wallet.navigateTo('/swap');
  await expect(wallet.page.getByTestId('swap-flow')).toBeVisible({ timeout: 90_000 });
  await expect(wallet.page.getByTestId('one-click-pay-network-picker')).toBeVisible({ timeout: 120_000 });
  return { accountAddress, faucetHex: funded.faucetHex };
}

async function chooseRoute(
  page: Page,
  pay: 'miden' | 'eth',
  receive: 'miden' | 'eth'
): Promise<void> {
  await page.getByTestId('one-click-pay-network-picker').click();
  await page.getByTestId(`one-click-pay-network-${pay}`).click();
  await page.getByTestId('one-click-receive-network-picker').click();
  await page.getByTestId(`one-click-receive-network-${receive}`).click();
  await page.getByTestId('one-click-pay-asset-picker').click();
  await page.getByTestId(`one-click-asset-pay-${pay === 'miden' ? MIDEN_ASSET_ID : ETH_ASSET_ID}`).click();
  await page.getByTestId('one-click-receive-asset-picker').click();
  await page.getByTestId(`one-click-asset-receive-${receive === 'miden' ? MIDEN_ASSET_ID : ETH_ASSET_ID}`).click();
}

function latestQuoteRequest(
  requests: HermeticOneClickFixture['service']['requests'],
  dry: boolean
): Record<string, unknown> | undefined {
  for (const request of [...requests].reverse()) {
    if (request.path === '/v0/quote' && isRecord(request.body) && Reflect.get(request.body, 'dry') === dry) {
      return request.body;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('Guardian Miden send uses a signed 1Click quote and the ordinary local transaction queue', async ({
  walletA,
  walletB,
  midenCli,
  oneClick
}) => {
  test.setTimeout(900_000);
  await walletB.createNewWallet();
  const depositAddress = await walletB.getAccountAddress();
  const { accountAddress } = await prepareWallet(walletA, midenCli, oneClick, depositAddress);
  await chooseRoute(walletA.page, 'miden', 'eth');
  await walletA.page.getByTestId('one-click-recipient-address').fill('0x000000000000000000000000000000000000dEaD');
  await walletA.page.getByTestId('one-click-pay-amount').fill('1');

  await expect.poll(() => latestQuoteRequest(oneClick.service.requests, true)).toMatchObject({
    amount: '1000000',
    originAsset: MIDEN_ASSET_ID,
    destinationAsset: ETH_ASSET_ID
  });
  await expect(walletA.page.getByTestId('one-click-review-submit')).toBeEnabled({ timeout: 60_000 });
  const wetResponse = walletA.page.waitForResponse(response => {
    if (!response.url().includes('/v0/quote') || response.request().method() !== 'POST') return false;
    const body: unknown = response.request().postDataJSON();
    return typeof body === 'object' && body !== null && Reflect.get(body, 'dry') === false;
  });
  await walletA.page.getByTestId('one-click-review-submit').click();
  await expect(walletA.page.getByTestId('one-click-review-hero')).toBeVisible();
  const signedReview: unknown = await (await wetResponse).json();
  expect(typeof signedReview === 'object' && signedReview !== null &&
    typeof Reflect.get(signedReview, 'quote') === 'object' && Reflect.get(Reflect.get(signedReview, 'quote'), 'deadline')).toBeTruthy();
  await expect.poll(() => oneClick.service.requests.some(request =>
    request.path === '/v0/quote' && typeof request.body === 'object' && request.body !== null && Reflect.get(request.body, 'dry') === false
  )).toBe(true);
  expect((await readTransactionRows(walletA.page)).some(row => row.type === 'send' && row.status === TxStatus.Completed)).toBe(false);

  await walletA.page.getByTestId('one-click-confirm').click();
  await expect
    .poll(async () => {
      const rows = await readTransactionRows(walletA.page);
      return rows.find(row => {
        const metadata = row.extraInputs?.oneClick;
        return row.type === 'send' && row.status === TxStatus.Completed &&
          typeof metadata === 'object' && metadata !== null && Reflect.get(metadata, 'accountAddress') === accountAddress;
      })?.status ?? null;
    }, { timeout: 300_000, intervals: [3_000] })
    .toBe(TxStatus.Completed);
  const sendRow = (await readTransactionRows(walletA.page)).find(row => {
    const metadata = row.extraInputs?.oneClick;
    return row.type === 'send' && typeof metadata === 'object' && metadata !== null &&
      Reflect.get(metadata, 'accountAddress') === accountAddress;
  });
  expect(sendRow?.id).toBeTruthy();
  const phaseForSend = async (): Promise<unknown> => {
    const row = (await readTransactionRows(walletA.page)).find(candidate => candidate.id === sendRow?.id);
    const metadata = row?.extraInputs?.oneClick;
    return typeof metadata === 'object' && metadata !== null ? Reflect.get(metadata, 'phase') : undefined;
  };
  oneClick.service.setStatus('INCOMPLETE_DEPOSIT', { depositedAmount: '500000' });
  await expect.poll(phaseForSend, { timeout: 60_000 }).toBe('incomplete-deposit');
  oneClick.service.setStatus('REFUNDED', { refundedAmount: '500000', refundReason: 'Local E2E refund' });
  await expect.poll(phaseForSend, { timeout: 60_000 }).toBe('refunded');
});

test('inbound WC keeps its session after amount edits, sends only on confirm, and links only the exact delivered note', async ({
  walletA,
  midenCli,
  oneClick
}) => {
  test.setTimeout(900_000);
  const { accountAddress, faucetHex } = await prepareWallet(walletA, midenCli, oneClick);
  await chooseRoute(walletA.page, 'eth', 'miden');
  const wc = new WcCounterparty({ chainId: 1, sessionChainIds: [1], rpcUrl: 'http://127.0.0.1:8545' });
  counterparty = wc;
  const appState = async () => walletA.page.evaluate(() => {
    const read = window.__TEST_APPKIT_STATE__;
    if (!read) throw new Error('Local E2E AppKit state hook is unavailable');
    return read();
  });
  await wc.start();
  const connection = wc.connectWithRetry(
    () => walletA.page.evaluate(() => {
      const read = window.__TEST_APPKIT_CONNECT_URI__;
      if (!read) throw new Error('Local E2E AppKit URI hook is unavailable');
      return read();
    }),
    async () => (await appState()).connected,
    { attempts: 3, backoffMs: 2_000, sessionTimeoutMs: 45_000 }
  );
  await walletA.page.getByTestId('one-click-connect-origin-wallet').click();
  await connection;
  expect((await appState()).address?.toLowerCase()).toBe(wc.account.address.toLowerCase());

  await setNativeBalance(wc.account.address, 1n);
  await walletA.page.getByTestId('one-click-pay-amount').fill(AMOUNT_ETH_INITIAL);
  await expect(walletA.page.getByTestId('one-click-evm-balance')).toContainText('Insufficient network fee balance', {
    timeout: 30_000
  });
  await setNativeBalance(wc.account.address, 10_000_000_000_000_000n);
  const priorWetQuoteCount = oneClick.service.requests.filter(request => request.path === '/v0/quote' &&
    typeof request.body === 'object' && request.body !== null && Reflect.get(request.body, 'dry') === false
  ).length;
  let wetQuoteCount = 0;
  oneClick.service.setQuoteBuilder((request, defaults) => {
    if (request.originAsset !== ETH_ASSET_ID) return defaults;
    const output = (BigInt(request.amount) / 1_000_000_000_000n).toString();
    const result = { ...defaults, amountOut: output, minAmountOut: output, amountOutFormatted: '0.0002' };
    if (request.dry) return result;
    wetQuoteCount += 1;
    return wetQuoteCount === 1
      ? { ...result, deadline: new Date(Date.now() + 5_000).toISOString() }
      : result;
  });
  await walletA.page.getByTestId('one-click-pay-amount').fill(AMOUNT_ETH_REVISED);
  await expect(walletA.page.getByTestId('one-click-review-submit')).toBeEnabled({ timeout: 60_000 });
  await expect.poll(() => latestQuoteRequest(oneClick.service.requests, true)).toMatchObject({
    amount: AMOUNT_ETH_REVISED_BASE.toString(),
    originAsset: ETH_ASSET_ID,
    destinationAsset: MIDEN_ASSET_ID
  });
  expect((await appState()).connected, 'editing amount preserves the WalletConnect session').toBe(true);
  expect(wc.requests.filter(request => request.method === 'eth_sendTransaction')).toHaveLength(0);
  await expect(walletA.page.getByTestId('one-click-connect-origin-wallet')).toHaveCount(0);

  await walletA.page.getByTestId('one-click-review-submit').click();
  await expect(walletA.page.getByTestId('one-click-review-hero')).toBeVisible();
  const wet = [...oneClick.service.requests].reverse().find(request => request.path === '/v0/quote' &&
    typeof request.body === 'object' && request.body !== null && Reflect.get(request.body, 'dry') === false
  );
  expect(wet?.body).toMatchObject({ amount: AMOUNT_ETH_REVISED_BASE.toString(), refundTo: wc.account.address });
  await expect(walletA.page.getByTestId('one-click-refresh-quote')).toBeVisible({ timeout: 15_000 });
  await walletA.page.getByTestId('one-click-refresh-quote').click();
  await expect(walletA.page.getByTestId('one-click-confirm')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => oneClick.service.requests.filter(request => request.path === '/v0/quote' &&
    typeof request.body === 'object' && request.body !== null && Reflect.get(request.body, 'dry') === false
  ).length).toBe(priorWetQuoteCount + 2);
  expect(wc.requests.filter(request => request.method === 'eth_sendTransaction')).toHaveLength(0);
  await walletA.page.getByTestId('one-click-confirm').click();
  await expect.poll(() => wc.requests.filter(request => request.method === 'eth_sendTransaction').length).toBe(1);
  const sentTransaction = wc.requests.find(request => request.method === 'eth_sendTransaction');
  if (!sentTransaction || !Array.isArray(sentTransaction.params) || typeof sentTransaction.params[0] !== 'object' ||
      sentTransaction.params[0] === null) {
    throw new Error('WalletConnect did not send a transaction object');
  }
  expect(Reflect.get(sentTransaction.params[0], 'to')).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(Reflect.get(sentTransaction.params[0], 'value')).toBe(`0x${AMOUNT_ETH_REVISED_BASE.toString(16)}`);
  expect((await appState()).connected, 'the transfer did not disconnect the session').toBe(true);

  const transactionRows = () => readTransactionRows(walletA.page);
  await expect.poll(async () => (await transactionRows()).find(row => {
    const metadata = row.extraInputs?.oneClick;
    return typeof metadata === 'object' && metadata !== null && Reflect.get(metadata, 'accountAddress') === accountAddress;
  }) ?? null, { timeout: 90_000 }).not.toBeNull();
  const tracked = (await transactionRows()).find(row => {
    const metadata = row.extraInputs?.oneClick;
    return typeof metadata === 'object' && metadata !== null && Reflect.get(metadata, 'accountAddress') === accountAddress;
  });
  expect(tracked?.id).toBeTruthy();
  expect(wet?.body).toMatchObject({ amount: AMOUNT_ETH_REVISED_BASE.toString() });
  oneClick.service.setStatus('SUCCESS', {
    amountIn: AMOUNT_ETH_REVISED_BASE.toString(),
    amountOut: AMOUNT_MIDEN_OUTPUT.toString(),
    destinationChainTxHashes: [{ hash: DEPOSIT_TX_HASH, explorerUrl: 'http://localhost/tx' }]
  });
  const unrelated = await midenCli.mint(faucetHex, accountAddress, AMOUNT_MIDEN_OUTPUT, 'public');
  await walletA.triggerSync(true);
  await walletA.claimAllNotes(120_000);
  await expect.poll(async () => {
    const rows = await transactionRows();
    const row = rows.find(candidate => candidate.id === tracked?.id);
    const metadata = row?.extraInputs?.oneClick;
    return typeof metadata === 'object' && metadata !== null ? Reflect.get(metadata, 'phase') : undefined;
  }, { timeout: 60_000 }).toBe('arriving');
  expect(unrelated.noteId).toBeTruthy();

  const linked = await midenCli.mint(faucetHex, accountAddress, AMOUNT_MIDEN_OUTPUT, 'public');
  oneClick.service.setReceipts([{ transactionHash: DEPOSIT_TX_HASH, noteIds: [linked.noteId] }]);
  await walletA.triggerSync(true);
  await walletA.claimAllNotes(120_000);
  await expect.poll(async () => {
    const row = (await transactionRows()).find(candidate => candidate.id === tracked?.id);
    const metadata = row?.extraInputs?.oneClick;
    return typeof metadata === 'object' && metadata !== null ? Reflect.get(metadata, 'phase') : undefined;
  }, { timeout: 90_000 }).toBe('delivered');
});

async function setNativeBalance(account: string, balance: bigint): Promise<void> {
  const response = await fetch('http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [account, `0x${balance.toString(16)}`] })
  });
  if (!response.ok) throw new Error(`Anvil rejected the test balance update (${response.status})`);
}
