import { JOURNEY_TIMEOUT_MS, journeyTitle } from '../../helpers/dapp-matrix';
import { mobileDappAxes } from '../../helpers/dapp-mobile-axis';
import { mobileCells } from '../../helpers/dapp-mobile-cells';
import { androidDevice } from '../../helpers/dapp-mobile-device';
import { runMobileJourneyCells, startMobileJourney } from '../../helpers/dapp-mobile-journey';
import { test } from '../fixtures/two-emulators';

/**
 * The test dApp in the Android in-app browser (spec section 3, PL1), one test per account kind. Selected by
 * playwright.android.dapp-e2e.config.ts; e2e-dapp.yml's dapp-e2e-android job runs one account kind per leg by title.
 */
for (const axis of mobileDappAxes()) {
  test(
    journeyTitle('PL', axis.label, 'android'),
    async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
      test.setTimeout(JOURNEY_TIMEOUT_MS.PL);
      const j = await startMobileJourney({
        surface: 'android',
        axis,
        walletA,
        walletB,
        midenCli,
        envConfig,
        steps,
        testInfo,
        device: androidDevice([walletA.serial, walletB.serial])
      });
      await runMobileJourneyCells(j, mobileCells(j));
    }
  );
}
