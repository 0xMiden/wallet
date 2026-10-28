import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CdpBridge } from '../../e2e/android/helpers/cdp-bridge';
import { EmulatorControl } from '../../e2e/android/helpers/emulator-control';

test('observe synthetic retained state on Android', async () => {
  const device = process.env.NATIVE_UI_DEVICE;
  const output = process.env.NATIVE_UI_SCREENSHOTS;
  if (!device || !output) throw new Error('Missing disposable CI device');
  await mkdir(output, { recursive: true });
  const session = await CdpBridge.connect({ serial: device, packageName: 'com.miden.wallet', hostPort: 19222 });
  const emulator = new EmulatorControl();
  try {
    await expect.poll(() => session.eval<boolean>('return !!window.__TEST_STORE__;'), { timeout: 60_000 }).toBe(true);
    const observe = () => session.eval(`
      var s = window.__TEST_STORE__.getState();
      return {status:s.status,availability:s.storageAvailability && s.storageAvailability.status,epoch:s.storageAvailability && s.storageAvailability.epoch,initialized:s.isInitialized,accountPresent:!!s.currentAccount,hash:location.hash === '#/storage-recovery',recovery:!!document.querySelector('[data-testid=storage-recovery-page]'),check:!!Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').trim() === 'Check storage')};
    `);
    const before = await observe();
    await session.eval(`
      var account = {publicKey:'retained-account',name:'Retained account',isPublic:true,type:'guardian',hdIndex:0,authScheme:'ecdsa'};
      location.hash = '#/storage-recovery';
      window.__TEST_STORE__.setState({status:2,accounts:[account],currentAccount:account,storageAvailability:{status:'unavailable',epoch:100,reason:'continuity',backend:'wallet',operation:'validate',time:0},recoverWalletStorage:async function(){throw new Error('synthetic failure');}}); return true;
    `);
    const immediate = await observe();
    await new Promise(resolve => setTimeout(resolve, 1000));
    const oneSecond = await observe();
    await new Promise(resolve => setTimeout(resolve, 4000));
    const settled = await observe();
    await emulator.screenshot(device, join(output, 'android-readiness.png'));
    await writeFile(join(output, 'readiness.json'), JSON.stringify({ before, immediate, oneSecond, settled }, null, 2));
  } finally {
    await session.close();
  }
});
