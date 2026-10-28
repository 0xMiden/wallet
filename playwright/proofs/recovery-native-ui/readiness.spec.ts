import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CdpBridge } from '../../e2e/ios/helpers/cdp-bridge';
import { SimulatorControl } from '../../e2e/ios/helpers/simulator-control';

test('observe synthetic recovery readiness without wallet data', async () => {
  const device = process.env.NATIVE_UI_DEVICE;
  const output = process.env.NATIVE_UI_SCREENSHOTS;
  if (!device || !output) throw new Error('Missing disposable CI device');
  await mkdir(output, { recursive: true });
  const session = await CdpBridge.connect({ udid: device, bundleId: 'com.miden.bread' });
  const sim = new SimulatorControl();
  try {
    await expect.poll(() => session.eval<boolean>('return !!window.__TEST_STORE__;'), { timeout: 60_000 }).toBe(true);
    const observe = () => session.eval(`
      var s = window.__TEST_STORE__.getState();
      return {status:s.status,availability:s.storageAvailability && s.storageAvailability.status,epoch:s.storageAvailability && s.storageAvailability.epoch,initialized:s.isInitialized,hash:location.hash === '#/storage-recovery',recovery:!!document.querySelector('[data-testid=storage-recovery-page]'),restricted:!!document.querySelector('[data-testid=wallet-access-gate]'),bodyNonempty:!!document.body.textContent.trim()};
    `);
    const before = await observe();
    await session.eval(`
      window.__TEST_STORE__.setState({status:2,storageAvailability:{status:'unavailable',epoch:100,reason:'continuity',backend:'wallet',operation:'validate',time:0},recoverWalletStorage:async function(){throw new Error('synthetic failure');}});
      location.hash='#/storage-recovery'; return true;
    `);
    const immediate = await observe();
    await sim.screenshot(device, join(output, 'ios-readiness-immediate.png'));
    await new Promise(resolve => setTimeout(resolve, 15_000));
    const settled = await observe();
    await sim.screenshot(device, join(output, 'ios-readiness-settled.png'));
    await writeFile(join(output, 'readiness.json'), JSON.stringify({ before, immediate, settled }, null, 2));
  } finally {
    await session.close();
  }
});
