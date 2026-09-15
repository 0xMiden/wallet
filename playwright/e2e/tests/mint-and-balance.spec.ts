import { test } from '../fixtures/two-wallets';
import { offChainAxis, runMintAndBalanceJourney } from '../helpers/money-path';

test.describe('Faucet Minting and Balance', () => {
  test.describe.configure({ mode: 'serial' });

  test('deploy faucet and mint tokens to both wallets', async ({ walletA, walletB, midenCli, steps, timeline }) => {
    await runMintAndBalanceJourney({ walletA, walletB, midenCli, steps, timeline, axis: offChainAxis });
  });
});
