import { Account, getWasmOrThrow } from '@miden-sdk/miden-sdk/lazy';

import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';
import type { GuardianClientOperation } from 'lib/shared/types';

import { midenClientProxy } from './miden-client-proxy';
import { assertWasmHoldCurrent, withWasmClientLock } from '../sdk/miden-client';
import { WASM_LOCK_SYNC_WATCHDOG_MS } from '../sdk/wasm-client-poison';

/** UI Guardian operations use the backend lock and the transaction writer. */
export function runGuardianClientOperation(operation: GuardianClientOperation): Promise<string | null> {
  return withWasmClientLock(
    async hold => {
      const serialize = (value: { serialize(): Uint8Array }) => {
        assertWasmHoldCurrent(hold, `guardian-client:${operation.method}`);
        return u8ToB64(value.serialize());
      };
      switch (operation.method) {
        case 'getAccount': {
          const account = await midenClientProxy.getAccount(operation.accountId);
          return account ? serialize(account) : null;
        }
        case 'insertAccount':
          await getWasmOrThrow();
          assertWasmHoldCurrent(hold, 'guardian-client:insertAccount');
          await midenClientProxy.insertAccount(Account.deserialize(b64ToU8(operation.accountB64)), operation.overwrite);
          return null;
        case 'sync':
          return serialize(await midenClientProxy.syncGuardianState(operation.chainOnly));
        case 'captureAnchor':
          return serialize(await midenClientProxy.captureGuardianAnchor(b64ToU8(operation.requestB64)));
        case 'preview':
          return serialize(
            await midenClientProxy.previewGuardianRequest(
              operation.accountId,
              b64ToU8(operation.requestB64),
              operation.anchorB64 ? b64ToU8(operation.anchorB64) : undefined
            )
          );
        case 'importNote':
          return midenClientProxy.importNoteBytes(b64ToU8(operation.noteB64));
      }
    },
    { label: `guardian-client:${operation.method}`, watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS }
  );
}
