import { IOSUpdateAdapter } from './ios';

const plugin = (response: unknown = { status: 'available', currentVersion: '1.16.0', availableVersion: '1.17.0' }) => ({
  check: jest.fn().mockResolvedValue(response),
  openAppStore: jest.fn().mockResolvedValue(undefined)
});

describe('IOSUpdateAdapter', () => {
  it('uses the exact validated App Store version and opens only on action', async () => {
    const native = plugin();
    const result = await new IOSUpdateAdapter(native, () => 'ios').check();

    expect(result).toMatchObject({ status: 'available', currentVersion: '1.16.0', availableVersion: '1.17.0' });
    expect(native.openAppStore).not.toHaveBeenCalled();
    if (result.status !== 'available') throw new Error('expected an available update');
    await result.action();
    expect(native.openAppStore).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      { status: 'none', currentVersion: '1.16.0' },
      { status: 'none', currentVersion: '1.16.0' }
    ],
    [
      { status: 'unknown', currentVersion: '1.16.0' },
      { status: 'unknown', currentVersion: '1.16.0' }
    ]
  ])('maps authoritative %j', async (response, expected) => {
    await expect(new IOSUpdateAdapter(plugin(response), () => 'ios').check()).resolves.toEqual(expected);
  });

  it('returns unknown outside iOS without calling the bridge', async () => {
    const native = plugin();

    await expect(new IOSUpdateAdapter(native, () => 'android').check()).resolves.toEqual({ status: 'unknown' });
    expect(native.check).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { status: 'available', currentVersion: 'invalid', availableVersion: '1.17.0' },
    { status: 'available', currentVersion: '1.16.0', availableVersion: 'invalid' },
    { status: 'available', currentVersion: '1.16.0', availableVersion: '1.16.0' },
    { status: 'none', currentVersion: 16 }
  ])('fails closed for malformed or inconsistent bridge response %#', async response => {
    await expect(new IOSUpdateAdapter(plugin(response), () => 'ios').check()).resolves.toMatchObject({
      status: 'unknown'
    });
  });

  it('maps transport failure to unknown and preserves action failure for retry', async () => {
    const failedCheck = plugin();
    failedCheck.check.mockRejectedValueOnce(new Error('lookup timed out'));
    await expect(new IOSUpdateAdapter(failedCheck, () => 'ios').check()).resolves.toEqual({ status: 'unknown' });

    const failedAction = plugin();
    failedAction.openAppStore.mockRejectedValueOnce(new Error('store unavailable'));
    const result = await new IOSUpdateAdapter(failedAction, () => 'ios').check();
    if (result.status !== 'available') throw new Error('expected an available update');
    await expect(result.action()).rejects.toThrow('store unavailable');
  });
});
