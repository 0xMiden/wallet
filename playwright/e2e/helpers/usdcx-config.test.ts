import * as harness from './usdcx-constants';
import * as wallet from '../../../src/lib/usdcx/constant';
import { usdcxMinimumBurnShortfall } from '../../../src/lib/usdcx/withdrawal';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

it('keeps the E2E burn protocol values equal to the wallet values', () => {
  expect(harness.USDCX_BURN_TAG).toBe(wallet.USDCX_BURN_TAG);
  expect(harness.USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME).toBe(wallet.USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME);
  expect(harness.USDCX_DECIMALS).toBe(wallet.USDCX_DECIMALS);
});

it.each([harness.ARC_PAYOUT, ...harness.L2_BRIDGE_IN_SOURCES.map(source => source.payout)])(
  'allows the live burn amount through the wallet minimum check on $networkName',
  chain => {
    expect(usdcxMinimumBurnShortfall(chain.burnUnits)).toBeUndefined();
  }
);

it('keeps the E2E payout floor equal to the configured wallet payout floor', () => {
  for (const chainId of harness.USDCX_DESTINATIONS.keys()) {
    for (const amount of [100_000n, 1_000_000n, 3_000_000n]) {
      expect(harness.minimumUsdcxPayout(chainId, amount)).toBe(wallet.minimumUsdcxPayout(chainId, amount));
    }
  }
});

it.each([84532, 421614, 11155111])(
  'reads the executor route of chain %i from the fixture as the wallet reads it',
  chainId => {
    const harnessRoute = harness.L2_BRIDGE_IN_SOURCES.find(l2 => l2.payout.chainId === chainId)?.source;
    const walletRoute = wallet.getUsdcxExecutorSource(chainId);
    const comparable = (route: typeof walletRoute | undefined) =>
      route && {
        route: route.route,
        chainId: route.chain.id,
        usdc: route.usdc,
        domain: route.domain,
        midenDomain: route.midenDomain,
        tokenMessengerWithFees: route.tokenMessengerWithFees,
        irisApi: route.irisApi,
        target: { ...route.target, chain: route.target.chain.id }
      };
    expect(comparable(harnessRoute)).toEqual(comparable(walletRoute));
  }
);

it('lists Base Sepolia, Arbitrum Sepolia, then Ethereum Sepolia, each read where usdcx-burn-l2 reads it', () => {
  expect(harness.L2_BRIDGE_IN_SOURCES.map(l2 => l2.payout)).toEqual([
    harness.BASE_SEPOLIA_PAYOUT,
    harness.ARBITRUM_SEPOLIA_PAYOUT,
    harness.ETHEREUM_SEPOLIA_PAYOUT
  ]);
});
