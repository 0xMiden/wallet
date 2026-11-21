import { assertResponse, request } from 'lib/miden/front/client';
import { WalletMessageType } from 'lib/shared/types';

/** Kept apart from `checks.ts`, which imports webextension-polyfill and throws outside an extension. */
export async function requestLock(): Promise<void> {
  const res = await request({
    type: WalletMessageType.LockRequest
  });
  assertResponse(res.type === WalletMessageType.LockResponse);
}
