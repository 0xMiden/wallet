import type {
  OneClickAsset,
  OneClickConfig,
  OneClickQuoteRequest,
  OneClickQuoteResponse
} from '../../../src/lib/one-click/types';
import { canonicalMainnetLoopFaucet } from './mainnet-loop-config';
import { parseMainnetNearCheckpoint, type MainnetNearCheckpoint } from './mainnet-near-checkpoint';
import {
  chooseCheapestOneClickRoute,
  MAINNET_ONE_CLICK_DRY_PROBES_PER_CANDIDATE,
  MAINNET_ONE_CLICK_MAX_CANDIDATES,
  planOneClickRoundTrip,
  searchSmallestViableAmount,
  tokenValueUsdMicro
} from './mainnet-one-click-plan';
import type { MainnetEvmHolding } from './mainnet-one-click-evm';

export interface MainnetNearPlanningFacts {
  account: string;
  accountHex: string;
  evmAccount: string;
  sourceRunId: string;
  pricedAt: string;
  native: MainnetNearCheckpoint['native'];
  baseFee: bigint;
  lossBudgetUsdMicros: bigint;
  config: OneClickConfig;
  nativeAsset: OneClickAsset;
  candidates: { holding: MainnetEvmHolding; tokenUsdMicros: bigint; gasUsdMicros: bigint }[];
}
export async function prepareMainnetNearRoundTrip(
  facts: MainnetNearPlanningFacts,
  quote: (request: OneClickQuoteRequest) => Promise<OneClickQuoteResponse | undefined>
): Promise<MainnetNearCheckpoint> {
  if (
    !/^mm1[a-z0-9_]{20,150}$/.test(facts.account) ||
    !/^0x[0-9a-f]{30}$/.test(facts.accountHex) ||
    !/^0x[0-9a-fA-F]{40}$/.test(facts.evmAccount) ||
    /^0x0{40}$/.test(facts.evmAccount) ||
    !/^[1-9]\d{0,19}$/.test(facts.sourceRunId)
  )
    throw new Error('Native NEAR planning requires the original existing mainnet actors and source run');
  const age = Date.now() - Date.parse(facts.pricedAt);
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > 600_000 ||
    facts.baseFee <= 0n ||
    facts.lossBudgetUsdMicros <= 0n ||
    facts.lossBudgetUsdMicros > 2_000_000n
  )
    throw new Error('Native NEAR planning requires fresh original prices and a remaining shared allowance');
  const nativePrice = BigInt(facts.native.usdMicros);
  if (nativePrice <= 0n) throw new Error('Missing verified native USD price');
  const feeBudget = facts.baseFee * 30n * 2n;
  const nativeAsset = selectMainnetNearNativeAsset(
    [facts.nativeAsset],
    facts.native.hex,
    BigInt(facts.native.balance),
    feeBudget
  );
  const available = BigInt(facts.native.balance) - feeBudget;
  const usdMaximum = (10_000_000n * 1_000_000n) / nativePrice;
  const maximum = available < usdMaximum ? available : usdMaximum;
  const request = (
    originAsset: OneClickAsset,
    destinationAsset: OneClickAsset,
    amount: bigint,
    refundTo: string,
    recipient: string
  ): OneClickQuoteRequest => ({
    originAsset,
    destinationAsset,
    amount: amount.toString(),
    refundTo,
    recipient,
    slippageTolerance: 100,
    deadline: new Date(Date.now() + 300_000).toISOString()
  });
  const loss = (value: OneClickQuoteResponse, inputPrice: bigint, outputPrice: bigint): bigint => {
    const input = tokenValueUsdMicro(BigInt(value.quote.amountIn), 6, inputPrice, true);
    const output = tokenValueUsdMicro(BigInt(value.quote.minAmountOut), 6, outputPrice, false);
    if (value.quote.refundFee === undefined) throw new Error('Native NEAR quote lacks a bounded refund fee');
    return (
      (input > output ? input - output : 0n) +
      tokenValueUsdMicro(BigInt(value.quote.refundFee), 6, inputPrice, true) +
      tokenValueUsdMicro(BigInt(value.quote.withdrawFee ?? '0'), 6, outputPrice, true)
    );
  };
  const candidates: {
    state: MainnetNearCheckpoint;
    plan: ReturnType<typeof planOneClickRoundTrip>;
    chainPriority: number;
  }[] = [];
  for (const candidate of facts.candidates.slice(0, MAINNET_ONE_CLICK_MAX_CANDIDATES)) {
    const { holding, tokenUsdMicros, gasUsdMicros } = candidate;
    const asset = holding.asset;
    if (
      (asset.chainId !== 1 && asset.chainId !== 42161) ||
      asset.blockchain !== (asset.chainId === 1 ? 'eth' : 'arb') ||
      asset.decimals !== 6 ||
      !/^(USDC|USDT|USDT0)$/i.test(asset.symbol) ||
      !asset.contractAddress ||
      asset.contractAddress === 'native' ||
      tokenUsdMicros <= 0n ||
      gasUsdMicros <= 0n ||
      holding.gasReserveWei <= 0n ||
      holding.nativeBalanceWei < holding.gasReserveWei * 2n
    )
      continue;
    const nativeFees = tokenValueUsdMicro(feeBudget, 6, nativePrice, true);
    const gasFees = tokenValueUsdMicro(holding.gasReserveWei, 18, gasUsdMicros, true);
    let found: {
      amount: bigint;
      quote: {
        forward: OneClickQuoteResponse;
        reverse: OneClickQuoteResponse;
        plan: ReturnType<typeof planOneClickRoundTrip>;
      };
    };
    try {
      found = await searchSmallestViableAmount({
        firstAmount: 1n,
        maximumAmount: maximum,
        attempts: MAINNET_ONE_CLICK_DRY_PROBES_PER_CANDIDATE,
        quote: async amount => {
          const forward = await quote(request(nativeAsset, asset, amount, facts.account, facts.evmAccount));
          if (!forward || BigInt(forward.quote.minAmountOut) <= 0n) return undefined;
          const reverse = await quote(
            request(asset, nativeAsset, BigInt(forward.quote.minAmountOut), facts.evmAccount, facts.account)
          );
          if (!reverse || BigInt(reverse.quote.minAmountOut) <= 0n) return undefined;
          const providerFees = loss(forward, nativePrice, tokenUsdMicros) + loss(reverse, tokenUsdMicros, nativePrice);
          if (providerFees + nativeFees + gasFees > facts.lossBudgetUsdMicros) return undefined;
          const plan = planOneClickRoundTrip({
            routeId: asset.assetId,
            symbol: nativeAsset.symbol,
            amountBaseUnits: amount,
            availableBaseUnits: available,
            providerFeesUsdMicros: providerFees,
            forward: { inputUsdMicros: 0n, minimumOutputUsdMicros: 0n, nativeFeeUsdMicros: nativeFees },
            reverse: { inputUsdMicros: 0n, minimumOutputUsdMicros: 0n, nativeFeeUsdMicros: gasFees }
          });
          return { forward, reverse, plan };
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('No viable 1Click quote found')) continue;
      throw error;
    }
    const now = new Date().toISOString();
    const state = parseMainnetNearCheckpoint({
      version: 2,
      network: 'mainnet',
      account: facts.account,
      accountHex: facts.accountHex,
      sourceRunId: facts.sourceRunId,
      authorizationRunId: facts.sourceRunId,
      phase: 'forward-authorized',
      createdAt: now,
      updatedAt: now,
      pricedAt: facts.pricedAt,
      native: { ...facts.native },
      nativeAssetId: nativeAsset.assetId,
      evmAssetId: asset.assetId,
      evm: {
        chainId: asset.chainId,
        account: facts.evmAccount,
        token: asset.contractAddress,
        tokenBalance: holding.balanceBaseUnits.toString(),
        nativeBalance: holding.nativeBalanceWei.toString(),
        tokenUsdMicros: tokenUsdMicros.toString(),
        nativeUsdMicros: gasUsdMicros.toString()
      },
      serviceUrl: facts.config.serviceUrl,
      appFees: (facts.config.appFees ?? []).map(fee => ({ ...fee })),
      ...(facts.config.feePolicy ? { feePolicy: { ...facts.config.feePolicy } } : {}),
      baseFee: facts.baseFee.toString(),
      principal: found.amount.toString(),
      forwardMinimum: found.quote.forward.quote.minAmountOut,
      reverseMinimum: found.quote.reverse.quote.minAmountOut,
      lossBudgetUsdMicros: facts.lossBudgetUsdMicros.toString(),
      feeBudget: feeBudget.toString(),
      evmFeeBudget: holding.gasReserveWei.toString(),
      paidMidenFees: '0',
      paidEvmFees: '0'
    });
    candidates.push({ state, plan: found.quote.plan, chainPriority: asset.chainId === 42161 ? 0 : 1 });
  }
  const selected = chooseCheapestOneClickRoute(candidates);
  if (!selected) throw new Error('No existing funded native NEAR route fits the remaining shared allowance');
  return selected.state;
}

export function selectMainnetNearNativeAsset(
  assets: readonly OneClickAsset[],
  nativeFaucetHex: string,
  balance: bigint,
  feeReserve: bigint
): OneClickAsset {
  if (
    nativeFaucetHex !== '0xe69e6ca6e39df1b10c1e5399399feb' ||
    typeof balance !== 'bigint' ||
    typeof feeReserve !== 'bigint' ||
    feeReserve <= 0n ||
    balance <= feeReserve
  )
    throw new Error('Existing native NEAR principal or fee reserve is unavailable');
  const matches = assets.filter(
    asset => asset.blockchain === 'miden' && asset.assetId === `nep141:miden-${nativeFaucetHex}.omft.near`
  );
  const asset = matches[0];
  if (
    matches.length !== 1 ||
    !asset?.faucetId ||
    asset.decimals !== 6 ||
    asset.symbol.toUpperCase() !== 'USDCX' ||
    canonicalMainnetLoopFaucet(asset.faucetId) !== nativeFaucetHex
  )
    throw new Error('Exact native NEAR catalog binding is missing or ambiguous');
  return asset;
}
