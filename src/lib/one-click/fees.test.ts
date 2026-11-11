import { expectedOneClickFees } from './fees';
import type { OneClickFeePolicy } from './types';

const partner: OneClickFeePolicy = {
  kind: 'partner',
  platformRecipient: 'platform.near',
  minimumPlatformFeeBps: 20
};
const custom = (fee: number, recipient = 'wallet.near') => ({ recipient, fee });

it('preserves the existing exact fee contract when no policy is configured', () => {
  expect(expectedOneClickFees([custom(10)])).toEqual([custom(10)]);
  expect(expectedOneClickFees([])).toEqual([]);
});
it('pins the configured platform fee even with no distribution-channel fee', () => {
  expect(expectedOneClickFees([], partner)).toEqual([custom(20, 'platform.near')]);
});
it.each([
  [5, 3, 20],
  [10, 5, 20],
  [21, 11, 20],
  [40, 20, 20],
  [41, 21, 21]
])('computes the documented partner split and minimum for %s bps', (requested, appShare, platformShare) => {
  expect(expectedOneClickFees([custom(requested)], partner)).toEqual([
    custom(appShare), custom(platformShare, 'platform.near')
  ]);
});
it('rounds each recipient share before summing the platform share', () => {
  expect(expectedOneClickFees([custom(21), custom(21, 'fees.near')], partner)).toEqual([
    custom(11), custom(11, 'fees.near'), custom(22, 'platform.near')
  ]);
});
it('does not merge distinct configured entries at the platform recipient', () => {
  expect(expectedOneClickFees([custom(20, 'platform.near')], partner)).toEqual([
    custom(10, 'platform.near'), custom(20, 'platform.near')
  ]);
});
it('supports only an explicitly configured one-basis-point stable-route schedule', () => {
  expect(expectedOneClickFees([], { ...partner, minimumPlatformFeeBps: 1 })).toEqual([custom(1, 'platform.near')]);
});
it('keeps public custom fees whole and adds exactly the configured public 25 bps', () => {
  const policy: OneClickFeePolicy = { ...partner, kind: 'public', minimumPlatformFeeBps: 25 };
  expect(expectedOneClickFees([custom(5)], policy)).toEqual([custom(5), custom(25, 'platform.near')]);
});
it('does not request a distribution payment for an explicitly zero fee', () => {
  expect(expectedOneClickFees([custom(0)], partner)).toEqual([custom(20, 'platform.near')]);
});
it.each([
  { ...partner, minimumPlatformFeeBps: 19 },
  { ...partner, minimumPlatformFeeBps: 25 },
  { ...partner, platformRecipient: '' }
])('rejects an unapproved platform schedule or recipient: %j', policy => {
  expect(() => expectedOneClickFees([], policy)).toThrow();
});
it('enforces the documented combined 500-bps ceiling without increasing the legacy cap', () => {
  expect(() => expectedOneClickFees([custom(999)], partner)).toThrow();
  expect(expectedOneClickFees([custom(1000)])).toEqual([custom(1000)]);
});
it('does not relax the existing three-entry response limit to fit a new policy', () => {
  expect(() => expectedOneClickFees([custom(5), custom(5, 'two.near'), custom(5, 'three.near')], partner)).toThrow();
});
