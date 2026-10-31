import * as fs from 'fs/promises';
import * as path from 'path';

import { expect } from '@playwright/test';

import { DappBrowserDriver } from '../../harness/dapp-browser-driver';
import { startDappFixtureServer, type DappFixtureServer } from '../../harness/dapp-fixture-server';
import {
  captureFrameTimeline,
  markFrameTimeline,
  nativeTap,
  readWebViewScreenBounds
} from '../helpers/native-presentation-trace';
import {
  cssRectCenterToScreen,
  type CssRect,
  type ScreenPoint,
  type ScreenRect
} from '../helpers/native-presentation-coordinates';
import { test } from '../fixtures/two-emulators';

const FRAME_TIMELINE_CAPTURE = process.env.E2E_FRAME_TIMELINE_CAPTURE === '1';
const VARIANT = process.env.PRESENTATION_VARIANT ?? 'single';

test.describe('dApp Browser native presentation (Android)', () => {
  test.describe.configure({ mode: 'serial' });

  let server: DappFixtureServer;

  test.beforeAll(async () => {
    server = await startDappFixtureServer({ deviceHost: '10.0.2.2' });
  });

  test.afterAll(async () => {
    await server?.stop();
  });

  test('native tap expands a minimized dApp and records FrameTimeline', async ({ walletA, steps }, testInfo) => {
    await steps.step('create_wallet', async () => {
      await walletA.createNewWallet();
    });

    const driver = new DappBrowserDriver({
      target: walletA,
      server,
      artifactDir: path.join(steps.outputDir, 'screens'),
      label: `android-${VARIANT}`
    });
    await driver.gotoBrowserTab();
    await driver.openViaUrlBar('alpha');
    await driver.expectDappPainted('alpha', 'native-presentation-initial');
    await driver.minimize();

    const trials: Array<{
      index: number;
      cssRect: CssRect;
      devicePixelRatio: number;
      webViewBounds: ScreenRect;
      tap: ScreenPoint;
    }> = [];
    const exercise = async (): Promise<void> => {
      for (let index = 1; index <= 5; index += 1) {
        await driver.waitForMotionIdle();
        const card = (await driver.peekCards()).find(candidate => candidate.url === server.urlFor('alpha'));
        if (!card) throw new Error(`alpha peek card should be present for trial ${index}`);
        const devicePixelRatio = await walletA.evalJs<number>('return window.devicePixelRatio || 1;');
        const webViewBounds = await readWebViewScreenBounds(walletA.serial, walletA.packageName);
        const tap = cssRectCenterToScreen(card.rect, webViewBounds, devicePixelRatio);

        if (FRAME_TIMELINE_CAPTURE) await markFrameTimeline(walletA.serial, `trial-${index}-start`);
        await nativeTap(walletA.serial, tap);
        await driver.waitForForeground('alpha');
        await driver.waitForMotionIdle();
        await driver.expectDappPainted('alpha', `native-presentation-${VARIANT}-${index}`);
        await driver.expectFreshFrame('alpha', `native-presentation-fresh-${VARIANT}-${index}`);
        await walletA.delay(300);
        if (FRAME_TIMELINE_CAPTURE) await markFrameTimeline(walletA.serial, `trial-${index}-end`);

        trials.push({ index, cssRect: card.rect, devicePixelRatio, webViewBounds, tap });
        await driver.minimize();
      }
    };

    if (FRAME_TIMELINE_CAPTURE) {
      await captureFrameTimeline(walletA.serial, testInfo.outputPath(`frame-timeline-${VARIANT}.pftrace`), exercise);
    } else {
      await exercise();
    }

    await fs.writeFile(
      testInfo.outputPath(`native-presentation-${VARIANT}.json`),
      `${JSON.stringify(
        {
          variant: VARIANT,
          sourceSha: process.env.PRESENTATION_SOURCE_SHA ?? process.env.GITHUB_SHA ?? 'local',
          packageName: walletA.packageName,
          trials
        },
        null,
        2
      )}\n`
    );
  });
});
