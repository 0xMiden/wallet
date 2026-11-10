import bs58 from 'bs58';

import {
  expect,
  MIDEN_ASSET_ID,
  MIDEN_SYMBOL,
  ORIGIN_CHAIN_ID,
  ORIGIN_TOKEN_ASSET_ID,
  ORIGIN_TOKEN_SYMBOL,
  test
} from '../../fixtures/hermetic-one-click';
import { fundBridgeToken } from '../../helpers/bridge';
import { forgetFixtureConfig, setEligibilityFixtureConfig } from '../../helpers/feature-eligibility';
import { readTransactionRows, type TransactionRowSnapshot } from '../../helpers/history';

/**
 * NEAR Intents on the Receive page, against the local node and the fake 1Click service. The user picks Solana and
 * SOL, types an amount and a Solana refund address, and gets a Solana deposit address. Nobody pays it here: the fake
 * service reports the provider states that a payment from an external wallet causes, with no deposit-submit call.
 * The wallet must follow the tracked row to `delivered` once the Miden note that the receipt names arrives.
 */

const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';
const AMOUNT_SOL = '1.5';
const AMOUNT_SOL_BASE = 1_500_000_000n;
// The fake scales 9 SOL decimals down to the 6 decimals of the local token.
const AMOUNT_MIDEN_OUTPUT = 1_500_000n;
const MIDEN_DECIMALS = 6;
// A Solana public key: the base58 form of 32 bytes.
const REFUND_ADDRESS = bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => (index * 13 + 5) % 256));
const DESTINATION_TX_HASH = `0x${'cd'.repeat(32)}`;

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', timeout: 900_000 });

function trackingOf(row: TransactionRowSnapshot | undefined): Record<string, unknown> | undefined {
  const tracking = row?.extraInputs?.oneClick;
  return typeof tracking === 'object' && tracking !== null && !Array.isArray(tracking) ? { ...tracking } : undefined;
}

test('Receive gives a NEAR Intents deposit address and follows the row to delivery', async ({
  walletA,
  midenCli,
  oneClick
}) => {
  await walletA.createGuardianWallet(GUARDIAN_URL);
  const accountAddress = await walletA.getAccountAddress();
  const funded = await fundBridgeToken(midenCli, walletA, {
    symbol: MIDEN_SYMBOL,
    decimals: MIDEN_DECIMALS,
    amount: 1_000_000
  });
  const document = oneClick.configureNearIntents(funded.faucetHex, funded.decimals);
  await setEligibilityFixtureConfig(document);
  await forgetFixtureConfig(walletA.page, 'localnet');
  await walletA.page.reload({ waitUntil: 'domcontentloaded' });

  const page = walletA.page;
  await walletA.navigateTo('/receive');
  await page.getByTestId('receive-tab-near-intents').click({ timeout: 90_000 });
  // The send token drawer lists the tokens of one origin chain; its network filter picks the chain.
  await page.getByTestId('near-intents-send-token-pill').click({ timeout: 120_000 });
  await page.getByTestId('near-intents-network-filter').click();
  await page.getByTestId(`near-intents-network-${ORIGIN_CHAIN_ID}`).click();
  await page.getByTestId(`near-intents-token-${ORIGIN_TOKEN_ASSET_ID}`).click();
  await expect(page.getByTestId('near-intents-send-token-pill')).toHaveText(ORIGIN_TOKEN_SYMBOL);
  await page.getByTestId('near-intents-amount').fill(AMOUNT_SOL);
  await page.getByTestId('near-intents-refund-address').fill(REFUND_ADDRESS);

  const getAddress = page.getByTestId('near-intents-get-deposit-address');
  await expect(getAddress).toBeEnabled({ timeout: 60_000 });
  await getAddress.click();

  // The wet quote names the account as recipient and the typed refund address, for the typed amount.
  await expect.poll(() => oneClick.service.latestDeposit()?.request ?? null, { timeout: 60_000 }).toMatchObject({
    dry: false,
    originAsset: ORIGIN_TOKEN_ASSET_ID,
    destinationAsset: MIDEN_ASSET_ID,
    amount: AMOUNT_SOL_BASE.toString(),
    refundTo: REFUND_ADDRESS,
    recipient: accountAddress
  });
  const deposit = oneClick.service.latestDeposit();
  if (!deposit) throw new Error('The fake 1Click service gave no deposit address');
  const depositAddress = deposit.depositAddress;

  // The page shows the Solana deposit address that the service gave, never an EVM one.
  await expect(page.getByTestId('near-intents-deposit-page')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/#\/receive\/near-intents\//);
  await expect(page.getByTestId('near-intents-deposit-address-full')).toHaveText(depositAddress);
  expect(depositAddress).not.toMatch(/^0x/);
  expect(bs58.decode(depositAddress)).toHaveLength(32);
  expect(oneClick.service.requests.some(request => request.path === '/v0/deposit/submit')).toBe(false);

  const rowId = async (): Promise<string | undefined> =>
    (await readTransactionRows(page)).find(row => trackingOf(row)?.depositAddress === depositAddress)?.id;
  await expect.poll(rowId, { timeout: 60_000 }).toBeTruthy();
  const trackedId = await rowId();
  const phase = async (): Promise<unknown> =>
    trackingOf((await readTransactionRows(page)).find(row => row.id === trackedId))?.phase;
  const statusLine = page.getByTestId('near-intents-deposit-status');

  oneClick.service.setDepositStatus(depositAddress, 'PENDING_DEPOSIT');
  await expect.poll(phase, { timeout: 90_000 }).toBe('pending-deposit');

  oneClick.service.setDepositStatus(depositAddress, 'PROCESSING', { depositedAmount: AMOUNT_SOL_BASE.toString() });
  await expect.poll(phase, { timeout: 90_000 }).toBe('processing');
  await expect(statusLine).toHaveAttribute('data-phase', 'processing', { timeout: 30_000 });

  oneClick.service.setDepositStatus(depositAddress, 'SUCCESS', {
    depositedAmount: AMOUNT_SOL_BASE.toString(),
    amountIn: AMOUNT_SOL_BASE.toString(),
    amountOut: AMOUNT_MIDEN_OUTPUT.toString(),
    destinationChainTxHashes: [{ hash: DESTINATION_TX_HASH, explorerUrl: 'http://localhost/tx' }]
  });
  await expect.poll(phase, { timeout: 90_000 }).toBe('arriving');

  // The receipt links the destination transaction to the exact note that the faucet minted for the account.
  const linked = await midenCli.mint(funded.faucetHex, accountAddress, AMOUNT_MIDEN_OUTPUT, 'public');
  oneClick.service.setReceipts([{ transactionHash: DESTINATION_TX_HASH, noteIds: [linked.noteId] }]);
  await walletA.triggerSync(true);
  await walletA.claimAllNotes(120_000);
  await expect.poll(phase, { timeout: 120_000 }).toBe('delivered');
  await expect(statusLine).toHaveAttribute('data-phase', 'delivered', { timeout: 30_000 });
  expect(oneClick.service.requests.some(request => request.path === '/v0/deposit/submit')).toBe(false);
});
