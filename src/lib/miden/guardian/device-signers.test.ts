import { deviceSignersAfterRevocation } from './device-signers';

const current = `0x${'1'.repeat(64)}`;
const recovery = `0x${'2'.repeat(64)}`;
const target = `0x${'3'.repeat(64)}`;
const added = `0x${'4'.repeat(64)}`;

describe('device signer revocation', () => {
  it('keeps every other signer, including a device added before the fresh read', () => {
    expect(deviceSignersAfterRevocation([target, recovery, added, current], target, current, recovery, 1)).toEqual([
      recovery,
      added,
      current
    ]);
  });
  it.each([current, recovery])('refuses to remove a protected key %s', protectedKey => {
    expect(() =>
      deviceSignersAfterRevocation([current, recovery, target], protectedKey, current, recovery, 1)
    ).toThrow();
  });
  it('refuses a stale target and an invalid threshold', () => {
    expect(() => deviceSignersAfterRevocation([current, recovery], target, current, recovery, 1)).toThrow();
    expect(() => deviceSignersAfterRevocation([current, recovery, target], target, current, recovery, 3)).toThrow();
  });
  it('compares commitments with different prefixes and case', () => {
    expect(deviceSignersAfterRevocation([current, recovery, target.slice(2)], target, current, recovery, 1)).toEqual([
      current,
      recovery
    ]);
  });
});
