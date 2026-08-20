/**
 * dApp browser — Android.
 *
 * Mirror of the iOS spec: the journey itself is shared
 * (`harness/dapp-browser-scenario.ts`) and only the transport and host address
 * differ. Android is the surface with the thinner E2E net — it had one spec
 * before this — and the dApp browser is one of the places the two platforms
 * genuinely diverge (different WebView, different window/overlay model), so
 * running the identical journey on both is the point.
 *
 * `10.0.2.2` is the emulator's alias for the host loopback; `127.0.0.1` inside
 * the emulator would be the emulator itself.
 */

import * as path from 'path';

import { DappBrowserDriver } from '../../harness/dapp-browser-driver';
import { runDappBrowserJourney } from '../../harness/dapp-browser-scenario';
import { startDappFixtureServer, type DappFixtureServer } from '../../harness/dapp-fixture-server';
import { test } from '../fixtures/two-emulators';

test.describe('dApp Browser (Android)', () => {
  test.describe.configure({ mode: 'serial' });

  let server: DappFixtureServer;

  test.beforeAll(async () => {
    server = await startDappFixtureServer({ deviceHost: '10.0.2.2' });
  });

  test.afterAll(async () => {
    await server?.stop();
  });

  test('open, minimize, maximize, switch and close dApps', async ({ walletA, steps }) => {
    await steps.step('create_wallet', async () => {
      await walletA.createNewWallet();
    });

    const driver = new DappBrowserDriver({
      target: walletA,
      server,
      artifactDir: path.join(steps.outputDir, 'screens'),
      label: 'android'
    });

    await runDappBrowserJourney({ driver, server, steps });
  });
});
