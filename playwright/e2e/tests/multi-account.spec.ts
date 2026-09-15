import { test } from '../fixtures/two-wallets';
import { offChainAxis, runMultiAccountJourney } from '../helpers/money-path';

test.describe('Multi-Account Operations', () => {
  test.describe.configure({ mode: 'serial' });

  test('create second account and verify independent balances', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    await runMultiAccountJourney({ walletA, walletB, midenCli, steps, timeline, axis: offChainAxis });
  });
});
