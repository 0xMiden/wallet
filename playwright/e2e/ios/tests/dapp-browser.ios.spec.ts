/**
 * dApp browser — iOS.
 *
 * The flow lives in `harness/dapp-browser-scenario.ts` and is shared verbatim
 * with the Android spec; this file only supplies the iOS transport (simulator
 * page object) and the host address the simulator uses to reach the fixture
 * server. Keeping the spec this thin is deliberate — the moment the two
 * platforms have their own copies of the journey, one of them stops being
 * maintained.
 *
 * The iOS Simulator shares the host's network stack, so `127.0.0.1` on the
 * device is this machine.
 */

import * as path from 'path';

import { DappBrowserDriver } from '../../harness/dapp-browser-driver';
import { runDappBrowserJourney } from '../../harness/dapp-browser-scenario';
import { startDappFixtureServer, type DappFixtureServer } from '../../harness/dapp-fixture-server';
import { test } from '../fixtures/two-simulators';

test.describe('dApp Browser (iOS)', () => {
  test.describe.configure({ mode: 'serial' });

  let server: DappFixtureServer;

  test.beforeAll(async () => {
    server = await startDappFixtureServer({ deviceHost: '127.0.0.1' });
  });

  test.afterAll(async () => {
    await server?.stop();
  });

  test('open, minimize, maximize, switch and close dApps', async ({ walletA, steps }) => {
    // A wallet has to exist before the browser tab is reachable — the peek tray
    // is gated on the unlocked wallet shell.
    await steps.step('create_wallet', async () => {
      await walletA.createNewWallet();
    });

    const driver = new DappBrowserDriver({
      target: walletA,
      server,
      artifactDir: path.join(steps.outputDir, 'screens'),
      label: 'ios'
    });

    await runDappBrowserJourney({ driver, server, steps });
  });
});
