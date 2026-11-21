import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from '../../fixtures/two-wallets';
import { fromBaseUnits } from '../../helpers/balance-truth';
import { mainnetRpc } from '../../helpers/mainnet-bridge-sources';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { captureMainnetOneClickReviewQuote, connectMainnetOneClickWallet, selectMainnetOneClickAssets } from '../../helpers/mainnet-one-click-ui';
import { WcCounterparty } from '../../ios/helpers/wc-counterparty';
import { ONE_CLICK_EVM_CHAIN_IDS } from '../../../../src/lib/one-click/client';
import { buildEvmOneClickTransaction } from '../../../../src/lib/one-click/evm-transfer';
import { hashOneClickQuote } from '../../../../src/lib/one-click/signature';

const path = 'test-results/near/roundtrip.json';
const digest = () => createHash('sha256').update(readFileSync(path)).digest('hex');
let stage = 'checkpoint';
test.use({ injectFeeFaucet: false });
test.afterEach(async ({}, info) => {
  if (info.status !== 'passed') writeFileSync('test-results/green04-near-stage.json', JSON.stringify({ stage }), { mode: 0o600 });
});
test('observe a fresh NEAR return request without signing or broadcasting', async ({ walletB }) => {
  test.setTimeout(360_000);
  const before = digest();
  const state = loadMainnetNearCheckpoint(path);
  assert.ok(state?.forwardReceived && state.reverseQuote && state.phase === 'reverse-authorized');
  assert.equal(state.evm.chainId, 42161);
  assert.ok(!state.transactions?.length && Date.now() > Date.parse(state.reverseQuote.deadline));
  stage = 'guardian-restore';
  await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  assert.equal(await walletB.getAccountAddress(), state.account);
  const key = `0x${(process.env.E2E_MAINNET_EVM_KEY ?? '').trim().replace(/^0x/, '')}` as const;
  assert.match(key, /^0x[0-9a-fA-F]{64}$/);
  let expected: ReturnType<typeof buildEvmOneClickTransaction> | undefined;
  let exactRequestHeld = false;
  const counterparty = new WcCounterparty({ privateKey: key, chainId: state.evm.chainId,
    rpcUrl: mainnetRpc(state.evm.chainId), sessionChainIds: Object.values(ONE_CLICK_EVM_CHAIN_IDS),
    send: async tx => {
      stage = 'request-mismatch';
      exactRequestHeld = !!expected && tx.to.toLowerCase() === expected.to?.toLowerCase() &&
        tx.data.toLowerCase() === expected.data?.toLowerCase() && tx.value === BigInt(expected.value ?? '0');
      throw new Error('Read-only diagnostic: signing and broadcast disabled');
    }
  });
  assert.equal(counterparty.address.toLowerCase(), state.evm.account.toLowerCase());
  try {
    stage = 'connect';
    const amount = BigInt(state.forwardReceived);
    const route = { payNetwork: 'arb', payAssetId: state.evmAssetId, receiveNetwork: 'miden', receiveAssetId: state.nativeAssetId, amount: fromBaseUnits(amount, 6) };
    await walletB.navigateTo('/swap');
    await selectMainnetOneClickAssets(walletB.page, route);
    await connectMainnetOneClickWallet(walletB, counterparty);
    stage = 'fresh-review';
    const quote = await captureMainnetOneClickReviewQuote(walletB, route, { originAsset: state.evmAssetId,
      destinationAsset: state.nativeAssetId, amount, refundTo: state.evm.account, recipient: state.account }, true);
    const deposit = quote.quote.depositAddress;
    assert.ok(deposit && deposit.toLowerCase() !== state.reverseQuote.depositAddress.toLowerCase());
    assert.notEqual(hashOneClickQuote(quote), state.reverseQuote.quoteHash);
    expected = buildEvmOneClickTransaction({ assetId: state.evmAssetId, symbol: 'USDC', decimals: 6, blockchain: 'arb', chainId: state.evm.chainId, contractAddress: state.evm.token }, deposit, amount.toString(), state.evm.account);
    stage = 'confirm-no-request';
    await walletB.page.getByTestId('one-click-confirm').click();
    await expect.poll(() => exactRequestHeld, { timeout: 90_000 }).toBe(true);
    assert.equal(digest(), before);
    writeFileSync('test-results/green04-near-custody.json', JSON.stringify({ exactRequestHeld, checkpointUnchanged: true, noSignOrBroadcast: true }), { mode: 0o600 });
  } finally {
    await counterparty.stop();
  }
});
