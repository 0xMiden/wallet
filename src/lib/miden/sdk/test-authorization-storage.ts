import { getStorageProvider } from '../../platform/storage-adapter';
import { isRecord } from '../../update/guards';
import { OFFSCREEN_TEST_AUTHORIZATION_STORAGE, SW_TARGET } from '../back/offscreen-codec';

const policyKeys = new Set(['e2e_mainnet_send_authorization', 'e2e_mainnet_consume_authorization']);
const readKeys = new Set([...policyKeys].flatMap(key => [key, `${key}_required`]));
const publicFields = new Set([
  'nonce',
  'accountId',
  'recipientId',
  'faucetId',
  'amount',
  'expiresAt',
  'kind',
  'requestedFaucetId',
  'requestedAmount',
  'noteId',
  'orderId',
  'sha256',
  'canonicalSha256',
  'status'
]);
function keysForRead(keys: string | string[]): string[] {
  const list = typeof keys === 'string' ? [keys] : keys;
  if (!list.length || list.length > 4 || !list.every(key => readKeys.has(key)))
    throw new Error('Invalid authorization storage keys');
  return list;
}
function publicItem(items: unknown): [string, Record<string, unknown>] {
  if (!isRecord(items) || Object.keys(items).length !== 1) throw new Error('Invalid authorization storage update');
  const entry = Object.entries(items)[0];
  if (!entry) throw new Error('Missing authorization storage update');
  const [key, value] = entry;
  if (
    !policyKeys.has(key) ||
    !isRecord(value) ||
    typeof value.nonce !== 'string' ||
    !value.nonce ||
    value.nonce.length > 80 ||
    typeof value.accountId !== 'string' ||
    !value.accountId ||
    (value.status !== 'waiting' && value.status !== 'spent') ||
    Object.entries(value).some(
      ([field, data]) =>
        !publicFields.has(field) || (typeof data !== 'string' && (typeof data !== 'number' || !Number.isFinite(data)))
    ) ||
    JSON.stringify(value).length > 8192
  )
    throw new Error('Invalid public authorization metadata');
  return [key, value];
}
async function relay(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response: unknown = await chrome.runtime.sendMessage({
    target: SW_TARGET,
    type: OFFSCREEN_TEST_AUTHORIZATION_STORAGE,
    ...message
  });
  if (!isRecord(response) || response.ok !== true) throw new Error('Authorization storage relay refused');
  return response;
}
export async function getTestAuthorizationStorage(keys: string | string[]): Promise<Record<string, unknown>> {
  const list = keysForRead(keys);
  if (typeof chrome !== 'undefined' && chrome.storage?.local) return chrome.storage.local.get(list);
  if (typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function') {
    const response = await relay({ operation: 'get', keys: list });
    if (!isRecord(response.value)) throw new Error('Invalid authorization storage response');
    return response.value;
  }
  return getStorageProvider().get(list);
}
export async function setTestAuthorizationStorage(items: Record<string, unknown>): Promise<void> {
  publicItem(items);
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set(items);
    return;
  }
  if (typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function') {
    await relay({ operation: 'set', items });
    return;
  }
  await getStorageProvider().set(items);
}

// Offscreen documents have runtime messaging but no storage API; never grant releases over this relay.
export async function handleTestAuthorizationStorage(message: unknown): Promise<Record<string, unknown>> {
  if (process.env.MIDEN_E2E_TEST !== 'true' || !isRecord(message)) throw new Error('Authorization storage disabled');
  const storage = getStorageProvider();
  if (message.operation === 'get') {
    if (!Array.isArray(message.keys) || !message.keys.every(key => typeof key === 'string'))
      throw new Error('Invalid authorization storage request');
    return { ok: true, value: await storage.get(keysForRead(message.keys)) };
  }
  if (message.operation !== 'set') throw new Error('Invalid authorization storage operation');
  const [key, value] = publicItem(message.items);
  const previous: unknown = (await storage.get([key]))[key];
  if (
    !isRecord(previous) ||
    previous.nonce !== value.nonce ||
    previous.accountId !== value.accountId ||
    previous.status !== (value.status === 'waiting' ? 'armed' : 'released')
  )
    throw new Error('Original authorization storage scope changed');
  await storage.set({ [key]: value });
  return { ok: true };
}
