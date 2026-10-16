import * as harness from './usdcx-constants';
import * as wallet from '../../../src/lib/usdcx/constant';

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

it('keeps the E2E payout floor equal to the configured wallet payout floor', () => {
  for (const chainId of harness.USDCX_DESTINATIONS.keys()) {
    for (const amount of [100_000n, 1_000_000n, 3_000_000n]) {
      expect(harness.minimumUsdcxPayout(chainId, amount)).toBe(wallet.minimumUsdcxPayout(chainId, amount));
    }
  }
});
