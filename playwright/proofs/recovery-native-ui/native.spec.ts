import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
    await expect.poll(() => session.eval<boolean>('return window.__TEST_STORE__.getState().isInitialized === true;'), { timeout: 60_000 }).toBe(true);
    for (const theme of ['light', 'dark']) {
      await session.eval(`
        var s = window.__TEST_STORE__;
        document.documentElement.classList.toggle('dark', ${theme === 'dark'});
        var account = {publicKey:'retained-account',name:'Retained account',isPublic:true,type:'guardian',hdIndex:0,authScheme:'ecdsa'};
        location.hash = '#/storage-recovery';
        s.setState({ status: 2, accounts:[account], currentAccount:account, storageAvailability: {status:'unavailable',epoch:${theme === 'dark' ? 101 : 100},reason:'continuity',backend:'wallet',operation:'validate',time:0}, recoverWalletStorage: async function() { window.__RECOVERY_CALLS__ = (window.__RECOVERY_CALLS__ || 0) + 1; throw new Error('synthetic failure'); } });
        return true;
      `);
      await expect.poll(() => session.eval<boolean>("return !!document.querySelector('[data-testid=storage-recovery-page]');"), { timeout: 30_000 }).toBe(true);
      const tap = async (label: string) => {
        const point = await session.eval<{ x: number; y: number; width: number; height: number; hit: boolean } | null>(`
          var b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').trim() === ${JSON.stringify(label)});
          if (!b) return null;
          var r = b.getBoundingClientRect();
          var x=r.left+r.width/2, y=r.top+r.height/2;
          return {x,y,width:innerWidth,height:innerHeight,hit:b.contains(document.elementFromPoint(x,y))};
        `);
        if (!point || !point.hit || point.x < 0 || point.y < 0 || point.x >= point.width || point.y >= point.height) throw new Error('Tap target outside viewport');
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
      const observe = () => session.eval(`
        var s=window.__TEST_STORE__.getState(), b=Array.from(document.querySelectorAll('button')).find(x=>(x.textContent||'').trim()==='Check storage');
        var r=b && b.getBoundingClientRect(), x=r && r.left+r.width/2, y=r && r.top+r.height/2;
        return {status:s.status,availability:s.storageAvailability.status,epoch:s.storageAvailability.epoch,accountPresent:!!s.currentAccount,recovery:!!document.querySelector('[data-testid=storage-recovery-page]'),checkHit:!!(b && b.contains(document.elementFromPoint(x,y))),checkInViewport:!!(r && x>=0 && y>=0 && x<innerWidth && y<innerHeight),calls:window.__RECOVERY_CALLS__||0,events:window.__TAP_DIAGNOSTIC__||[],center:r ? {x,y,width:innerWidth,height:innerHeight} : null,error:document.body.textContent.includes('The check could not finish. Wallet actions remain paused.')};
      `);
      await session.eval(`
        window.__TAP_DIAGNOSTIC__=[];
        for (var kind of ['touchstart','click']) document.addEventListener(kind, function(e) {
          var b=e.target && e.target.closest && e.target.closest('button');
          window.__TAP_DIAGNOSTIC__.push({kind:e.type,check:!!(b && (b.textContent||'').trim()==='Check storage')});
        }, {capture:true, once:true});
        return true;
      `);
      const beforeTap = await observe();
      await tap('Check storage');
      await new Promise(resolve => setTimeout(resolve, 1000));
      const afterTap = await observe();
      await screenshot('postcheck');
      await writeFile(join(output, `${platform}-${theme}-tap.json`), JSON.stringify({beforeTap,afterTap}, null, 2));
      await expect.poll(() => session.eval<boolean>("return document.body.textContent.includes('The check could not finish. Wallet actions remain paused.');"), { timeout: 30_000 }).toBe(true);
      await screenshot('error');
      if (!ios) {
        const { stdout } = await exec('adb', ['-s', device, 'shell', 'wm', 'size'], { timeout: 30_000 });
        const size = stdout.match(/(\d+)x(\d+)/);
        if (!size) throw new Error('Missing emulator screen size');
        const width = Number(size[1]);
        const height = Number(size[2]);
        await exec('adb', ['-s', device, 'shell', 'input', 'swipe', String(Math.round(width / 2)), String(Math.round(height * 0.8)), String(Math.round(width / 2)), String(Math.round(height * 0.35)), '500'], { timeout: 30_000 });
        await screenshot('scrolled');
      }
      await tap('Export recovery data');
      await expect.poll(() => session.eval<boolean>("return !!document.querySelector('[data-testid=export-file-password]');"), { timeout: 30_000 }).toBe(true);
      await screenshot('export');
    }
  } finally {
    await session.close();
  }
});
