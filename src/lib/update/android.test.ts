import fs from 'node:fs';
import path from 'node:path';

import { AndroidUpdateAdapter, versionCodeToSemver } from './android';

const plugin = (
  response: unknown = {
    status: 'available',
    currentVersion: '1.16.0',
    availableVersionCode: 11700001,
    // The native side also decides the action; the adapter must ignore it and
    // always go back through performUpdate.
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

    if (result.status !== 'available') throw new Error('expected an available update');
    const { action, ...availability } = result;
    expect(availability).toEqual({ status: 'available', currentVersion: '1.16.0', availableVersion: '1.17.0' });
    expect(native.performUpdate).not.toHaveBeenCalled();
    await action();
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

  it('reports none when Play answers with a build that is not newer', async () => {
    // A re-upload of the same marketing version carries a higher version code
    // but the same semver, which is an answer: no update.
    const native = plugin({ status: 'available', currentVersion: '1.16.0', availableVersionCode: 11600002 });

    await expect(new AndroidUpdateAdapter(native, () => 'android').check()).resolves.toEqual({
      status: 'none',
      currentVersion: '1.16.0'
    });
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

describe('versionCodeToSemver against the Gradle scheme it inverts', () => {
  // The encoder lives in Gradle and the decoder here; drift in either silently
  // degrades every Android check to unknown, so the test reads both sides.
  const gradle = fs.readFileSync(path.resolve(__dirname, '../../../android/app/build.gradle'), 'utf8');

  const formula = gradle.match(
    /appVersionCode = vMajor \* (\d+) \+ vMinor \* (\d+) \+ vPatch \* (\d+) \+ androidBuildNumber/
  );
  const buildCeiling = gradle.match(/androidBuildNumber < 1 \|\| androidBuildNumber > (\d+)/);
  if (!formula || !buildCeiling) throw new Error('android/app/build.gradle no longer declares the version code');

  // The build slot is the one field a re-upload moves, so the round trip is
  // checked at both ends of the range Gradle accepts.
  it.each([1, Number(buildCeiling[1])])('round-trips a version built with build number %i', build => {
    const [major, minor, patch] = [1, 16, 3];
    const versionCode = major * Number(formula[1]) + minor * Number(formula[2]) + patch * Number(formula[3]) + build;

    expect(versionCodeToSemver(versionCode)).toBe(`${major}.${minor}.${patch}`);
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
