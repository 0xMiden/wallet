import { AndroidUpdateAdapter, versionCodeToSemver } from './android';

const plugin = (
  response: unknown = {
    status: 'available',
    currentVersion: '1.16.0',
    availableVersionCode: 11700001,
    action: 'start_flexible'
  }
) => ({
  check: jest.fn().mockResolvedValue(response),
  performUpdate: jest.fn().mockResolvedValue({ started: true })
});

describe('AndroidUpdateAdapter', () => {
  it('maps Play version codes produced by the compiled Android version scheme', async () => {
    const native = plugin();
    const adapter = new AndroidUpdateAdapter(native, () => 'android');

    const result = await adapter.check();

    expect(result).toMatchObject({ status: 'available', currentVersion: '1.16.0', availableVersion: '1.17.0' });
    expect(native.performUpdate).not.toHaveBeenCalled();
    if (result.status !== 'available') throw new Error('expected an available update');
    await result.action();
    expect(native.performUpdate).toHaveBeenCalledTimes(1);
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
    await expect(new AndroidUpdateAdapter(plugin(response), () => 'android').check()).resolves.toEqual(expected);
  });

  it('returns unknown outside Android without calling the bridge', async () => {
    const native = plugin();

    await expect(new AndroidUpdateAdapter(native, () => 'ios').check()).resolves.toEqual({ status: 'unknown' });
    expect(native.check).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { status: 'available', currentVersion: 'invalid', availableVersionCode: 11700001 },
    { status: 'available', currentVersion: '1.16.0', availableVersionCode: 11600001 },
    { status: 'available', currentVersion: '1.16.0', availableVersionCode: 11700000 },
    { status: 'none', currentVersion: 16 }
  ])('fails closed for malformed or inconsistent bridge response %#', async response => {
    await expect(new AndroidUpdateAdapter(plugin(response), () => 'android').check()).resolves.toMatchObject({
      status: 'unknown'
    });
  });

  it('maps bridge exceptions to unknown and preserves action failures for retry', async () => {
    const failedCheck = plugin();
    failedCheck.check.mockRejectedValueOnce(new Error('Play unavailable'));
    await expect(new AndroidUpdateAdapter(failedCheck, () => 'android').check()).resolves.toEqual({
      status: 'unknown'
    });

    const failedAction = plugin();
    failedAction.performUpdate.mockRejectedValueOnce(new Error('user canceled'));
    const result = await new AndroidUpdateAdapter(failedAction, () => 'android').check();
    if (result.status !== 'available') throw new Error('expected an available update');
    await expect(result.action()).rejects.toThrow('user canceled');
  });
});

describe('versionCodeToSemver', () => {
  it.each([
    [11700001, '1.17.0'],
    [20345007, '2.3.45'],
    [990000001, '99.0.0']
  ])('maps %i to %s', (versionCode, version) => {
    expect(versionCodeToSemver(versionCode)).toBe(version);
  });

  it.each([0, -1, 11700000, 117000000, 1.5, Number.NaN])('rejects invalid code %s', versionCode => {
    expect(versionCodeToSemver(versionCode)).toBeNull();
  });
});
