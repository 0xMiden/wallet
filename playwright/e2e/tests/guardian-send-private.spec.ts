import { getEnvironmentConfig } from '../config/environments';
import { test } from '../fixtures/two-wallets';
import { guardianAxis, runPrivateSendJourney } from '../helpers/money-path';

// Private send on a guardian account: the note-transport delivery path AND
// guardian co-signing in the same transaction. `guardian-send-consume.spec.ts`
// already covers a PUBLIC guardian send; private notes take a different
// delivery route, which is where silent non-delivery has bitten before
// (the block-hint overshoot fixed in wallet #502).
const MINT_BASE_UNITS = 100_000_000_000n; // 1000 TST
const SEND_AMOUNT = '500';

test.describe('Private Note Send - guardian account', () => {
  test.describe.configure({ mode: 'serial' });

  test('guardian wallet A sends privately to guardian wallet B', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    // Two guardian creations, a claim and a co-signed send.
    test.setTimeout(600_000);

    await runPrivateSendJourney(
      { walletA, walletB, midenCli, steps, timeline, axis: guardianAxis(getEnvironmentConfig().guardianUrl) },
      { mintBaseUnits: MINT_BASE_UNITS, sendAmount: SEND_AMOUNT }
    );
  });
});
