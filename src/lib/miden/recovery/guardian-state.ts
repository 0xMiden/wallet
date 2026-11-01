import { AccountId, Endpoint, RpcClient } from '@miden-sdk/miden-sdk/lazy';
import { GuardianHttpClient, type Signer } from '@openzeppelin/guardian-client';

import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { b64ToU8 } from 'lib/shared/helpers';

import type { RecoveryAccountMaterial } from './account-restore';
import { StorageContinuityError } from './continuity';
import { JOURNAL_MAX_BYTES } from './journal';
import { registerGuardianOrigin } from '../guardian/native-http';

export function guardianStateReadSigner(
  delegate: Signer,
  accountId: string,
  assertCurrent: () => Promise<void>
): Signer {
  let used = false;
  const refuse = () => {
    throw new StorageContinuityError();
  };
  return {
    commitment: delegate.commitment,
    publicKey: delegate.publicKey,
    scheme: delegate.scheme,
    signAccountIdWithTimestamp: refuse,
    signCommitment: refuse,
    signRequest: async (id, timestamp, payload) => {
      if (used || id !== accountId || payload.toCanonicalJson() !== JSON.stringify({ account_id: accountId }))
        return refuse();
      used = true;
      await assertCurrent();
      if (!delegate.signRequest) return refuse();
      const signature = await delegate.signRequest(id, timestamp, payload);
      await assertCurrent();
      return signature;
    }
  };
}

export async function readGuardianRecoveryAccount(
  accountId: string,
  endpoint: string,
  rpcUrl: string,
  signer: Signer,
  assertCurrent: () => Promise<void>
): Promise<Pick<RecoveryAccountMaterial, 'accountBytes' | 'chainCommitment'>> {
  await assertCurrent();
  registerGuardianOrigin(endpoint);
  const guardian = new GuardianHttpClient(endpoint);
  guardian.setSigner(guardianStateReadSigner(signer, accountId, assertCurrent));
  const state = await withRpcTimeout(() => guardian.getState(accountId), 'storage recovery Guardian state', {
    timeoutMs: 30_000,
    retries: 0
  });
  await assertCurrent();
  const encoded: unknown = state?.stateJson?.data;
  if (
    state?.accountId !== accountId ||
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > Math.ceil(JOURNAL_MAX_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    throw new StorageContinuityError();
  const accountBytes = b64ToU8(encoded);
  if (accountBytes.byteLength > JOURNAL_MAX_BYTES) throw new StorageContinuityError();
  await ensureSdkWasmReady();
  await assertCurrent();
  const proof = await withRpcTimeout(
    () => new RpcClient(new Endpoint(rpcUrl)).getAccountProof(AccountId.fromHex(accountId)),
    'storage recovery node commitment',
    { timeoutMs: 30_000, retries: 0 }
  );
  await assertCurrent();
  const commitment = proof.accountCommitment();
  try {
    return { accountBytes, chainCommitment: commitment.toHex() };
  } finally {
    commitment.free();
    proof.free();
  }
}
