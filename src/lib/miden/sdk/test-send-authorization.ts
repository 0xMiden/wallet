import { getTestAuthorizationStorage, setTestAuthorizationStorage } from './test-authorization-storage';
import {
  inspectTestMainnetSendRequest,
  inspectTestMainnetSwapRequest,
  type TestMainnetSendScope,
  type TestMainnetSwapScope
} from './test-send-request';
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
  request: { serialize(): Uint8Array },
  kind: 'send' | 'swap' = 'send'
): Promise<void> {
  if (process.env.MIDEN_E2E_TEST !== 'true') return;
  const stored = await getTestAuthorizationStorage([KEY, `${KEY}_required`]);
  const policy: unknown = stored[KEY];
  const required: unknown = stored[`${KEY}_required`];
  if (policy === undefined) {
    if (required !== undefined) throw new Error('Missing required native send authorization');
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
    typeof policy.faucetId !== 'string' ||
    typeof policy.amount !== 'string' ||
    ![policy.accountId, policy.faucetId].every(id => /^0x[0-9a-f]{30}$/.test(id)) ||
    !/^[1-9]\d{0,18}$/.test(policy.amount) ||
    typeof policy.expiresAt !== 'number' ||
    !Number.isSafeInteger(policy.expiresAt) ||
    policy.expiresAt <= Date.now() ||
    policy.expiresAt > Date.now() + 600_000
  )
    throw new Error('Invalid or already used native send authorization');
  const common = { accountId: policy.accountId, faucetId: policy.faucetId, amount: policy.amount };
  let route: TestMainnetSendScope | TestMainnetSwapScope;
  if (kind === 'swap') {
    if (
      policy.kind !== 'swap' ||
      typeof policy.requestedFaucetId !== 'string' ||
      !/^0x[0-9a-f]{30}$/.test(policy.requestedFaucetId) ||
      policy.requestedFaucetId === policy.faucetId ||
      typeof policy.requestedAmount !== 'string' ||
      !/^[1-9]\d{0,18}$/.test(policy.requestedAmount)
    )
      throw new Error('Invalid PSWAP authorization scope');
    route = {
      ...common,
      kind: 'swap',
      requestedFaucetId: policy.requestedFaucetId,
      requestedAmount: policy.requestedAmount
    };
  } else {
    if (
      policy.kind !== undefined ||
      typeof policy.recipientId !== 'string' ||
      !/^0x[0-9a-f]{30}$/.test(policy.recipientId)
    )
      throw new Error('Invalid native send authorization scope');
    route = { ...common, recipientId: policy.recipientId };
  }
  const scope = { ...route, nonce: policy.nonce, expiresAt: policy.expiresAt };
  if (accountId !== scope.accountId) throw new Error('Native send SDK payer differs from its authorization');
  const started = Date.now();
  const active = () => {
    if (Date.now() < started || Date.now() - started >= 240_000 || Date.now() >= scope.expiresAt)
      throw new Error('Native send authorization timed out');
  };
  const bytes = request.serialize();
  const identity =
    'kind' in scope
      ? inspectTestMainnetSwapRequest(scope, bytes)
      : { noteId: inspectTestMainnetSendRequest(scope, bytes) };
  const sha = await sha256(bytes);
  const canonicalSha256 = await sha256(canonicalRequestBytes(bytes));
  const same = (value: unknown, expected: Record<string, string | number>): boolean =>
    isRecord(value) && Object.entries(expected).every(([key, entry]) => value[key] === entry);
  if (!same((await getTestAuthorizationStorage(KEY))[KEY], { ...scope, status: 'armed' }))
    throw new Error('Native send authority changed during request inspection');
  active();
  // Only public route identities and request fingerprints cross storage, never note/request bytes.
  const held = { ...scope, ...identity, sha256: sha, canonicalSha256 };
  await setTestAuthorizationStorage({ [KEY]: { ...held, status: 'waiting' } });
  for (let poll = 0; poll < 480; poll++) {
    active();
    const live: unknown = (await getTestAuthorizationStorage(KEY))[KEY];
    if (!same(live, held) || !isRecord(live) || (live.status !== 'waiting' && live.status !== 'released'))
      throw new Error('Native send authority changed during the request hold');
    if (live.status === 'released') {
      if ((await sha256(request.serialize())) !== sha)
        throw new Error('Actual native send bytes changed during upload');
      active();
      if (!same((await getTestAuthorizationStorage(KEY))[KEY], { ...held, status: 'released' }))
        throw new Error('Native send release changed during request verification');
      active();
      await setTestAuthorizationStorage({ [KEY]: { ...held, status: 'spent' } });
      if (!same((await getTestAuthorizationStorage(KEY))[KEY], { ...held, status: 'spent' }))
        throw new Error('Native send spent authority changed before execution');
      active();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Native send authorization timed out');
}
