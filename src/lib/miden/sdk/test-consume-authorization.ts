import type { Note } from '@miden-sdk/miden-sdk/lazy';
import { getTestAuthorizationStorage, setTestAuthorizationStorage } from './test-authorization-storage';
import { inspectTestMainnetGuardianConsumeRequest } from './test-send-request';
import { testRequestSha256 } from './test-request-sha256';
import { canonicalRequestBytes } from '../../../../scripts/canonical-request-bytes.mjs';
import { isRecord } from '../../update/guards';

export const TEST_CONSUME_AUTHORIZATION_KEY = 'e2e_mainnet_consume_authorization';
const KEY = TEST_CONSUME_AUTHORIZATION_KEY;

export async function awaitTestConsumeAuthorization(
  accountId: string,
  noteIds: string[],
  request: { serialize(): Uint8Array },
  guardianNote?: Note
): Promise<void> {
  if (process.env.MIDEN_E2E_TEST !== 'true') return;
  const stored = await getTestAuthorizationStorage([KEY, `${KEY}_required`]);
  const policy: unknown = stored[KEY];
  const required: unknown = stored[`${KEY}_required`];
  if (policy === undefined) {
    if (required !== undefined) throw new Error('Missing required native consume authorization');
    return;
  }
  if (
    !isRecord(policy) ||
    (required !== undefined &&
      (!isRecord(required) || required.accountId !== policy.accountId || required.nonce !== policy.nonce)) ||
    policy.status !== 'armed' ||
    typeof policy.nonce !== 'string' ||
    !policy.nonce ||
    policy.nonce.length > 80 ||
    typeof policy.accountId !== 'string' ||
    !policy.accountId ||
    typeof policy.noteId !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(policy.noteId) ||
    typeof policy.canonicalSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(policy.canonicalSha256)
  )
    throw new Error('Invalid or already used native consume authorization');
  if (policy.accountId !== accountId || noteIds.length !== 1 || noteIds[0] !== policy.noteId)
    throw new Error('Native consume actor or note scope differs from its authorization');
  const scope = {
    nonce: policy.nonce,
    accountId: policy.accountId,
    noteId: policy.noteId,
    canonicalSha256: policy.canonicalSha256
  };
  const started = Date.now();
  const bytes = request.serialize();
  const requestCanonicalSha256 = guardianNote
    ? await inspectTestMainnetGuardianConsumeRequest(scope, bytes, guardianNote)
    : undefined;
  if (!guardianNote && (await testRequestSha256(canonicalRequestBytes(bytes))) !== scope.canonicalSha256)
    throw new Error('Actual native consume request differs from its canonical authorization');
  const digest = await testRequestSha256(bytes);
  const held = {
    ...scope,
    sha256: digest,
    ...(requestCanonicalSha256 === undefined ? {} : { requestCanonicalSha256, expiresAt: started + 240_000 })
  };
  const same = (value: unknown, expected: Record<string, string | number>): boolean =>
    isRecord(value) && Object.entries(expected).every(([key, entry]) => value[key] === entry);
  if (!same((await getTestAuthorizationStorage(KEY))[KEY], { ...scope, status: 'armed' }))
    throw new Error('Native consume authority changed during request inspection');
  if (Date.now() < started || Date.now() - started >= 240_000)
    throw new Error('Native consume authorization timed out');
  // Only public request fingerprints cross storage; private note/request bytes stay in memory.
  await setTestAuthorizationStorage({ [KEY]: { ...held, status: 'waiting' } });
  for (let poll = 0; poll < 480; poll++) {
    if (Date.now() < started || Date.now() - started >= 240_000) break;
    const live: unknown = (await getTestAuthorizationStorage(KEY))[KEY];
    if (
      !isRecord(live) ||
      !same(live, held) ||
      (live.status !== 'waiting' && live.status !== 'released')
    )
      throw new Error('Native consume authorization changed during the request hold');
    if (live.status === 'released') {
      if ((await testRequestSha256(request.serialize())) !== digest)
        throw new Error('Native request changed during authorization upload');
      if (!same((await getTestAuthorizationStorage(KEY))[KEY], { ...held, status: 'released' }))
        throw new Error('Native consume release changed during request verification');
      if (Date.now() < started || Date.now() - started >= 240_000)
        throw new Error('Native consume authorization timed out');
      await setTestAuthorizationStorage({ [KEY]: { ...held, status: 'spent' } });
      if (!same((await getTestAuthorizationStorage(KEY))[KEY], { ...held, status: 'spent' }))
        throw new Error('Native consume spent authority changed before execution');
      if (Date.now() < started || Date.now() - started >= 240_000)
        throw new Error('Native consume authorization timed out');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Native consume authorization timed out');
}
