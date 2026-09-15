import type { CdpSession } from './cdp-bridge';
import { IosWalletPage } from './ios-wallet-page';
import type { SimulatorControl } from './simulator-control';

describe('IosWalletPage.screenshot', () => {
  it('runs the before-capture hook before it shoots', async () => {
    const order: string[] = [];
    const sim = {
      screenshot: jest.fn(async () => {
        order.push('shot');
      })
    } as unknown as SimulatorControl;
    const page = new IosWalletPage({
      cdp: {} as CdpSession,
      sim,
      udid: 'udid',
      bundleId: 'bundle',
      beforeCapture: async () => {
        order.push('gate');
      }
    });

    await page.screenshot({ path: 'shot.png' });

    expect(order).toEqual(['gate', 'shot']);
  });

  it('shoots without a hook', async () => {
    const screenshot = jest.fn(async () => undefined);
    const page = new IosWalletPage({
      cdp: {} as CdpSession,
      sim: { screenshot } as unknown as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });

    await page.screenshot({ path: 'shot.png' });

    expect(screenshot).toHaveBeenCalledWith('udid', 'shot.png');
  });
});
