import { test } from '../../fixtures/two-wallets';
import { runMainnetNearStage } from '../../helpers/mainnet-near-runtime';

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', retries: 0, timeout: 1_200_000 });
test.skip(
  process.env.MAINNET_NEAR_MODE === undefined && process.env.MAINNET_ONE_CLICK_MODE === undefined,
  'NEAR is selected only by the staged nightly workflow'
);

test('mainnet NEAR staged round trip', async ({ walletB }) => {
  if (process.env.MAINNET_NEAR_MODE === undefined)
    throw new Error(
      'Legacy 1Click v1 execution is read-only; retain its original checkpoint for recovery review, never reinterpret it as native NEAR v2'
    );
  await runMainnetNearStage(walletB, process.env.MAINNET_NEAR_MODE);
});
