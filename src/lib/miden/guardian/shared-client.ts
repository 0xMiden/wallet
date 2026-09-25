import { Account, ChainAnchor, SyncSummary, TransactionSummary, type MidenClient } from '@miden-sdk/miden-sdk/lazy';
import { setRawClientAdapter } from '@openzeppelin/miden-multisig-client';

import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';
import type { GuardianClientOperation } from 'lib/shared/types';

import { midenClientProxy } from '../back/miden-client-proxy';

export type GuardianClientRequest = (operation: GuardianClientOperation) => Promise<string | null>;

/** Route Guardian state operations through the wallet's transaction writer. Callers hold the WASM lock. */
export function bindGuardianWriteClient(client: MidenClient, request?: GuardianClientRequest): void {
  if (request) {
    const requestBytes = async (operation: GuardianClientOperation) => {
      const result = await request(operation);
      if (result === null) throw new Error(`Guardian client returned no result for ${operation.method}`);
      return b64ToU8(result);
    };
    setRawClientAdapter(client, {
      getAccount: async accountId => {
        const result = await request({ method: 'getAccount', accountId: accountId.toString() });
        return result === null ? undefined : Account.deserialize(b64ToU8(result));
      },
      newAccount: async (account, overwrite) => {
        await request({ method: 'insertAccount', accountB64: u8ToB64(account.serialize()), overwrite });
      },
      syncState: async () => SyncSummary.deserialize(await requestBytes({ method: 'sync', chainOnly: false })),
      syncChain: async () => SyncSummary.deserialize(await requestBytes({ method: 'sync', chainOnly: true })),
      chainAnchorForRequest: async transactionRequest =>
        ChainAnchor.deserialize(
          await requestBytes({ method: 'captureAnchor', requestB64: u8ToB64(transactionRequest.serialize()) })
        ),
      executeForSummary: async (accountId, transactionRequest) =>
        TransactionSummary.deserialize(
          await requestBytes({
            method: 'preview',
            accountId: accountId.toString(),
            requestB64: u8ToB64(transactionRequest.serialize())
          })
        ),
      executeForSummaryAt: async (accountId, transactionRequest, anchor) =>
        TransactionSummary.deserialize(
          await requestBytes({
            method: 'preview',
            accountId: accountId.toString(),
            requestB64: u8ToB64(transactionRequest.serialize()),
            anchorB64: u8ToB64(anchor.serialize())
          })
        ),
      importNoteFile: async noteFile => {
        const result = await request({ method: 'importNote', noteB64: u8ToB64(noteFile.serialize()) });
        if (result === null) throw new Error('Guardian client returned no imported note ID');
        return result;
      }
    });
    return;
  }
  setRawClientAdapter(client, {
    getAccount: async accountId => (await midenClientProxy.getAccount(accountId.toString())) ?? undefined,
    newAccount: (account, overwrite) => midenClientProxy.insertAccount(account, overwrite),
    syncState: () => midenClientProxy.syncGuardianState(false),
    syncChain: () => midenClientProxy.syncGuardianState(true),
    chainAnchorForRequest: request => midenClientProxy.captureGuardianAnchor(request.serialize()),
    executeForSummary: (accountId, request) =>
      midenClientProxy.previewGuardianRequest(accountId.toString(), request.serialize()),
    executeForSummaryAt: (accountId, request, anchor) =>
      midenClientProxy.previewGuardianRequest(accountId.toString(), request.serialize(), anchor.serialize()),
    importNoteFile: noteFile => midenClientProxy.importNoteBytes(noteFile.serialize())
  });
}
