import { getCrashBuildIdentity } from './crash-build';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

describe('compile-time crash build identity', () => {
  it.each(['extension', 'mobile', 'desktop', 'background'])('accepts fixed build target %s', target => {
    process.env.WALLET_BUILD_TARGET = target;
    process.env.WALLET_BUILD_REVISION = '0123456789abcdef0123456789abcdef01234567';
    process.env.WALLET_BUILD_DIRTY = 'false';
    expect(getCrashBuildIdentity()).toEqual({ target, revision: process.env.WALLET_BUILD_REVISION, dirty: false });
  });
  it('reports local modifications as a boolean without filenames', () => {
    process.env.WALLET_BUILD_DIRTY = 'true';
    expect(getCrashBuildIdentity().dirty).toBe(true);
  });
  it('drops poisoned or unavailable metadata rather than copying arbitrary strings', () => {
    process.env.WALLET_BUILD_TARGET = 'private.example';
    process.env.WALLET_BUILD_REVISION = 'private token 12345';
    process.env.WALLET_BUILD_DIRTY = 'private';
    expect(getCrashBuildIdentity()).toEqual({});
    delete process.env.WALLET_BUILD_TARGET;
    delete process.env.WALLET_BUILD_REVISION;
    delete process.env.WALLET_BUILD_DIRTY;
    expect(getCrashBuildIdentity()).toEqual({});
  });
});
