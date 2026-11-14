import { writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

import { parseBridgeConfig } from '../../../../src/lib/remote-config/schema';
import { expect, test } from '../../fixtures/two-wallets';
import {
  vaultBalanceByFaucetId,
  walletDiscoveredBaseFee,
  walletDiscoveredNativeFaucetId
} from '../../helpers/balance-truth';
import {
  loadMainnetEpochCheckpoint,
  saveMainnetEpochCheckpoint,
  type MainnetEpochCheckpoint
} from '../../helpers/mainnet-epoch-checkpoint';
import { epochReadOnlyProvider, prepareEpochRoundTrip } from '../../helpers/mainnet-epoch-provider';
import {
  recoverEpochForward,
  recoverEpochReturn,
  runEpochRefund,
  runEpochForward,
  runEpochReverse
} from '../../helpers/mainnet-epoch-runtime';
import { planEpochRoundTrip } from '../../helpers/mainnet-epoch-ui';
import { remainingMainnetLoopBudget } from '../../helpers/mainnet-loop-budget';
import { canonicalMainnetLoopFaucet } from '../../helpers/mainnet-loop-config';
import { readMainnetMidenBlock } from '../../helpers/mainnet-miden-read';
import { loadMainnetOneClickSetup, mainnetConfigSource } from '../../helpers/mainnet-one-click-config';
import { readMainnetEvmHolding } from '../../helpers/mainnet-one-click-evm';
import { fetchMainnetOneClickUsdPrices, mainnetOneClickPriceId } from '../../helpers/mainnet-one-click-prices';
import { loadMainnetSwapCheckpoint } from '../../helpers/mainnet-swap-checkpoint';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { getEnvironmentConfig } from '../../config/environments';

const STATE_PATH = 'test-results/mainnet-epoch-state/roundtrip.json';
test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', retries: 0 });

test.afterEach(async ({},info)=>{
  if(info.status===info.expectedStatus)return;
  writeFileSync('test-results/epoch-readonly-preview.json',JSON.stringify({purpose:'independent read-only Epoch plan; no persisted grant/signature/funding',eligible:false,grantPersisted:false,sdkAuthorityIssued:false}));
});
test('independent read-only Epoch planning without grant persistence', async ({ walletB }) => {
  test.setTimeout(600000);
  const mode = process.env.MAINNET_EPOCH_MODE;
  if(mode!=='prepare')throw new Error('Read-only provider preflight forbids execution modes');
  test.skip(mode === undefined, 'Epoch is selected only by the staged nightly workflow');
  const runId = process.env.GITHUB_RUN_ID;
  if (
    process.env.E2E_NETWORK !== 'mainnet' ||
    !runId ||
    !/^\d{1,20}$/.test(runId) ||
    process.env.GITHUB_RUN_ATTEMPT !== '1' ||
    !['recover', 'prepare', 'forward', 'reverse'].includes(mode ?? '')
  )
    throw new Error('Epoch requires an explicit first-attempt mainnet workflow stage');
  const previous = loadMainnetEpochCheckpoint(STATE_PATH);
  if (mode === 'recover') {
    if (
      previous?.phase === 'forward-authorized' &&
      !previous.forwardAuthority &&
      !previous.forwardNoteId &&
      !previous.forwardMidenTxId &&
      !previous.forwardReceived &&
      !previous.forwardEvmTxHash &&
      previous.reverseNonce === undefined &&
      !previous.reverseAuthority &&
      !previous.transactions?.length &&
      !previous.consumeAuthority &&
      previous.paidMidenFees === '0' &&
      previous.paidEvmFees === '0' &&
      process.env.MAINNET_EPOCH_FORWARD_ATTEMPTED === 'false'
    ) {
      previous.phase = 'unspent';
      previous.updatedAt = new Date().toISOString();
      saveMainnetEpochCheckpoint(STATE_PATH, previous);
    }
    if (!previous || ['complete', 'unspent', 'cancelled'].includes(previous.phase)) {
      writeFileSync('test-results/mainnet-epoch-recovery.json', `${JSON.stringify({ recoveryOnly: false })}\n`);
      return;
    }
    if (previous.consumeAuthority && !previous.returnMidenTxId)
      throw new Error('Original native claim authorization has an unresolved outcome; never retry it');
    const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR?.trim();
    if (!keyPair) throw new Error('Existing funded Guardian key pair is required for Epoch recovery');
    await restoreMainnetLoopGuardian(walletB, keyPair);
    if ((await walletB.getAccountAddress()) !== previous.account)
      throw new Error('Epoch recovery Guardian account changed');
    const signal = AbortSignal.timeout(1_100_000);
    const returnOriginalProceeds = async () => {
      if (
        previous.reverseNonce !== undefined ||
        previous.reverseAuthority ||
        previous.transactions?.length ||
        previous.consumeAuthority
      )
        throw new Error('Existing original reverse authorization is ambiguous; never refresh or retry it');
      const key = (process.env.E2E_MAINNET_EVM_KEY?.trim() ?? '').replace(/^0x/, '');
      if (!/^[0-9a-f]{64}$/i.test(key))
        throw new Error('Existing funded EVM key is required for original return recovery');
      await recoverEpochForward(walletB, previous, STATE_PATH, signal);
      await runEpochReverse(
        walletB,
        previous,
        STATE_PATH,
        previous.sourceRunId,
        `0x${key}`,
        `${STATE_PATH}.recover-reverse`,
        signal
      );
    };
    if (previous.returnMidenTxId && previous.returnNoteId === previous.forwardNoteId) {
      await runEpochRefund(walletB, previous, STATE_PATH, `${STATE_PATH}.refund`, signal);
    } else if (previous.transactions?.length) {
      await recoverEpochReturn(walletB, previous, STATE_PATH, `${STATE_PATH}.recover`, signal);
    } else if (previous.forwardReceived) {
      await returnOriginalProceeds();
    } else {
      if (!previous.forwardAuthority || !previous.forwardNoteId)
        throw new Error('Missing exact original collateral authorization; submission outcome is ambiguous');
      const provider = epochReadOnlyProvider(previous.allocatorUrl, previous.virtualChainId, previous.evm.account);
      const status = await provider.sdk.getIntentStatus(provider.config, previous.evm.account, previous.forwardNonce);
      if (!Array.isArray(status)) throw new Error('Unknown original Epoch settlement status; do not refund or retry');
      if (status.some(leg => leg.chainId === previous.evm.chainId && ['success', 'completed'].includes(leg.status))) {
        await returnOriginalProceeds();
      } else {
        if ((await readMainnetMidenBlock(getEnvironmentConfig().rpcUrl)) < previous.forwardAuthority.reclaimHeight)
          throw new Error('Original Epoch collateral is still pending before reclaim maturity');
        await runEpochRefund(walletB, previous, STATE_PATH, `${STATE_PATH}.refund`, signal);
      }
    }
    writeFileSync(
      'test-results/mainnet-epoch-recovery.json',
      `${JSON.stringify({ recoveryOnly: true, sourceRunId: previous.sourceRunId })}\n`
    );
    return;
  }
  if (mode !== 'prepare') {
    if (
      !previous ||
      previous.sourceRunId !== runId ||
      previous.authorizationRunId !== runId ||
      (mode === 'forward' &&
        (previous.phase !== 'forward-authorized' || previous.forwardNoteId || previous.forwardAuthority)) ||
      (mode === 'reverse' &&
        (previous.phase !== 'forward-settled' ||
          previous.reverseNonce !== undefined ||
          previous.reverseAuthority ||
          previous.evmNonceBefore !== undefined ||
          previous.transactions?.length ||
          previous.consumeAuthority ||
          previous.returnMidenTxId))
    )
      throw new Error('Epoch requires unused original same-run authority; never renew uncertain funding');
    if (process.env.MAINNET_LOOP_RECOVERY_CLEARED !== 'true')
      throw new Error('The all-provider recovery barrier must clear before Epoch funding');
    const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR?.trim();
    const key = (process.env.E2E_MAINNET_EVM_KEY?.trim() ?? '').replace(/^0x/, '');
    if (
      !keyPair ||
      !/^[0-9a-f]{64}$/i.test(key) ||
      privateKeyToAccount(`0x${key}`).address.toLowerCase() !== previous.evm.account.toLowerCase()
    )
      throw new Error('Existing original Guardian and EVM keys are required before Epoch funding');
    await restoreMainnetLoopGuardian(walletB, keyPair);
    if ((await walletB.getAccountAddress()) !== previous.account) throw new Error('Original Epoch Guardian changed');
    const signal = AbortSignal.timeout(1_100_000);
    try {
      if (mode === 'forward')
        await runEpochForward(walletB, previous, STATE_PATH, runId, `${STATE_PATH}.forward`, signal);
      else await runEpochReverse(walletB, previous, STATE_PATH, runId, `0x${key}`, `${STATE_PATH}.reverse`, signal);
    } catch {
      throw new Error('Epoch stage blocked; retain original public authority and never retry uncertain submissions');
    }
    return;
  }
  if (previous && !['complete', 'unspent', 'cancelled'].includes(previous.phase))
    throw new Error('Cannot replace an unresolved Epoch authorization');
  if (previous?.sourceRunId === runId) throw new Error('Epoch authorization already exists for this run');
  const predecessor = loadMainnetSwapCheckpoint('test-results/mainnet-swap-state/roundtrip.json');
  const allowance = BigInt(process.env.MAINNET_LOOP_LOSS_BUDGET_USD_MICROS ?? '0');
  expect(allowance).toBe(1997018n);
  if (process.env.MAINNET_LOOP_RECOVERY_CLEARED !== 'true')
    throw new Error('The all-provider recovery barrier must clear before Epoch preparation');
  const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR?.trim();
  const rawEvmKey = (process.env.E2E_MAINNET_EVM_KEY?.trim() ?? '').replace(/^0x/, '');
  if (!keyPair || !/^[0-9a-f]{64}$/i.test(rawEvmKey))
    throw new Error('Existing funded mainnet account keys are required');
  const evm = privateKeyToAccount(`0x${rawEvmKey}`);
  await restoreMainnetLoopGuardian(walletB, keyPair);
  const account = await walletB.getAccountAddress();
  if (predecessor?.account !== account) throw new Error('Epoch and swap must use the same existing Guardian account');
  const response = await fetch(mainnetConfigSource(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Epoch qualification config is unavailable');
  const document = parseBridgeConfig(await response.json(), 'mainnet');
  const allocatorUrl = document?.['bridge-providers'].epoch?.allocatorUrl;
  if (!document || !allocatorUrl) throw new Error('No published mainnet Epoch provider');
  const setup = await loadMainnetOneClickSetup(fetch, fetch, walletB.extensionId);
  if (!setup) throw new Error('The owned nightly token/config overlay is required');
  const nativeFaucet = await walletDiscoveredNativeFaucetId(walletB.page);
  const baseFee = await walletDiscoveredBaseFee(walletB.page);
  if (!nativeFaucet || baseFee === null || baseFee < 1) throw new Error('Missing discovered native fee reserve');
  const nativeHex = canonicalMainnetLoopFaucet(nativeFaucet);
  const verifiedNative = setup.config.midenAssets.find(
    asset => canonicalMainnetLoopFaucet(asset.faucetId) === nativeHex
  );
  const nativeAsset = setup.assets.find(asset => asset.assetId === verifiedNative?.assetId);
  if (!verifiedNative || !nativeAsset || nativeAsset.symbol !== 'USDCX' || nativeAsset.decimals !== 6)
    throw new Error('Epoch requires the verified native USDCX/6 identity');
  const candidates = [42161, 1].flatMap(chainId => {
    const chain = Object.values(document.supportedEvmChains).find(value => value.chainId === chainId);
    const bridge = chain?.bridges.epoch;
    const token = bridge?.tokens.USDC;
    if (!bridge?.depositEnabled || !bridge.withdrawalEnabled || token?.midenSymbol !== 'USDCX') return [];
    return setup.assets.filter(
      asset =>
        asset.chainId === chainId &&
        asset.decimals === 6 &&
        asset.symbol === 'USDC' &&
        asset.contractAddress?.toLowerCase() === token.contractAddress.toLowerCase()
    );
  });
  if (!candidates.length) throw new Error('No exact published Epoch stablecoin binding');
  const priceId = mainnetOneClickPriceId(nativeAsset, verifiedNative);
  const prices = await fetchMainnetOneClickUsdPrices([
    ...new Set([priceId, 'ethereum', ...candidates.map(asset => mainnetOneClickPriceId(asset, verifiedNative))])
  ]);
  const nativePrice = prices.usdMicrosById[priceId];
  const ethPrice = prices.usdMicrosById.ethereum;
  if (!nativePrice || !ethPrice) throw new Error('Missing verified native or EVM gas price');
  const balance = await vaultBalanceByFaucetId(walletB.page, nativeFaucet);
  const feeBudget = BigInt(baseFee) * 30n * 6n;
  let selected: { state: MainnetEpochCheckpoint; cost: bigint } | undefined;
  for (const asset of candidates) {
    if (asset.chainId !== 1 && asset.chainId !== 42161) throw new Error('Unsupported Epoch chain');
    const holding = await readMainnetEvmHolding(asset, evm.address);
    const evmFeeBudget = holding.gasReserveWei * 5n;
    if (holding.nativeBalanceWei < evmFeeBudget) continue;
    const tokenPrice = prices.usdMicrosById[mainnetOneClickPriceId(asset, verifiedNative)];
    if (!tokenPrice || !asset.contractAddress || asset.contractAddress === 'native') continue;
    for (const usd of [1_000_000n, 2_000_000n, 5_000_000n]) {
      const principal = (usd * 1_000_000n + nativePrice - 1n) / nativePrice;
      if (principal + feeBudget > balance) continue;
      try {
        const state = await prepareEpochRoundTrip({
          account,
          accountHex: canonicalMainnetLoopFaucet(account),
          sourceRunId: runId,
          native: {
            faucetId: nativeFaucet,
            hex: nativeHex,
            symbol: 'USDCX',
            decimals: 6,
            balance: balance.toString(),
            usdMicros: nativePrice.toString()
          },
          evm: {
            chainId: asset.chainId,
            account: evm.address,
            token: asset.contractAddress,
            tokenBalance: holding.balanceBaseUnits.toString(),
            nativeBalance: holding.nativeBalanceWei.toString(),
            tokenUsdMicros: tokenPrice.toString(),
            nativeUsdMicros: ethPrice.toString()
          },
          allocatorUrl,
          principal: principal.toString(),
          reverseMinimum: ((principal * 98n) / 100n).toString(),
          lossBudgetUsdMicros: allowance.toString(),
          feeBudget: feeBudget.toString(),
          evmFeeBudget: evmFeeBudget.toString(),
          pricedAt: prices.fetchedAt,
          currentBlock: await readMainnetMidenBlock(getEnvironmentConfig().rpcUrl)
        });
        const cost = planEpochRoundTrip(state, BigInt(state.forwardMinimum)).worstCaseCostUsdMicros;
        if (!selected || cost < selected.cost) selected = { state, cost };
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/quote|proceeds|allowance|bound/i.test(error.message)) throw error;
      }
    }
  }
  if (!selected) throw new Error('No funded Epoch route has a real quote pair within the remaining shared allowance');
  const keys=['e2e_mainnet_send_authorization','e2e_mainnet_consume_authorization'];
  const policies=await walletB.page.evaluate(async names=>chrome.storage.local.get(names),keys);
  expect(keys.every(key=>policies[key]===undefined)).toBe(true);
  writeFileSync('test-results/epoch-readonly-preview.json',JSON.stringify({purpose:'independent read-only Epoch live two-way plan; candidate discarded, NOT accepted provider history',eligible:true,account:selected.state.account,chainId:selected.state.evm.chainId,principal:selected.state.principal,forwardMinimum:selected.state.forwardMinimum,reverseMinimum:selected.state.reverseMinimum,worstCaseCostUsdMicros:selected.cost.toString(),lossBudgetUsdMicros:allowance.toString(),noLivePolicy:true,grantPersisted:false,sdkAuthorityIssued:false}));
});
