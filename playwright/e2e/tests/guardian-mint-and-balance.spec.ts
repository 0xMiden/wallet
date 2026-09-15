import { getEnvironmentConfig } from '../config/environments';
import { test } from '../fixtures/two-wallets';
import { guardianAxis, runMintAndBalanceJourney } from '../helpers/money-path';

test.describe('Faucet Minting and Balance - guardian account', () => {
  test.describe.configure({ mode: 'serial' });

  test('deploy faucet and mint tokens to both guardian wallets', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    test.setTimeout(600_000);
    await runMintAndBalanceJourney({
      walletA,
      walletB,
      midenCli,
      steps,
      timeline,
      axis: guardianAxis(getEnvironmentConfig().guardianUrl)
    });
  });
});
