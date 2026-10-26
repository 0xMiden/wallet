import { DesktopUpdateAdapter } from './desktop';

describe('DesktopUpdateAdapter', () => {
  it('reports unknown and exposes no update action', async () => {
    await expect(new DesktopUpdateAdapter().check()).resolves.toEqual({ status: 'unknown' });
  });
});
