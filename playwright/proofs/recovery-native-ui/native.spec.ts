import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CdpBridge as IosCdp } from '../../e2e/ios/helpers/cdp-bridge';
import { SimulatorControl } from '../../e2e/ios/helpers/simulator-control';
import { CdpBridge as AndroidCdp } from '../../e2e/android/helpers/cdp-bridge';
import { EmulatorControl } from '../../e2e/android/helpers/emulator-control';

const exec = promisify(execFile);
const platform = process.env.NATIVE_UI_PLATFORM;
const device = process.env.NATIVE_UI_DEVICE;
const output = process.env.NATIVE_UI_SCREENSHOTS;

test('synthetic recovery controls respond to native taps in both themes', async () => {
  if (!device || !output || (platform !== 'ios' && platform !== 'android')) throw new Error('Missing CI device setup');
  await mkdir(output, { recursive: true });
  const ios = platform === 'ios';
  const session = ios
    ? await IosCdp.connect({ udid: device, bundleId: 'com.miden.bread' })
    : await AndroidCdp.connect({ serial: device, packageName: 'com.miden.wallet', hostPort: 19222 });
  const simulator = new SimulatorControl();
  const emulator = new EmulatorControl();
  try {
    await expect.poll(() => session.eval<boolean>('return !!window.__TEST_STORE__;'), { timeout: 60_000 }).toBe(true);
    for (const theme of ['light', 'dark']) {
      await session.eval(`
        var s = window.__TEST_STORE__;
        document.documentElement.classList.toggle('dark', ${theme === 'dark'});
        s.setState({ status: 2, storageAvailability: {status:'unavailable',epoch:${theme === 'dark' ? 101 : 100},reason:'continuity',backend:'wallet',operation:'validate',time:0}, recoverWalletStorage: async function() { throw new Error('synthetic failure'); } });
        location.hash = '#/storage-recovery';
        return true;
      `);
      await expect.poll(() => session.eval<boolean>("return !!document.querySelector('[data-testid=storage-recovery-page]');"), { timeout: 30_000 }).toBe(true);
      const tap = async (label: string) => {
        const point = await session.eval<{ x: number; y: number; width: number; height: number } | null>(`
          var b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').trim() === ${JSON.stringify(label)});
          if (!b) return null;
          var r = b.getBoundingClientRect();
          return {x:r.left+r.width/2,y:r.top+r.height/2,width:innerWidth,height:innerHeight};
        `);
        if (!point || point.x < 0 || point.y < 0 || point.x >= point.width || point.y >= point.height) throw new Error('Tap target outside viewport');
        if (ios) await exec('idb', ['ui', 'tap', '--udid', device, String(point.x), String(point.y)], { timeout: 30_000 });
        else {
          const { stdout } = await exec('adb', ['-s', device, 'shell', 'wm', 'size'], { timeout: 30_000 });
          const size = stdout.match(/(\d+)x(\d+)/);
          if (!size) throw new Error('Missing emulator screen size');
          await exec('adb', ['-s', device, 'shell', 'input', 'tap', String(Math.round(point.x * Number(size[1]) / point.width)), String(Math.round(point.y * Number(size[2]) / point.height))], { timeout: 30_000 });
        }
      };
      const screenshot = async (name: string) => {
        const path = join(output, `${platform}-${theme}-${name}.png`);
        if (ios) await simulator.screenshot(device, path); else await emulator.screenshot(device, path);
      };
      await screenshot('recovery');
      await tap('Check storage');
      await expect.poll(() => session.eval<boolean>("return document.body.textContent.includes('The check could not finish. Wallet actions remain paused.');"), { timeout: 30_000 }).toBe(true);
      await screenshot('error');
      await tap('Export recovery data');
      await expect.poll(() => session.eval<boolean>("return !!document.querySelector('[data-testid=export-file-password]');"), { timeout: 30_000 }).toBe(true);
      await screenshot('export');
    }
  } finally {
    await session.close();
  }
});
