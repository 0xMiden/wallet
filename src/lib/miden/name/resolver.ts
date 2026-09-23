/**
 * Miden Name resolver (forward: label -> address, reverse: address -> label).
 *
 * A result is accepted ONLY when the forward map (`domain_to_account`) and the
 * reverse map (`account_to_domain`) agree. When they do not agree, or when a
 * record is missing, the result is null.
 *
 * The domain key of `domain_to_account` is not verified on chain (the maps have
 * no writes yet). The forward read tries the commitment key [c0, c1, 0, 0]
 * first and then the raw domain word.
 *
 * An RPC failure is thrown (not returned as null), so that a caller can show
 * "resolve failed" and not "name not found". Only a found or not-found result
 * goes into the cache.
 */

import { getBech32AddressFromAccountId, walletAccountIdToSdk } from 'lib/miden/sdk/helpers';

import { MIDEN_NAME_SLOTS, type MidenNameConfig, getMidenNameConfig } from './config';
import {
  type AccountIdParts,
  type Felts4,
  accountKeyFelts,
  decodeDomainFelts,
  encodeDomainFelts,
  feltsEqual,
  validateMidenLabel
} from './encoding';
import { MidenNameAbortedError } from './errors';
import { readRegistryStorage } from './reads';
import { accountIdFromParts, decodeAccountWord, idParts, idPartsFromHex, statusKeyFeltsForLabel } from './sdk-words';

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

function sameParts(a: AccountIdParts, b: AccountIdParts): boolean {
  return a.prefix === b.prefix && a.suffix === b.suffix;
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

/** Reverse read: the domain value that `account_to_domain` holds for an account. */
async function reverseLookup(
  config: MidenNameConfig,
  account: AccountIdParts,
  signal: AbortSignal | undefined
): Promise<Felts4> {
  const key = accountKeyFelts(account);
  const storage = await readRegistryStorage(
    config,
    [{ slot: MIDEN_NAME_SLOTS.accountToDomain, keys: [key] }],
    'midenNameResolveReverse'
  );
  throwIfAborted(signal);
  return storage.mapValue(MIDEN_NAME_SLOTS.accountToDomain, key);
}

/**
 * True when a reverse-map value points to the label. The value can be the raw
 * domain word or the commitment key; the layout is not verified on chain yet.
 */
function reverseMatchesLabel(config: MidenNameConfig, value: Felts4, label: string): boolean {
  const registry = idPartsFromHex(config.registryAccountIdHex);
  return feltsEqual(value, encodeDomainFelts(label)) || feltsEqual(value, statusKeyFeltsForLabel(label, registry));
}

/**
 * Resolve a label (without ".miden") to a bech32 address. Return null when the
 * network has no deployment, the label is not valid, the name has no record,
 * or the forward and reverse records do not agree.
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

  const reverse = await reverseLookup(config, account, signal);
  if (!reverseMatchesLabel(config, reverse, label)) {
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

/**
 * Resolve an account (bech32, composite wallet id or hex) to its label (without
 * ".miden"). Return null when there is no record, when the reverse value is not
 * a decodable domain word, or when the forward record does not point back to
 * the same account.
 */
export async function reverseResolveMidenName(
  accountId: string,
  { signal }: ResolveOptions = {}
): Promise<string | null> {
  const config = getMidenNameConfig();
  if (!config) return null;
  throwIfAborted(signal);

  let account: AccountIdParts;
  try {
    account = idParts(walletAccountIdToSdk(accountId));
  } catch {
    return null;
  }

  const cacheKey = `${config.network}|reverse|${account.prefix}:${account.suffix}`;
  const cached = readCache(cacheKey);
  if (cached) return cached.value;

  const reverse = await reverseLookup(config, account, signal);
  const label = decodeDomainFelts(reverse);
  if (label === null) {
    writeCache(cacheKey, null);
    return null;
  }

  const forward = await forwardLookup(config, label, signal);
  const value = forward && sameParts(forward, account) ? label : null;
  writeCache(cacheKey, value);
  return value;
}
