import {
  AccountId,
  type AccountProof,
  AccountStorageRequirements,
  BasicFungibleFaucetComponent,
  Endpoint,
  RpcClient,
  SlotAndKeys
} from '@miden-sdk/miden-sdk/lazy';
import { createPublicClient, getAddress, http, parseAbi } from 'viem';

import { MIDEN_DESTINATION_CHAIN_ID } from 'lib/epoch/config';
import { earnMarketForVault, type EarnVaultInfo, earnVaultTakesDeposits, readEarnVaults } from 'lib/epoch/pools-read';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { fetchBoundedJson, type JsonFetch } from 'lib/remote-json';
import { loadTokenFaucetsBySymbol } from 'lib/token-list/runtime';
import { isRecord } from 'lib/update/guards';
import { getChain } from 'lib/walletconnect/config';

import {
  type AgglayerDepositTokenConfig,
  type BridgeConfig,
  epochCollateralFaucetId,
  type EpochTokenConfig,
  epochTokenFaucetId,
  type EvmAddress
} from './schema';
import { parseSwapPairs, SWAP_PAIRS_PATH, type SwapPairs, type SwapPairsToken } from './swap-pairs';
import type { EarnMarket } from './values';

export type Probe<T> =
  | { state: 'ok'; value: T }
  | { state: 'absent' } // confirmed missing: no code, no account, empty registry
  | { state: 'error'; message: string } // the call failed or timed out
  | { state: 'skipped' }; // the root it needs is not configured

export interface BridgeToken {
  midenFaucetId: string; // '0x' + 30 lowercase hex
  originToken: EvmAddress; // zero address for native ETH
  originNetwork: number;
  scale: number;
}

export interface TokenMetadata {
  symbol: string;
  decimals: number;
}

/**
 * An Epoch token's contract read, with the Miden faucet the solver settles it into (lowercase hex): the document's
 * output for it, else the token-list's entry for its Miden symbol. Absent when neither names one.
 */
export interface EpochTokenRead extends TokenMetadata {
  midenFaucetId?: string;
}

/**
 * An ERC-20 the deposit picker offers on an AggLayer chain: the document's symbol, the contract's decimals, and the
 * faucet the bridge registry holds for its address, which mints its deliveries at `scale`.
 */
export interface AgglayerDepositToken {
  symbol: string;
  contractAddress: EvmAddress; // lowercase
  decimals: number;
  midenFaucetId: string; // '0x' + 30 lowercase hex
  scale: number;
}

export interface DerivedBridgeConfig {
  network: string;
  version: number; // the document version it was derived from
  derivedAt: number;
  /** Every listed chain's reads, by chain id; a route the chain does not list reads as skipped. */
  chains: Record<number, DerivedChainConfig>;
  // The providers every chain shares.
  agglayer: { indexer: Probe<true> };
  epoch: {
    allocator: Probe<true>;
    market: Probe<EarnMarket>;
    midenUsdcFaucet: Probe<TokenMetadata>; // existence and metadata in one read
    /**
     * The Earn vault catalogue: the listed vaults that the `/pools` catalogue (or the positions fallback) serves,
     * merged over every Epoch route that the list names, in the document's vault order. The derivation reads it and
     * every realm shares the stored copy, so no page reads `/pools`. The same requests give `market`. Skipped when
     * the document names no positions host or lists no vault on an Epoch route; an error when one route read fails.
     */
    vaults: Probe<EarnVaultInfo[]>;
  };
  /** Always set by a derivation; optional in the type so a stand-in snapshot built by a test needs none. */
  swap?: {
    /** The solver's tokens and pairs, read from `swap.etaUrl`. */
    pairs: Probe<SwapPairs>;
  };
}

export interface DerivedChainConfig {
  agglayer: {
    rollupId: Probe<number>;
    tokens: Probe<BridgeToken[]>;
    evmNetworkId: Probe<number>;
    l1BridgeCode: Probe<true>;
    /** The document's deposit tokens, each verified against the registry; skipped while the document lists none. */
    depositTokens: Probe<AgglayerDepositToken[]>;
  };
  /** One ERC-20 read per token of the chain's Epoch route, keyed by the symbol the document gives it. */
  epoch: { tokens: Record<string, Probe<EpochTokenRead>> };
}

/** Reads over one EVM chain's RPC. */
export interface EvmReads {
  /** False when the address holds no contract code. */
  hasCode(address: EvmAddress): Promise<boolean>;
  /** The AggLayer bridge's `networkID()`. */
  networkId(l1Bridge: EvmAddress): Promise<number>;
  /** ERC-20 `symbol()` and `decimals()`. */
  erc20(token: EvmAddress): Promise<TokenMetadata>;
}

/** Injectable I/O for derivation; nothing outside derive.ts and its tests constructs one. */
export interface DeriveDeps {
  now(): number;
  /** The Miden RPC every Miden read goes to. */
  midenRpcUrl(): string;
  /** Rejects with NotDeployedError when the bridge account does not exist or is not a bridge. */
  readBridgeRegistry(midenBridge: string, rpcUrl: string): Promise<{ rollupId: number; tokens: BridgeToken[] }>;
  /**
   * Rejects with NotDeployedError when the faucet account does not exist, and with NotAFaucetError when it has no
   * public state or its storage is not a basic fungible faucet's.
   */
  readMidenFaucet(faucetId: string, rpcUrl: string): Promise<TokenMetadata>;
  /** Reads over the wallet's RPC for the chain, or null when the wallet ships none for it. */
  evm(chainId: number): EvmReads | null;
  fetch: JsonFetch;
  /** The verified token-list's faucet per symbol on `network`, as the list spells each id; null with no list. */
  tokenFaucetsBySymbol(network: string): Promise<Map<string, string> | null>;
  /** A Miden account id in any spelling as lowercase hex. */
  midenAccountHex(accountId: string): Promise<string>;
}

/** A confirmed absence: the node has no such account, or the account at that id is not an AggLayer bridge. */
export class NotDeployedError extends Error {
  name = 'NotDeployedError';
}

/**
 * The account exists but is not a public basic fungible faucet. Not a NotDeployedError, so the Earn probe reads it as
 * an error, not as absent.
 */
export class NotAFaucetError extends Error {
  name = 'NotAFaucetError';
}

// The bridge account's layout, the same in miden-agglayer 0.16.1 and 0.17.0
// (asm/agglayer/bridge/bridge_config.masm, register_faucet and load_network_id):
//   network_id           value                    [network_id, 0, 0, 0]
//   faucet_registry_map  [0, 0, suffix, prefix] -> [1, is_native, 0, 0]
//   faucet_metadata_map  [0, 0, suffix, prefix] -> [addr0, addr1, addr2, addr3]
//                        [1, 0, suffix, prefix] -> [addr4, origin_network, scale, 0]
// Each addr limb is four address bytes read as a little-endian u32 (EthAddress::to_elements in
// miden-standards interop/eth/address.rs). A key the map does not hold reads as the empty word, as
// it does for the contract, so native ETH, whose address limbs are all zero, has no sub-key 0 entry.
const NETWORK_ID_SLOT = 'agglayer::bridge::network_id';
const REGISTRY_SLOT = 'agglayer::bridge::faucet_registry_map';
const METADATA_SLOT = 'agglayer::bridge::faucet_metadata_map';
const U32_MAX = 0xffff_ffffn;
// AmountScale is a u8 (asm/agglayer/types.masm).
const SCALE_MAX = 0xffn;

interface MapEntry {
  key: readonly bigint[];
  value: readonly bigint[];
}

const at = (word: readonly bigint[], index: number): bigint => word[index] ?? 0n;
const wordKey = (sub: bigint, suffix: bigint, prefix: bigint) => `${sub}:0:${suffix}:${prefix}`;
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The id in the hex form `AccountId.fromHex` parses: the prefix felt's 8 bytes, then the top 7 bytes of the
 * suffix felt, whose low byte is always 0. A reader compares it with another id through the SDK, never as text.
 */
function accountIdHex(prefix: bigint, suffix: bigint): string {
  return `0x${prefix.toString(16).padStart(16, '0')}${(suffix >> 8n).toString(16).padStart(14, '0')}`;
}

function originAddress(limbs: readonly bigint[]): EvmAddress {
  const bytes = limbs.map(limb => {
    const hex = limb.toString(16).padStart(8, '0');
    return `${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`;
  });
  return `0x${bytes.join('')}`;
}

function decodeRegistry(
  networkId: readonly bigint[],
  registry: readonly MapEntry[],
  metadata: readonly MapEntry[]
): { rollupId: number; tokens: BridgeToken[] } {
  const rollupId = at(networkId, 0);
  if (rollupId > U32_MAX) throw new Error('The bridge network id is not a u32');
  const words = new Map(metadata.map(entry => [entry.key.join(':'), entry.value]));
  const tokens: BridgeToken[] = [];
  for (const { key, value } of registry) {
    // syncStorageMaps reports a deregistered faucet's key with the empty word.
    if (at(value, 0) !== 1n) continue;
    const suffix = at(key, 2);
    const prefix = at(key, 3);
    // Only the sub-key 0 word may be missing (native ETH). Without sub-key 1 there is no origin or scale on record,
    // and zeros would decode as native ETH, which prices bridged ETH and is trusted as the delivery sender.
    const hi = words.get(wordKey(1n, suffix, prefix));
    if (!hi) continue;
    const lo = words.get(wordKey(0n, suffix, prefix)) ?? [];
    const limbs = [at(lo, 0), at(lo, 1), at(lo, 2), at(lo, 3), at(hi, 0)];
    const originNetwork = at(hi, 1);
    const scale = at(hi, 2);
    if (limbs.some(limb => limb > U32_MAX) || originNetwork > U32_MAX || scale > SCALE_MAX) continue;
    tokens.push({
      midenFaucetId: accountIdHex(prefix, suffix),
      originToken: originAddress(limbs),
      originNetwork: Number(originNetwork),
      scale: Number(scale)
    });
  }
  return { rollupId: Number(rollupId), tokens };
}

/** Runs a read of `accountId` at the chain tip; the node's not-found for that account becomes NotDeployedError. */
async function readAccount<T>(accountId: string, label: string, read: () => Promise<T>): Promise<T> {
  try {
    return await withRpcTimeout(read, label);
  } catch (err) {
    // miden-node GetAccountError::AccountNotFound (crates/store/src/errors.rs), through the SDK's
    // "invalid request parameters" wrapper.
    const missing = /account (0x[0-9a-f]+) not found at block \d+/i.exec(errorMessage(err));
    if (missing?.[1]?.toLowerCase() === accountId.toLowerCase()) {
      throw new NotDeployedError(`${accountId} does not exist`);
    }
    throw err;
  }
}

function bridgeNetworkId(proof: AccountProof, bridge: string): bigint[] {
  const value = proof.getStorageSlotValue(NETWORK_ID_SLOT);
  if (!value) throw new NotDeployedError(`${bridge} is not an AggLayer bridge`);
  return Array.from(value.toU64s());
}

/** The map's entries, or null when it was too large to come back in the proof. */
function mapEntries(proof: AccountProof, slot: string, bridge: string): MapEntry[] | null {
  if (proof.hasStorageMapTooManyEntries(slot)) return null;
  const entries = proof.getStorageMapEntries(slot);
  if (!entries) throw new NotDeployedError(`${bridge} has no ${slot}`);
  return entries.map(entry => ({ key: Array.from(entry.key().toU64s()), value: Array.from(entry.value().toU64s()) }));
}

/** The bridge's AggLayer network id and every faucet its registry lists, both maps read whole. */
export async function readBridgeRegistry(
  midenBridge: string,
  rpcUrl: string
): Promise<{ rollupId: number; tokens: BridgeToken[] }> {
  await ensureSdkWasmReady();
  const rpc = new RpcClient(new Endpoint(rpcUrl));
  // The SDK takes these arguments by value and frees them, so each attempt, a retry included, builds its own.
  const proof = await readAccount(midenBridge, 'agglayer bridge registry', () =>
    rpc.getAccountProof(
      AccountId.fromHex(midenBridge),
      AccountStorageRequirements.fromSlotAndKeysArray([
        new SlotAndKeys(REGISTRY_SLOT, []),
        new SlotAndKeys(METADATA_SLOT, [])
      ])
    )
  );
  const networkId = bridgeNetworkId(proof, midenBridge);
  const registry = mapEntries(proof, REGISTRY_SLOT, midenBridge);
  const metadata = mapEntries(proof, METADATA_SLOT, midenBridge);
  if (registry && metadata) return decodeRegistry(networkId, registry, metadata);

  // syncStorageMaps returns every map slot of the account (on testnet that is about 1,700 entries,
  // most of them ger_map), so it is the fallback, not the default. The client pages it to the tip.
  const synced = await withRpcTimeout(
    () => rpc.syncStorageMaps(0, undefined, AccountId.fromHex(midenBridge)),
    'agglayer bridge storage maps'
  );
  const updates = synced.updates().map(update => ({
    slot: update.slotName(),
    key: Array.from(update.key().toU64s()),
    value: Array.from(update.value().toU64s())
  }));
  return decodeRegistry(
    networkId,
    updates.filter(update => update.slot === REGISTRY_SLOT),
    updates.filter(update => update.slot === METADATA_SLOT)
  );
}

const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_MAX_BYTES = 32 * 1_024;
const EVM_TIMEOUT_MS = 10_000;
const L1_BRIDGE_ABI = parseAbi(['function networkID() view returns (uint32)']);
const ERC20_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

// /health is Epoch's liveness route; a service that is down answers 503. The allocator body is the SDK's
// HealthCheckResponse. It is admitted only when `status` is exactly `healthy` and the body would pass
// `resolveServiceConfiguration` (epoch-intents-sdk 2.0.1) for every chain this document can hand the SDK: each
// supported chain that names an Epoch token, plus the Miden destination chain. The positions host, whose /health
// answers `{ ok: true }`, is never taken for the allocator.
function epochSdkChainIds(config: BridgeConfig): number[] {
  const chainIds = Object.values(config.supportedEvmChains).flatMap(chain =>
    chain.bridges.epoch ? [chain.chainId] : []
  );
  return [...new Set([...chainIds, MIDEN_DESTINATION_CHAIN_ID])];
}

function isAllocatorHealthy(body: unknown, chainIds: readonly number[]): boolean {
  if (!isRecord(body) || body.status !== 'healthy') return false;
  for (const chainId of chainIds) {
    admitServiceAddress(body.allocatorAddresses, chainId, 'allocator address');
    admitServiceAddress(body.arbiterAddresses, chainId, 'arbiter address');
    admitServiceAddress(body.compactAddresses, chainId, 'Compact address');
  }
  // Same numeric bounds as `resolveServiceConfiguration` in @epoch-protocol/epoch-intents-sdk.
  admitSdkInteger(body.compactLockResetPeriod, 'compactLockResetPeriod', 0, 7);
  admitSdkInteger(body.compactLockScope, 'compactLockScope', 0, 1);
  admitSdkInteger(body.compactExpirySeconds, 'compactExpirySeconds', 1, Number.MAX_SAFE_INTEGER);
  admitSdkInteger(body.compactExpiryBufferSeconds, 'compactExpiryBufferSeconds', 1, Number.MAX_SAFE_INTEGER);
  admitSdkInteger(body.midenRecallBufferBlocks, 'midenRecallBufferBlocks', 0);
  admitSdkInteger(body.midenVirtualChainId, 'midenVirtualChainId', 1);
  admitSdkInteger(body.midenTestnetVirtualChainId, 'midenTestnetVirtualChainId', 1);
  admitSdkInteger(body.midenMainnetVirtualChainId, 'midenMainnetVirtualChainId', 1);
  return true;
}

function admitServiceAddress(map: unknown, chainId: number, label: string): void {
  const value = isRecord(map) ? map[String(chainId)] : undefined;
  if (typeof value !== 'string') throw new Error(`allocator /health has no ${label} for chain ${chainId}`);
  try {
    getAddress(value);
  } catch {
    throw new Error(`allocator /health returned an invalid ${label} for chain ${chainId}`);
  }
}

function admitSdkInteger(value: unknown, name: string, min: number, max?: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new Error(`allocator /health returned invalid ${name}`);
  }
}

const isIndexerServing = (body: unknown) => isRecord(body) && body.status === 'SERVING';

const SWAP_PAIRS_TIMEOUT_MS = 10_000;
const SWAP_PAIRS_MAX_BYTES = 64 * 1_024;
// The derivation settles only once every probe has. Each faucet read is bounded, but a long enough list read four at a
// time is not, so the list is capped and its verification bounded as a whole.
const SWAP_PAIRS_MAX_TOKENS = 64;
const SWAP_PAIRS_VERIFY_TIMEOUT_MS = 30_000;
const SWAP_FAUCET_READS_AT_ONCE = 4;

type FaucetRead = (faucetId: string) => Promise<TokenMetadata>;

// The solver's decimals convert typed amounts into the swap note's base units, so a token is kept only at its faucet's
// on-chain scale. A faucet that is missing or not a fungible faucet costs only its own listing; any other failure fails
// the read, so the registry last verified stays in use rather than one at an unchecked scale.
// `stop.expired` is set once the caller's deadline has failed the probe: no batch starts after that, while one already
// started finishes on its own per-read bounds and its result is discarded.
async function verifyOnChain(
  listed: SwapPairs,
  readFaucet: FaucetRead,
  stop: { expired: boolean }
): Promise<SwapPairs> {
  const verified = new Set<string>();
  const verify = async (token: SwapPairsToken) => {
    try {
      if ((await readFaucet(token.faucetId)).decimals === token.decimals) verified.add(token.faucetId);
    } catch (err) {
      if (!(err instanceof NotDeployedError || err instanceof NotAFaucetError)) throw err;
    }
  };
  for (let start = 0; start < listed.tokens.length; start += SWAP_FAUCET_READS_AT_ONCE) {
    if (stop.expired) break;
    await Promise.all(listed.tokens.slice(start, start + SWAP_FAUCET_READS_AT_ONCE).map(verify));
  }
  return {
    tokens: listed.tokens.filter(token => verified.has(token.faucetId)),
    pairs: listed.pairs.filter(pair => pair.faucetIds.every(id => verified.has(id)))
  };
}

// The solver answers 503 `not_ready` for a moment after it starts. That is an error here, so a registry read before
// stays in use (see keepValuesRead in runtime.ts).
function readSwapPairs(fetchFn: JsonFetch, etaUrl: string, readFaucet: FaucetRead): Promise<Probe<SwapPairs>> {
  return attempt(async () => {
    const url = `${etaUrl}${SWAP_PAIRS_PATH}`;
    const body = await fetchBoundedJson(fetchFn, url, {
      maxBytes: SWAP_PAIRS_MAX_BYTES,
      timeoutMs: SWAP_PAIRS_TIMEOUT_MS
    });
    const pairs = parseSwapPairs(body);
    if (!pairs) throw new Error(`${url} answered an unexpected body`);
    if (pairs.tokens.length > SWAP_PAIRS_MAX_TOKENS) {
      throw new Error(
        `${url} lists ${pairs.tokens.length} tokens, more than the ${SWAP_PAIRS_MAX_TOKENS} the wallet verifies`
      );
    }
    const stop = { expired: false };
    try {
      return await withRpcTimeout(() => verifyOnChain(pairs, readFaucet, stop), 'swap pairs faucet verification', {
        timeoutMs: SWAP_PAIRS_VERIFY_TIMEOUT_MS,
        retries: 0
      });
    } catch (err) {
      stop.expired = true;
      throw err;
    }
  });
}

export async function readMidenFaucetMetadata(faucetId: string, rpcUrl: string): Promise<TokenMetadata> {
  if (!/^0x[0-9a-f]{30}$/i.test(faucetId) || !rpcUrl || rpcUrl.length > 2048) {
    throw new Error('Invalid Miden faucet metadata request');
  }
  await ensureSdkWasmReady();
  const rpc = new RpcClient(new Endpoint(rpcUrl));
  const fetched = await readAccount(faucetId, 'bridge config faucet', () =>
    rpc.getAccountDetails(AccountId.fromHex(faucetId))
  );
  const account = fetched.account();
  if (!account) throw new NotAFaucetError(`${faucetId} has no public state`);
  let faucet: BasicFungibleFaucetComponent;
  try {
    faucet = BasicFungibleFaucetComponent.fromAccountStorage(account.storage());
  } catch (err) {
    if (err instanceof WebAssembly.RuntimeError) throw err;
    throw new NotAFaucetError(`${faucetId} is not a basic fungible faucet: ${errorMessage(err)}`);
  }
  return { symbol: faucet.symbol().toString(), decimals: faucet.decimals() };
}

// One read per faucet per derivation: the Earn probe and the swap registry can name the same faucet.
function sharedFaucetReads(io: DeriveDeps, rpcUrl: string): FaucetRead {
  const reads = new Map<string, Promise<TokenMetadata>>();
  return faucetId => {
    const read = reads.get(faucetId) ?? io.readMidenFaucet(faucetId, rpcUrl);
    reads.set(faucetId, read);
    return read;
  };
}

/** Reads over the RPC the wallet's own reads of that chain use (walletconnect/config.ts), E2E override included. */
function viemReads(chainId: number): EvmReads | null {
  const rpcUrl = getChain(chainId)?.rpcUrl;
  if (!rpcUrl) return null;
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: EVM_TIMEOUT_MS, retryCount: 1 }) });
  return {
    hasCode: async address => {
      const code = await client.getCode({ address });
      return code !== undefined && code !== '0x';
    },
    networkId: address => client.readContract({ address, abi: L1_BRIDGE_ABI, functionName: 'networkID' }),
    erc20: async address => {
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }),
        client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' })
      ]);
      return { symbol, decimals };
    }
  };
}

const defaultDeps: DeriveDeps = {
  now: () => Date.now(),
  midenRpcUrl: () => getEffectiveRpcUrl(),
  readBridgeRegistry,
  readMidenFaucet: readMidenFaucetMetadata,
  evm: viemReads,
  fetch: (url, init) => fetch(url, init),
  tokenFaucetsBySymbol: loadTokenFaucetsBySymbol,
  midenAccountHex
};

async function midenAccountHex(accountId: string): Promise<string> {
  if (/^0x[0-9a-f]{30}$/i.test(accountId)) return accountId.toLowerCase();
  await ensureSdkWasmReady();
  return accountRefToSdk(accountId).toString().toLowerCase();
}

async function attempt<T>(read: () => Promise<T>): Promise<Probe<T>> {
  try {
    return { state: 'ok', value: await read() };
  } catch (err) {
    return err instanceof NotDeployedError ? { state: 'absent' } : { state: 'error', message: errorMessage(err) };
  }
}

function when<R, T>(root: R | undefined, probe: (root: R) => Promise<Probe<T>>): Promise<Probe<T>> {
  return root === undefined ? Promise.resolve<Probe<T>>({ state: 'skipped' }) : probe(root);
}

function checkHealth(fetchFn: JsonFetch, url: string, healthy: (body: unknown) => boolean): Promise<Probe<true>> {
  return attempt(async (): Promise<true> => {
    const body = await fetchBoundedJson(fetchFn, url, { maxBytes: HEALTH_MAX_BYTES, timeoutMs: HEALTH_TIMEOUT_MS });
    if (!healthy(body)) throw new Error(`${url} answered an unexpected body`);
    return true;
  });
}

function checkCode(reads: EvmReads, address: EvmAddress): Promise<Probe<true>> {
  return attempt(async (): Promise<true> => {
    if (!(await reads.hasCode(address))) throw new NotDeployedError(`${address} has no code`);
    return true;
  });
}

async function probeL1Bridge(
  reads: EvmReads | null,
  l1Bridge: EvmAddress | undefined
): Promise<{ code: Probe<true>; networkId: Probe<number> }> {
  if (!reads || !l1Bridge) return { code: { state: 'skipped' }, networkId: { state: 'skipped' } };
  const code = await checkCode(reads, l1Bridge);
  if (code.state !== 'ok') return { code, networkId: code };
  return { code, networkId: await attempt(() => reads.networkId(l1Bridge)) };
}

async function probeErc20(reads: EvmReads | null, token: EvmAddress | undefined): Promise<Probe<TokenMetadata>> {
  if (!reads || !token) return { state: 'skipped' };
  const code = await checkCode(reads, token);
  return code.state === 'ok' ? attempt(() => reads.erc20(token)) : code;
}

// The token-list's faucets by symbol. A list that cannot be read names no faucet: an Epoch token then has none, which
// keeps it off the routes that need one and costs nothing else.
async function readTokenFaucets(io: DeriveDeps, network: string): Promise<Map<string, string>> {
  try {
    return (await io.tokenFaucetsBySymbol(network)) ?? new Map();
  } catch {
    return new Map();
  }
}

/**
 * An Epoch token's ERC-20 read, with the Miden faucet it settles into: the document's output for it, else the
 * token-list's faucet for its Miden symbol (its key when the document names none). A faucet that cannot be resolved
 * leaves the read without one; it never fails the read.
 */
async function probeEpochToken(
  reads: EvmReads | null,
  config: BridgeConfig,
  symbol: string,
  token: EpochTokenConfig,
  tokenFaucets: Promise<Map<string, string>>,
  io: DeriveDeps
): Promise<Probe<EpochTokenRead>> {
  const read = await probeErc20(reads, token.contractAddress);
  if (read.state !== 'ok') return read;
  const listed = epochTokenFaucetId(config, token) ?? (await tokenFaucets).get(token.midenSymbol ?? symbol);
  if (listed === undefined) return read;
  try {
    return { state: 'ok', value: { ...read.value, midenFaucetId: await io.midenAccountHex(listed) } };
  } catch {
    return read;
  }
}

/** Every read of `reads` settled, under the same keys. A read never rejects: a failure is its probe's error state. */
async function settleEach<T>(reads: Record<string, Promise<Probe<T>>>): Promise<Record<string, Probe<T>>> {
  const entries = await Promise.all(Object.entries(reads).map(async ([key, read]) => [key, await read] as const));
  return Object.fromEntries(entries);
}

// The derivation settles only once every probe has, so the list a document may name is capped.
const DEPOSIT_TOKENS_MAX = 16;

/**
 * The document's deposit tokens the registry confirms: a token is kept only when the bridge holds a faucet for its
 * address on this chain's network, and at the decimals its contract reports, since the deposit converts the typed
 * amount with them. A token the registry does not hold, or whose address has no code, costs only its own listing; a
 * failed contract read fails the probe, so no token is offered at an unchecked scale. Nothing to offer is `absent`.
 * On a test network the picker offers the connected wallet's holdings as well (lib/agglayer/token-holdings.ts).
 */
async function probeDepositTokens(
  reads: EvmReads | null,
  listed: Record<string, AgglayerDepositTokenConfig> | undefined,
  registry: Probe<{ rollupId: number; tokens: BridgeToken[] }>,
  evmNetworkId: Probe<number>
): Promise<Probe<AgglayerDepositToken[]>> {
  const entries = Object.entries(listed ?? {});
  if (!reads || entries.length === 0) return { state: 'skipped' };
  if (registry.state !== 'ok') return registry;
  if (evmNetworkId.state !== 'ok') return evmNetworkId;
  if (entries.length > DEPOSIT_TOKENS_MAX) {
    return {
      state: 'error',
      message: `The document lists ${entries.length} deposit tokens, more than the ${DEPOSIT_TOKENS_MAX} the wallet verifies`
    };
  }
  const networkId = evmNetworkId.value;
  const registered = registry.value.tokens;
  return attempt(async () => {
    const tokens = await Promise.all(
      entries.map(async ([symbol, { contractAddress }]): Promise<AgglayerDepositToken | null> => {
        const faucet = registered.find(
          token => token.originToken === contractAddress && token.originNetwork === networkId
        );
        if (!faucet) return null;
        const metadata = await probeErc20(reads, contractAddress);
        switch (metadata.state) {
          case 'ok':
            return {
              symbol,
              contractAddress,
              decimals: metadata.value.decimals,
              midenFaucetId: faucet.midenFaucetId,
              scale: faucet.scale
            };
          case 'absent':
            return null;
          case 'error':
            throw new Error(`${symbol} at ${contractAddress}: ${metadata.message}`);
          case 'skipped':
          default:
            throw new Error(`${symbol} at ${contractAddress}: the chain has no reads`);
        }
      })
    );
    const verified = tokens.filter((token): token is AgglayerDepositToken => token !== null);
    if (verified.length === 0) throw new NotDeployedError('no listed deposit token is registered on the bridge');
    return verified;
  });
}

type EvmUsdcRead = (chainId: number) => Promise<Probe<TokenMetadata>>;

// A deposit mandates the market's chain and token, so only an Epoch route's own USDC can be the market, and only a
// market the document lists (`earn.vaults`). The vault catalogue (`/pools`, else the zero account's positions on a
// host with no `/pools` route) of each route the list names is read; a route it does not name is not read. The
// positions fallback names no token, so it takes the symbol and decimals from the route's own USDC read when that
// read succeeds. The vaults of every route are merged in the list's order, and one failed route read fails the
// catalogue and the market. The market is the first listed vault that the document keeps open and the catalogue
// opens, else the first listed vault that the catalogue serves.
async function discoverEarnVaults(
  config: BridgeConfig,
  io: DeriveDeps,
  readEvmUsdc: EvmUsdcRead
): Promise<{ vaults: Probe<EarnVaultInfo[]>; market: Probe<EarnMarket> }> {
  const positionsUrl = config['bridge-providers'].epoch.positionsUrl;
  const listed = config.earn?.vaults ?? [];
  const routes = Object.values(config.supportedEvmChains).flatMap(chain => {
    const usdc = chain.bridges.epoch?.tokens.USDC?.contractAddress;
    return usdc ? [{ chainId: chain.chainId, usdc: getAddress(usdc) }] : [];
  });
  const listedRoutes = routes.filter(route =>
    listed.some(vault => vault.marketUid.endsWith(`:${route.chainId}:${route.usdc.toLowerCase()}`))
  );
  if (!positionsUrl || listedRoutes.length === 0) return { vaults: { state: 'skipped' }, market: { state: 'skipped' } };
  const vaults = await attempt(async () => {
    const reads = await Promise.allSettled(
      listedRoutes.map(async route => {
        const usdc = await readEvmUsdc(route.chainId);
        return readEarnVaults(
          io.fetch,
          {
            positionsUrl,
            chainId: route.chainId,
            underlying: route.usdc,
            listed,
            ...(usdc.state === 'ok'
              ? { fallbackUnderlying: { symbol: usdc.value.symbol, decimals: usdc.value.decimals } }
              : {})
          },
          HEALTH_TIMEOUT_MS
        );
      })
    );
    // The document's list order decides, across every route. Chain order in `supportedEvmChains` says nothing about
    // which vault comes first.
    const order = new Map(listed.map((vault, index) => [vault.marketUid, index]));
    const rank = (vault: EarnVaultInfo): number => order.get(vault.marketUid.toLowerCase()) ?? listed.length;
    return reads
      .flatMap(read => {
        if (read.status === 'rejected') throw read.reason;
        return read.value.vaults;
      })
      .sort((a, b) => rank(a) - rank(b));
  });
  if (vaults.state !== 'ok') return { vaults, market: vaults };
  const market = await attempt(async () => {
    const best = vaults.value.find(earnVaultTakesDeposits) ?? vaults.value[0];
    if (best) return earnMarketForVault(best);
    throw new NotDeployedError('Epoch has no supported USDC market');
  });
  return { vaults, market };
}

/** Every value the document leaves to chain and service reads; a probe's failure never stops another. */
export async function deriveBridgeConfig(
  config: BridgeConfig,
  deps: Partial<DeriveDeps> = {}
): Promise<DerivedBridgeConfig> {
  const io: DeriveDeps = { ...defaultDeps, ...deps };
  const rpcUrl = io.midenRpcUrl();
  const providers = config['bridge-providers'];
  const epoch = providers.epoch;
  const faucetId = epochCollateralFaucetId(config);
  const readFaucet = sharedFaucetReads(io, rpcUrl);
  const supportedChains = Object.values(config.supportedEvmChains);
  const evmReads = new Map(supportedChains.map(chain => [chain.chainId, io.evm(chain.chainId)]));
  // One read per Epoch token per chain. The route's USDC read is also the token of the Earn catalogue's positions
  // fallback on that route.
  const tokenFaucets = readTokenFaucets(io, config.network);
  const epochTokenReads = new Map(
    supportedChains.map(chain => [
      chain.chainId,
      Object.fromEntries(
        Object.entries(chain.bridges.epoch?.tokens ?? {}).map(([symbol, token]) => [
          symbol,
          probeEpochToken(evmReads.get(chain.chainId) ?? null, config, symbol, token, tokenFaucets, io)
        ])
      )
    ])
  );
  const readEvmUsdc: EvmUsdcRead = chainId =>
    epochTokenReads.get(chainId)?.USDC ?? Promise.resolve<Probe<TokenMetadata>>({ state: 'skipped' });
  const [earn, allocator, midenUsdcFaucet, indexer, swapPairs] = await Promise.all([
    discoverEarnVaults(config, io, readEvmUsdc),
    when(epoch.allocatorUrl, url =>
      checkHealth(io.fetch, `${url}/health`, body => isAllocatorHealthy(body, epochSdkChainIds(config)))
    ),
    when(faucetId, id => attempt(() => readFaucet(id))),
    when(providers.agglayer.indexerUrl, url => checkHealth(io.fetch, `${url}/healthz`, isIndexerServing)),
    when(config.swap?.etaUrl, url => readSwapPairs(io.fetch, url, readFaucet))
  ]);
  const chains: Record<number, DerivedChainConfig> = {};
  await Promise.all(
    supportedChains.map(async chain => {
      const reads = evmReads.get(chain.chainId) ?? null;
      const agglayer = chain.bridges.agglayer;
      const [registry, l1Bridge, epochTokens] = await Promise.all([
        when(agglayer?.midenBridgeId, bridge => attempt(() => io.readBridgeRegistry(bridge, rpcUrl))),
        probeL1Bridge(reads, agglayer?.contractAddress),
        settleEach(epochTokenReads.get(chain.chainId) ?? {})
      ]);
      let tokens: Probe<BridgeToken[]> =
        registry.state === 'ok' ? { state: 'ok', value: registry.value.tokens } : registry;
      if (tokens.state === 'ok' && tokens.value.length === 0) tokens = { state: 'absent' };
      const depositTokens = await probeDepositTokens(reads, agglayer?.tokens, registry, l1Bridge.networkId);
      chains[chain.chainId] = {
        agglayer: {
          rollupId: registry.state === 'ok' ? { state: 'ok', value: registry.value.rollupId } : registry,
          tokens,
          evmNetworkId: l1Bridge.networkId,
          l1BridgeCode: l1Bridge.code,
          depositTokens
        },
        epoch: { tokens: epochTokens }
      };
    })
  );
  return {
    network: config.network,
    version: config.version,
    derivedAt: io.now(),
    chains,
    agglayer: { indexer },
    epoch: { allocator, market: earn.market, midenUsdcFaucet, vaults: earn.vaults },
    swap: { pairs: swapPairs }
  };
}
