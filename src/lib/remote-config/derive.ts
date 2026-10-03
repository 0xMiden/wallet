import {
  AccountId,
  type AccountProof,
  AccountStorageRequirements,
  BasicFungibleFaucetComponent,
  Endpoint,
  RpcClient,
  SlotAndKeys
} from '@miden-sdk/miden-sdk/lazy';
import { createPublicClient, http, parseAbi } from 'viem';

import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { fetchBoundedJson, type JsonFetch } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';
import { getChain } from 'lib/walletconnect/config';

import type { BridgeConfig, EvmAddress } from './schema';

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

export interface DerivedBridgeConfig {
  network: string;
  version: number; // the document version it was derived from
  derivedAt: number;
  agglayer: {
    rollupId: Probe<number>;
    tokens: Probe<BridgeToken[]>;
    evmNetworkId: Probe<number>;
    l1BridgeCode: Probe<true>;
    indexer: Probe<true>;
  };
  epoch: {
    allocator: Probe<true>;
    midenUsdcFaucet: Probe<TokenMetadata>; // existence and metadata in one read
    evmUsdc: Probe<TokenMetadata>;
  };
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
  /** Rejects with NotDeployedError when the faucet account does not exist. */
  readMidenFaucet(faucetId: string, rpcUrl: string): Promise<TokenMetadata>;
  /** Reads over the wallet's RPC for the chain, or null when the wallet ships none for it. */
  evm(chainId: number): EvmReads | null;
  fetch: JsonFetch;
}

/** A confirmed absence: the node has no such account, or the account at that id is not an AggLayer bridge. */
export class NotDeployedError extends Error {
  name = 'NotDeployedError';
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
 * The id as `AccountId.toString()` prints it: the prefix felt's 8 bytes, then the top 7 bytes of the
 * suffix felt, whose low byte is always 0.
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
    const lo = words.get(wordKey(0n, suffix, prefix)) ?? [];
    const hi = words.get(wordKey(1n, suffix, prefix)) ?? [];
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

// /health is Epoch's liveness route; a service that is down answers 503. The allocator's body is the SDK's
// HealthCheckResponse, whose `status` reads 'healthy' (live, 2026-10-03), so the positions host, whose /health
// answers `{ ok: true }`, is never taken for the allocator. The config repo's validator uses the same predicate.
const isAllocatorHealthy = (body: unknown) => isRecord(body) && body.status === 'healthy';
const isIndexerServing = (body: unknown) => isRecord(body) && body.status === 'SERVING';

async function readMidenFaucet(faucetId: string, rpcUrl: string): Promise<TokenMetadata> {
  await ensureSdkWasmReady();
  const rpc = new RpcClient(new Endpoint(rpcUrl));
  const fetched = await readAccount(faucetId, 'bridge config faucet', () =>
    rpc.getAccountDetails(AccountId.fromHex(faucetId))
  );
  const account = fetched.account();
  if (!account) throw new Error(`${faucetId} has no public state`);
  const faucet = BasicFungibleFaucetComponent.fromAccountStorage(account.storage());
  return { symbol: faucet.symbol().toString(), decimals: faucet.decimals() };
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
  readMidenFaucet,
  evm: viemReads,
  fetch: (url, init) => fetch(url, init)
};

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

/** Every value the document leaves to chain and service reads; a probe's failure never stops another. */
export async function deriveBridgeConfig(
  config: BridgeConfig,
  deps: Partial<DeriveDeps> = {}
): Promise<DerivedBridgeConfig> {
  const io: DeriveDeps = { ...defaultDeps, ...deps };
  const rpcUrl = io.midenRpcUrl();
  const { agglayer, epoch, evm } = config;
  const reads = evm.chainId === undefined ? null : io.evm(evm.chainId);
  const [registry, l1Bridge, indexer, allocator, midenUsdcFaucet, evmUsdc] = await Promise.all([
    when(agglayer.midenBridge, bridge => attempt(() => io.readBridgeRegistry(bridge, rpcUrl))),
    probeL1Bridge(reads, agglayer.l1Bridge),
    when(agglayer.indexerUrl, url => checkHealth(io.fetch, `${url}/healthz`, isIndexerServing)),
    when(epoch.allocatorUrl, url => checkHealth(io.fetch, `${url}/health`, isAllocatorHealthy)),
    when(epoch.midenUsdcFaucet, faucetId => attempt(() => io.readMidenFaucet(faucetId, rpcUrl))),
    probeErc20(reads, epoch.evmUsdc)
  ]);

  let tokens: Probe<BridgeToken[]> = registry.state === 'ok' ? { state: 'ok', value: registry.value.tokens } : registry;
  // A bridge that registers nothing has nothing to bridge, the same as no bridge.
  if (tokens.state === 'ok' && tokens.value.length === 0) tokens = { state: 'absent' };

  return {
    network: config.network,
    version: config.version,
    derivedAt: io.now(),
    agglayer: {
      rollupId: registry.state === 'ok' ? { state: 'ok', value: registry.value.rollupId } : registry,
      tokens,
      evmNetworkId: l1Bridge.networkId,
      l1BridgeCode: l1Bridge.code,
      indexer
    },
    epoch: { allocator, midenUsdcFaucet, evmUsdc }
  };
}
