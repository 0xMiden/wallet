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
import { getAddress } from 'viem';
import { loadMainnetOneClickSetup } from '../../helpers/mainnet-one-click-config';
import { createMainnetOneClickEvmSender, readMainnetEvmHolding } from '../../helpers/mainnet-one-click-evm';
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
  let sender: ReturnType<typeof createMainnetOneClickEvmSender> | undefined;
  let exactRequestHeld = false;
  const counterparty = new WcCounterparty({ privateKey: key, chainId: state.evm.chainId,
    rpcUrl: mainnetRpc(state.evm.chainId), sessionChainIds: Object.values(ONE_CLICK_EVM_CHAIN_IDS),
    send: async (tx, signal) => {
      stage = 'sender-preflight';
      assert.ok(sender);
      return sender.send(tx, signal);
    }
  });
  assert.equal(counterparty.address.toLowerCase(), state.evm.account.toLowerCase());
  try {
    stage = 'connect';
    const amount = BigInt(state.forwardReceived);
    const route = { payNetwork: 'arb', payAssetId: state.evmAssetId, receiveNetwork: 'miden', receiveAssetId: state.nativeAssetId, amount: fromBaseUnits(amount, 6) };
    stage = 'navigate-swap';
    await walletB.navigateTo('/swap');
    stage = 'select-return-route';
    await selectMainnetOneClickAssets(walletB.page, route);
    stage = 'connect-walletconnect';
    await connectMainnetOneClickWallet(walletB, counterparty);
    stage = 'fresh-review';
    const quote = await captureMainnetOneClickReviewQuote(walletB, route, { originAsset: state.evmAssetId,
      destinationAsset: state.nativeAssetId, amount, refundTo: state.evm.account, recipient: state.account }, true);
    const deposit = quote.quote.depositAddress;
    assert.ok(deposit && deposit.toLowerCase() !== state.reverseQuote.depositAddress.toLowerCase());
    assert.notEqual(hashOneClickQuote(quote), state.reverseQuote.quoteHash);
    stage = 'sender-bind';
    const setup = await loadMainnetOneClickSetup(fetch, fetch, walletB.extensionId);
    assert.ok(setup);
    const originAsset = setup.assets.find(asset => asset.assetId === state.evmAssetId);
    const destinationAsset = setup.assets.find(asset => asset.assetId === state.nativeAssetId);
    const deadline = quote.quoteRequest.deadline;
    assert.ok(originAsset && destinationAsset && deadline);
    const account = getAddress(state.evm.account);
    const holding = await readMainnetEvmHolding(originAsset, account);
    sender = createMainnetOneClickEvmSender({ holding, account, config: setup.config,
      gasBudgetWei: BigInt(state.evmFeeBudget), broadcast: async () => {
        exactRequestHeld = true;
        throw new Error('Diagnostic refuses signing and broadcast');
      }
    });
    sender.bind({ originAsset, destinationAsset, amount: amount.toString(), refundTo: state.evm.account,
      recipient: state.account, deadline, slippageTolerance: 100 }, quote);
    stage = 'confirm-no-request';
    await walletB.page.getByTestId('one-click-confirm').click();
    await expect.poll(() => exactRequestHeld, { timeout: 90_000 }).toBe(true);
    assert.equal(digest(), before);
    writeFileSync('test-results/green04-near-custody.json', JSON.stringify({ exactRequestHeld, checkpointUnchanged: true, noSignOrBroadcast: true }), { mode: 0o600 });
  } finally {
    await counterparty.stop();
  }
});
