import { screenShotName } from './screen-capture';

describe('screenShotName', () => {
  it('zero-pads seq and slugifies the key', () => {
    expect(screenShotName(4, '/send > SelectAmount > drawer:token', 'A')).toBe(
      'screen-004-send-SelectAmount-drawer-token-wallet-a.png'
    );
  });
});
