import { canonicalRequestBytes } from '../../../../scripts/canonical-request-bytes.mjs';
import { isRecord } from '../../update/guards';

export const TEST_CONSUME_AUTHORIZATION_KEY = 'e2e_mainnet_consume_authorization';
const KEY = TEST_CONSUME_AUTHORIZATION_KEY;

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 1_048_576)
    throw new Error('Invalid native request byte size');
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

export async function awaitTestConsumeAuthorization(
  accountId: string, noteIds: string[], request: { serialize(): Uint8Array }
): Promise<void> {
  if (process.env.MIDEN_E2E_TEST !== 'true') return;
  const policy: unknown = (await chrome.storage.local.get(KEY))[KEY];
  if (policy === undefined) return;
  if (!isRecord(policy) || policy.status !== 'armed' || typeof policy.nonce !== 'string' ||
      !policy.nonce || policy.nonce.length > 80 || typeof policy.accountId !== 'string' || !policy.accountId ||
      typeof policy.noteId !== 'string' || !/^0x[0-9a-f]{64}$/.test(policy.noteId) ||
      typeof policy.canonicalSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(policy.canonicalSha256))
    throw new Error('Invalid or already used native consume authorization');
  if (policy.accountId !== accountId || noteIds.length !== 1 || noteIds[0] !== policy.noteId)
    throw new Error('Native consume actor or note scope differs from its authorization');
  const scope = { nonce: policy.nonce, accountId: policy.accountId, noteId: policy.noteId, canonicalSha256: policy.canonicalSha256 };
  const bytes = request.serialize();
  if (await sha256(canonicalRequestBytes(bytes)) !== scope.canonicalSha256)
    throw new Error('Actual native consume request differs from its canonical authorization');
  const digest = await sha256(bytes);
  const same = (value: unknown, expected: Record<string, string>): boolean => isRecord(value) &&
    Object.entries(expected).every(([key, entry]) => value[key] === entry);
  const started = Date.now();
  if (!same((await chrome.storage.local.get(KEY))[KEY], { ...scope, status: 'armed' }))
    throw new Error('Native consume authority changed during request inspection');
  if (Date.now() < started || Date.now() - started >= 240_000) throw new Error('Native consume authorization timed out');
  // Only public request fingerprints cross storage; private note/request bytes stay in memory.
  await chrome.storage.local.set({ [KEY]: { ...scope, sha256: digest, status: 'waiting' } });
  for (let poll = 0; poll < 480; poll++) {
    if (Date.now() < started || Date.now() - started >= 240_000) break;
    const live: unknown = (await chrome.storage.local.get(KEY))[KEY];
    if (!isRecord(live) || live.nonce !== scope.nonce || live.accountId !== scope.accountId ||
        live.noteId !== scope.noteId || live.canonicalSha256 !== scope.canonicalSha256 || live.sha256 !== digest ||
        (live.status !== 'waiting' && live.status !== 'released'))
      throw new Error('Native consume authorization changed during the request hold');
    if (live.status === 'released') {
      if (await sha256(request.serialize()) !== digest) throw new Error('Native request changed during authorization upload');
      if (!same((await chrome.storage.local.get(KEY))[KEY], { ...scope, sha256: digest, status: 'released' }))
        throw new Error('Native consume release changed during request verification');
      if (Date.now() < started || Date.now() - started >= 240_000) throw new Error('Native consume authorization timed out');
      await chrome.storage.local.set({ [KEY]: { ...scope, sha256: digest, status: 'spent' } });
      if (!same((await chrome.storage.local.get(KEY))[KEY], { ...scope, sha256: digest, status: 'spent' }))
        throw new Error('Native consume spent authority changed before execution');
      if (Date.now() < started || Date.now() - started >= 240_000) throw new Error('Native consume authorization timed out');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Native consume authorization timed out');
}
