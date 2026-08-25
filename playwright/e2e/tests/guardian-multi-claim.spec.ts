import { getEnvironmentConfig } from '../config/environments';
import { test } from '../fixtures/two-wallets';
import { guardianAxis, runMultiNoteClaimJourney } from '../helpers/money-path';

// Same journey as multi-claim.spec.ts, on the account type production actually
// creates. `ChooseGuardian.handleContinue` always emits an operator endpoint, so
// every real user's notes are consumed through a CO-SIGNED transaction — a path
// the offchain leg never exercises.
const MINTS = [50_000_000_000n, 30_000_000_000n, 20_000_000_000n] as const;

test.describe('Multi-Note Claiming - guardian account', () => {
  test.describe.configure({ mode: 'serial' });

  test('mint three notes to a guardian account and claim them all', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    // Guardian co-signing adds a round trip per transaction, and this journey
    // claims three notes on top of two account creations.
    test.setTimeout(600_000);

    await runMultiNoteClaimJourney(
      { walletA, walletB, midenCli, steps, timeline, axis: guardianAxis(getEnvironmentConfig().guardianUrl) },
      MINTS
    );
  });
});
