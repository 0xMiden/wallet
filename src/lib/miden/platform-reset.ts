import Dexie, { type Table } from 'dexie';

import { getAccountsWriteQueue } from 'lib/miden/back/accounts-write-queue';
import { hasExtensionRuntime } from 'lib/platform';
import { WalletMessageType } from 'lib/shared/types';
import { decodePlatformBytes, encodePlatformBytes } from 'lib/platform-auth/crypto';
import { PLATFORM_RESET_STORAGE_KEY } from 'lib/platform-auth/types';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

export interface ExtensionResetOptions {
  keepEndpointOverride: boolean;
  targetNetwork?: MIDEN_NETWORK_NAME;
  accessCode?: string;
}
type ResetAuthorization =
  | { id: 'reset'; version: 1; nonce: string; phase: 'pending'; options: ExtensionResetOptions }
  | { id: 'reset'; version: 1; nonce: string; phase: 'complete' };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function optionsFrom(value: unknown): ExtensionResetOptions {
  if (!object(value) || typeof value.keepEndpointOverride !== 'boolean') throw new Error('Invalid reset options');
  const network = Object.values(MIDEN_NETWORK_NAME).find(item => item === value.targetNetwork);
  if ((value.targetNetwork !== undefined && network === undefined) ||
      (value.accessCode !== undefined && typeof value.accessCode !== 'string')) throw new Error('Invalid reset options');
  const result: ExtensionResetOptions = { keepEndpointOverride: value.keepEndpointOverride };
  if (network !== undefined) result.targetNetwork = network;
  if (typeof value.accessCode === 'string') result.accessCode = value.accessCode;
  return result;
}
function authorizationFrom(value: unknown): ResetAuthorization | null {
  if (value === undefined) return null;
  if (!object(value) || value.id !== 'reset' || value.version !== 1 || typeof value.nonce !== 'string' ||
      decodePlatformBytes(value.nonce).length !== 32) throw new Error('Invalid reset authorization');
  const { nonce } = value;
  if (value.phase === 'complete') return { id: 'reset', version: 1, nonce, phase: 'complete' };
  if (value.phase !== 'pending') throw new Error('Invalid reset authorization');
  return { id: 'reset', version: 1, nonce, phase: 'pending', options: optionsFrom(value.options) };
}
async function authorizationTurn<T>(action: (table: Table<unknown, string>) => Promise<T>): Promise<T> {
  const db = new Dexie('miden-platform-unlock-reset');
  db.version(1).stores({ authorization: 'id' });
  const table = db.table<unknown, string>('authorization');
  try { return await db.transaction('rw', table, () => action(table)); }
  finally { db.close(); }
}

export async function authorizeExtensionReset(options: ExtensionResetOptions): Promise<string> {
  const canonical = optionsFrom(options);
  return authorizationTurn(async table => {
    const existing = authorizationFrom(await table.get('reset'));
    if (existing?.phase === 'pending') {
      if (JSON.stringify(existing.options) !== JSON.stringify(canonical)) throw new Error('Another reset is pending');
      return existing.nonce;
    }
    const nonce = encodePlatformBytes(crypto.getRandomValues(new Uint8Array(32)));
    await table.put({ id: 'reset', version: 1, nonce, phase: 'pending', options: canonical });
    return nonce;
  });
}

async function finishResetInTurn(expectedNonce?: string): Promise<void> {
  const authorization = await authorizationTurn(async table => authorizationFrom(await table.get('reset')));
  if (authorization === null) {
    if (expectedNonce !== undefined) throw new Error('Reset authorization unavailable');
    return;
  }
  if (expectedNonce !== undefined && expectedNonce !== authorization.nonce) throw new Error('Reset authorization changed');
  const { nonce } = authorization;
  if (authorization.phase === 'pending') {
    const provider = getStorageProvider();
    await provider.set({ [PLATFORM_RESET_STORAGE_KEY]: { nonce } });
    const { lockForResetInTurn } = await import('lib/miden/back/actions');
    await lockForResetInTurn();
    const { resetStorageDestructive } = await import('lib/miden/reset');
    const { keepEndpointOverride, targetNetwork, accessCode } = authorization.options;
    await resetStorageDestructive({ keepEndpointOverride });
    if (targetNetwork) {
      const { applyEndpointOverride, buildNetworkChoiceOverride } = await import('lib/miden-chain/effective-endpoints');
      await applyEndpointOverride(buildNetworkChoiceOverride(targetNetwork));
    }
    if (accessCode) {
      const { carryMainnetAccessCode } = await import('lib/carried-mainnet-code');
      await carryMainnetAccessCode(accessCode).catch(() => console.warn('Accepted access code could not be kept'));
    }
    await authorizationTurn(async table => {
      const current = authorizationFrom(await table.get('reset'));
      if (current?.nonce !== nonce) throw new Error('Reset authorization changed');
      // A completed nonce is not permission to erase a wallet created after this reset.
      await table.put({ id: 'reset', version: 1, nonce, phase: 'complete' });
    });
  }
  const provider = getStorageProvider();
  const values = await provider.get([PLATFORM_RESET_STORAGE_KEY]);
  const marker: unknown = values[PLATFORM_RESET_STORAGE_KEY];
  if (object(marker) && marker.nonce === nonce) await provider.remove([PLATFORM_RESET_STORAGE_KEY]);
}

export async function performAuthorizedExtensionReset(nonce: string): Promise<void> {
  if (typeof nonce !== 'string' || decodePlatformBytes(nonce).length !== 32) throw new Error('Invalid reset nonce');
  return getAccountsWriteQueue().add(() => finishResetInTurn(nonce));
}
export async function resumeExtensionReset(): Promise<void> {
  const authorization = await authorizationTurn(async table => authorizationFrom(await table.get('reset')));
  if (authorization === null) return;
  if (authorization.phase === 'complete') {
    const values = await getStorageProvider().get([PLATFORM_RESET_STORAGE_KEY]);
    const marker: unknown = values[PLATFORM_RESET_STORAGE_KEY];
    if (!object(marker) || marker.nonce !== authorization.nonce) return;
  }
  return getAccountsWriteQueue().add(() => finishResetInTurn());
}
export async function requestExtensionReset(options: ExtensionResetOptions): Promise<void> {
  if (!['chrome-extension:', 'moz-extension:', 'safari-web-extension:'].includes(globalThis.location?.protocol ?? '')) {
    throw new Error('Extension page required');
  }
  const nonce = await authorizeExtensionReset(options);
  if (!hasExtensionRuntime()) return;
  await getStorageProvider().set({ [PLATFORM_RESET_STORAGE_KEY]: { nonce } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sent = (async () => {
    const { request } = await import('lib/miden/front/client');
    const response = await request({ type: WalletMessageType.PlatformResetRequest, nonce });
    if (response?.type !== WalletMessageType.PlatformResetResponse) throw new Error('Invalid reset response');
  })();
  try {
    await Promise.race([sent, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
