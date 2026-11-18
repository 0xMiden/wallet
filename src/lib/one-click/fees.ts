import { isRecord } from 'lib/update/guards';

import type { OneClickAppFee, OneClickFeePolicy } from './types';

export function parseOneClickFeePolicy(value: unknown): OneClickFeePolicy | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    Object.keys(value).some(key => !['kind', 'platformRecipient', 'minimumPlatformFeeBps'].includes(key))
  )
    throw new Error('Invalid 1Click platform fee policy');
  const { kind, platformRecipient, minimumPlatformFeeBps } = value;
  if (
    (kind !== 'partner' && kind !== 'public') ||
    typeof platformRecipient !== 'string' ||
    !/^[a-z0-9._-]{2,64}$/.test(platformRecipient) ||
    typeof minimumPlatformFeeBps !== 'number' ||
    (kind === 'partner' ? ![1, 20].includes(minimumPlatformFeeBps) : minimumPlatformFeeBps !== 25)
  )
    throw new Error('Invalid 1Click platform fee policy');
  return { kind, platformRecipient, minimumPlatformFeeBps };
}

export function expectedOneClickFees(fees: readonly OneClickAppFee[], policy?: OneClickFeePolicy): OneClickAppFee[] {
  if (
    !Array.isArray(fees) ||
    fees.length > 3 ||
    fees.some(
      fee =>
        !fee ||
        typeof fee.recipient !== 'string' ||
        fee.recipient.length < 2 ||
        fee.recipient.length > 128 ||
        !Number.isSafeInteger(fee.fee) ||
        fee.fee < 0 ||
        fee.fee > 1000
    ) ||
    fees.reduce((sum, fee) => sum + fee.fee, 0) > 1000
  )
    throw new Error('Invalid 1Click app fee configuration');
  const pinned = parseOneClickFeePolicy(policy);
  if (!pinned) return fees.map(fee => ({ ...fee }));
  const shares = fees
    .filter(fee => fee.fee > 0)
    .map(fee => ({
      recipient: fee.recipient,
      fee: pinned.kind === 'partner' ? Math.ceil(fee.fee / 2) : fee.fee
    }));
  const platform =
    pinned.kind === 'partner'
      ? Math.max(
          pinned.minimumPlatformFeeBps,
          shares.reduce((sum, fee) => sum + fee.fee, 0)
        )
      : pinned.minimumPlatformFeeBps;
  const expected = [...shares, { recipient: pinned.platformRecipient, fee: platform }];
  if (expected.length > 3 || expected.reduce((sum, fee) => sum + fee.fee, 0) > 500)
    throw new Error('1Click effective fees exceed the pinned policy bounds');
  return expected;
}
