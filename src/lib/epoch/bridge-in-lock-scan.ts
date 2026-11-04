import { createLockTag, getAllocatorId, getTokenId } from '@epoch-protocol/epoch-intents-sdk';
import { resolveServiceConfiguration } from '@epoch-protocol/epoch-intents-sdk/dist/services/shared.js';
import { type Address, createPublicClient, createWalletClient, getAddress, http, isAddress, parseAbi } from 'viem';

import type { IBridgedReceiveExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { initBridgeConfig } from 'lib/remote-config/runtime';
import { type EpochToken, selectEpochChainIds, selectEpochTokens } from 'lib/remote-config/values';

import { epochRpcChain } from './client';

const EVM_READ_TIMEOUT_MS = 10_000;

/** The two Compact reads that the scan and the lock page do. Both are views, so they need no wallet. */
export const COMPACT_READ_ABI = parseAbi([
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function getForcedWithdrawalStatus(address account, uint256 id) view returns (uint8, uint256)'
]);

const TOKEN_MASK = (1n << 160n) - 1n;

/**
 * The id of the Compact lock that holds the Fast deposits of `token` (the zero address for the native coin). The id
 * is the allocator's lock tag over the token: `(lockTag << 160) | token`, with
 * `lockTag = (scope << 95) | (resetPeriod << 92) | allocatorId`. The SDK helpers do the arithmetic, so the id is the
 * one that a deposit through the SDK used.
 */
export function compactLockId(allocator: Address, resetPeriod: number, scope: number, token: string): bigint {
  const lockTag = createLockTag(BigInt(resetPeriod), BigInt(scope), getAllocatorId(allocator));
  return getTokenId(lockTag, BigInt(token));
}

/** The token of lock `lockId`: its low 160 bits, checksummed. The zero address is the native coin. */
export function compactLockToken(lockId: string | bigint): Address {
  const token = BigInt(lockId) & TOKEN_MASK;
  return getAddress(`0x${token.toString(16).padStart(40, '0')}`);
}

/** What the allocator's `/health` says about the locks of one chain. */
export interface CompactLockConfig {
  chainId: number;
  compact: Address;
  allocator: Address;
  resetPeriod: number;
  scope: number;
}

/** Read the Compact and the lock settings of the allocator at `allocatorUrl` on `chainId`. */
export async function readCompactLockConfig(allocatorUrl: string, chainId: number): Promise<CompactLockConfig> {
  const chain = epochRpcChain(chainId);
  // The SDK reads only `apiBaseUrl` here. Its config type also asks for a wallet client, so give it one that cannot sign.
  const walletClient = createWalletClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
  const service = await resolveServiceConfiguration({ apiBaseUrl: allocatorUrl, walletClient }, chainId);
  return {
    chainId,
    compact: service.compactAddress,
    allocator: service.allocatorAddress,
    resetPeriod: service.compactLockResetPeriod,
    scope: service.compactLockScope
  };
}

/** A public client on `chainId`, with the RPC of the Epoch reads. It throws for a chain that the wallet does not know. */
function compactPublicClient(chainId: number) {
  const chain = epochRpcChain(chainId);
  return createPublicClient({
    chain,
    transport: http(chain.rpcUrls.default.http[0], { timeout: EVM_READ_TIMEOUT_MS, retryCount: 0 })
  });
}

/** One balance read. A failed read is never zero: the screen shows "could not check" for it. */
export type LockBalanceRead = { state: 'ok'; balance: bigint } | { state: 'failed' };

const FAILED: LockBalanceRead = { state: 'failed' };

const balanceRead = (value: unknown): LockBalanceRead =>
  typeof value === 'bigint' ? { state: 'ok', balance: value } : FAILED;

interface BalanceCall {
  address: Address;
  abi: typeof COMPACT_READ_ABI;
  functionName: 'balanceOf';
  args: readonly [Address, bigint];
}

const balanceCall = (compact: Address, owner: Address, id: bigint): BalanceCall => ({
  address: compact,
  abi: COMPACT_READ_ABI,
  functionName: 'balanceOf',
  args: [owner, id]
});

/**
 * Read the balance of `owner` in each lock of `ids`, in one multicall when the chain has multicall3, else one call per
 * lock. A failed call gives a failed read for its lock only. A failed multicall gives a failed read for every lock.
 */
async function readLockBalances(chainId: number, compact: Address, owner: Address, ids: readonly bigint[]) {
  if (ids.length === 0) return [];
  const client = compactPublicClient(chainId);
  if (client.chain.contracts?.multicall3 === undefined) {
    return Promise.all(
      ids.map(id =>
        client.readContract(balanceCall(compact, owner, id)).then(balanceRead, (err: unknown) => {
          console.warn('[epoch] Compact lock balance read failed', err);
          return FAILED;
        })
      )
    );
  }
  try {
    const results = await client.multicall({
      contracts: ids.map(id => balanceCall(compact, owner, id)),
      allowFailure: true
    });
    return results.map(result => (result.status === 'success' ? balanceRead(result.result) : FAILED));
  } catch (err) {
    console.warn('[epoch] Compact lock multicall failed', err);
    return ids.map(() => FAILED);
  }
}

/** One token of one chain for one address. */
export interface LockScanEntry {
  chainId: number;
  token: EpochToken;
  /** The lock id, as a decimal string. Absent when the allocator's lock settings could not be read. */
  lockId?: string;
  read: LockBalanceRead;
}

export interface AddressLockScan {
  address: Address;
  entries: LockScanEntry[];
}

interface ScanChain {
  chainId: number;
  tokens: EpochToken[];
  /** Absent when the allocator did not give the lock settings of this chain. */
  config?: CompactLockConfig;
}

async function scanChain(owner: Address, chain: ScanChain): Promise<LockScanEntry[]> {
  const { chainId, config, tokens } = chain;
  if (config === undefined) return tokens.map(token => ({ chainId, token, read: FAILED }));
  const locks = tokens.map(token => ({
    token,
    id: compactLockId(config.allocator, config.resetPeriod, config.scope, token.address)
  }));
  let reads: LockBalanceRead[];
  try {
    reads = await readLockBalances(
      chainId,
      config.compact,
      owner,
      locks.map(lock => lock.id)
    );
  } catch (err) {
    console.warn('[epoch] Compact lock scan failed', chainId, err);
    reads = [];
  }
  return locks.map((lock, index) => ({
    chainId,
    token: lock.token,
    lockId: lock.id.toString(),
    read: reads[index] ?? FAILED
  }));
}

/**
 * Find the Fast bridge-in funds that each address of `addresses` has in The Compact. For every chain with an Epoch
 * route and every token of that route, compute the lock id from the allocator's settings and read the balance, one
 * multicall per chain and address. Return every entry, also the empty and the failed ones: the screen chooses what to
 * show.
 */
export async function scanLockedBridgeFunds(addresses: readonly Address[]): Promise<AddressLockScan[]> {
  if (addresses.length === 0) return [];
  const snapshot = await initBridgeConfig();
  const allocatorUrl = snapshot.config?.['bridge-providers'].epoch.allocatorUrl;
  const chains = await Promise.all(
    selectEpochChainIds(snapshot).map(async (chainId): Promise<ScanChain> => {
      const tokens = selectEpochTokens(snapshot, chainId);
      if (tokens.length === 0 || allocatorUrl === undefined) return { chainId, tokens };
      try {
        return { chainId, tokens, config: await readCompactLockConfig(allocatorUrl, chainId) };
      } catch (err) {
        console.warn('[epoch] Compact lock settings read failed', chainId, err);
        return { chainId, tokens };
      }
    })
  );
  return Promise.all(
    addresses.map(async address => ({
      address,
      entries: (await Promise.all(chains.map(chain => scanChain(address, chain)))).flat()
    }))
  );
}

/**
 * The EVM address of every Fast bridge-in row, once each, in the order of the rows. A row restored from a backup is
 * not used: its contents come from the file.
 */
export async function collectBridgeInSponsors(): Promise<Address[]> {
  const rows = await Repo.transactions.where('type').equals('bridged-receive').toArray();
  const sponsors = rows.flatMap(row => {
    const inputs: IBridgedReceiveExtraInputs | undefined = row.type === 'bridged-receive' ? row.extraInputs : undefined;
    if (inputs?.provider !== 'epoch' || row.restoredFromBackup === true) return [];
    // Not strict: the case of a stored address is not a checksum that the scan must verify.
    if (!isAddress(inputs.sourceAddress, { strict: false })) return [];
    return [getAddress(inputs.sourceAddress)];
  });
  return [...new Set(sponsors)];
}

/** The addresses to scan: the connected EVM wallet first, then the bridge-in addresses, each once. */
export function lockScanAddresses(connected: string | undefined, sponsors: readonly Address[]): Address[] {
  const first = connected !== undefined && isAddress(connected, { strict: false }) ? [getAddress(connected)] : [];
  return [...new Set([...first, ...sponsors])];
}

export type ForcedWithdrawalStatusName = 'Disabled' | 'Pending' | 'Enabled';

/** The on-chain state of one lock. A field is absent when its read failed. */
export interface CompactLockState {
  balance?: bigint;
  withdrawal?: { status: ForcedWithdrawalStatusName; withdrawableAt?: number };
}

function forcedWithdrawalOf(value: unknown): CompactLockState['withdrawal'] {
  if (!Array.isArray(value)) return undefined;
  const [status, at]: unknown[] = value;
  if (typeof at !== 'bigint') return undefined;
  switch (status) {
    case 0:
      return { status: 'Disabled' };
    case 1:
      return { status: 'Pending', withdrawableAt: Number(at) };
    case 2:
      return { status: 'Enabled', withdrawableAt: Number(at) };
    default:
      return undefined;
  }
}

/** Read the balance of `owner` in lock `lockId` on `chainId` and the state of its forced withdrawal. */
export async function readCompactLockState(chainId: number, owner: Address, lockId: bigint): Promise<CompactLockState> {
  const snapshot = await initBridgeConfig();
  const allocatorUrl = snapshot.config?.['bridge-providers'].epoch.allocatorUrl;
  if (allocatorUrl === undefined) return {};
  let compact: Address;
  let client: ReturnType<typeof compactPublicClient>;
  try {
    compact = (await readCompactLockConfig(allocatorUrl, chainId)).compact;
    client = compactPublicClient(chainId);
  } catch (err) {
    console.warn('[epoch] Compact lock settings read failed', chainId, err);
    return {};
  }
  const [balance, withdrawal] = await Promise.allSettled([
    client.readContract(balanceCall(compact, owner, lockId)),
    client.readContract({
      address: compact,
      abi: COMPACT_READ_ABI,
      functionName: 'getForcedWithdrawalStatus',
      args: [owner, lockId]
    })
  ]);
  const balanceValue = balance.status === 'fulfilled' ? balanceRead(balance.value) : FAILED;
  return {
    balance: balanceValue.state === 'ok' ? balanceValue.balance : undefined,
    withdrawal: withdrawal.status === 'fulfilled' ? forcedWithdrawalOf(withdrawal.value) : undefined
  };
}
