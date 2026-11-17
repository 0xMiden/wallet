import { type Address, getAddress, isAddress } from 'viem';

import type { CompactLockRef } from 'lib/epoch/forced-withdrawal-record';

/** The Settings page that scans The Compact for Fast bridge-in funds and lists every lock that holds some. */
export const RECOVER_FUNDS_PATH = '/settings/recover-funds';

/** The page of one lock: `/settings/recover-funds/:chainId/:lockId?address=0x…`. */
export function recoverFundsLockPath(ref: CompactLockRef): string {
  const query = new URLSearchParams({ address: ref.sponsorAddress });
  return `${RECOVER_FUNDS_PATH}/${ref.chainId}/${ref.lockId}?${query.toString()}`;
}

/** A lock that the route names, with its sponsor checksummed. */
export type RoutedLock = CompactLockRef & { sponsorAddress: Address };

const DECIMAL = /^[0-9]+$/;

/** The lock that the route names, or undefined when a segment or the `address` query is not valid. */
export function parseLockRoute(
  chainId: string | null | undefined,
  lockId: string | null | undefined,
  search: string
): RoutedLock | undefined {
  const address = new URLSearchParams(search).get('address');
  if (!chainId || !DECIMAL.test(chainId) || !lockId || !DECIMAL.test(lockId) || !address) return undefined;
  if (!isAddress(address, { strict: false })) return undefined;
  return { chainId: Number(chainId), lockId: BigInt(lockId).toString(), sponsorAddress: getAddress(address) };
}
