/**
 * Arc Testnet legs of the USDCx live suites: Circle's Gateway payout to the run's Arc key, the deposit back through
 * xReserve, and Circle's attestation of it. Clients and the clock are injectable, so the unit tests replay captured
 * chain data with no network.
 *
 * Never imports usdcx/deposit.ts, which pulls in lib/miden/activity and with it the wallet's SDK.
 */
import {
  createPublicClient,
  encodeFunctionData,
  formatLog,
  http,
  HttpRequestError,
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
  type Chain,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import {
  ARC_CHAIN_ID,
  ARC_PAYOUT,
  ARC_RPC_TIMEOUT_MS,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  DEFAULT_ARC_RPCS,
  ETHEREUM_SEPOLIA_PAYOUT,
  GATEWAY_MINTER,
  realArcClock,
  USDCX_REMOTE_DOMAIN,
  type ArcClock,
  type PayoutChain
} from './usdcx-constants';
import { fetchXReserveAttestations, type XReserveAttestation } from '../../../src/lib/usdcx/attestation-protocol';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';

export { realArcClock, type ArcClock } from './usdcx-constants';

export const ERC20_ABI = parseAbi([
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
/**
 * A deposit leg's call is asked again at most this often, 2, 4 and 8 s apart, after a transient error or, when it is
 * pinned to a block, a node behind that block.
 */
const TRANSIENT_RETRIES = 3;
const TRANSIENT_BACKOFF_MS = 2_000;
const DEPOSIT_INTENT_MAGIC: Hex = '0x5a2e0acd';
const DEPOSIT_INTENT_HEADER_BYTES = 240;

/** Appended to every payout failure but key-moved (spec section 11). */
export const LATE_PAYOUT_NOTE =
  'Arc payouts have arrived up to ~17 h late and one 1 USDCx burn of 2026-10-08 was still unpaid after 45 h; red means a user was not paid in time';
/** LATE_PAYOUT_NOTE's place on Base Sepolia and Arbitrum Sepolia, which have no history of late payouts yet. */
export const L2_LATE_PAYOUT_NOTE =
  'Base Sepolia and Arbitrum Sepolia payouts landed 6-8 s after the consume when probed on 2026-10-11; red means a user was not paid in time';
/**
 * LATE_PAYOUT_NOTE's place on Ethereum Sepolia, where the one unpaid burn since Circle's fix was not late: its forwarder
 * sends gatewayMint with a fixed 250,000 gas limit, a mint to an address that never held Sepolia USDC needs about
 * 346,000, and it retried with the same limit until the key held USDC (2026-10-16).
 */
export const SEPOLIA_LATE_PAYOUT_NOTE =
  "Circle's forwarder mint runs out of gas at its fixed 250,000 limit when the recipient holds no Sepolia USDC: check the forwarder's reverted gatewayMint transactions to GatewayMinter for the recipient. Ethereum Sepolia paid no burn until Circle fixed a Gateway configuration error on 2026-10-14 (0xMiden/miden-usdcx#308), so no payout time there is known yet; red means a user was not paid in time";
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

/**
 * A rate limit (HTTP 429, JSON-RPC -32005 or 429) or a request timeout anywhere in the cause chain: the same call can
 * answer a moment later or on another endpoint. Anything else, a revert included, is final.
 */
function isTransientArcError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 6; depth++, current = current.cause) {
    if (current.name === 'TimeoutError') return true;
    if (current instanceof HttpRequestError && current.status === 429) return true;
    const code = Reflect.get(current, 'code');
    if (code === -32005 || code === 429) return true;
  }
  return false;
}

/**
 * A call pinned to a block the answering node has not reached, as the harness's endpoints word it (2026-10-16): `block
 * not found` (Base Sepolia's three, QuickNode, arc.io), `unsupported block number` (Arbitrum's own RPC), `header not
 * found` (Arbitrum's publicnode, and Tenderly as code 3, which viem reports as a revert), `Unknown block` (drpc).
 */
function isBlockNotReached(error: unknown): boolean {
  return /block not found|unsupported block number|header not found|unknown block/i.test(errorText(error));
}

function retriesAt(atBlock: bigint | undefined): (error: unknown) => boolean {
  return error => isTransientArcError(error) || (atBlock !== undefined && isBlockNotReached(error));
}

/** An Arc endpoint as evidence and messages name it: an operator's URL may carry its API key in the path or query. */
export function arcHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'an unparseable Arc endpoint';
  }
}

function rpcCode(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 6; depth++, current = current.cause) {
    const code = Reflect.get(current, 'code');
    if (typeof code === 'number' && code !== -1) return code;
  }
  return undefined;
}

/** The Arc key a run holds (R21): the harness key, or usdcx-in's operator key. */
export interface ArcKey {
  address: Address;
  privateKey: Hex;
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
  /** The chain the key's balance and payout are read on; absent is Arc. xReserve and the deposit refuse any other. */
  payoutChain?: PayoutChain;
}

/** Writes sign locally with the key and send raw through the read client, so they need nothing more. */
export type ArcWriteDeps = ArcReadDeps;

function defaultPublicClient(endpoint: string, chain: Chain): PublicClient {
  // cacheTime 0: viem caches eth_blockNumber for its polling interval, and every payout cycle needs a fresh head.
  return createPublicClient({
    chain,
    cacheTime: 0,
    transport: http(endpoint, { retryCount: 0, timeout: ARC_RPC_TIMEOUT_MS })
  });
}

function chainOf(deps: ArcReadDeps): PayoutChain {
  return deps.payoutChain ?? ARC_PAYOUT;
}

/** xReserve and the deposit exist on Arc alone, and a deposit signs with Arc's chain id: an L2 endpoint is refused. */
function arcOnly(deps: ArcReadDeps, what: string): void {
  const chain = chainOf(deps);
  if (chain.chainId !== ARC_CHAIN_ID) throw new Error(`${what} runs on Arc only, not on ${chain.networkName}`);
}

function clientFor(deps: ArcReadDeps): ArcPublicClientFactory {
  return deps.publicClient ?? (endpoint => defaultPublicClient(endpoint, chainOf(deps).chain));
}

export async function onFirstEndpoint<T>(
  deps: ArcReadDeps,
  what: string,
  read: (client: PublicClient, endpoint: string) => Promise<T>
): Promise<T> {
  const failures: string[] = [];
  for (const endpoint of deps.endpoints) {
    try {
      return await read(clientFor(deps)(endpoint), endpoint);
    } catch (error) {
      failures.push(`${arcHost(endpoint)}: ${errorText(error)}`);
    }
  }
  throw new Error(`${what}: no ${chainOf(deps).label} endpoint answered\n  ${failures.join('\n  ') || 'no endpoints'}`);
}

/** USDC balance of `address` at `blockNumber` (default latest), from the first endpoint that answers. */
export async function readArcUsdc(address: Address, deps: ArcReadDeps, blockNumber?: bigint): Promise<bigint> {
  const { label, usdc } = chainOf(deps);
  return onFirstEndpoint(deps, `${label} USDC balance of ${address}`, client =>
    client.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [address], blockNumber })
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
  const { label, usdc } = chainOf(deps);
  return onFirstEndpoint(deps, `${label} USDC snapshot of ${address}`, async (client, endpoint) => {
    const blockNumber = await client.getBlockNumber();
    const balance = await client.readContract({
      address: usdc,
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

/** Whether `xReserve` has `domain` registered. The caller names the address, so mainnet Arc is not read at the testnet one. */
export async function readRemoteDomainRegistered(
  deps: ArcReadDeps,
  xReserve: Address,
  domain: number
): Promise<boolean> {
  return onFirstEndpoint(deps, 'xReserve domain registration', client =>
    client.readContract({
      address: xReserve,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'isRemoteDomainRegistered',
      args: [domain]
    })
  );
}

/** Miden's domain on Arc's xReserve, all reads on one endpoint. */
export async function readXReserveDomainState(deps: ArcReadDeps): Promise<XReserveDomainState> {
  arcOnly(deps, 'xReserve domain state');
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

function lateNote(chain: PayoutChain): string {
  if (chain.chainId === ARC_CHAIN_ID) return LATE_PAYOUT_NOTE;
  return chain.chainId === ETHEREUM_SEPOLIA_PAYOUT.chainId ? SEPOLIA_LATE_PAYOUT_NOTE : L2_LATE_PAYOUT_NOTE;
}

function describeRanges(ranges: readonly ScannedRange[]): string {
  if (ranges.length === 0) return 'none';
  const byEndpoint = new Map<string, ScannedRange[]>();
  for (const range of ranges) byEndpoint.set(range.endpoint, [...(byEndpoint.get(range.endpoint) ?? []), range]);
  return [...byEndpoint]
    .map(
      ([endpoint, list]) => `${arcHost(endpoint)} ${list.map(range => `${range.fromBlock}-${range.toBlock}`).join(',')}`
    )
    .join('; ');
}

export interface GatewayPayoutArgs {
  /** The key Circle pays. */
  recipient: Address;
  /** `usdcxBurn.noteId`: Circle's TransferSpec carries it as the salt, so it is in the gatewayMint calldata. */
  burnNoteId: Hex;
  burnUnits: bigint;
  /** The payout chain's block `balanceBefore` was read at, before the burn was queued; only logs after it count. */
  fromBlock: bigint;
  /** The key's USDC at `fromBlock` (R20(d)); default 0n, an empty key. The payout must be exactly the rise above it. */
  balanceBefore?: bigint;
  /** The burn's consume block time, in ms. */
  consumeTsMs: number;
  /** consumeTsMs + PAYOUT_TIMEOUT_MS. */
  deadlineMs: number;
  /** `readXReserveDomainState().depositor`. */
  depositor: Hex;
  /** `minimumUsdcxPayout(<payout chain id>, burnUnits)`, the floor the wallet's own confirmation uses. */
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
  chain: PayoutChain,
  clock: ArcClock,
  state: PayoutState,
  base: Record<string, string>
): Promise<GatewayPayout | undefined> {
  const balanceBlock = await client.getBlockNumber();
  const balance = await client.readContract({
    address: chain.usdc,
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
      { ...base, endpoint: arcHost(endpoint), balanceBlock: String(balanceBlock), balance: String(balance) },
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
    // The token topic is the paid chain's USDC: under Arc's, an L2 payout finds no log.
    topics: [ATTESTATION_USED_TOPIC, lowerHex(pad(chain.usdc)), lowerHex(pad(args.recipient))],
    // balanceOf at fromBlock already counts a log in that block, so the window starts after it.
    fromBlock: args.fromBlock + 1n,
    toBlock: balanceBlock,
    chunk: chain.logChunk(endpoint)
  });
  state.ranges.push(...scan.ranges);
  if (scan.logs.length === 0) {
    throw new PayoutScanMiss(`found 0 AttestationUsed logs after block ${args.fromBlock} up to block ${balanceBlock}`);
  }
  const where = {
    ...base,
    endpoint: arcHost(endpoint),
    balanceBlock: String(balanceBlock),
    balance: String(balance),
    ranges: describeRanges(scan.ranges)
  };
  const uncorrelated = (reason: string) =>
    new PayoutGateError(
      'uncorrelated',
      `payout received but not correlated: ${correlationReason(reason, before)}`,
      where,
      lateNote(chain)
    );
  const decoded = parseEventLogs({ abi: GATEWAY_MINTER_ABI, logs: scan.logs });
  if (scan.logs.length > 1 || decoded.length !== 1) {
    // Each log by its transaction and block, so the stray payout can be looked up on the explorer.
    const seen = scan.logs.map(
      found => `${found.transactionHash ?? 'no transaction'} in block ${found.blockNumber ?? 'unknown'}`
    );
    throw uncorrelated(
      `found ${scan.logs.length} AttestationUsed logs after block ${args.fromBlock} up to block ${balanceBlock}, ` +
        `${decoded.length} decodable: ${seen.join(', ')}`
    );
  }
  const [log] = decoded;
  if (!log || log.transactionHash === null || log.blockNumber === null)
    throw uncorrelated('the log has no transaction');
  const { sourceDomain, sourceDepositor, value } = log.args;
  // The Gateway source (26) on every chain, never the destination domain the burn carried.
  if (sourceDomain !== chain.attestationSourceDomain)
    throw uncorrelated(`sourceDomain ${sourceDomain}, expected ${chain.attestationSourceDomain}`);
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
  const chain = chainOf(deps);
  if (deps.endpoints.length === 0) throw new Error(`waitForGatewayPayout: no ${chain.label} endpoints`);
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
      const payout = await payoutCycle(clientFor(deps)(endpoint), endpoint, args, chain, clock, state, base);
      if (payout) return payout;
      failuresInRow = 0;
    } catch (error) {
      if (error instanceof PayoutGateError) throw error;
      const reason = `${arcHost(endpoint)}: ${errorText(error)}`;
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
    throw new PayoutGateError(
      'uncorrelated',
      `payout received but not correlated: ${reason}`,
      details,
      lateNote(chain)
    );
  }
  if (state.firstPaidMs !== undefined || !state.readOk) {
    throw new PayoutGateError(
      'scan-gaps',
      `unknown: scan gaps ${describeRanges(state.ranges)}`,
      details,
      lateNote(chain)
    );
  }
  throw new PayoutGateError(
    'no-mint',
    `no destination mint for this key by ${base.deadline}`,
    details,
    lateNote(chain)
  );
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
    if (code === -32602 || /decode|rlp|typed transaction|reading transaction object failed/i.test(text)) return true;
    if (code === -32601 || /not (supported|available|allowed)|method not found/i.test(text)) return false;
    throw error;
  }
}

/**
 * The first endpoint on the deps' chain that takes raw transactions: a garbage one must fail to decode, not be refused.
 * Shared with usdcx-l2-deposit.ts.
 */
export async function pickWriteEndpoint(deps: ArcWriteDeps): Promise<string> {
  const { chainId, label } = chainOf(deps);
  const failures: string[] = [];
  for (const endpoint of deps.endpoints) {
    const client = clientFor(deps)(endpoint);
    try {
      const served = await client.getChainId();
      if (served !== chainId) failures.push(`${arcHost(endpoint)}: chain ${served}`);
      else if (await acceptsRawTransactions(client)) return endpoint;
      else failures.push(`${arcHost(endpoint)}: refuses eth_sendRawTransaction`);
    } catch (error) {
      failures.push(`${arcHost(endpoint)}: ${errorText(error)}`);
    }
  }
  throw new Error(`no ${label} endpoint takes writes\n  ${failures.join('\n  ') || 'no endpoints'}`);
}

/**
 * `call` on `endpoints[0]`, asked again at most TRANSIENT_RETRIES times after an error `retryable` takes (by default a
 * transient one), each time after a doubling backoff and on the next of `endpoints` (the same one when there is one).
 * Any other error, and the last retried one, is thrown at once through `failure`, which names the endpoint. `before`
 * runs ahead of each attempt, outside the retry, so what it throws ends the call as it is.
 */
async function withTransientRetry<T>(
  endpoints: readonly string[],
  deps: ArcReadDeps,
  call: (client: PublicClient, attempt: number) => Promise<T>,
  failure: (endpoint: string, error: unknown) => Error,
  {
    before,
    retryable = isTransientArcError
  }: { before?: (attempt: number) => void; retryable?: (error: unknown) => boolean } = {}
): Promise<T> {
  const clock = deps.clock ?? realArcClock;
  for (let attempt = 0; ; attempt++) {
    const endpoint = endpoints[attempt % endpoints.length] ?? '';
    before?.(attempt);
    try {
      return await call(clientFor(deps)(endpoint), attempt);
    } catch (error) {
      if (!retryable(error) || attempt >= TRANSIENT_RETRIES) throw failure(endpoint, error);
      await clock.sleep(TRANSIENT_BACKOFF_MS * 2 ** attempt);
    }
  }
}

/** Where a failed call ran: the endpoint, and for a pinned call its block and a node still behind it. */
function ranAt(endpoint: string, atBlock: bigint | undefined, error: unknown): string {
  if (atBlock === undefined) return `on ${arcHost(endpoint)}`;
  const behind = isBlockNotReached(error) ? `, still behind it after ${TRANSIENT_RETRIES} retries` : '';
  return `at block ${atBlock} on ${arcHost(endpoint)}${behind}`;
}

/**
 * `endpoints` with `first` in front: a deposit leg's reads start on its write endpoint and fail over to the rest.
 * Shared with usdcx-l2-deposit.ts and usdcx-cctp-proof.ts.
 */
export function startingAt(endpoints: readonly string[], first: string): string[] {
  return [first, ...endpoints.filter(endpoint => endpoint !== first)];
}

/** `read` through withTransientRetry; pinned to `atBlock` (`read`'s blockNumber), asked again while a node lags. */
export function chainRead<T>(
  what: string,
  endpoints: readonly string[],
  deps: ArcReadDeps,
  read: (client: PublicClient, blockNumber: bigint | undefined) => Promise<T>,
  atBlock?: bigint
): Promise<T> {
  return withTransientRetry(
    endpoints,
    deps,
    client => read(client, atBlock),
    (endpoint, error) => new Error(`${what} ${ranAt(endpoint, atBlock, error)}: ${errorText(error)}`, { cause: error }),
    { retryable: retriesAt(atBlock) }
  );
}

/**
 * `run` on the write endpoint alone, retried there on a transient error. One endpoint URL can be a pool of nodes at
 * different heights, so a call that depends on an approve runs at `atBlock` (`run`'s blockNumber, from
 * pinAfterApprove): a node behind it then answers that it lacks the block, which is retried, instead of a revert read
 * from a state without the approve. Shared with usdcx-l2-deposit.ts.
 */
export async function simulate(
  what: string,
  write: string,
  deps: ArcReadDeps,
  run: (client: PublicClient, blockNumber: bigint | undefined) => Promise<unknown>,
  atBlock?: bigint
): Promise<void> {
  const retryable = retriesAt(atBlock);
  await withTransientRetry(
    [write],
    deps,
    client => run(client, atBlock),
    (endpoint, error) => {
      const outcome = retryable(error) ? 'could not be simulated' : 'would revert';
      return new Error(`${what} ${outcome} ${ranAt(endpoint, atBlock, error)}: ${errorText(error)}`, { cause: error });
    },
    { retryable }
  );
}

/**
 * The block a call that depends on an approve mined in `approveBlock` runs at, read just before its simulation: the
 * write endpoint's head, or the approve's block when the node that answered is behind the one that gave the receipt. At
 * the head the call meets the state it will be sent into, so a quote whose deadline passed since the approve is refused
 * unsent. Undefined, with no read, when there was no approve. Shared with usdcx-l2-deposit.ts.
 */
export async function pinAfterApprove(
  write: string,
  deps: ArcReadDeps,
  approveBlock: bigint | undefined
): Promise<bigint | undefined> {
  if (approveBlock === undefined) return undefined;
  const head = await chainRead(`${chainOf(deps).label} head`, [write], deps, client => client.getBlockNumber());
  return head > approveBlock ? head : approveBlock;
}

/** Throws in place of a send once `signal` is aborted: an overrun step runs on after its test failed, sending nothing. */
function refuseSendIfAborted(signal: AbortSignal | undefined, what: string): void {
  if (!signal?.aborted) return;
  const error = new Error(`${what} not sent: ${errorText(signal.reason)}`, { cause: signal.reason });
  error.name = 'AbortError';
  throw error;
}

/**
 * `fees` with the tip held to `cap` (PayoutChain.maxPriorityFeeCap). The max fee drops by the tip given up, keeping
 * viem's base fee headroom, so the balance a node asks of the send is what the capped send can pay. Shared with
 * usdcx-l2-deposit.ts.
 */
export function capPriorityFee(
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  cap: bigint | undefined
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  if (cap === undefined || fees.maxPriorityFeePerGas <= cap) return fees;
  const headroom = fees.maxFeePerGas > fees.maxPriorityFeePerGas ? fees.maxFeePerGas - fees.maxPriorityFeePerGas : 0n;
  return { maxFeePerGas: headroom + cap, maxPriorityFeePerGas: cap };
}

/**
 * Signs `tx` and sends it to `endpoints.write`, which takes writes and estimates its gas. The estimate executes the
 * call, so one that depends on an approve runs at `tx.atBlock`, the block its simulation ran at; the signed transaction
 * names no block. Its fees are reads that fail over across `endpoints.reads`, the tip held to the chain's cap. A send
 * that fails transiently is sent again as the same signed bytes, so the hash cannot change. Nothing is sent, first time
 * or again, once `signal` is aborted.
 */
export async function sendSigned(
  deps: ArcWriteDeps,
  endpoints: { write: string; reads: readonly string[] },
  account: PrivateKeyAccount,
  tx: { what: string; to: Address; data: Hex; nonce: number; atBlock?: bigint },
  signal: AbortSignal | undefined
): Promise<Hash> {
  const { chainId, label, maxPriorityFeeCap } = chainOf(deps);
  const gas = await chainRead(
    `${label} gas estimate`,
    [endpoints.write],
    deps,
    (client, blockNumber) => client.estimateGas({ account: account.address, to: tx.to, data: tx.data, blockNumber }),
    tx.atBlock
  );
  const fees = capPriorityFee(
    await chainRead(`${label} fee estimate`, endpoints.reads, deps, client => client.estimateFeesPerGas()),
    maxPriorityFeeCap
  );
  const serializedTransaction = await account.signTransaction({
    chainId,
    type: 'eip1559',
    to: tx.to,
    data: tx.data,
    nonce: tx.nonce,
    gas: (gas * 12n) / 10n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas
  });
  const hash = keccak256(serializedTransaction);
  await withTransientRetry(
    [endpoints.write],
    deps,
    async (client, attempt) => {
      try {
        await client.sendRawTransaction({ serializedTransaction });
      } catch (error) {
        const text = errorText(error);
        // The node already holding this exact transaction is not a failure: the hash is the signed bytes' own.
        if (/already known/i.test(text)) return;
        // A resend after a transient failure finds the nonce spent when the first send landed; the receipt wait on
        // `hash` fails if another transaction took the nonce instead.
        if (attempt > 0 && /nonce too low/i.test(text)) return;
        throw error;
      }
    },
    (endpoint, error) =>
      new Error(`${label} transaction ${hash} was not sent on ${arcHost(endpoint)}: ${errorText(error)}`, {
        cause: error
      }),
    { before: attempt => refuseSendIfAborted(signal, attempt === 0 ? tx.what : `${tx.what} resend of ${hash}`) }
  );
  return hash;
}

/**
 * Polls `hash`'s receipt from `endpoints[0]` for RECEIPT_TIMEOUT_MS. A transient error counts as no receipt yet and
 * moves the poll to the next endpoint; a revert, or any other error, fails at once.
 * Shared with usdcx-l2-deposit.ts and usdcx-cctp-proof.ts.
 */
export async function waitForReceipt(
  endpoints: readonly string[],
  deps: ArcReadDeps,
  hash: Hash
): Promise<TransactionReceipt> {
  const { label } = chainOf(deps);
  const clock = deps.clock ?? realArcClock;
  const deadline = clock.now() + RECEIPT_TIMEOUT_MS;
  let index = 0;
  let lastTransient = 'none';
  for (;;) {
    const endpoint = endpoints[index % endpoints.length] ?? '';
    let receipt: TransactionReceipt | undefined;
    try {
      receipt = await clientFor(deps)(endpoint).getTransactionReceipt({ hash });
    } catch (error) {
      if (isTransientArcError(error)) {
        lastTransient = `${arcHost(endpoint)}: ${errorText(error)}`;
        index += 1;
      } else if (!(error instanceof TransactionReceiptNotFoundError)) {
        throw new Error(`${label} transaction ${hash} receipt on ${arcHost(endpoint)}: ${errorText(error)}`, {
          cause: error
        });
      }
    }
    if (receipt) {
      if (receipt.status !== 'success')
        throw new Error(`${label} transaction ${hash} reverted in block ${receipt.blockNumber}`);
      return receipt;
    }
    if (clock.now() >= deadline) {
      throw new Error(
        `${label} transaction ${hash} has no receipt after ${RECEIPT_TIMEOUT_MS} ms (last transient error: ${lastTransient})`
      );
    }
    await clock.sleep(RECEIPT_POLL_MS);
  }
}

/**
 * Approve (when asked) and `depositToRemote(units, 10007, recipient, USDC, 0, 0x)` from the key, sent to one write
 * endpoint with a local nonce; reads and receipts fail over to the other endpoints on a rate limit or a timeout. Each
 * call is simulated and its gas estimated on the write endpoint first, so a revert decodes; after an approve, the
 * deposit's simulation and estimate run at the later of the approve's block and that endpoint's head, so a node still
 * behind the approve never reports a false revert. 'exact' always approves exactly `units`; 'if-short' only when the
 * allowance is short. Once `signal` is aborted (the step ran out of budget) nothing more is sent.
 */
export async function submitDepositToMiden(
  args: { privateKey: Hex; units: bigint; recipientHex: string; approve: 'exact' | 'if-short' },
  deps: ArcWriteDeps,
  signal?: AbortSignal
): Promise<DepositSubmission> {
  arcOnly(deps, 'the xReserve deposit');
  const account = privateKeyToAccount(args.privateKey);
  const remoteRecipient = midenAccountHexToXReserveRecipient(args.recipientHex);
  const endpoint = await pickWriteEndpoint(deps);
  const endpoints = { write: endpoint, reads: startingAt(deps.endpoints, endpoint) };
  let nonce = await chainRead('Arc nonce', endpoints.reads, deps, client =>
    client.getTransactionCount({ address: account.address, blockTag: 'pending' })
  );
  const allowance = await chainRead('USDC allowance', endpoints.reads, deps, client =>
    client.readContract({
      address: ARC_USDC,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, ARC_XRESERVE]
    })
  );
  const approved = args.approve === 'exact' || allowance < args.units;
  let approveHash: Hash | undefined;
  let approveBlock: bigint | undefined;
  if (approved) {
    await simulate('USDC approve', endpoints.write, deps, client =>
      client.simulateContract({
        account: account.address,
        address: ARC_USDC,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ARC_XRESERVE, args.units]
      })
    );
    approveHash = await sendSigned(
      deps,
      endpoints,
      account,
      {
        what: 'USDC approve',
        to: ARC_USDC,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ARC_XRESERVE, args.units] }),
        nonce
      },
      signal
    );
    nonce += 1;
    approveBlock = (await waitForReceipt(endpoints.reads, deps, approveHash)).blockNumber;
  }
  const atBlock = await pinAfterApprove(endpoints.write, deps, approveBlock);
  const depositArgs: readonly [bigint, number, Hex, Address, bigint, Hex] = [
    args.units,
    USDCX_REMOTE_DOMAIN,
    remoteRecipient,
    ARC_USDC,
    0n,
    '0x'
  ];
  await simulate(
    'xReserve depositToRemote',
    endpoints.write,
    deps,
    (client, blockNumber) =>
      client.simulateContract({
        account: account.address,
        address: ARC_XRESERVE,
        abi: XRESERVE_HARNESS_ABI,
        functionName: 'depositToRemote',
        args: depositArgs,
        blockNumber
      }),
    atBlock
  );
  const depositHash = await sendSigned(
    deps,
    endpoints,
    account,
    {
      what: 'xReserve depositToRemote',
      to: ARC_XRESERVE,
      data: encodeFunctionData({ abi: XRESERVE_HARNESS_ABI, functionName: 'depositToRemote', args: depositArgs }),
      nonce,
      atBlock
    },
    signal
  );
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

/** The one DepositedToRemote Arc's xReserve emitted in `receipt`; throws naming `what` and the count otherwise. */
export function depositedToRemoteOf(receipt: TransactionReceipt, what: string): DepositedToRemoteEvent {
  const events = parseEventLogs({
    abi: XRESERVE_HARNESS_ABI,
    eventName: 'DepositedToRemote',
    logs: receipt.logs
  }).filter(log => isAddressEqual(log.address, ARC_XRESERVE));
  const [event] = events;
  if (!event || events.length !== 1) {
    throw new Error(`${what}: ${events.length} DepositedToRemote events from xReserve, expected 1`);
  }
  return {
    value: event.args.value,
    localDepositor: event.args.localDepositor,
    remoteRecipient: lowerHex(event.args.remoteRecipient),
    remoteDomain: event.args.remoteDomain,
    remoteToken: lowerHex(event.args.remoteToken),
    maxFee: event.args.maxFee,
    hookData: event.args.hookData,
    blockNumber: receipt.blockNumber
  };
}

/**
 * The submission's receipts, read from its write endpoint first and failing over to the others, and the one
 * DepositedToRemote xReserve emitted.
 */
export async function confirmDepositToMiden(
  submission: DepositSubmission,
  deps: ArcReadDeps
): Promise<{ approveBlock?: bigint; depositBlock: bigint; event: DepositedToRemoteEvent; gasCostWei: bigint }> {
  arcOnly(deps, 'the xReserve deposit receipt');
  const reads = startingAt(deps.endpoints, submission.endpoint);
  const approveReceipt = submission.approveHash ? await waitForReceipt(reads, deps, submission.approveHash) : undefined;
  const depositReceipt = await waitForReceipt(reads, deps, submission.depositHash);
  const event = depositedToRemoteOf(depositReceipt, `deposit ${submission.depositHash}`);
  return {
    approveBlock: approveReceipt?.blockNumber,
    depositBlock: depositReceipt.blockNumber,
    event,
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
