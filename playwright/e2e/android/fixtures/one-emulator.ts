import * as path from 'path';

import {
  buildAndroidSnapshotCaps,
  launchEmuWalletInstance,
  test as twoEmulatorTest,
  type TwoEmulatorFixtures
} from './two-emulators';
import { startScreenPoll } from '../../harness/screen-capture';
import { EmulatorControl } from '../helpers/emulator-control';

/** Single-wallet Android fixture for routes whose counterparty runs on the host. */
export const test = twoEmulatorTest.extend<TwoEmulatorFixtures>({
  _emuPair: async ({ envConfig, timeline, steps }, use) => {
    const serial = await EmulatorControl.reserveSingle();
    const emulator = new EmulatorControl();
    const instanceA = await launchEmuWalletInstance(emulator, serial, envConfig, timeline, 'A', 9230);
    steps.registerSnapshotCaps('A', buildAndroidSnapshotCaps(instanceA.walletPage, ''));

    const screenPoll = startScreenPoll({
      intervalMs: 250,
      read: () =>
        instanceA.walletPage.evaluate(() =>
          document.body && document.body.innerText.trim().length > 0
            ? ((window as unknown as { __TEST_SCREEN__?: { key: string; seq: number } }).__TEST_SCREEN__ ?? null)
            : null
        ),
      grab: screenshotPath => instanceA.walletPage.screenshot({ path: screenshotPath }),
      dir: path.join(steps.outputDir, 'screens'),
      label: 'A'
    });

    await use({ instanceA, emuA: emulator });

    screenPoll.stop();
    await instanceA.cdp.close().catch(() => undefined);
    await emulator.terminate(serial, 'com.miden.wallet').catch(() => undefined);
  }
});
