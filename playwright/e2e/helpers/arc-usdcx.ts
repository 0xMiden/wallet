/**
 * Arc Testnet legs of the USDCx live suites: the per-run key and its ledger, Circle's Gateway payout to that key, the
 * deposit back through xReserve, and Circle's attestation of it. Clients and the clock are injectable, so the unit
 * tests replay captured chain data with no network.
 *
 * Never imports usdcx/deposit.ts or executor.ts: they pull in lib/miden/activity and with it the wallet's SDK.
 */
import fs from 'fs';
import path from 'path';
import {
  createPublicClient,
  encodeFunctionData,
  formatLog,
  http,
  isAddressEqual,
  isHex,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  recoverAddress,
  size,
  slice,
  hexToBigInt,
  hexToNumber,
  toHex,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import {
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_DRPC_LOG_CHUNK,
  ARC_KEY_LEDGER_DIR,
  ARC_LOG_CHUNK,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  DEFAULT_ARC_RPCS,
  GATEWAY_MINTER,
  realArcClock,
  USDCX_REMOTE_DOMAIN,
  type ArcClock
} from './usdcx-constants';
import { fetchXReserveAttestations, type XReserveAttestation } from '../../../src/lib/usdcx/attestation';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';

export { realArcClock, type ArcClock } from './usdcx-constants';

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
]);

/** The xReserve reads and the deposit, verified on Arc Testnet (Blockscout ABI of the implementation, 2026-10-10). */
export const XRESERVE_HARNESS_ABI = parseAbi([
  'function paused() view returns (bool)',
  'function domainDepositsPaused(uint32 domain) view returns (bool)',
  'function domainWithdrawalsPaused(uint32 domain) view returns (bool)',
  'function isRemoteDomainRegistered(uint32 remoteDomain) view returns (bool)',
  'function getRemoteToken(uint32 remoteDomain, address localToken) view returns (bytes32)',
  'function getRemoteDomainDepositor(uint32 remoteDomain) view returns (address)',
  'function gatewayMinter() view returns (address)',
  'function depositToRemote(uint256 value, uint32 remoteDomain, bytes32 remoteRecipient, address localToken, uint256 maxFee, bytes hookData)',
  'event DepositedToRemote(address indexed localToken, uint256 value, address indexed localDepositor, bytes32 indexed remoteRecipient, uint32 remoteDomain, bytes32 remoteToken, uint256 maxFee, bytes hookData)',
  'error EnforcedPause()',
  'error DomainDepositsPaused(uint32 domain)',
  'error DomainWithdrawalsPaused(uint32 domain)',
  'error RemoteDomainNotRegistered(uint32 remoteDomain)',
  'error LocalTokenNotRegistered(uint32 remoteDomain, address localToken)',
  'error InvalidDepositAmount(uint256 amount)',
  'error AccountBlocklisted(uint32 remoteDomain, bytes32 remoteAddress)',
  'error ZeroValue()'
]);

const GATEWAY_MINTER_ABI = parseAbi([
  'event AttestationUsed(address indexed token, address indexed recipient, bytes32 indexed transferSpecHash, uint32 sourceDomain, bytes32 sourceDepositor, bytes32 sourceSigner, uint256 value)'
]);

const PAYOUT_POLL_MS = 5_000;
const HEAD_LAG_BUDGET_MS = 60_000;
const RECEIPT_TIMEOUT_MS = 120_000;
const RECEIPT_POLL_MS = 1_000;
const DEPOSIT_INTENT_MAGIC: Hex = '0x5a2e0acd';
const DEPOSIT_INTENT_HEADER_BYTES = 240;

/** Appended to every payout failure but key-moved (spec section 11). */
export const LATE_PAYOUT_NOTE =
  'Arc payouts have arrived up to ~17 h late and one 1 USDCx burn of 2026-10-08 was still unpaid after 45 h; red means a user was not paid in time';
/** Ends a key-moved failure in place of LATE_PAYOUT_NOTE: a spend from the key says nothing about Circle's payout. */
export const KEY_MOVED_NOTE =
  'something spent from the payout key while the gate watched it (a manual sweep, a deposit a killed run left pending, a run that skipped the lock), so this red does not say whether Circle paid';
/** Ends every uncorrelated reason when the key held USDC before the burn, as a key shared across runs does. */
export const PREFUNDED_KEY_NOTE =
  "the key held USDC before this burn, so another credit or spend in the window (an earlier burn's late payout, a manual transfer) breaks the proof: check the key on the explorer and rerun";

function lowerHex(value: string): Hex {
  const lowered = value.toLowerCase();
  if (!isHex(lowered)) throw new Error(`${value} is not hex`);
  return lowered;
}

/** A viem error as one line: its short message, the RPC's own text, and a decoded revert. */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth++, current = current.cause) {
    const short = Reflect.get(current, 'shortMessage');
    const details = Reflect.get(current, 'details');
    const data: unknown = Reflect.get(current, 'data');
    const errorName = data !== null && typeof data === 'object' ? Reflect.get(data, 'errorName') : undefined;
    const errorArgs = data !== null && typeof data === 'object' ? Reflect.get(data, 'args') : undefined;
    const revert =
      typeof errorName === 'string'
        ? `${errorName}(${Array.isArray(errorArgs) ? errorArgs.map(String).join(', ') : ''})`
        : undefined;
    for (const part of [typeof short === 'string' ? short : current.message, details, revert]) {
      const line = typeof part === 'string' ? part.split('\n')[0]?.trim() : undefined;
      if (line && !parts.includes(line)) parts.push(line);
    }
  }
  return parts.length > 0 ? parts.join(' | ') : String(error);
}

function rpcCode(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 6; depth++, current = current.cause) {
    const code = Reflect.get(current, 'code');
    if (typeof code === 'number' && code !== -1) return code;
  }
  return undefined;
}

export interface ArcKey {
  address: Address;
  privateKey: Hex;
}

export function newArcKey(): ArcKey {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
}

export interface ArcKeyLedgerEntry {
  iso: string;
  address: Address;
  privateKey: Hex;
  walletAddress: string;
}

/**
 * Writes the key to `<dir>/<iso with ':' and '.' as '-'>-<address>.json`, mode 0600, before any funds reach it, so a
 * paid run's payout stays recoverable. The directory is created 0700. Returns the path; never logs the key.
 */
export function recordArcKey(
  key: ArcKey,
  walletAddress: string,
  opts: { dir?: string; now?: () => Date } = {}
): string {
  const dir = opts.dir ?? ARC_KEY_LEDGER_DIR;
  const iso = (opts.now ?? (() => new Date()))().toISOString();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${iso.replace(/[:.]/g, '-')}-${key.address}.json`);
  const entry: ArcKeyLedgerEntry = { iso, address: key.address, privateKey: key.privateKey, walletAddress };
  // 'wx': a file that already exists may hold a funded key.
  fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}

/** The endpoints a run reads Arc through: the operator's `--arc-rpc` first, then the defaults, without duplicates. */
export function arcEndpoints(override?: string): string[] {
  if (override === undefined) return [...DEFAULT_ARC_RPCS];
  const first = override.trim();
  if (first === '') throw new Error('E2E_ARC_RPC_URL is set but empty');
  return [first, ...DEFAULT_ARC_RPCS.filter(endpoint => endpoint !== first)];
}

export type ArcPublicClientFactory = (endpoint: string) => PublicClient;

export interface ArcReadDeps {
  endpoints: readonly string[];
  publicClient?: ArcPublicClientFactory;
  clock?: ArcClock;
}

/** Writes sign locally with the key and send raw through the read client, so they need nothing more. */
export type ArcWriteDeps = ArcReadDeps;

function defaultPublicClient(endpoint: string): PublicClient {
  // cacheTime 0: viem caches eth_blockNumber for its polling interval, and every payout cycle needs a fresh head.
  return createPublicClient({
    chain: ARC_TESTNET,
    cacheTime: 0,
    transport: http(endpoint, { retryCount: 0, timeout: 15_000 })
  });
}

function clientFor(deps: ArcReadDeps): ArcPublicClientFactory {
  return deps.publicClient ?? defaultPublicClient;
}

async function onFirstEndpoint<T>(
  deps: ArcReadDeps,
  what: string,
  read: (client: PublicClient, endpoint: string) => Promise<T>
): Promise<T> {
  const failures: string[] = [];
  for (const endpoint of deps.endpoints) {
    try {
      return await read(clientFor(deps)(endpoint), endpoint);
    } catch (error) {
      failures.push(`${endpoint}: ${errorText(error)}`);
    }
  }
  throw new Error(`${what}: no Arc endpoint answered\n  ${failures.join('\n  ') || 'no endpoints'}`);
}

/** USDC balance of `address` at `blockNumber` (default latest), from the first endpoint that answers. */
export async function readArcUsdc(address: Address, deps: ArcReadDeps, blockNumber?: bigint): Promise<bigint> {
  return onFirstEndpoint(deps, `Arc USDC balance of ${address}`, client =>
    client.readContract({ address: ARC_USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [address], blockNumber })
  );
}

export interface ArcUsdcSnapshot {
  endpoint: string;
  blockNumber: bigint;
  balance: bigint;
}

/**
 * The head and `address`'s USDC at exactly that head, both from the first endpoint that answers: a delta-mode payout
 * gate's `fromBlock` and `balanceBefore` must come from one read, or a credit between two reads breaks the delta.
 */
export async function readArcUsdcSnapshot(address: Address, deps: ArcReadDeps): Promise<ArcUsdcSnapshot> {
  return onFirstEndpoint(deps, `Arc USDC snapshot of ${address}`, async (client, endpoint) => {
    const blockNumber = await client.getBlockNumber();
    const balance = await client.readContract({
      address: ARC_USDC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
      blockNumber
    });
    return { endpoint, blockNumber, balance };
  });
}

export interface XReserveDomainState {
  endpoint: string;
  registered: boolean;
  paused: boolean;
  depositsPaused: boolean;
  withdrawalsPaused: boolean;
  /** `getRemoteToken(10007, ARC_USDC)`, lowercase bytes32: the USDCx faucet as xReserve names it. */
  remoteToken: Hex;
  /** `getRemoteDomainDepositor(10007)` padded to a lowercase bytes32, the payout's `sourceDepositor`. */
  depositor: Hex;
  gatewayMinter: Address;
}

/** Miden's domain on Arc's xReserve, all reads on one endpoint. */
export async function readXReserveDomainState(deps: ArcReadDeps): Promise<XReserveDomainState> {
  return onFirstEndpoint(deps, 'xReserve domain state', async (client, endpoint) => {
    const registered = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'isRemoteDomainRegistered',
      args: [USDCX_REMOTE_DOMAIN]
    });
    const paused = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'paused'
    });
    const depositsPaused = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'domainDepositsPaused',
      args: [USDCX_REMOTE_DOMAIN]
    });
    const withdrawalsPaused = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'domainWithdrawalsPaused',
      args: [USDCX_REMOTE_DOMAIN]
    });
    const remoteToken = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'getRemoteToken',
      args: [USDCX_REMOTE_DOMAIN, ARC_USDC]
    });
    const depositor = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'getRemoteDomainDepositor',
      args: [USDCX_REMOTE_DOMAIN]
    });
    const gatewayMinter = await client.readContract({
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'gatewayMinter'
    });
    return {
      endpoint,
      registered,
      paused,
      depositsPaused,
      withdrawalsPaused,
      remoteToken: lowerHex(remoteToken),
      depositor: lowerHex(pad(depositor)),
      gatewayMinter
    };
  });
}

export interface ScannedRange {
  endpoint: string;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface ArcLogScan {
  logs: Log[];
  ranges: ScannedRange[];
}

function isRangeError(error: unknown): boolean {
  return /\branges?\b|too many (blocks|results|logs)|more than \d+ (blocks|results|logs)/i.test(errorText(error));
}

/** eth_getLogs over `fromBlock..toBlock` in `chunk`-block windows, halving the window on a range error down to 1. */
export async function scanArcLogs(
  client: PublicClient,
  endpoint: string,
  query: { address: Address; topics: readonly (Hex | null)[]; fromBlock: bigint; toBlock: bigint; chunk: number }
): Promise<ArcLogScan> {
  const logs: Log[] = [];
  const ranges: ScannedRange[] = [];
  let window = BigInt(Math.max(1, Math.floor(query.chunk)));
  let from = query.fromBlock;
  while (from <= query.toBlock) {
    const to = from + window - 1n < query.toBlock ? from + window - 1n : query.toBlock;
    try {
      const found = await client.request({
        method: 'eth_getLogs',
        params: [{ address: query.address, topics: [...query.topics], fromBlock: toHex(from), toBlock: toHex(to) }]
      });
      logs.push(...found.map(log => formatLog(log)));
      ranges.push({ endpoint, fromBlock: from, toBlock: to });
      from = to + 1n;
    } catch (error) {
      if (!isRangeError(error) || window === 1n) throw error;
      window /= 2n;
    }
  }
  return { logs, ranges };
}

export interface GatewayPayout {
  endpoint: string;
  /** The AttestationUsed value, which equals `balance` less the gate's `balanceBefore`. */
  value: bigint;
  /** The key's USDC at `balanceBlock`. */
  balance: bigint;
  balanceBlock: bigint;
  logBlock: bigint;
  /** The gatewayMint transaction that emitted AttestationUsed. */
  transactionHash: Hash;
  sourceDomain: number;
  sourceDepositor: Hex;
  /** burnUnits - value: Circle's payout fee. */
  fee: bigint;
  /** First read above `balanceBefore` minus the burn's consume time. */
  latencyMs: number;
  ranges: ScannedRange[];
}

export type PayoutGateFailure = 'no-mint' | 'scan-gaps' | 'uncorrelated' | 'key-moved';

export class PayoutGateError extends Error {
  readonly failure: PayoutGateFailure;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    failure: PayoutGateFailure,
    headline: string,
    details: Record<string, string>,
    note: string = LATE_PAYOUT_NOTE
  ) {
    super(
      `${headline}\n${Object.entries(details)
        .map(([key, value]) => `  ${key}: ${value}`)
        .join('\n')}\n${note}`
    );
    this.name = 'PayoutGateError';
    this.failure = failure;
    this.details = details;
  }
}

/** A cycle that saw the payout's balance but could not finish proving it: retried on the next endpoint. */
class PayoutScanMiss extends Error {}

function correlationReason(reason: string, balanceBefore: bigint): string {
  return balanceBefore > 0n ? `${reason}; ${PREFUNDED_KEY_NOTE}` : reason;
}

function logChunkFor(endpoint: string): number {
  try {
    return new URL(endpoint).hostname.includes('drpc') ? ARC_DRPC_LOG_CHUNK : ARC_LOG_CHUNK;
  } catch {
    return ARC_LOG_CHUNK;
  }
}

function describeRanges(ranges: readonly ScannedRange[]): string {
  if (ranges.length === 0) return 'none';
  const byEndpoint = new Map<string, ScannedRange[]>();
  for (const range of ranges) byEndpoint.set(range.endpoint, [...(byEndpoint.get(range.endpoint) ?? []), range]);
  return [...byEndpoint]
    .map(([endpoint, list]) => `${endpoint} ${list.map(range => `${range.fromBlock}-${range.toBlock}`).join(',')}`)
    .join('; ');
}

export interface GatewayPayoutArgs {
  /** The key Circle pays. */
  recipient: Address;
  /** `usdcxBurn.noteId`: Circle's TransferSpec carries it as the salt, so it is in the gatewayMint calldata. */
  burnNoteId: Hex;
  burnUnits: bigint;
  /** The Arc block `balanceBefore` was read at, before the burn was queued; only logs after it count. */
  fromBlock: bigint;
  /** The key's USDC at `fromBlock` (R20(d)); default 0n, an empty key. The payout must be exactly the rise above it. */
  balanceBefore?: bigint;
  /** The burn's consume block time, in ms. */
  consumeTsMs: number;
  /** consumeTsMs + PAYOUT_TIMEOUT_MS. */
  deadlineMs: number;
  /** `readXReserveDomainState().depositor`. */
  depositor: Hex;
  /** `minimumUsdcxPayout(ARC_CHAIN_ID, burnUnits)`, the floor the wallet's own confirmation uses. */
  minimumValue: bigint;
}

interface PayoutState {
  readOk: boolean;
  firstPaidMs?: number;
  lastMiss?: string;
  ranges: ScannedRange[];
  errors: string[];
}

async function payoutCycle(
  client: PublicClient,
  endpoint: string,
  args: GatewayPayoutArgs,
  clock: ArcClock,
  state: PayoutState,
  base: Record<string, string>
): Promise<GatewayPayout | undefined> {
  const balanceBlock = await client.getBlockNumber();
  const balance = await client.readContract({
    address: ARC_USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [args.recipient],
    blockNumber: balanceBlock
  });
  state.readOk = true;
  const before = args.balanceBefore ?? 0n;
  // A head at or below the snapshot block reads the key before the burn: neither a payout nor a spend shows there.
  if (balanceBlock <= args.fromBlock || balance === before) return undefined;
  if (balance < before) {
    throw new PayoutGateError(
      'key-moved',
      `the payout key moved during the payout window: balance ${balance} at block ${balanceBlock} is below ` +
        `${before} at block ${args.fromBlock}`,
      { ...base, endpoint, balanceBlock: String(balanceBlock), balance: String(balance) },
      KEY_MOVED_NOTE
    );
  }
  const firstPaidMs = (state.firstPaidMs ??= clock.now());

  const lagDeadline = clock.now() + HEAD_LAG_BUDGET_MS;
  while ((await client.getBlockNumber()) < balanceBlock) {
    if (clock.now() >= lagDeadline) throw new PayoutScanMiss(`head stayed below ${balanceBlock} for 60 s`);
    await clock.sleep(2_000);
  }
  const scan = await scanArcLogs(client, endpoint, {
    address: GATEWAY_MINTER,
    topics: [ATTESTATION_USED_TOPIC, lowerHex(pad(ARC_USDC)), lowerHex(pad(args.recipient))],
    // balanceOf at fromBlock already counts a log in that block, so the window starts after it.
    fromBlock: args.fromBlock + 1n,
    toBlock: balanceBlock,
    chunk: logChunkFor(endpoint)
  });
  state.ranges.push(...scan.ranges);
  if (scan.logs.length === 0) {
    throw new PayoutScanMiss(`found 0 AttestationUsed logs after block ${args.fromBlock} up to block ${balanceBlock}`);
  }
  const where = {
    ...base,
    endpoint,
    balanceBlock: String(balanceBlock),
    balance: String(balance),
    ranges: describeRanges(scan.ranges)
  };
  const uncorrelated = (reason: string) =>
    new PayoutGateError(
      'uncorrelated',
      `payout received but not correlated: ${correlationReason(reason, before)}`,
      where
    );
  const decoded = parseEventLogs({ abi: GATEWAY_MINTER_ABI, logs: scan.logs });
  if (scan.logs.length > 1 || decoded.length !== 1) {
    throw uncorrelated(
      `found ${scan.logs.length} AttestationUsed logs after block ${args.fromBlock} up to block ${balanceBlock}, ` +
        `${decoded.length} decodable`
    );
  }
  const [log] = decoded;
  if (!log || log.transactionHash === null || log.blockNumber === null)
    throw uncorrelated('the log has no transaction');
  const { sourceDomain, sourceDepositor, value } = log.args;
  if (sourceDomain !== ARC_CIRCLE_DOMAIN)
    throw uncorrelated(`sourceDomain ${sourceDomain}, expected ${ARC_CIRCLE_DOMAIN}`);
  if (sourceDepositor.toLowerCase() !== args.depositor.toLowerCase()) {
    throw uncorrelated(`sourceDepositor ${sourceDepositor}, expected ${args.depositor}`);
  }
  if (value !== balance - before) {
    throw uncorrelated(
      `log value ${value} differs from the balance ${balance} at ${balanceBlock} less ${before} at ${args.fromBlock}`
    );
  }
  const transaction = await client.getTransaction({ hash: log.transactionHash });
  if (!transaction.input.toLowerCase().includes(args.burnNoteId.slice(2).toLowerCase())) {
    throw uncorrelated(`gatewayMint ${log.transactionHash} calldata lacks the burn note id ${args.burnNoteId}`);
  }
  if (value < args.minimumValue) {
    throw uncorrelated(`value ${value} is below the wallet's minimum payout ${args.minimumValue}`);
  }
  return {
    endpoint,
    value,
    balance,
    balanceBlock,
    logBlock: log.blockNumber,
    transactionHash: log.transactionHash,
    sourceDomain,
    sourceDepositor: lowerHex(sourceDepositor),
    fee: args.burnUnits - value,
    latencyMs: firstPaidMs - args.consumeTsMs,
    ranges: [...state.ranges]
  };
}

/**
 * Spec 5 step 8 (D3), the hard payout gate. Every 5 s reads the key's USDC balance at an explicit head B; once it rises
 * above `balanceBefore` (R20(d); 0n, an empty key, by default), scans GatewayMinter's AttestationUsed logs for the key
 * after `fromBlock` up to B on the same endpoint and requires exactly one, from Arc's xReserve depositor, of exactly
 * that rise, whose gatewayMint calldata carries the burn note id. A balance below `balanceBefore` fails key-moved at
 * once. An endpoint error moves to the next endpoint with a fresh B. Throws a PayoutGateError at `deadlineMs`.
 */
export async function waitForGatewayPayout(args: GatewayPayoutArgs, deps: ArcReadDeps): Promise<GatewayPayout> {
  if (deps.endpoints.length === 0) throw new Error('waitForGatewayPayout: no Arc endpoints');
  const clock = deps.clock ?? realArcClock;
  const before = args.balanceBefore ?? 0n;
  const base = {
    recipient: args.recipient,
    burnNoteId: args.burnNoteId,
    fromBlock: String(args.fromBlock),
    balanceBefore: String(before),
    deadline: new Date(args.deadlineMs).toISOString()
  };
  const state: PayoutState = { readOk: false, ranges: [], errors: [] };
  let index = 0;
  let failuresInRow = 0;
  for (;;) {
    const endpoint = deps.endpoints[index % deps.endpoints.length] ?? '';
    try {
      const payout = await payoutCycle(clientFor(deps)(endpoint), endpoint, args, clock, state, base);
      if (payout) return payout;
      failuresInRow = 0;
    } catch (error) {
      if (error instanceof PayoutGateError) throw error;
      const reason = `${endpoint}: ${errorText(error)}`;
      if (error instanceof PayoutScanMiss) state.lastMiss = reason;
      state.errors = [...state.errors, reason].slice(-6);
      index += 1;
      failuresInRow += 1;
    }
    // After an error, try the next endpoint at once, unless every endpoint just failed in a row.
    const retryNow = failuresInRow > 0 && failuresInRow < deps.endpoints.length;
    if (clock.now() >= args.deadlineMs) break;
    if (!retryNow) {
      failuresInRow = 0;
      await clock.sleep(PAYOUT_POLL_MS);
    }
  }
  const details = {
    ...base,
    ranges: describeRanges(state.ranges),
    endpointErrors: state.errors.join(' || ') || 'none'
  };
  if (state.firstPaidMs !== undefined && state.lastMiss !== undefined) {
    const reason = correlationReason(state.lastMiss, before);
    throw new PayoutGateError('uncorrelated', `payout received but not correlated: ${reason}`, details);
  }
  if (state.firstPaidMs !== undefined || !state.readOk) {
    throw new PayoutGateError('scan-gaps', `unknown: scan gaps ${describeRanges(state.ranges)}`, details);
  }
  throw new PayoutGateError('no-mint', `no destination mint for this key by ${base.deadline}`, details);
}

export interface DepositSubmission {
  endpoint: string;
  approveHash?: Hash;
  depositHash: Hash;
  approved: boolean;
}

async function acceptsRawTransactions(client: PublicClient): Promise<boolean> {
  try {
    await client.request({ method: 'eth_sendRawTransaction', params: ['0x00'] });
    return false;
  } catch (error) {
    const code = rpcCode(error);
    const text = errorText(error);
    if (code === -32602 || /decode|rlp|typed transaction/i.test(text)) return true;
    if (code === -32601 || /not (supported|available|allowed)|method not found/i.test(text)) return false;
    throw error;
  }
}

/** The first endpoint on Arc Testnet that takes raw transactions: a garbage one must fail to decode, not be refused. */
async function pickWriteEndpoint(deps: ArcWriteDeps): Promise<{ client: PublicClient; endpoint: string }> {
  const failures: string[] = [];
  for (const endpoint of deps.endpoints) {
    const client = clientFor(deps)(endpoint);
    try {
      const chainId = await client.getChainId();
      if (chainId !== ARC_CHAIN_ID) failures.push(`${endpoint}: chain ${chainId}`);
      else if (await acceptsRawTransactions(client)) return { client, endpoint };
      else failures.push(`${endpoint}: refuses eth_sendRawTransaction`);
    } catch (error) {
      failures.push(`${endpoint}: ${errorText(error)}`);
    }
  }
  throw new Error(`no Arc endpoint takes writes\n  ${failures.join('\n  ') || 'no endpoints'}`);
}

async function simulate(endpoint: string, what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    throw new Error(`${what} would revert on ${endpoint}: ${errorText(error)}`, { cause: error });
  }
}

async function sendSigned(
  client: PublicClient,
  account: PrivateKeyAccount,
  tx: { to: Address; data: Hex; nonce: number }
): Promise<Hash> {
  const gas = await client.estimateGas({ account: account.address, to: tx.to, data: tx.data });
  const fees = await client.estimateFeesPerGas();
  const serializedTransaction = await account.signTransaction({
    chainId: ARC_CHAIN_ID,
    type: 'eip1559',
    to: tx.to,
    data: tx.data,
    nonce: tx.nonce,
    gas: (gas * 12n) / 10n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas
  });
  const hash = keccak256(serializedTransaction);
  try {
    await client.sendRawTransaction({ serializedTransaction });
  } catch (error) {
    // The node already holding this exact transaction is not a failure: the hash is the signed bytes' own.
    if (!/already known/i.test(errorText(error))) throw error;
  }
  return hash;
}

async function waitForReceipt(client: PublicClient, hash: Hash, clock: ArcClock): Promise<TransactionReceipt> {
  const deadline = clock.now() + RECEIPT_TIMEOUT_MS;
  for (;;) {
    const receipt = await client.getTransactionReceipt({ hash }).catch((error: unknown) => {
      if (error instanceof TransactionReceiptNotFoundError) return undefined;
      throw error;
    });
    if (receipt) {
      if (receipt.status !== 'success')
        throw new Error(`Arc transaction ${hash} reverted in block ${receipt.blockNumber}`);
      return receipt;
    }
    if (clock.now() >= deadline)
      throw new Error(`Arc transaction ${hash} has no receipt after ${RECEIPT_TIMEOUT_MS} ms`);
    await clock.sleep(RECEIPT_POLL_MS);
  }
}

/**
 * Approve (when asked) and `depositToRemote(units, 10007, recipient, USDC, 0, 0x)` from the key, on one write endpoint
 * with a local nonce. Each call is simulated first so a revert decodes; the approve is mined before the deposit's
 * simulation reads its allowance. 'exact' always approves exactly `units`; 'if-short' only when the allowance is short.
 */
export async function submitDepositToMiden(
  args: { privateKey: Hex; units: bigint; recipientHex: string; approve: 'exact' | 'if-short' },
  deps: ArcWriteDeps
): Promise<DepositSubmission> {
  const clock = deps.clock ?? realArcClock;
  const account = privateKeyToAccount(args.privateKey);
  const remoteRecipient = midenAccountHexToXReserveRecipient(args.recipientHex);
  const { client, endpoint } = await pickWriteEndpoint(deps);
  let nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const allowance = await client.readContract({
    address: ARC_USDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, ARC_XRESERVE]
  });
  const approved = args.approve === 'exact' || allowance < args.units;
  let approveHash: Hash | undefined;
  if (approved) {
    await simulate(endpoint, 'USDC approve', () =>
      client.simulateContract({
        account: account.address,
        address: ARC_USDC,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ARC_XRESERVE, args.units]
      })
    );
    approveHash = await sendSigned(client, account, {
      to: ARC_USDC,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ARC_XRESERVE, args.units] }),
      nonce
    });
    nonce += 1;
    await waitForReceipt(client, approveHash, clock);
  }
  const depositArgs: readonly [bigint, number, Hex, Address, bigint, Hex] = [
    args.units,
    USDCX_REMOTE_DOMAIN,
    remoteRecipient,
    ARC_USDC,
    0n,
    '0x'
  ];
  await simulate(endpoint, 'xReserve depositToRemote', () =>
    client.simulateContract({
      account: account.address,
      address: ARC_XRESERVE,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'depositToRemote',
      args: depositArgs
    })
  );
  const depositHash = await sendSigned(client, account, {
    to: ARC_XRESERVE,
    data: encodeFunctionData({ abi: XRESERVE_HARNESS_ABI, functionName: 'depositToRemote', args: depositArgs }),
    nonce
  });
  return { endpoint, approveHash, depositHash, approved };
}

export interface DepositedToRemoteEvent {
  value: bigint;
  localDepositor: Address;
  remoteRecipient: Hex;
  remoteDomain: number;
  remoteToken: Hex;
  maxFee: bigint;
  hookData: Hex;
  blockNumber: bigint;
}

/** The submission's receipts, on its write endpoint, and the one DepositedToRemote xReserve emitted. */
export async function confirmDepositToMiden(
  submission: DepositSubmission,
  deps: ArcReadDeps
): Promise<{ approveBlock?: bigint; depositBlock: bigint; event: DepositedToRemoteEvent; gasCostWei: bigint }> {
  const clock = deps.clock ?? realArcClock;
  const client = clientFor(deps)(submission.endpoint);
  const approveReceipt = submission.approveHash
    ? await waitForReceipt(client, submission.approveHash, clock)
    : undefined;
  const depositReceipt = await waitForReceipt(client, submission.depositHash, clock);
  const events = parseEventLogs({
    abi: XRESERVE_HARNESS_ABI,
    eventName: 'DepositedToRemote',
    logs: depositReceipt.logs
  }).filter(log => isAddressEqual(log.address, ARC_XRESERVE));
  const [event] = events;
  if (!event || events.length !== 1) {
    throw new Error(
      `deposit ${submission.depositHash}: ${events.length} DepositedToRemote events from xReserve, expected 1`
    );
  }
  return {
    approveBlock: approveReceipt?.blockNumber,
    depositBlock: depositReceipt.blockNumber,
    event: {
      value: event.args.value,
      localDepositor: event.args.localDepositor,
      remoteRecipient: lowerHex(event.args.remoteRecipient),
      remoteDomain: event.args.remoteDomain,
      remoteToken: lowerHex(event.args.remoteToken),
      maxFee: event.args.maxFee,
      hookData: event.args.hookData,
      blockNumber: depositReceipt.blockNumber
    },
    gasCostWei: [approveReceipt, depositReceipt].reduce(
      (sum, receipt) => (receipt ? sum + receipt.gasUsed * receipt.effectiveGasPrice : sum),
      0n
    )
  };
}

/**
 * Circle's attestation of the deposit: polls `fetchXReserveAttestations` (attestation.ts) until it lists the deposit's
 * Miden entry. Throws naming the count on none by the deadline or on more than one.
 */
export async function waitForXReserveAttestation(
  depositHash: Hash,
  opts: {
    baseUrl: string;
    timeoutMs: number;
    pollMs?: number;
    clock?: ArcClock;
    fetchList?: (hash: Hash, o: { baseUrl: string }) => Promise<XReserveAttestation[]>;
  }
): Promise<XReserveAttestation> {
  const clock = opts.clock ?? realArcClock;
  const fetchList = opts.fetchList ?? fetchXReserveAttestations;
  const deadline = clock.now() + opts.timeoutMs;
  let lastError = 'none';
  const domainsSeen = new Set<number>();
  for (;;) {
    let list: XReserveAttestation[] | undefined;
    try {
      list = await fetchList(depositHash, { baseUrl: opts.baseUrl });
    } catch (error) {
      lastError = errorText(error);
    }
    if (list) {
      for (const entry of list) domainsSeen.add(entry.remoteDomain);
      const forMiden = list.filter(entry => entry.remoteDomain === USDCX_REMOTE_DOMAIN);
      if (forMiden.length > 1) {
        throw new Error(
          `Circle lists ${forMiden.length} attestations for deposit ${depositHash} to domain 10007, expected 1`
        );
      }
      const [attestation] = forMiden;
      if (attestation) return attestation;
    }
    if (clock.now() >= deadline) {
      throw new Error(
        `Circle has not attested deposit ${depositHash}: 0 entries for domain ${USDCX_REMOTE_DOMAIN} after ` +
          `${opts.timeoutMs} ms (domains listed: [${[...domainsSeen].join(', ')}]; last error: ${lastError})`
      );
    }
    await clock.sleep(opts.pollMs ?? 3_000);
  }
}

/** Circle's DepositIntent payload, field by field. Same layout as attestation.ts's product decoder. */
export interface DecodedDepositIntent {
  magic: Hex;
  version: number;
  amount: bigint;
  remoteDomain: number;
  remoteToken: Hex;
  remoteRecipient: Hex;
  localToken: Hex;
  localDepositor: Hex;
  maxFee: bigint;
  nonce: Hex;
  hookLength: number;
  hookData: Hex;
}

/**
 * The harness's own reader of the 240 + hookLen byte DepositIntent: magic@0[4] version@4[4] amount@8[32]
 * remoteDomain@40[4] remoteToken@44[32] remoteRecipient@76[32] localToken@108[32] localDepositor@140[32]
 * maxFee@172[32] nonce@204[32] hookLen@236[4] hookData@240. Throws naming the field that fails.
 */
export function decodeDepositIntent(payload: Hex): DecodedDepositIntent {
  const bytes = size(payload);
  if (bytes < DEPOSIT_INTENT_HEADER_BYTES) {
    throw new Error(`DepositIntent length: ${bytes} bytes, below the ${DEPOSIT_INTENT_HEADER_BYTES}-byte header`);
  }
  const word = (offset: number, length: number): Hex => lowerHex(slice(payload, offset, offset + length));
  const magic = word(0, 4);
  if (magic !== DEPOSIT_INTENT_MAGIC)
    throw new Error(`DepositIntent magic: ${magic}, expected ${DEPOSIT_INTENT_MAGIC}`);
  const version = hexToNumber(word(4, 4));
  if (version !== 1) throw new Error(`DepositIntent version: ${version}, expected 1`);
  const hookLength = hexToNumber(word(236, 4));
  if (bytes !== DEPOSIT_INTENT_HEADER_BYTES + hookLength) {
    throw new Error(
      `DepositIntent length: ${bytes} bytes, expected ${DEPOSIT_INTENT_HEADER_BYTES} + hookLen ${hookLength}`
    );
  }
  return {
    magic,
    version,
    amount: hexToBigInt(word(8, 32)),
    remoteDomain: hexToNumber(word(40, 4)),
    remoteToken: word(44, 32),
    remoteRecipient: word(76, 32),
    localToken: word(108, 32),
    localDepositor: word(140, 32),
    maxFee: hexToBigInt(word(172, 32)),
    nonce: word(204, 32),
    hookLength,
    hookData: hookLength === 0 ? '0x' : word(DEPOSIT_INTENT_HEADER_BYTES, hookLength)
  };
}

/**
 * Spec 5 step 12: every DepositIntent field against the deposit the key signed, `messageHash == keccak256(payload)`,
 * and the signer recovered from Circle's signature over `messageHash` (returned, not pinned).
 */
export async function assertDepositIntent(
  attestation: XReserveAttestation,
  expected: { amount: bigint; remoteToken: Hex; remoteRecipient: Hex; localToken: Address; localDepositor: Address }
): Promise<{ intent: DecodedDepositIntent; signer: Address }> {
  const intent = decodeDepositIntent(attestation.payload);
  const mismatches: string[] = [];
  const check = (field: string, actual: string | number | bigint, wanted: string | number | bigint) => {
    if (actual !== wanted) mismatches.push(`${field}: ${actual}, expected ${wanted}`);
  };
  check('entry remoteDomain', attestation.remoteDomain, USDCX_REMOTE_DOMAIN);
  check('amount@8', intent.amount, expected.amount);
  check('remoteDomain@40', intent.remoteDomain, USDCX_REMOTE_DOMAIN);
  check('remoteToken@44', intent.remoteToken, expected.remoteToken.toLowerCase());
  check('remoteRecipient@76', intent.remoteRecipient, expected.remoteRecipient.toLowerCase());
  check('localToken@108', intent.localToken, pad(expected.localToken).toLowerCase());
  check('localDepositor@140', intent.localDepositor, pad(expected.localDepositor).toLowerCase());
  check('maxFee@172', intent.maxFee, 0n);
  check('hookLen@236', intent.hookLength, 0);
  check('messageHash', attestation.messageHash.toLowerCase(), keccak256(attestation.payload));
  if (mismatches.length > 0) {
    throw new Error(`Circle's DepositIntent differs from the deposit:\n  ${mismatches.join('\n  ')}`);
  }
  const signer = await recoverAddress({ hash: attestation.messageHash, signature: attestation.attestation });
  return { intent, signer };
}
