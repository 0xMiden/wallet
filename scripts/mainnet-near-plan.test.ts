/** @jest-environment node */
import type { OneClickAsset, OneClickQuoteRequest, OneClickQuoteResponse } from '../src/lib/one-click/types';
import {
  prepareMainnetNearRoundTrip,
  selectMainnetNearNativeAsset,
  type MainnetNearPlanningFacts
} from '../playwright/e2e/helpers/mainnet-near-plan';
import { nativeNearFixture } from './helpers/mainnet-near-fixture';
import type { MainnetEvmHolding } from '../playwright/e2e/helpers/mainnet-one-click-evm';
jest.mock('@miden-sdk/miden-sdk', () => ({
  Address: {
    fromBech32: (value: string) => {
      if (value !== 'mm1arnfum9xuwwlrvgvrefejwvlavn3vk24') throw new Error('Invalid unit native address');
      return { accountId: () => ({ toString: () => '0xe69e6ca6e39df1b10c1e5399399feb' }) };
    }
  }
}));
const native = '0xe69e6ca6e39df1b10c1e5399399feb';
const asset: OneClickAsset = {
  assetId: `nep141:miden-${native}.omft.near`,
  blockchain: 'miden',
  symbol: 'USDCx',
  decimals: 6,
  faucetId: native,
  coingeckoId: 'usdcx'
};
const unrelated: OneClickAsset = {
  ...asset,
  assetId: 'nep141:miden-0x111111111111111111111111111111.omft.near',
  faucetId: '0x111111111111111111111111111111',
  symbol: 'OTHER'
};
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-12T12:00:01.000Z'));
});
afterEach(() => {
  jest.useRealTimers();
});
function planningFixture() {
  const saved = nativeNearFixture();
  const unused = async () => {
    throw new Error('Planning must use already-read holdings, never execute a chain action');
  };
  const holding: MainnetEvmHolding = {
    asset: {
      assetId: saved.evmAssetId,
      blockchain: 'arb',
      chainId: 42161,
      contractAddress: saved.evm.token,
      symbol: 'USDC',
      decimals: 6,
      coingeckoId: 'usd-coin'
    },
    balanceBaseUnits: 3000000n,
    nativeBalanceWei: 10000000000000000n,
    gasPriceWei: 500000n,
    gasReserveWei: 1000000000000n,
    client: {
      estimateGas: unused,
      estimateFeesPerGas: unused,
      getBalance: unused,
      readTokenBalance: unused,
      waitForTransactionReceipt: unused
    }
  };
  const facts: MainnetNearPlanningFacts = {
    account: saved.account,
    accountHex: saved.accountHex,
    evmAccount: saved.evm.account,
    sourceRunId: saved.sourceRunId,
    pricedAt: saved.pricedAt,
    native: saved.native,
    baseFee: 7n,
    lossBudgetUsdMicros: 1999095n,
    nativeAsset: asset,
    config: {
      serviceUrl: saved.serviceUrl,
      appFees: saved.appFees,
      feePolicy: saved.feePolicy,
      midenAssets: [{ assetId: asset.assetId, faucetId: native, symbol: 'USDCX', decimals: 6 }]
    },
    candidates: [{ holding, tokenUsdMicros: 1000000n, gasUsdMicros: 2000000000n }]
  };
  const quote = jest.fn(async (request: OneClickQuoteRequest): Promise<OneClickQuoteResponse | undefined> => {
    if (BigInt(request.amount) < 1000000n) return undefined;
    const minimum =
      request.originAsset.blockchain === 'miden' ? request.amount : (BigInt(request.amount) - 1000n).toString();
    return {
      correlationId: 'read-only-sdk-boundary-fixture',
      timestamp: new Date().toISOString(),
      signature: 'unit-validated-sdk-boundary',
      quoteRequest: {
        dry: true,
        swapType: 'EXACT_INPUT',
        amount: request.amount,
        originAsset: request.originAsset.assetId,
        destinationAsset: request.destinationAsset.assetId,
        refundTo: request.refundTo,
        recipient: request.recipient,
        depositType: 'ORIGIN_CHAIN',
        refundType: 'ORIGIN_CHAIN',
        recipientType: 'DESTINATION_CHAIN',
        deadline: request.deadline,
        slippageTolerance: request.slippageTolerance
      },
      quote: {
        amountIn: request.amount,
        minAmountIn: request.amount,
        amountOut: minimum,
        minAmountOut: minimum,
        amountInFormatted: '1',
        amountOutFormatted: '0.999',
        amountInUsd: '1',
        amountOutUsd: '0.999',
        deadline: request.deadline,
        timeEstimate: 24,
        refundFee: '100',
        withdrawFee: '10'
      }
    };
  });
  return { facts, holding, quote };
}
it('builds a bounded native checkpoint from real quote-boundary results without changing the original shared budget or actors', async () => {
  const f = planningFixture();
  const state = await prepareMainnetNearRoundTrip(f.facts, f.quote);
  expect(state).toMatchObject({
    version: 2,
    phase: 'forward-authorized',
    account: f.facts.account,
    sourceRunId: '100',
    authorizationRunId: '100',
    native: f.facts.native,
    principal: '1000000',
    forwardMinimum: '1000000',
    reverseMinimum: '999000',
    lossBudgetUsdMicros: '1999095',
    paidMidenFees: '0',
    paidEvmFees: '0'
  });
  expect(state.forwardQuote).toBeUndefined();
  expect(state.sendAuthority).toBeUndefined();
});
it('refuses a requested route whose conservative quote/fee pair exceeds the actual remaining shared allowance', async () => {
  const f = planningFixture();
  f.facts.lossBudgetUsdMicros = 3000n;
  await expect(prepareMainnetNearRoundTrip(f.facts, f.quote)).rejects.toThrow();
});
it('keeps USDT0 proceeds under their own source price rather than substituting the native USD Coin identity', async () => {
  const f = planningFixture();
  f.holding.asset = {
    ...f.holding.asset,
    symbol: 'USDT0',
    coingeckoId: 'usdt0',
    contractAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    assetId: 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near'
  };
  const candidate = f.facts.candidates[0];
  if (!candidate) throw new Error('Missing unit candidate');
  candidate.tokenUsdMicros = 500000n;
  const state = await prepareMainnetNearRoundTrip(f.facts, f.quote);
  expect(state.evm.tokenUsdMicros).toBe('500000');
  expect(state.native.usdMicros).toBe('1000000');
  expect(state.evmAssetId).toBe(f.holding.asset.assetId);
});
it('searches another supported funded chain instead of spending from an unfunded preferred route', async () => {
  const f = planningFixture();
  f.holding.nativeBalanceWei = 0n;
  f.facts.candidates.push({
    holding: {
      ...f.holding,
      nativeBalanceWei: 10000000000000000n,
      asset: {
        ...f.holding.asset,
        blockchain: 'eth',
        chainId: 1,
        contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'
      }
    },
    tokenUsdMicros: 1000000n,
    gasUsdMicros: 2000000000n
  });
  const state = await prepareMainnetNearRoundTrip(f.facts, f.quote);
  expect(state.evm.chainId).toBe(1);
});
it('fails requested coverage when no existing EVM gas holding can fund a bounded return', async () => {
  const f = planningFixture();
  f.holding.nativeBalanceWei = 0n;
  await expect(prepareMainnetNearRoundTrip(f.facts, f.quote)).rejects.toThrow();
  expect(f.quote.mock.calls.length).toBe(0);
});
it('selects the actual funded native binding rather than the first listed Miden asset', () => {
  expect(selectMainnetNearNativeAsset([unrelated, asset], native, 20000000n, 420n)).toEqual(asset);
  const encoded = { ...asset, faucetId: 'mm1arnfum9xuwwlrvgvrefejwvlavn3vk24_qr7qqq9wr6w' };
  expect(selectMainnetNearNativeAsset([unrelated, encoded], native, 20000000n, 420n)).toEqual(encoded);
});
it('refuses a catalog without the exact native identity rather than falling back to an unfunded first asset', () => {
  expect(() => selectMainnetNearNativeAsset([unrelated], native, 20000000n, 420n)).toThrow();
});
it('refuses duplicate eligible native bindings', () => {
  expect(() => selectMainnetNearNativeAsset([asset, { ...asset }], native, 20000000n, 420n)).toThrow();
});
it('rejects a different faucet even with a copied native asset ID and ticker', () => {
  expect(() =>
    selectMainnetNearNativeAsset([{ ...asset, faucetId: unrelated.faucetId }], native, 20000000n, 420n)
  ).toThrow();
});
it('refuses an unavailable existing principal instead of counting reserved gas as spendable funding', () => {
  expect(() => selectMainnetNearNativeAsset([asset], native, 420n, 420n)).toThrow();
});
it('does not silently trust different native decimals', () => {
  expect(() => selectMainnetNearNativeAsset([{ ...asset, decimals: 18 }], native, 20000000n, 420n)).toThrow();
});
it('does not authorize negative balance or fee facts', () => {
  expect(() => selectMainnetNearNativeAsset([asset], native, -1n, 420n)).toThrow();
  expect(() => selectMainnetNearNativeAsset([asset], native, 20000000n, -1n)).toThrow();
});
