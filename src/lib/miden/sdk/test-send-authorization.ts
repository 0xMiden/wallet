import { inspectTestMainnetSendRequest } from './test-send-request';
import { canonicalRequestBytes } from '../../../../scripts/canonical-request-bytes.mjs';
import { isRecord } from '../../update/guards';

export const TEST_SEND_AUTHORIZATION_KEY = 'e2e_mainnet_send_authorization';
const KEY = TEST_SEND_AUTHORIZATION_KEY;
async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

export async function awaitTestSendAuthorization(
  accountId: string,
  request: { serialize(): Uint8Array }
): Promise<void> {
  if (process.env.MIDEN_E2E_TEST !== 'true') return;
  const policy: unknown = (await chrome.storage.local.get(KEY))[KEY];
  if (policy === undefined) return;
  if (
    !isRecord(policy) ||
    policy.status !== 'armed' ||
    typeof policy.nonce !== 'string' ||
    !policy.nonce ||
    policy.nonce.length > 80 ||
    typeof policy.accountId !== 'string' ||
    typeof policy.recipientId !== 'string' ||
    typeof policy.faucetId !== 'string' ||
    typeof policy.amount !== 'string' ||
    ![policy.accountId, policy.recipientId, policy.faucetId].every(id => /^0x[0-9a-f]{30}$/.test(id)) ||
    !/^[1-9]\d{0,18}$/.test(policy.amount) ||
    typeof policy.expiresAt !== 'number' ||
    !Number.isSafeInteger(policy.expiresAt) ||
    policy.expiresAt <= Date.now() ||
    policy.expiresAt > Date.now() + 600_000
  )
    throw new Error('Invalid or already used native send authorization');
  const scope = {
    nonce: policy.nonce,
    accountId: policy.accountId,
    recipientId: policy.recipientId,
    faucetId: policy.faucetId,
    amount: policy.amount,
    expiresAt: policy.expiresAt
  };
  if (accountId !== scope.accountId) throw new Error('Native send SDK payer differs from its authorization');
  const started = Date.now();
  const active = () => {
    if (Date.now() < started || Date.now() - started >= 240_000 || Date.now() >= scope.expiresAt)
      throw new Error('Native send authorization timed out');
  };
  const bytes = request.serialize();
  const noteId = inspectTestMainnetSendRequest(scope, bytes);
  const sha = await sha256(bytes);
  const canonicalSha256 = await sha256(canonicalRequestBytes(bytes));
  const same = (value: unknown, expected: Record<string, string | number>): boolean =>
    isRecord(value) && Object.entries(expected).every(([key, entry]) => value[key] === entry);
  if (!same((await chrome.storage.local.get(KEY))[KEY], { ...scope, status: 'armed' }))
    throw new Error('Native send authority changed during request inspection');
  active();
  // Only public route identities and request fingerprints cross storage, never note/request bytes.
  const held = { ...scope, noteId, sha256: sha, canonicalSha256 };
  await chrome.storage.local.set({ [KEY]: { ...held, status: 'waiting' } });
  for (let poll = 0; poll < 480; poll++) {
    active();
    const live: unknown = (await chrome.storage.local.get(KEY))[KEY];
    if (!same(live, held) || !isRecord(live) || (live.status !== 'waiting' && live.status !== 'released'))
      throw new Error('Native send authority changed during the request hold');
    if (live.status === 'released') {
      if ((await sha256(request.serialize())) !== sha)
        throw new Error('Actual native send bytes changed during upload');
      active();
      if (!same((await chrome.storage.local.get(KEY))[KEY], { ...held, status: 'released' }))
        throw new Error('Native send release changed during request verification');
      active();
      await chrome.storage.local.set({ [KEY]: { ...held, status: 'spent' } });
      if (!same((await chrome.storage.local.get(KEY))[KEY], { ...held, status: 'spent' }))
        throw new Error('Native send spent authority changed before execution');
      active();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Native send authorization timed out');
}
