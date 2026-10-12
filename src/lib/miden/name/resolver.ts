/**
 * Miden Name resolver (label -> address).
 *
 * The registry writes `domain_to_account` when it mints a name, and that
 * forward record is the only one the wallet reads: the auto-publication
 * deployment writes no `account_to_domain` entry that the wallet can find, so a
 * name resolves on the forward map alone.
 *
 * The domain key of `domain_to_account` is not verified on chain. The forward
 * read tries the commitment key [c0, c1, 0, 0] first and then the raw domain
 * word (the key the Testnet registry writes).
 *
 * An RPC failure is thrown (not returned as null), so that a caller can show
 * "resolve failed" and not "name not found". Only a found or not-found result
 * goes into the cache.
 */

import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

import { MIDEN_NAME_SLOTS, type MidenNameConfig, getMidenNameConfig } from './config';
import { type AccountIdParts, encodeDomainFelts, validateMidenLabel } from './encoding';
import { MidenNameAbortedError, MidenNameUnsupportedNetworkError } from './errors';
import { readRegistryStorage } from './reads';
import { accountIdFromParts, decodeAccountWord, idPartsFromHex, statusKeyFeltsForLabel } from './sdk-words';

const RESOLVE_CACHE_TTL_MS = 60_000;

interface ResolveOptions {
  signal?: AbortSignal;
}

const resolveCache = new Map<string, { value: string | null; expiresAt: number }>();

/** Clear the resolver cache. Tests use this. */
export function clearMidenNameResolverCache(): void {
  resolveCache.clear();
}

function readCache(key: string): { value: string | null } | undefined {
  const hit = resolveCache.get(key);
  if (!hit) return undefined;
  if (Date.now() >= hit.expiresAt) {
    resolveCache.delete(key);
    return undefined;
  }
  return { value: hit.value };
}

function writeCache(key: string, value: string | null): void {
  resolveCache.set(key, { value, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MidenNameAbortedError();
}

/** Forward read: the account that `domain_to_account` holds for a label. */
async function forwardLookup(
  config: MidenNameConfig,
  label: string,
  signal: AbortSignal | undefined
): Promise<AccountIdParts | null> {
  const registry = idPartsFromHex(config.registryAccountIdHex);
  const commitmentKey = statusKeyFeltsForLabel(label, registry);
  const domainWord = encodeDomainFelts(label);
  const storage = await readRegistryStorage(
    config,
    [{ slot: MIDEN_NAME_SLOTS.domainToAccount, keys: [commitmentKey, domainWord] }],
    'midenNameResolveForward'
  );
  throwIfAborted(signal);
  return (
    decodeAccountWord(storage.mapValue(MIDEN_NAME_SLOTS.domainToAccount, commitmentKey)) ??
    decodeAccountWord(storage.mapValue(MIDEN_NAME_SLOTS.domainToAccount, domainWord))
  );
}

/**
 * The account that the registry record of `label` points to, or null when the
 * registry has no record. No cache: a caller that watches for the record to
 * appear needs the live value.
 */
export async function fetchDomainRecord(label: string): Promise<AccountIdParts | null> {
  const config = getMidenNameConfig();
  if (!config) throw new MidenNameUnsupportedNetworkError(getEffectiveNetworkName());
  return forwardLookup(config, label, undefined);
}

/**
 * The bech32 account that the registry record of `label` points to, or null
 * when the registry has no record. Same read as `fetchDomainRecord`, for
 * callers that compare against a wallet account id.
 */
export async function fetchDomainRecordAccount(label: string): Promise<string | null> {
  const record = await fetchDomainRecord(label);
  return record === null ? null : getBech32AddressFromAccountId(accountIdFromParts(record));
}

/**
 * Resolve a label (without ".miden") to a bech32 address. Return null when the
 * network has no deployment, the label is not valid, or the name has no record.
 *
 * Throws MidenNameAbortedError when the signal aborts, and the RPC error when a
 * read fails.
 */
export async function resolveMidenName(label: string, { signal }: ResolveOptions = {}): Promise<string | null> {
  const config = getMidenNameConfig();
  if (!config || validateMidenLabel(label) !== null) return null;
  throwIfAborted(signal);

  const cacheKey = `${config.network}|forward|${label}`;
  const cached = readCache(cacheKey);
  if (cached) return cached.value;

  const account = await forwardLookup(config, label, signal);
  if (!account) {
    writeCache(cacheKey, null);
    return null;
  }

  let address: string | null;
  try {
    address = getBech32AddressFromAccountId(accountIdFromParts(account));
  } catch {
    // The record holds felts that are not a valid account id.
    address = null;
  }
  writeCache(cacheKey, address);
  return address;
}
