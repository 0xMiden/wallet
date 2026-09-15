import { getEnvironmentConfig } from '../config/environments';
import { test } from '../fixtures/two-wallets';
import { guardianAxis, runMultiAccountJourney } from '../helpers/money-path';

test.describe('Multi-Account Operations - guardian account', () => {
  test.describe.configure({ mode: 'serial' });

  test('create second account and verify independent balances', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    test.setTimeout(600_000);
    await runMultiAccountJourney({
      walletA,
      walletB,
      midenCli,
      steps,
      timeline,
      axis: guardianAxis(getEnvironmentConfig().guardianUrl)
    });
  });
});
