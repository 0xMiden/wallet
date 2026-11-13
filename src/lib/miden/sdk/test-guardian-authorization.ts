import type { Note, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import { getTestAuthorizationStorage } from './test-authorization-storage';
import { awaitTestConsumeAuthorization } from './test-consume-authorization';
import { awaitTestSendAuthorization } from './test-send-authorization';
import { walletAccountIdToSdk } from './helpers';
import { testRequestSha256 } from './test-request-sha256';
import { canonicalRequestBytes } from '../../../../scripts/canonical-request-bytes.mjs';
import { isRecord } from '../../update/guards';

export type TestGuardianAuthorizationKind = 'send' | 'consume';
const SEND = 'e2e_mainnet_send_authorization';
const CONSUME = 'e2e_mainnet_consume_authorization';

export async function authorizeTestGuardianRequest(
  transaction: { type: string; accountId: string; noteId?: unknown; noteIds?: unknown; extraInputs?: unknown },
  request: TransactionRequest,
  loadNote: (noteId: string) => Promise<Note | null>
): Promise<TestGuardianAuthorizationKind | undefined> {
  if (process.env.MIDEN_E2E_TEST !== 'true') return;
  const kind =
    transaction.type === 'consume'
      ? 'consume'
      : ['send', 'swap', 'bridged-send'].includes(transaction.type)
        ? 'send'
        : undefined;
  const stored = await getTestAuthorizationStorage([SEND, `${SEND}_required`, CONSUME, `${CONSUME}_required`]);
  if (!kind) {
    if (Object.values(stored).some(value => value !== undefined))
      throw new Error('Unsupported Guardian operation while native authority exists');
    return;
  }
  const key = kind === 'send' ? SEND : CONSUME;
  if (stored[key] === undefined && stored[`${key}_required`] === undefined) return kind;
  const account = walletAccountIdToSdk(transaction.accountId).toString();
  if (kind === 'consume') {
    const ids =
      Array.isArray(transaction.noteIds) && transaction.noteIds.length > 0 ? transaction.noteIds : [transaction.noteId];
    if (ids.length !== 1 || typeof ids[0] !== 'string')
      throw new Error('Guardian consume authority requires one exact original note');
    const noteId = ids[0];
    const note = await loadNote(noteId);
    if (!note) throw new Error('Missing original Guardian consume note');
    await awaitTestConsumeAuthorization(account, [noteId], request, note);
  } else {
    const requestKind =
      transaction.type === 'swap'
        ? 'swap'
        : transaction.type === 'bridged-send' &&
            isRecord(transaction.extraInputs) &&
            transaction.extraInputs.provider === 'epoch'
          ? 'epoch'
          : 'send';
    await awaitTestSendAuthorization(account, request, requestKind, true);
  }
  return kind;
}

export async function assertTestGuardianRequestAuthorization(
  accountId: string,
  request: { serialize(): Uint8Array },
  kind?: TestGuardianAuthorizationKind
): Promise<void> {
  if (process.env.MIDEN_E2E_TEST !== 'true') return;
  const stored = await getTestAuthorizationStorage([SEND, `${SEND}_required`, CONSUME, `${CONSUME}_required`]);
  if (kind !== 'send' && kind !== 'consume') {
    if (kind !== undefined || Object.values(stored).some(value => value !== undefined))
      throw new Error('Missing Guardian authorization operation scope');
    return;
  }
  const key = kind === 'send' ? SEND : CONSUME;
  const policy: unknown = stored[key];
  const required: unknown = stored[`${key}_required`];
  if (policy === undefined && required === undefined) return;
  if (
    !isRecord(policy) ||
    !isRecord(required) ||
    policy.accountId !== walletAccountIdToSdk(accountId).toString() ||
    required.accountId !== policy.accountId ||
    required.nonce !== policy.nonce ||
    typeof policy.nonce !== 'string' ||
    !policy.nonce ||
    policy.status !== 'spent' ||
    typeof policy.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(policy.sha256) ||
    typeof policy.expiresAt !== 'number' ||
    !Number.isSafeInteger(policy.expiresAt) ||
    policy.expiresAt <= Date.now()
  )
    throw new Error('Guardian signed authority is missing, changed or expired');
  const fingerprint = kind === 'consume' ? policy.requestCanonicalSha256 : policy.canonicalSha256;
  if (
    typeof fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(fingerprint) ||
    (await testRequestSha256(canonicalRequestBytes(request.serialize()))) !== fingerprint
  )
    throw new Error('Actual Guardian signed bytes differ from their uploaded authority');
  const live = await getTestAuthorizationStorage([key, `${key}_required`]);
  const current: unknown = live[key];
  const marker: unknown = live[`${key}_required`];
  if (
    !isRecord(current) ||
    !isRecord(marker) ||
    Object.keys(current).length !== Object.keys(policy).length ||
    Object.entries(policy).some(([name, value]) => current[name] !== value) ||
    marker.accountId !== required.accountId ||
    marker.nonce !== required.nonce ||
    Date.now() >= policy.expiresAt
  )
    throw new Error('Guardian signed authority changed before execution');
}
