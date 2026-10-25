/**
 * @jest-environment node
 */
import os from 'os';
import path from 'path';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  hexToBigInt,
  HttpRequestError,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  pad,
  parseTransaction,
  RpcRequestError,
  TimeoutError,
  toBytes,
  toHex,
  type Address,
  type Hex,
  type PublicClient
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

import {
  arcEndpoints,
  arcHost,
  assertDepositIntent,
  confirmDepositToMiden,
  decodeDepositIntent,
  KEY_MOVED_NOTE,
  L2_LATE_PAYOUT_NOTE,
  LATE_PAYOUT_NOTE,
  PayoutGateError,
  PREFUNDED_KEY_NOTE,
  readArcUsdc,
  readArcUsdcSnapshot,
  readXReserveDomainState,
  scanArcLogs,
  SEPOLIA_LATE_PAYOUT_NOTE,
  submitDepositToMiden,
  waitForGatewayPayout,
  waitForReceipt,
  waitForXReserveAttestation,
  XRESERVE_HARNESS_ABI,
  type ArcClock
} from './arc-usdcx';
import arcVectors from './arc-usdcx.vectors.json';
import type { BridgedSendRow } from './bridge';
import { TxStatus } from './history';
import {
  ARBITRUM_SEPOLIA_PAYOUT,
  ARC_ATTESTATION_API,
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_DRPC_URL,
  ARC_KEY_LEDGER_DIR,
  ARC_PAYOUT,
  ARC_PUBLIC_URL,
  ARC_QUICKNODE_URL,
  ARC_READ_STEP_BUDGET_MS,
  ARC_RPC_TIMEOUT_MS,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  BASE_OFFICIAL_LOG_CHUNK,
  BASE_SEPOLIA_PAYOUT,
  BURN_UNITS,
  DEFAULT_ARC_RPCS,
  DEPOSIT_UNITS,
  ETHEREUM_SEPOLIA_PAYOUT,
  FEE_RESERVE_MULTIPLE,
  GAS_RESERVE_UNITS,
  GATEWAY_MINTER,
  GRANT_MARGIN_UNITS,
  GRANT_UNITS,
  HARNESS_ARC_KEY_FILE,
  isWorthClaiming,
  L2_LOG_CHUNK,
  minimumUsdcxPayout,
  PAYOUT_TIMEOUT_MS,
  payoutChainFor,
  WALLET_CONFIRM_TIMEOUT_MS
} from './usdcx-constants';
import l2Vectors from './usdcx-l2.vectors.json';
import { burnTarget, harnessPayoutLeg, payoutLeg, waitForWalletPayoutConfirmation } from './usdcx-legs';
import { newRunEvidence, withStepBudget, type NamedStep, type RunEvidence } from './usdcx-run';
import type { XReserveAttestation } from '../../../src/lib/usdcx/attestation-protocol';
import attestationVectors from '../../../src/lib/usdcx/attestation.vectors.json';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';
import { ARC_TESTNET, WC_PROJECT_ID } from '../../../src/lib/walletconnect/config';

function addressOf(value: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`${value} is not an address`);
  return value;
}

function hexOf(value: string): Hex {
  if (!isHex(value)) throw new Error(`${value} is not hex`);
  return value;
}

describe('usdcx-constants', () => {
  it("reads the Arc Testnet xReserve source from the wallet's own table", () => {
    expect(ARC_CHAIN_ID).toBe(5042002);
    expect(ARC_XRESERVE).toBe('0x008888878f94C0d87defdf0B07f46B93C1934442');
    expect(ARC_USDC).toBe('0x3600000000000000000000000000000000000000');
    expect(ARC_ATTESTATION_API).toBe('https://xreserve-api-testnet.circle.com');
    expect(ARC_CIRCLE_DOMAIN).toBe(26);
  });

  it('names the GatewayMinter mint event by its signature hash', () => {
    expect(ATTESTATION_USED_TOPIC).toBe(
      keccak256(toBytes('AttestationUsed(address,address,bytes32,uint32,bytes32,bytes32,uint256)'))
    );
  });

  it("reads Arc through drpc, then QuickNode, and the wallet's own arc.io last", () => {
    expect(DEFAULT_ARC_RPCS).toEqual([ARC_DRPC_URL, ARC_QUICKNODE_URL, ARC_PUBLIC_URL]);
    expect(ARC_PUBLIC_URL).toBe('https://rpc.testnet.arc.io');
  });

  it('keeps the key ledger and the harness key in the home directory, outside the repository', () => {
    expect(ARC_KEY_LEDGER_DIR).toBe(path.join(os.homedir(), '.miden-e2e', 'arc-keys'));
    expect(HARNESS_ARC_KEY_FILE).toBe(path.join(os.homedir(), '.miden-e2e', 'arc-keys', 'harness.json'));
  });

  it("sizes the run on the wallet's minimum burn, one 10 USDCx grant and a deposit the wallet claims", () => {
    expect([BURN_UNITS, GRANT_UNITS, GRANT_MARGIN_UNITS, DEPOSIT_UNITS, GAS_RESERVE_UNITS]).toEqual([
      5_000_000n,
      10_000_000n,
      1_000_000n,
      1_000n,
      20_000n
    ]);
    // The grant clears the burn floor after its own consume fee, at most baseFee x 30 at testnet's base fee of 7.
    expect(GRANT_UNITS - 7n * BigInt(FEE_RESERVE_MULTIPLE) >= BURN_UNITS + GRANT_MARGIN_UNITS).toBe(true);
    // One burn's payout floor pays one deposit back and its gas reserve.
    expect(minimumUsdcxPayout(ARC_CHAIN_ID, BURN_UNITS) >= DEPOSIT_UNITS + GAS_RESERVE_UNITS).toBe(true);
    expect(isWorthClaiming(DEPOSIT_UNITS, 7)).toBe(true);
  });

  // A stalled endpoint is left only after the transport timeout, so a read step must outlast one on every endpoint.
  it('gives a step that reads Arc one transport timeout per endpoint an operator run can have, plus 15 s', () => {
    expect(ARC_RPC_TIMEOUT_MS).toBe(15_000);
    expect(ARC_READ_STEP_BUDGET_MS).toBeGreaterThanOrEqual(
      arcEndpoints('https://operator.example').length * ARC_RPC_TIMEOUT_MS + 15_000
    );
    expect(ARC_READ_STEP_BUDGET_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe('arcHost', () => {
  it('names an endpoint by its host, never the API key its path or query may carry', () => {
    expect(arcHost('https://arc-testnet.example.com:8443/v2/token-in-path?key=token-in-query')).toBe(
      'arc-testnet.example.com:8443'
    );
    expect(arcHost(ARC_DRPC_URL)).toBe('rpc.drpc.testnet.arc.io');
  });

  it('never echoes an endpoint it cannot parse', () => {
    expect(arcHost('token-in-path/not-a-url')).toBe('an unparseable Arc endpoint');
  });
});

type Rpc = (method: string, params: readonly unknown[]) => unknown;

/** A real viem client over a stub EIP-1193 provider, so viem's own encoding and decoding run in every test. */
function stubClient(rpc: Rpc, calls: string[] = []): PublicClient {
  return createPublicClient({
    chain: ARC_TESTNET,
    cacheTime: 0,
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          calls.push(method);
          return rpc(method, Array.isArray(params) ? params : []);
        }
      },
      { retryCount: 0 }
    )
  });
}

function rpcError(code: number, message: string, data?: Hex): Error {
  return Object.assign(new Error(message), { code, data });
}

const CALL_ABI = [
  ...XRESERVE_HARNESS_ABI,
  ...parseAbi([
    'function balanceOf(address account) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
  ])
];

function callOf(params: readonly unknown[]): { functionName: string; args: readonly unknown[]; block: unknown } {
  const [request, block] = params;
  const data: unknown = request !== null && typeof request === 'object' ? Reflect.get(request, 'data') : undefined;
  if (!isHex(data)) throw new Error('eth_call without data');
  const decoded = decodeFunctionData({ abi: CALL_ABI, data });
  return { functionName: decoded.functionName, args: decoded.args ?? [], block };
}

const encodeUint = (value: bigint) => encodeAbiParameters([{ type: 'uint256' }], [value]);
const encodeBool = (value: boolean) => encodeAbiParameters([{ type: 'bool' }], [value]);

function fakeClock(start = 0): ArcClock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async ms => {
      slept.push(ms);
      now += ms;
    }
  };
}

function payoutAt(index: number): (typeof arcVectors.payouts)[number] {
  const payout = arcVectors.payouts[index];
  if (!payout) throw new Error(`arc-usdcx.vectors.json has no payout ${index}`);
  return payout;
}

function l2PayoutOn(chainId: number): (typeof l2Vectors.payouts)[number] {
  const payout = l2Vectors.payouts.find(candidate => candidate.chainId === chainId);
  if (!payout) throw new Error(`usdcx-l2.vectors.json has no payout on chain ${chainId}`);
  return payout;
}

const SPIKE = payoutAt(5);
const DEPOSIT_RECEIPT = arcVectors.deposit.receipt;
const [CAPTURED] = attestationVectors.attestations;

function capturedAttestation(): XReserveAttestation {
  if (!CAPTURED || !isHex(CAPTURED.payload) || !isHex(CAPTURED.messageHash) || !isHex(CAPTURED.attestation)) {
    throw new Error('attestation.vectors.json lost its captured entry');
  }
  return {
    payload: CAPTURED.payload,
    messageHash: CAPTURED.messageHash,
    attestation: CAPTURED.attestation,
    remoteDomain: CAPTURED.remoteDomain
  };
}

describe('arcEndpoints', () => {
  it('puts the operator endpoint first and keeps the defaults after it, once each', () => {
    expect(arcEndpoints()).toEqual([ARC_DRPC_URL, ARC_QUICKNODE_URL, ARC_PUBLIC_URL]);
    expect(arcEndpoints(' https://arc.example ')).toEqual([
      'https://arc.example',
      ARC_DRPC_URL,
      ARC_QUICKNODE_URL,
      ARC_PUBLIC_URL
    ]);
    expect(arcEndpoints(ARC_PUBLIC_URL)).toEqual([ARC_PUBLIC_URL, ARC_DRPC_URL, ARC_QUICKNODE_URL]);
  });

  it('refuses an override that is set but empty', () => {
    expect(() => arcEndpoints('')).toThrow('E2E_ARC_RPC_URL is set but empty');
    expect(() => arcEndpoints('   ')).toThrow('E2E_ARC_RPC_URL is set but empty');
  });
});

describe('readArcUsdc', () => {
  it('moves to the next endpoint when one fails, and reads at the block it is given', async () => {
    const calls: string[] = [];
    const blocks: unknown[] = [];
    const clients: Record<string, PublicClient> = {
      'https://a': stubClient(() => {
        throw rpcError(-32005, 'rate limit exceeded');
      }, calls),
      'https://b': stubClient((_method, params) => {
        const call = callOf(params);
        blocks.push(call.block);
        return encodeUint(9_983_600n);
      }, calls)
    };
    const balance = await readArcUsdc(
      addressOf(SPIKE.recipient),
      {
        endpoints: ['https://a', 'https://b'],
        publicClient: endpoint => clients[endpoint] ?? stubClient(() => null)
      },
      66483812n
    );
    expect(balance).toBe(9_983_600n);
    expect(calls).toEqual(['eth_call', 'eth_call']);
    expect(blocks).toEqual(['0x3f67664']);
  });

  it('names every endpoint by its host when none answers', async () => {
    const failing = stubClient(() => {
      throw rpcError(-32005, 'rate limit exceeded');
    });
    const failure = readArcUsdc(ARC_USDC, {
      endpoints: ['https://a.example/v2/token-in-path', 'https://b.example/?key=token-in-query'],
      publicClient: () => failing
    });
    await expect(failure).rejects.toThrow(
      /no Arc endpoint answered\n {2}a\.example: .*rate limit exceeded\n {2}b\.example: /
    );
    await expect(failure).rejects.not.toThrow(/token-in/);
  });

  it('snapshots the head and the balance at that head on one endpoint, moving on when one fails', async () => {
    const blocks: unknown[] = [];
    const clients: Record<string, PublicClient> = {
      'https://a': stubClient(() => {
        throw rpcError(-32005, 'rate limit exceeded');
      }),
      'https://b': stubClient((method, params) => {
        if (method === 'eth_blockNumber') return '0x3f67664';
        blocks.push(callOf(params).block);
        return encodeUint(968_903n);
      })
    };
    const snapshot = await readArcUsdcSnapshot(addressOf(SPIKE.recipient), {
      endpoints: ['https://a', 'https://b'],
      publicClient: endpoint => clients[endpoint] ?? stubClient(() => null)
    });
    expect(snapshot).toEqual({ endpoint: 'https://b', blockNumber: 66483812n, balance: 968_903n });
    expect(blocks).toEqual(['0x3f67664']);
  });
});

describe('readXReserveDomainState', () => {
  it("reads Miden's domain on one endpoint, the token lowercased and the depositor as a bytes32", async () => {
    const answers: Record<string, Hex> = {
      isRemoteDomainRegistered: encodeBool(true),
      paused: encodeBool(false),
      domainDepositsPaused: encodeBool(false),
      domainWithdrawalsPaused: encodeBool(false),
      getRemoteToken: '0x000000000000000000000000000000004CBDCAFFE75F0A317482224DAE643600',
      getRemoteDomainDepositor: encodeAbiParameters(
        [{ type: 'address' }],
        ['0xb21c91a0f4d4c03f4b6a0fc5214f06e431ff2b2d']
      ),
      gatewayMinter: encodeAbiParameters([{ type: 'address' }], [GATEWAY_MINTER])
    };
    const asked: string[] = [];
    const client = stubClient((_method, params) => {
      const call = callOf(params);
      asked.push(`${call.functionName}(${call.args.map(String).join(',')})`);
      return answers[call.functionName];
    });

    const state = await readXReserveDomainState({ endpoints: [ARC_DRPC_URL], publicClient: () => client });

    expect(state).toEqual({
      endpoint: ARC_DRPC_URL,
      registered: true,
      paused: false,
      depositsPaused: false,
      withdrawalsPaused: false,
      remoteToken: '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600',
      depositor: arcVectors.remoteDomainDepositor,
      gatewayMinter: GATEWAY_MINTER
    });
    expect(asked).toEqual([
      'isRemoteDomainRegistered(10007)',
      'paused()',
      'domainDepositsPaused(10007)',
      'domainWithdrawalsPaused(10007)',
      `getRemoteToken(10007,${ARC_USDC})`,
      'getRemoteDomainDepositor(10007)',
      'gatewayMinter()'
    ]);
  });
});

function filterOf(params: readonly unknown[]): { from: bigint; to: bigint; topics: unknown[] } {
  const [filter] = params;
  if (filter === null || typeof filter !== 'object') throw new Error('eth_getLogs without a filter');
  const from: unknown = Reflect.get(filter, 'fromBlock');
  const to: unknown = Reflect.get(filter, 'toBlock');
  const topics: unknown = Reflect.get(filter, 'topics');
  if (!isHex(from) || !isHex(to)) throw new Error('eth_getLogs without a block range');
  return { from: hexToBigInt(from), to: hexToBigInt(to), topics: Array.isArray(topics) ? topics : [] };
}

describe('scanArcLogs', () => {
  const query = { address: GATEWAY_MINTER, topics: [ATTESTATION_USED_TOPIC], fromBlock: 1000n, toBlock: 1249n };

  it('walks the range in chunk-block windows and reports each window it covered', async () => {
    const spans: string[] = [];
    const client = stubClient((_method, params) => {
      const { from, to } = filterOf(params);
      spans.push(`${from}-${to}`);
      return from <= 1100n && 1100n <= to ? [SPIKE.log] : [];
    });
    const scan = await scanArcLogs(client, ARC_DRPC_URL, { ...query, chunk: 100 });
    expect(spans).toEqual(['1000-1099', '1100-1199', '1200-1249']);
    expect(scan.logs.map(log => log.transactionHash)).toEqual([SPIKE.transaction.hash]);
    expect(scan.ranges).toEqual([
      { endpoint: ARC_DRPC_URL, fromBlock: 1000n, toBlock: 1099n },
      { endpoint: ARC_DRPC_URL, fromBlock: 1100n, toBlock: 1199n },
      { endpoint: ARC_DRPC_URL, fromBlock: 1200n, toBlock: 1249n }
    ]);
  });

  it("halves the window on drpc's range refusal until it fits, leaving no gap", async () => {
    const spans: bigint[] = [];
    const refused: bigint[] = [];
    const client = stubClient((_method, params) => {
      const { from, to } = filterOf(params);
      if (to - from + 1n > 25n) {
        refused.push(to - from + 1n);
        throw rpcError(35, 'ranges over 10000 blocks are not supported on free plan');
      }
      spans.push(to - from + 1n);
      return [];
    });
    const scan = await scanArcLogs(client, ARC_DRPC_URL, { ...query, chunk: 100 });
    // Stepping down by one also lands on 25-block windows; only the refused sizes tell halving apart.
    expect(refused).toEqual([100n, 50n]);
    expect(spans).toEqual(Array(10).fill(25n));
    expect(scan.ranges.map(range => `${range.fromBlock}-${range.toBlock}`)).toEqual(
      Array.from({ length: 10 }, (_, index) => `${1000 + index * 25}-${1024 + index * 25}`)
    );
  });

  it('rethrows an error that is not about the range, at once', async () => {
    const calls: string[] = [];
    const client = stubClient(() => {
      throw rpcError(-32005, 'rate limit exceeded');
    }, calls);
    await expect(scanArcLogs(client, ARC_DRPC_URL, { ...query, chunk: 100 })).rejects.toThrow('rate limit exceeded');
    expect(calls).toEqual(['eth_getLogs']);
  });
});

type CapturedLog = (typeof arcVectors.payouts)[number]['log'];

/** The payout gate's Arc: a head that moves, a scripted balance, and the captured logs and gatewayMint transactions. */
function payoutChain(world: {
  balances: readonly bigint[];
  logs: readonly CapturedLog[];
  failLogs?: boolean;
  /** Each balance read's token address, lowercase. */
  tokens?: string[];
}): Rpc {
  let head = 66483820n;
  let balanceReads = 0;
  const transactions = new Map<string, unknown>(
    [...arcVectors.payouts, ...l2Vectors.payouts].map(payout => [payout.transaction.hash, payout.transaction])
  );
  return (method, params) => {
    switch (method) {
      case 'eth_blockNumber':
        head += 2n;
        return toHex(head);
      case 'eth_call': {
        const [request] = params;
        world.tokens?.push(
          String(request !== null && typeof request === 'object' ? Reflect.get(request, 'to') : '').toLowerCase()
        );
        const balance = world.balances[Math.min(balanceReads, world.balances.length - 1)] ?? 0n;
        balanceReads += 1;
        return encodeUint(balance);
      }
      case 'eth_getLogs': {
        if (world.failLogs) throw rpcError(-32603, 'internal error');
        const { from, to, topics } = filterOf(params);
        return world.logs.filter(log => {
          const block = BigInt(log.blockNumber);
          return (
            block >= from &&
            block <= to &&
            topics.every(
              (topic, index) => topic === null || String(topic).toLowerCase() === log.topics[index]?.toLowerCase()
            )
          );
        });
      }
      case 'eth_getTransactionByHash':
        return transactions.get(String(params[0])) ?? null;
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
}

/** A captured log moved to another block, so it falls inside a scan that the original does not. */
const movedTo = (log: CapturedLog, block: bigint): CapturedLog => ({ ...log, blockNumber: toHex(block) });

describe('waitForGatewayPayout', () => {
  const CONSUME_MS = 1_791_638_693_000;
  const args = {
    recipient: addressOf(SPIKE.recipient),
    burnNoteId: hexOf(SPIKE.burnNoteId),
    burnUnits: BigInt(SPIKE.burnUnits),
    fromBlock: 66483700n,
    consumeTsMs: CONSUME_MS,
    deadlineMs: CONSUME_MS + PAYOUT_TIMEOUT_MS,
    depositor: hexOf(arcVectors.remoteDomainDepositor),
    minimumValue: minimumUsdcxPayout(ARC_CHAIN_ID, BigInt(SPIKE.burnUnits))
  };
  // Another recipient's payout inside the scanned range: only the recipient topic keeps it out.
  const neighbour = movedTo(payoutAt(1).log, 66483790n);

  it('proves the spike payout: one AttestationUsed for the key, its value the balance, the note id in the calldata', async () => {
    const clock = fakeClock(CONSUME_MS + 12_000);
    const chain = payoutChain({ balances: [0n, 9_983_600n], logs: [SPIKE.log, neighbour] });

    const payout = await waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(chain),
      clock
    });

    expect(payout).toMatchObject({
      endpoint: ARC_DRPC_URL,
      value: 9_983_600n,
      balance: 9_983_600n,
      logBlock: 66483812n,
      transactionHash: SPIKE.transaction.hash,
      sourceDomain: 26,
      sourceDepositor: arcVectors.remoteDomainDepositor,
      fee: 16_400n,
      latencyMs: 17_000
    });
    expect(payout.balanceBlock >= 66483812n).toBe(true);
    expect(clock.slept).toEqual([5_000]);
    // drpc: 100-block windows from the block after the snapshot to B.
    expect(payout.ranges[0]).toEqual({ endpoint: ARC_DRPC_URL, fromBlock: 66483701n, toBlock: 66483800n });
  });

  it.each(arcVectors.payouts.map(payout => [payout.burnUnits, payout]))(
    'correlates the captured payout of a %s-unit burn, Circle keeping 16400',
    async (_units, payout) => {
      const block = BigInt(payout.log.blockNumber);
      const correlated = await waitForGatewayPayout(
        {
          ...args,
          recipient: addressOf(payout.recipient),
          burnNoteId: hexOf(payout.burnNoteId),
          burnUnits: BigInt(payout.burnUnits),
          fromBlock: block - 50n,
          minimumValue: minimumUsdcxPayout(ARC_CHAIN_ID, BigInt(payout.burnUnits))
        },
        {
          endpoints: [ARC_QUICKNODE_URL],
          publicClient: () =>
            stubClient(payoutChain({ balances: [BigInt(payout.value)], logs: [movedTo(payout.log, 66483812n)] })),
          clock: fakeClock(CONSUME_MS)
        }
      );
      expect(correlated.fee).toBe(16_400n);
      expect(correlated.value).toBe(BigInt(payout.value));
    }
  );

  it('fails uncorrelated, at once, when the gatewayMint calldata does not carry this burn', async () => {
    const otherBurn = hexOf(payoutAt(1).burnNoteId);
    const failure = waitForGatewayPayout(
      { ...args, burnNoteId: otherBurn },
      {
        endpoints: [ARC_DRPC_URL],
        publicClient: () => stubClient(payoutChain({ balances: [9_983_600n], logs: [SPIKE.log] })),
        clock: fakeClock(CONSUME_MS)
      }
    );
    await expect(failure).rejects.toThrow(PayoutGateError);
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow(`calldata lacks the burn note id ${otherBurn}`);
    await expect(failure).rejects.toThrow(LATE_PAYOUT_NOTE);
  });

  it('fails uncorrelated on two logs for the key, and on a value that is not the balance', async () => {
    const twice = movedTo(SPIKE.log, 66483810n);
    await expect(
      waitForGatewayPayout(args, {
        endpoints: [ARC_DRPC_URL],
        publicClient: () => stubClient(payoutChain({ balances: [9_983_600n], logs: [SPIKE.log, twice] })),
        clock: fakeClock(CONSUME_MS)
      })
    ).rejects.toThrow('found 2 AttestationUsed logs');
    await expect(
      waitForGatewayPayout(args, {
        endpoints: [ARC_DRPC_URL],
        publicClient: () => stubClient(payoutChain({ balances: [9_983_601n], logs: [SPIKE.log] })),
        clock: fakeClock(CONSUME_MS)
      })
    ).rejects.toThrow('log value 9983600 differs from the balance 9983601');
  });

  it('moves to the next endpoint with a fresh head when one fails', async () => {
    const failing = stubClient(() => {
      throw rpcError(-32005, 'rate limit exceeded');
    });
    const healthy = stubClient(payoutChain({ balances: [9_983_600n], logs: [SPIKE.log] }));
    const payout = await waitForGatewayPayout(args, {
      endpoints: [ARC_PUBLIC_URL, ARC_DRPC_URL],
      publicClient: endpoint => (endpoint === ARC_PUBLIC_URL ? failing : healthy),
      clock: fakeClock(CONSUME_MS)
    });
    expect(payout.endpoint).toBe(ARC_DRPC_URL);
  });

  it('fails no-mint at the deadline when the balance stays zero', async () => {
    const clock = fakeClock(CONSUME_MS);
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [0n], logs: [] })),
      clock
    });
    await expect(failure).rejects.toMatchObject({ failure: 'no-mint' });
    await expect(failure).rejects.toThrow(
      `no destination mint for this key by ${new Date(args.deadlineMs).toISOString()}`
    );
    expect(clock.slept).toEqual(Array(PAYOUT_TIMEOUT_MS / 5_000).fill(5_000));
  });

  it('fails scan-gaps when the balance arrived but no scan could run', async () => {
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [9_983_600n], logs: [SPIKE.log], failLogs: true })),
      clock: fakeClock(CONSUME_MS)
    });
    await expect(failure).rejects.toMatchObject({ failure: 'scan-gaps' });
    await expect(failure).rejects.toThrow('unknown: scan gaps none');
  });

  it('names each endpoint by its host in a failure, never the token in its path', async () => {
    const operator = 'https://arc.example/v2/token-in-path';
    const failing = stubClient(() => {
      throw rpcError(-32005, 'rate limit exceeded');
    });
    const uncorrelated = waitForGatewayPayout(
      { ...args, burnNoteId: hexOf(payoutAt(1).burnNoteId) },
      {
        endpoints: [operator],
        publicClient: () => stubClient(payoutChain({ balances: [9_983_600n], logs: [SPIKE.log] })),
        clock: fakeClock(CONSUME_MS)
      }
    );
    await expect(uncorrelated).rejects.toThrow('  endpoint: arc.example\n');
    await expect(uncorrelated).rejects.toThrow('  ranges: arc.example 66483701-');
    await expect(uncorrelated).rejects.not.toThrow('token-in-path');
    const noMint = waitForGatewayPayout(args, {
      endpoints: [operator, ARC_DRPC_URL],
      publicClient: endpoint =>
        endpoint === operator ? failing : stubClient(payoutChain({ balances: [0n], logs: [] })),
      clock: fakeClock(CONSUME_MS)
    });
    await expect(noMint).rejects.toThrow('endpointErrors: arc.example: ');
    await expect(noMint).rejects.not.toThrow('token-in-path');
  });

  it('fails uncorrelated at the deadline when every complete scan finds no log', async () => {
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [9_983_600n], logs: [] })),
      clock: fakeClock(CONSUME_MS)
    });
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow('found 0 AttestationUsed logs');
    // An empty key held nothing before the burn, so no earlier credit can be in the window.
    await expect(failure).rejects.not.toThrow(PREFUNDED_KEY_NOTE);
  });
});

describe('waitForGatewayPayout delta mode', () => {
  const CONSUME_MS = 1_791_638_693_000;
  // Payouts 1, 2 and 4 all paid 0xe88f...ff99: a real key that held USDC before a 1 USDCx burn (payout 4).
  const [EARLIER, OTHER, ONE_USDCX] = [payoutAt(1), payoutAt(2), payoutAt(4)];
  const HELD = BigInt(EARLIER.value) + BigInt(OTHER.value);
  const args = {
    recipient: addressOf(ONE_USDCX.recipient),
    burnNoteId: hexOf(ONE_USDCX.burnNoteId),
    burnUnits: BigInt(ONE_USDCX.burnUnits),
    fromBlock: 66483700n,
    balanceBefore: HELD,
    consumeTsMs: CONSUME_MS,
    deadlineMs: CONSUME_MS + PAYOUT_TIMEOUT_MS,
    depositor: hexOf(arcVectors.remoteDomainDepositor),
    minimumValue: minimumUsdcxPayout(ARC_CHAIN_ID, BigInt(ONE_USDCX.burnUnits))
  };
  // The key's earlier payouts, the second in the snapshot block itself: both are already inside balanceBefore.
  const history = [movedTo(EARLIER.log, 66483650n), movedTo(OTHER.log, 66483700n)];
  const paid = movedTo(ONE_USDCX.log, 66483812n);

  it('proves a 1 USDCx payout to a key that already held USDC, its earlier payouts outside the window', async () => {
    const clock = fakeClock(CONSUME_MS + 12_000);
    // One chain for every cycle, so the scripted balances advance read by read.
    const chain = payoutChain({ balances: [HELD, HELD, HELD + 983_600n], logs: [...history, paid] });
    const payout = await waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(chain),
      clock
    });
    expect(payout).toMatchObject({
      value: 983_600n,
      balance: HELD + 983_600n,
      logBlock: 66483812n,
      transactionHash: ONE_USDCX.transaction.hash,
      fee: 16_400n,
      latencyMs: 22_000
    });
    expect(clock.slept).toEqual([5_000, 5_000]);
    expect(payout.ranges[0]).toEqual({ endpoint: ARC_DRPC_URL, fromBlock: 66483701n, toBlock: 66483800n });
  });

  it('fails uncorrelated on a rise that is not the log value, saying the key held USDC before', async () => {
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [HELD + 983_601n], logs: [...history, paid] })),
      clock: fakeClock(CONSUME_MS)
    });
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow(
      `log value 983600 differs from the balance ${HELD + 983_601n} at 66483822 less ${HELD} at 66483700; ` +
        PREFUNDED_KEY_NOTE
    );
    await expect(failure).rejects.toThrow(`balanceBefore: ${HELD}`);
  });

  it("fails uncorrelated on a stray payout in the window, naming each log's transaction and block", async () => {
    const stray = movedTo(OTHER.log, 66483815n);
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [HELD + 983_600n], logs: [...history, paid, stray] })),
      clock: fakeClock(CONSUME_MS)
    });
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow(
      'found 2 AttestationUsed logs after block 66483700 up to block 66483822, 2 decodable: ' +
        `${ONE_USDCX.log.transactionHash} in block 66483812, ${OTHER.log.transactionHash} in block 66483815; ` +
        PREFUNDED_KEY_NOTE
    );
  });

  it('fails uncorrelated at the deadline when no complete scan finds the log, saying the key held USDC before', async () => {
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [HELD + 983_600n], logs: history })),
      clock: fakeClock(CONSUME_MS)
    });
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow(
      'payout received but not correlated: rpc.drpc.testnet.arc.io: found 0 AttestationUsed logs after block ' +
        `66483700 up to block 66483822; ${PREFUNDED_KEY_NOTE}`
    );
  });

  it('waits while the balance stays at balanceBefore, and fails no-mint at the deadline', async () => {
    const clock = fakeClock(CONSUME_MS);
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [HELD], logs: history })),
      clock
    });
    await expect(failure).rejects.toMatchObject({ failure: 'no-mint' });
    expect(clock.slept).toEqual(Array(PAYOUT_TIMEOUT_MS / 5_000).fill(5_000));
  });

  it('fails key-moved at once when the key falls below balanceBefore, without the late-payout note', async () => {
    const clock = fakeClock(CONSUME_MS);
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [HELD - 14_697n], logs: history })),
      clock
    });
    await expect(failure).rejects.toMatchObject({ failure: 'key-moved' });
    await expect(failure).rejects.toThrow(
      `the payout key moved during the payout window: balance ${HELD - 14_697n} at block 66483822 is below ` +
        `${HELD} at block 66483700`
    );
    await expect(failure).rejects.toThrow(KEY_MOVED_NOTE);
    await expect(failure).rejects.not.toThrow(LATE_PAYOUT_NOTE);
    expect(clock.slept).toEqual([]);
  });

  it('reads nothing into a head at or below the snapshot block, then proves the payout once past it', async () => {
    const clock = fakeClock(CONSUME_MS);
    // A lagging endpoint reads the key as it was before the snapshot, here 5 below it.
    const chain = payoutChain({
      balances: [HELD - 5n, HELD - 5n, HELD - 5n, HELD + 983_600n],
      logs: [...history, movedTo(ONE_USDCX.log, 66483827n)]
    });
    const payout = await waitForGatewayPayout(
      { ...args, fromBlock: 66483826n },
      { endpoints: [ARC_DRPC_URL], publicClient: () => stubClient(chain), clock }
    );
    expect(payout.value).toBe(983_600n);
    expect(clock.slept).toEqual([5_000, 5_000, 5_000]);
  });
});

describe('payout chains (usdcx-constants.ts)', () => {
  it("keeps Arc's payout chain exactly the Arc values every Arc test read before the L2 suite", () => {
    expect(ARC_PAYOUT).toMatchObject({
      chainId: ARC_CHAIN_ID,
      chain: ARC_TESTNET,
      label: 'Arc',
      rpcUrls: DEFAULT_ARC_RPCS,
      usdc: ARC_USDC,
      burnDomain: ARC_CIRCLE_DOMAIN,
      attestationSourceDomain: ARC_CIRCLE_DOMAIN,
      reviewNetwork: 'arc-testnet',
      networkName: 'Arc Testnet',
      explorer: ARC_TESTNET.blockExplorers.default.url,
      walletRpcUrl: ARC_PUBLIC_URL,
      walletRpcName: 'arc.io',
      burnUnits: 5_000_000n
    });
  });

  it("reads each L2 from the wallet's tables: the burn carries its own domain, every payout Arc's 26", () => {
    expect(BASE_SEPOLIA_PAYOUT).toMatchObject({
      chainId: 84532,
      label: 'Base Sepolia',
      rpcUrls: [
        'https://base-sepolia-rpc.publicnode.com',
        'https://base-sepolia.gateway.tenderly.co',
        'https://sepolia.base.org'
      ],
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      burnDomain: 6,
      attestationSourceDomain: 26,
      reviewNetwork: 'base-sepolia',
      networkName: 'Base Sepolia',
      explorer: 'https://sepolia.basescan.org',
      walletRpcName: 'rpc.walletconnect.org',
      burnUnits: 5_000_000n
    });
    expect(ARBITRUM_SEPOLIA_PAYOUT).toMatchObject({
      chainId: 421614,
      label: 'Arbitrum Sepolia',
      rpcUrls: [
        'https://sepolia-rollup.arbitrum.io/rpc',
        'https://arbitrum-sepolia-rpc.publicnode.com',
        'https://arbitrum-sepolia.gateway.tenderly.co'
      ],
      usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      burnDomain: 3,
      attestationSourceDomain: 26,
      reviewNetwork: 'arbitrum-sepolia',
      networkName: 'Arbitrum Sepolia',
      explorer: 'https://sepolia.arbiscan.io',
      walletRpcName: 'rpc.walletconnect.org',
      burnUnits: 5_000_000n
    });
    for (const chain of [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT, ETHEREUM_SEPOLIA_PAYOUT]) {
      expect(chain.walletRpcUrl).toBe(
        `https://rpc.walletconnect.org/v1?chainId=eip155:${chain.chainId}&projectId=${WC_PROJECT_ID}`
      );
      // drpc fails near the head on both L2s and serves no Sepolia, and the wallet's own RPC is what the tests check.
      expect(chain.rpcUrls.filter(url => /drpc|walletconnect/.test(url))).toEqual([]);
    }
  });

  it("reads Ethereum Sepolia from the wallet's tables: the burn carries domain 0, the payout Arc's 26, and it burns 5 USDCx", () => {
    expect(ETHEREUM_SEPOLIA_PAYOUT).toMatchObject({
      chainId: 11155111,
      label: 'Ethereum Sepolia',
      rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.gateway.tenderly.co'],
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      burnDomain: 0,
      attestationSourceDomain: 26,
      reviewNetwork: 'sepolia',
      networkName: 'Sepolia',
      explorer: 'https://sepolia.etherscan.io',
      walletRpcName: 'rpc.walletconnect.org',
      burnUnits: 5_000_000n
    });
  });

  it('refuses a chain Send does not offer, and a burn its payout fee allowance takes whole, which Send refuses', () => {
    const reads = { rpcUrls: [], logChunk: () => L2_LOG_CHUNK };
    expect(() => payoutChainFor(1, reads)).toThrow('chain 1 is not a Send destination');
    // An explicit 1 USDCx amount does not clear Ethereum's 1.5 USDC allowance.
    expect(() => payoutChainFor(11155111, { ...reads, burnUnits: 1_000_000n })).toThrow(
      'a 1 USDCx burn to Sepolia does not exceed its 1.5 USDC payout fee allowance, so the Send flow refuses it'
    );
    expect(() => payoutChainFor(11155111, { ...reads, burnUnits: 1_500_000n })).toThrow(
      'a 1.5 USDCx burn to Sepolia does not exceed its 1.5 USDC payout fee allowance'
    );
    expect(payoutChainFor(11155111, { ...reads, burnUnits: 1_500_001n }).burnUnits).toBe(1_500_001n);
    expect(() => payoutChainFor(84532, { ...reads, burnUnits: 100_000n })).toThrow(
      'a 0.1 USDCx burn to Base Sepolia does not exceed its 0.1 USDC payout fee allowance'
    );
  });

  it("scans Base Sepolia's own RPC in 200-block windows, Arc's drpc in 100 and every other endpoint in 1000", () => {
    expect([BASE_OFFICIAL_LOG_CHUNK, L2_LOG_CHUNK]).toEqual([200, 1000]);
    expect(BASE_SEPOLIA_PAYOUT.rpcUrls.map(url => BASE_SEPOLIA_PAYOUT.logChunk(url))).toEqual([1000, 1000, 200]);
    expect(ARBITRUM_SEPOLIA_PAYOUT.rpcUrls.map(url => ARBITRUM_SEPOLIA_PAYOUT.logChunk(url))).toEqual([
      1000, 1000, 1000
    ]);
    // publicnode and tenderly served 10_000-block eth_getLogs on Sepolia's GatewayMinter when probed (2026-10-16).
    expect(ETHEREUM_SEPOLIA_PAYOUT.rpcUrls.map(url => ETHEREUM_SEPOLIA_PAYOUT.logChunk(url))).toEqual([1000, 1000]);
    expect(DEFAULT_ARC_RPCS.map(url => ARC_PAYOUT.logChunk(url))).toEqual([100, 1000, 1000]);
  });

  it('gives an L2 read step the Arc read budget, which outlasts a stall on every L2 endpoint', () => {
    for (const chain of [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT, ETHEREUM_SEPOLIA_PAYOUT]) {
      expect(chain.rpcUrls.length * ARC_RPC_TIMEOUT_MS + 15_000).toBeLessThanOrEqual(ARC_READ_STEP_BUDGET_MS);
    }
  });
});

describe('reads on an L2 payout chain', () => {
  const RECIPIENT = addressOf(l2PayoutOn(84532).recipient);

  it("reads the L2's own USDC and names the L2 when no endpoint answers", async () => {
    const asked: string[] = [];
    const answering = stubClient((_method, params) => {
      const [request] = params;
      asked.push(String(request !== null && typeof request === 'object' ? Reflect.get(request, 'to') : ''));
      return encodeUint(988_901n);
    });
    const reads = {
      endpoints: ['https://base-sepolia-rpc.publicnode.com'],
      publicClient: () => answering,
      payoutChain: BASE_SEPOLIA_PAYOUT
    };
    await expect(readArcUsdc(RECIPIENT, reads)).resolves.toBe(988_901n);
    expect(asked.map(to => to.toLowerCase())).toEqual([BASE_SEPOLIA_PAYOUT.usdc.toLowerCase()]);
    const failing = stubClient(() => {
      throw rpcError(-32005, 'rate limit exceeded');
    });
    await expect(readArcUsdcSnapshot(RECIPIENT, { ...reads, publicClient: () => failing })).rejects.toThrow(
      /^Base Sepolia USDC snapshot of 0x[0-9a-fA-F]{40}: no Base Sepolia endpoint answered\n {2}base-sepolia-rpc\.publicnode\.com: /
    );
  });

  it("snapshots the key's balance of the L2's own USDC at the L2's head", async () => {
    const tokens: string[] = [];
    const reads = {
      endpoints: ['https://base-sepolia-rpc.publicnode.com'],
      publicClient: () => stubClient(payoutChain({ balances: [988_901n], logs: [], tokens })),
      payoutChain: BASE_SEPOLIA_PAYOUT
    };
    await expect(readArcUsdcSnapshot(RECIPIENT, reads)).resolves.toEqual({
      endpoint: 'https://base-sepolia-rpc.publicnode.com',
      blockNumber: 66483822n,
      balance: 988_901n
    });
    expect(tokens).toEqual([BASE_SEPOLIA_PAYOUT.usdc.toLowerCase()]);
  });

  it('refuses an L2 deps object where only Arc applies: the xReserve state and both deposit legs, building no client', async () => {
    const built: string[] = [];
    const l2 = {
      endpoints: ['https://base-sepolia-rpc.publicnode.com'],
      payoutChain: BASE_SEPOLIA_PAYOUT,
      publicClient: (endpoint: string) => {
        built.push(endpoint);
        return stubClient(() => null);
      }
    };
    await expect(readXReserveDomainState(l2)).rejects.toThrow(
      'xReserve domain state runs on Arc only, not on Base Sepolia'
    );
    await expect(
      submitDepositToMiden(
        {
          privateKey: `0x${'11'.repeat(32)}`,
          units: DEPOSIT_UNITS,
          recipientHex: '0xf2f42cda8d010f417d1cad5dc4d52b',
          approve: 'exact'
        },
        l2
      )
    ).rejects.toThrow('the xReserve deposit runs on Arc only, not on Base Sepolia');
    await expect(
      confirmDepositToMiden(
        {
          endpoint: 'https://base-sepolia-rpc.publicnode.com',
          depositHash: hexOf(arcVectors.deposit.transactionHash),
          approved: false
        },
        l2
      )
    ).rejects.toThrow('the xReserve deposit receipt runs on Arc only, not on Base Sepolia');
    expect(built).toEqual([]);
  });
});

describe('waitForGatewayPayout on an L2', () => {
  const CONSUME_MS = 1_791_638_693_000;
  const BASE = l2PayoutOn(84532);
  const ENDPOINT = 'https://base-sepolia-rpc.publicnode.com';
  const args = {
    recipient: addressOf(BASE.recipient),
    burnNoteId: hexOf(BASE.burnNoteId),
    burnUnits: BigInt(BASE.burnUnits),
    fromBlock: 66483700n,
    consumeTsMs: CONSUME_MS,
    deadlineMs: CONSUME_MS + PAYOUT_TIMEOUT_MS,
    depositor: hexOf(l2Vectors.depositor),
    minimumValue: minimumUsdcxPayout(84532, BigInt(BASE.burnUnits))
  };
  const paid = movedTo(BASE.log, 66483812n);
  const baseReads = (world: Rpc, endpoint = ENDPOINT) => ({
    endpoints: [endpoint],
    publicClient: () => stubClient(world),
    clock: fakeClock(CONSUME_MS + 7_000),
    payoutChain: BASE_SEPOLIA_PAYOUT
  });

  it("proves the probe's Base Sepolia payout: Base's USDC in the token topic, Arc's domain 26 as the source", async () => {
    const payout = await waitForGatewayPayout(args, baseReads(payoutChain({ balances: [988_901n], logs: [paid] })));
    expect(payout).toMatchObject({
      endpoint: ENDPOINT,
      value: 988_901n,
      balance: 988_901n,
      logBlock: 66483812n,
      transactionHash: BASE.transaction.hash,
      sourceDomain: 26,
      sourceDepositor: l2Vectors.depositor,
      fee: 11_099n,
      latencyMs: 7_000
    });
  });

  it.each(l2Vectors.payouts.map(payout => [payout.chainId, payout]))(
    'correlates the probe payout on chain %s, Circle keeping 11099',
    async (chainId, payout) => {
      const chain = [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT].find(candidate => candidate.chainId === chainId);
      if (!chain) throw new Error(`no payout chain ${chainId}`);
      const correlated = await waitForGatewayPayout(
        {
          ...args,
          recipient: addressOf(payout.recipient),
          burnNoteId: hexOf(payout.burnNoteId),
          minimumValue: minimumUsdcxPayout(chain.chainId, BigInt(payout.burnUnits))
        },
        {
          endpoints: [chain.rpcUrls[0] ?? ''],
          publicClient: () =>
            stubClient(payoutChain({ balances: [BigInt(payout.value)], logs: [movedTo(payout.log, 66483812n)] })),
          clock: fakeClock(CONSUME_MS),
          payoutChain: chain
        }
      );
      expect({ value: correlated.value, fee: correlated.fee }).toEqual({ value: 988_901n, fee: 11_099n });
    }
  );

  // The token topic is the paid chain's USDC: under Arc's, an L2 payout is invisible.
  it("finds no log for an L2 payout under Arc's token topic, so the gate must filter on the L2's USDC", async () => {
    const failure = waitForGatewayPayout(args, {
      endpoints: [ENDPOINT],
      publicClient: () => stubClient(payoutChain({ balances: [988_901n], logs: [paid] })),
      clock: fakeClock(CONSUME_MS)
    });
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow('found 0 AttestationUsed logs');
    await expect(failure).rejects.toThrow(LATE_PAYOUT_NOTE);
  });

  it("fails uncorrelated on a payout naming the burn's domain 6 as its source, ending with the L2 note", async () => {
    const asBurnDomain = { ...paid, data: `0x${(6).toString(16).padStart(64, '0')}${paid.data.slice(66)}` };
    const failure = waitForGatewayPayout(args, baseReads(payoutChain({ balances: [988_901n], logs: [asBurnDomain] })));
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow('sourceDomain 6, expected 26');
    await expect(failure).rejects.toThrow(L2_LATE_PAYOUT_NOTE);
    await expect(failure).rejects.not.toThrow(LATE_PAYOUT_NOTE);
  });

  it("scans Base Sepolia's own RPC in 200-block windows from the block after the snapshot", async () => {
    const payout = await waitForGatewayPayout(
      { ...args, fromBlock: 66483400n },
      baseReads(payoutChain({ balances: [988_901n], logs: [paid] }), 'https://sepolia.base.org')
    );
    expect(payout.ranges.map(range => `${range.fromBlock}-${range.toBlock}`)).toEqual([
      '66483401-66483600',
      '66483601-66483800',
      '66483801-66483822'
    ]);
  });

  it('names the L2 when the gate has no endpoint', async () => {
    await expect(waitForGatewayPayout(args, { endpoints: [], payoutChain: BASE_SEPOLIA_PAYOUT })).rejects.toThrow(
      'waitForGatewayPayout: no Base Sepolia endpoints'
    );
  });
});

/**
 * No Sepolia payout was ever captured (Circle paid none there before 2026-10-14), so this is the Base Sepolia capture
 * under Sepolia's USDC token topic with its source domain and value set: the gate reads only those, the depositor and
 * the gatewayMint calldata.
 */
const asSepoliaPayout = (log: CapturedLog, set: { sourceDomain: number; value: bigint }): CapturedLog => ({
  ...log,
  topics: log.topics.map((topic, index) => (index === 1 ? pad(ETHEREUM_SEPOLIA_PAYOUT.usdc).toLowerCase() : topic)),
  data:
    `0x${set.sourceDomain.toString(16).padStart(64, '0')}${log.data.slice(66, 194)}` +
    set.value.toString(16).padStart(64, '0')
});

describe('waitForGatewayPayout on Ethereum Sepolia', () => {
  const CONSUME_MS = 1_791_638_693_000;
  const BASE = l2PayoutOn(84532);
  const args = {
    recipient: addressOf(BASE.recipient),
    burnNoteId: hexOf(BASE.burnNoteId),
    burnUnits: 2_000_000n,
    fromBlock: 66483700n,
    consumeTsMs: CONSUME_MS,
    deadlineMs: CONSUME_MS + PAYOUT_TIMEOUT_MS,
    depositor: hexOf(l2Vectors.depositor),
    minimumValue: minimumUsdcxPayout(11155111, 2_000_000n)
  };
  const sepoliaReads = (sourceDomain: number) => ({
    endpoints: ['https://ethereum-sepolia-rpc.publicnode.com'],
    publicClient: () =>
      stubClient(
        payoutChain({
          balances: [988_901n],
          logs: [movedTo(asSepoliaPayout(BASE.log, { sourceDomain, value: 988_901n }), 66483812n)]
        })
      ),
    clock: fakeClock(CONSUME_MS),
    payoutChain: ETHEREUM_SEPOLIA_PAYOUT
  });

  it("proves a payout naming Arc's 26 as its source under Sepolia's USDC, Circle keeping the rest of 2 USDCx", async () => {
    await expect(waitForGatewayPayout(args, sepoliaReads(26))).resolves.toMatchObject({
      value: 988_901n,
      sourceDomain: 26,
      fee: 1_011_099n,
      transactionHash: BASE.transaction.hash
    });
  });

  it("fails uncorrelated on a payout naming the burn's domain 0 as its source, ending with the Sepolia note", async () => {
    const failure = waitForGatewayPayout(args, sepoliaReads(0));
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow('sourceDomain 0, expected 26');
    await expect(failure).rejects.toThrow(SEPOLIA_LATE_PAYOUT_NOTE);
    await expect(failure).rejects.not.toThrow(L2_LATE_PAYOUT_NOTE);
  });
});

/** A captured log moved to `block` and paid to `recipient`, so it lands in the scan of a key this test holds. */
const paidTo = (log: CapturedLog, recipient: Address, block: bigint): CapturedLog => ({
  ...movedTo(log, block),
  topics: log.topics.map((topic, index) => (index === 2 ? pad(recipient).toLowerCase() : topic))
});

describe('harnessPayoutLeg (usdcx-legs.ts)', () => {
  const CONSUME_MS = 1_791_638_693_000;
  const [EARLIER, ONE_USDCX] = [payoutAt(1), payoutAt(4)];
  const ARC_KEY: Hex = `0x${'11'.repeat(32)}`;
  const KEY = privateKeyToAccount(ARC_KEY).address;
  const ENV = { E2E_ARC_PRIVATE_KEY: ARC_KEY, E2E_ARC_KEY_ROLE: 'harness' };
  const HELD = BigInt(EARLIER.value);
  const BUDGET = { keySnapshot: 30_000, payout: PAYOUT_TIMEOUT_MS + 120_000 };
  // The chain's first head is 66483822, the snapshot block: the key's earlier payout in it is already inside HELD.
  const history = [paidTo(EARLIER.log, KEY, 66483822n)];
  const paid = paidTo(ONE_USDCX.log, KEY, 66483823n);
  const burn = {
    burnNoteId: hexOf(ONE_USDCX.burnNoteId),
    oracle: { consumeTimestampSec: CONSUME_MS / 1_000, consumeBlock: 412_345, amount: 1_000_000n }
  };
  const depositor = hexOf(arcVectors.remoteDomainDepositor);

  /** The spec's named steps, each under its budget as namedSteps runs it, recorded by name and budget. */
  function recordingSteps(): { step: NamedStep; taken: Array<[string, number]> } {
    const taken: Array<[string, number]> = [];
    const step: NamedStep = (name, budgetMs, run, context) => {
      taken.push([name, budgetMs]);
      return withStepBudget(name, budgetMs, run, context);
    };
    return { step, taken };
  }

  it('reads the harness key before the burn, proves Circle paid exactly that burn and records both', async () => {
    const { step, taken } = recordingSteps();
    const evidence = newRunEvidence('usdcx-burn standard');
    const secrets: string[] = [];
    // One chain for both steps: the snapshot takes the first balance read, the payout cycle the second.
    const chain = payoutChain({ balances: [HELD, HELD + 983_600n], logs: [...history, paid] });
    const arc = {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(chain),
      clock: fakeClock(CONSUME_MS + 12_000)
    };

    const leg = await harnessPayoutLeg(step, { env: { ...ENV }, arc, budget: BUDGET, evidence, secrets });
    expect({ key: leg.key.address, snapshot: leg.snapshot }).toEqual({
      key: KEY,
      snapshot: { endpoint: ARC_DRPC_URL, blockNumber: 66483822n, balance: HELD }
    });
    const payout = await leg.waitForPayout(burn, depositor);

    expect(payout).toMatchObject({
      value: 983_600n,
      balance: HELD + 983_600n,
      logBlock: 66483823n,
      transactionHash: ONE_USDCX.transaction.hash,
      fee: 16_400n,
      latencyMs: 12_000
    });
    expect(payout.ranges[0]?.fromBlock).toBe(66483823n);
    expect(taken).toEqual([
      ['key_snapshot', BUDGET.keySnapshot],
      ['payout', BUDGET.payout]
    ]);
    expect(secrets).toEqual([ARC_KEY]);
    expect(evidence).toMatchObject({
      ids: { arcKey: KEY, arcKeyRole: 'harness', arcBalanceBefore: String(HELD), arcSnapshotBlock: '66483822' },
      hashes: { payout: ONE_USDCX.transaction.hash },
      fees: [{ name: 'circle payout fee', amount: 16_400n, kind: 'exact' }],
      latenciesMs: { consumeToPayout: 12_000 }
    });
    // An Arc run's evidence keeps exactly the keys it had before the L2 suite.
    expect(evidence.ids).not.toHaveProperty('payoutChainId');
  });

  it('reads and proves an L2 payout on the L2 alone, reading Arc for nothing about the key', async () => {
    const { step, taken } = recordingSteps();
    const evidence = newRunEvidence('usdcx-burn-l2 base-sepolia');
    const secrets: string[] = [];
    const base = l2PayoutOn(84532);
    const arcReads: string[] = [];
    const arc = {
      endpoints: [ARC_DRPC_URL],
      publicClient: () =>
        stubClient(method => {
          arcReads.push(method);
          throw new Error('the L2 leg read Arc');
        })
    };
    const tokens: string[] = [];
    const l2 = payoutChain({ balances: [HELD, HELD + 988_901n], logs: [paidTo(base.log, KEY, 66483823n)], tokens });
    const payoutReads = {
      endpoints: [BASE_SEPOLIA_PAYOUT.rpcUrls[0] ?? ''],
      publicClient: () => stubClient(l2),
      clock: fakeClock(CONSUME_MS + 7_000),
      payoutChain: BASE_SEPOLIA_PAYOUT
    };

    const leg = await harnessPayoutLeg(step, { env: { ...ENV }, arc, payoutReads, budget: BUDGET, evidence, secrets });
    expect(leg.snapshot).toEqual({
      endpoint: 'https://base-sepolia-rpc.publicnode.com',
      blockNumber: 66483822n,
      balance: HELD
    });
    const payout = await leg.waitForPayout(
      {
        burnNoteId: hexOf(base.burnNoteId),
        oracle: { consumeTimestampSec: CONSUME_MS / 1_000, consumeBlock: 412_345, amount: 1_000_000n }
      },
      hexOf(l2Vectors.depositor)
    );

    expect(payout).toMatchObject({
      value: 988_901n,
      fee: 11_099n,
      sourceDomain: 26,
      transactionHash: base.transaction.hash,
      latencyMs: 7_000
    });
    expect(arcReads).toEqual([]);
    // The key snapshot and the payout cycle each read the key's balance of the L2's own USDC.
    expect(tokens).toEqual([BASE_SEPOLIA_PAYOUT.usdc.toLowerCase(), BASE_SEPOLIA_PAYOUT.usdc.toLowerCase()]);
    expect(taken).toEqual([
      ['key_snapshot', BUDGET.keySnapshot],
      ['payout', BUDGET.payout]
    ]);
    expect(evidence).toMatchObject({
      ids: {
        arcKey: KEY,
        arcKeyRole: 'harness',
        arcBalanceBefore: String(HELD),
        arcSnapshotBlock: '66483822',
        payoutChainId: '84532'
      },
      hashes: { payout: base.transaction.hash },
      fees: [{ name: 'circle payout fee', amount: 11_099n, kind: 'exact' }]
    });
  });

  // The floor and Circle's fee follow the burn the node consumed: a 2 USDCx burn to Sepolia less its 1.5 allowance.
  it("proves a 2 USDCx Sepolia burn against that burn's own floor and fee, and fails a payout under its 0.5 USDC floor", async () => {
    const base = l2PayoutOn(84532);
    const legPaying = async (value: bigint, evidence: RunEvidence) => {
      const sepolia = payoutChain({
        balances: [HELD, HELD + value],
        logs: [paidTo(asSepoliaPayout(base.log, { sourceDomain: 26, value }), KEY, 66483823n)]
      });
      const leg = await harnessPayoutLeg(recordingSteps().step, {
        env: { ...ENV },
        arc: {
          endpoints: [ARC_DRPC_URL],
          publicClient: () =>
            stubClient(() => {
              throw new Error('xReserve unread');
            })
        },
        payoutReads: {
          endpoints: [ETHEREUM_SEPOLIA_PAYOUT.rpcUrls[0] ?? ''],
          publicClient: () => stubClient(sepolia),
          clock: fakeClock(CONSUME_MS + 7_000),
          payoutChain: ETHEREUM_SEPOLIA_PAYOUT
        },
        budget: BUDGET,
        evidence,
        secrets: []
      });
      return leg.waitForPayout(
        {
          burnNoteId: hexOf(base.burnNoteId),
          oracle: { consumeTimestampSec: CONSUME_MS / 1_000, consumeBlock: 412_345, amount: 2_000_000n }
        },
        hexOf(l2Vectors.depositor)
      );
    };

    const evidence = newRunEvidence('usdcx-burn-l2 sepolia');
    await expect(legPaying(500_000n, evidence)).resolves.toMatchObject({ value: 500_000n, fee: 1_500_000n });
    expect(evidence).toMatchObject({
      ids: { payoutChainId: '11155111' },
      fees: [{ name: 'circle payout fee', amount: 1_500_000n, kind: 'exact' }]
    });
    await expect(legPaying(499_999n, newRunEvidence('usdcx-burn-l2 sepolia'))).rejects.toThrow(
      "value 499999 is below the wallet's minimum payout 500000"
    );
  });

  it("fails an L2 payout step naming the key's read on that L2 and xReserve's flags read on Arc", async () => {
    const { step } = recordingSteps();
    const evidence = newRunEvidence('usdcx-burn-l2 base-sepolia');
    const flags: Record<string, Hex> = {
      isRemoteDomainRegistered: encodeBool(true),
      paused: encodeBool(false),
      domainDepositsPaused: encodeBool(false),
      domainWithdrawalsPaused: encodeBool(true),
      getRemoteToken: `0x${'00'.repeat(32)}`,
      getRemoteDomainDepositor: encodeAbiParameters(
        [{ type: 'address' }],
        ['0xb21c91a0f4d4c03f4b6a0fc5214f06e431ff2b2d']
      ),
      gatewayMinter: encodeAbiParameters([{ type: 'address' }], [GATEWAY_MINTER])
    };
    const arc = {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient((_method, params) => flags[callOf(params).functionName])
    };
    const payoutReads = {
      endpoints: [BASE_SEPOLIA_PAYOUT.rpcUrls[0] ?? ''],
      publicClient: () => stubClient(payoutChain({ balances: [HELD], logs: [] })),
      clock: fakeClock(CONSUME_MS),
      payoutChain: BASE_SEPOLIA_PAYOUT
    };

    const leg = await harnessPayoutLeg(step, {
      env: { ...ENV },
      arc,
      payoutReads,
      budget: BUDGET,
      evidence,
      secrets: []
    });
    const failure = leg.waitForPayout(burn, depositor);

    await expect(failure).rejects.toThrow(
      `harness key ${KEY} (${HARNESS_ARC_KEY_FILE}) held ${HELD} at Base Sepolia block 66483822 (read on ` +
        'base-sepolia-rpc.publicnode.com); '
    );
    await expect(failure).rejects.toThrow('xReserve paused false, deposits paused false, withdrawals paused true');
  });

  it("fails the payout step at the consume's deadline, naming the key's pre-burn read by host", async () => {
    const { step } = recordingSteps();
    const evidence = newRunEvidence('usdcx');
    const clock = fakeClock(CONSUME_MS);
    const chain = payoutChain({ balances: [HELD], logs: history });
    const operator = 'https://arc.example/v2/token-in-path';
    const arc = { endpoints: [operator], publicClient: () => stubClient(chain), clock };

    const leg = await harnessPayoutLeg(step, { env: { ...ENV }, arc, budget: BUDGET, evidence, secrets: [] });
    const failure = leg.waitForPayout(burn, depositor);

    await expect(failure).rejects.toThrow(
      `payout: no destination mint for this key by ${new Date(CONSUME_MS + PAYOUT_TIMEOUT_MS).toISOString()}`
    );
    await expect(failure).rejects.toThrow(
      `harness key ${KEY} (${HARNESS_ARC_KEY_FILE}) held ${HELD} at Arc block 66483822 (read on arc.example); ` +
        `burn note ${burn.burnNoteId} consumed in Miden block 412345 at ${new Date(CONSUME_MS).toISOString()}; ` +
        'xReserve '
    );
    await expect(failure).rejects.not.toThrow('token-in-path');
    expect(clock.slept).toEqual(Array(PAYOUT_TIMEOUT_MS / 5_000).fill(5_000));
    expect(evidence.hashes).toEqual({});
    expect(evidence.fees).toEqual([]);
  });

  // R20: the iOS nightly burns back to its deposit key, which no runner hands out, so the spec names that key itself.
  it('takes any key the run names, records its role and names it by its label when Circle has not paid', async () => {
    const { step, taken } = recordingSteps();
    const evidence = newRunEvidence('usdcx-live-ios');
    const secrets: string[] = [];
    const chain = payoutChain({ balances: [HELD], logs: history });
    const arc = {
      endpoints: ['https://arc.example/v2/token-in-path'],
      publicClient: () => stubClient(chain),
      clock: fakeClock(CONSUME_MS)
    };
    const label = `deposit key ${KEY} (USDCX_LIVE_EVM_PRIVATE_KEY), which Circle pays,`;

    const leg = await payoutLeg(step, {
      takeKey: () => ({ key: { address: KEY, privateKey: ARC_KEY }, role: 'deposit', label }),
      arc,
      budget: BUDGET,
      evidence,
      secrets
    });
    const failure = leg.waitForPayout(burn, depositor);

    await expect(failure).rejects.toThrow(`${label} held ${HELD} at Arc block 66483822 (read on arc.example); `);
    expect(taken).toEqual([
      ['key_snapshot', BUDGET.keySnapshot],
      ['payout', BUDGET.payout]
    ]);
    expect(secrets).toEqual([ARC_KEY]);
    expect(evidence.ids).toMatchObject({ arcKey: KEY, arcKeyRole: 'deposit', arcBalanceBefore: String(HELD) });
  });
});

describe('waitForWalletPayoutConfirmation (usdcx-legs.ts)', () => {
  const KEY = addressOf(payoutAt(4).recipient);
  const HELD = BigInt(payoutAt(1).value);
  // The harnessPayoutLeg test's payout: the key's pre-burn read at 66483822, the log at 66483823.
  const payout = { value: 983_600n, balance: HELD + 983_600n, logBlock: 66483823n };
  const before = { balance: String(HELD), blockNumber: '66483822' };
  const where = async () => 'route #/ (visible)';

  function burnRow(id: string, confirmed?: { balance: string; blockNumber: string }): BridgedSendRow {
    const usdcxBurn = { noteId: hexOf(payoutAt(4).burnNoteId), destinationDomain: 26, phase: 'confirmed' };
    return {
      id,
      status: TxStatus.Completed,
      extraInputs: {
        provider: 'usdcx',
        usdcxBurn: confirmed
          ? { ...usdcxBurn, destinationBalanceBefore: before, destinationBalanceConfirmed: confirmed }
          : { ...usdcxBurn, destinationBalanceBefore: before }
      }
    };
  }

  /** The wallet's rows, one list per read, the last list again on every read after. */
  function rowReads(reads: BridgedSendRow[][]): () => Promise<BridgedSendRow[]> {
    let next = 0;
    return async () => reads[Math.min(next++, reads.length - 1)] ?? [];
  }

  it("waits for this burn row's own confirmation at the payout's balance and records it", async () => {
    const clock = fakeClock(1_000);
    const evidence = newRunEvidence('usdcx-live-ios');
    const paid = { balance: String(payout.balance), blockNumber: '66483824' };

    const confirmedAt = await waitForWalletPayoutConfirmation({
      // Another burn's confirmation is never this one's.
      readRows: rowReads([
        [burnRow('other', paid), burnRow('burn')],
        [burnRow('other', paid), burnRow('burn', paid)]
      ]),
      rowId: 'burn',
      arcFromBlock: 66483822n,
      payout,
      key: { address: KEY },
      arc: { endpoints: [ARC_DRPC_URL], clock },
      where,
      evidence
    });

    expect(confirmedAt).toBe(4_000);
    expect(clock.slept).toEqual([3_000]);
    expect(evidence.ids.walletConfirmedBalance).toBe(String(payout.balance));
  });

  it("fails a confirmation at another balance or before the payout's log, naming the key's pre-burn balance", async () => {
    // Each case fails exactly one of the three checks, so none of them is proven only through another.
    for (const { confirmed, arcFromBlock } of [
      { confirmed: { balance: String(payout.balance + 1n), blockNumber: '66483824' }, arcFromBlock: 66483822n },
      { confirmed: { balance: String(payout.balance), blockNumber: '66483822' }, arcFromBlock: 66483821n },
      { confirmed: { balance: String(payout.balance), blockNumber: '66483823' }, arcFromBlock: 66483823n }
    ]) {
      const evidence = newRunEvidence('usdcx');
      const failure = waitForWalletPayoutConfirmation({
        readRows: rowReads([[burnRow('burn', confirmed)]]),
        rowId: 'burn',
        arcFromBlock,
        payout,
        key: { address: KEY },
        arc: { endpoints: [ARC_DRPC_URL], clock: fakeClock() },
        where,
        evidence
      });

      await expect(failure).rejects.toThrow(
        `confirmation at Arc block ${confirmed.blockNumber}, snapshot ${arcFromBlock}, payout log 66483823, ${HELD} ` +
          'on the key before the burn'
      );
      expect(evidence.ids.walletConfirmedBalance).toBeUndefined();
    }
  });

  it('names the saved balance, the key now on its endpoints and on arc.io, and the page when the wallet never confirms', async () => {
    const clock = fakeClock();
    const operator = 'https://arc.example/v2/token-in-path';
    // arc.io lags the operator's endpoint, which already reads the payout.
    const arc = {
      endpoints: [operator],
      publicClient: (endpoint: string) =>
        stubClient(payoutChain({ balances: [endpoint === ARC_PUBLIC_URL ? HELD : payout.balance], logs: [] })),
      clock
    };

    const failure = waitForWalletPayoutConfirmation({
      readRows: rowReads([[burnRow('burn')]]),
      rowId: 'burn',
      arcFromBlock: 66483822n,
      payout,
      key: { address: KEY },
      arc,
      where,
      evidence: newRunEvidence('usdcx')
    });

    await expect(failure).rejects.toThrow(
      `the wallet confirming the payout: not reached within ${WALLET_CONFIRM_TIMEOUT_MS} ms; last read {"id":"burn"`
    );
    await expect(failure).rejects.toThrow(
      `; Circle paid this burn (harness proof) but the wallet never confirmed it; destinationBalanceBefore ` +
        `${JSON.stringify(before)}, key balance now ${payout.balance}, arc.io reads ${HELD}; route #/ (visible)`
    );
    await expect(failure).rejects.not.toThrow('token-in-path');
    expect(clock.slept).toEqual(Array(WALLET_CONFIRM_TIMEOUT_MS / 3_000).fill(3_000));
  });

  it("names the L2's wallet RPC by host, never its project id, when the wallet never confirms", async () => {
    const reads = {
      endpoints: [BASE_SEPOLIA_PAYOUT.rpcUrls[0] ?? ''],
      payoutChain: BASE_SEPOLIA_PAYOUT,
      // The wallet's WalletConnect backend lags the harness's endpoint, which already reads the payout.
      publicClient: (endpoint: string) =>
        stubClient(
          payoutChain({ balances: [endpoint === BASE_SEPOLIA_PAYOUT.walletRpcUrl ? HELD : payout.balance], logs: [] })
        ),
      clock: fakeClock()
    };

    const failure = waitForWalletPayoutConfirmation({
      readRows: rowReads([[burnRow('burn')]]),
      rowId: 'burn',
      arcFromBlock: 66483822n,
      payout,
      key: { address: KEY },
      arc: reads,
      where,
      evidence: newRunEvidence('usdcx-burn-l2 base-sepolia')
    });

    await expect(failure).rejects.toThrow(
      `key balance now ${payout.balance}, rpc.walletconnect.org reads ${HELD}; route #/ (visible)`
    );
    await expect(failure).rejects.not.toThrow('projectId=');
  });

  // errorText keeps only the first line of each message part, and viem carries the request URL in metaMessages, so
  // a viem read failure prints no project id: the redaction is defense in depth, for an error whose first line has it.
  it('redacts the project id when the read through the L2 wallet RPC itself fails', async () => {
    const reads = {
      endpoints: [BASE_SEPOLIA_PAYOUT.rpcUrls[0] ?? ''],
      payoutChain: BASE_SEPOLIA_PAYOUT,
      publicClient: (endpoint: string) =>
        endpoint === BASE_SEPOLIA_PAYOUT.walletRpcUrl
          ? stubClient(() => {
              // errorText keeps each message's first line alone, so the URL rides on it, as a fetch error's text can.
              throw new Error(
                'HTTP request failed. URL: https://rpc.walletconnect.org/v1?chainId=eip155:84532&projectId=operator-project'
              );
            })
          : stubClient(payoutChain({ balances: [payout.balance], logs: [] })),
      clock: fakeClock()
    };

    const failure = waitForWalletPayoutConfirmation({
      readRows: rowReads([[burnRow('burn')]]),
      rowId: 'burn',
      arcFromBlock: 66483822n,
      payout,
      key: { address: KEY },
      arc: reads,
      where,
      evidence: newRunEvidence('usdcx-burn-l2 base-sepolia')
    });

    await expect(failure).rejects.toThrow(
      `key balance now ${payout.balance}, rpc.walletconnect.org failed: Base Sepolia USDC balance of ${KEY}`
    );
    await expect(failure).rejects.toThrow('projectId=<redacted>');
    await expect(failure).rejects.not.toThrow('operator-project');
  });

  it("fails an L2 confirmation read before the payout's log, naming the L2's block", async () => {
    const failure = waitForWalletPayoutConfirmation({
      readRows: rowReads([[burnRow('burn', { balance: String(payout.balance), blockNumber: '66483822' })]]),
      rowId: 'burn',
      arcFromBlock: 66483821n,
      payout,
      key: { address: KEY },
      arc: { endpoints: [BASE_SEPOLIA_PAYOUT.rpcUrls[0] ?? ''], payoutChain: BASE_SEPOLIA_PAYOUT, clock: fakeClock() },
      where,
      evidence: newRunEvidence('usdcx-burn-l2 base-sepolia')
    });

    await expect(failure).rejects.toThrow(
      `confirmation at Base Sepolia block 66483822, snapshot 66483821, payout log 66483823, ${HELD} on the key ` +
        'before the burn'
    );
  });
});

describe('burnTarget (usdcx-legs.ts)', () => {
  const KEY = addressOf('0x6aF7413CbC1FC53454539Da54aAefFE1114FDC66');

  it("carries the destination's own domain on the burn and its row, never the payout's source domain", () => {
    expect([ARC_PAYOUT, BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT].map(chain => burnTarget(chain, KEY))).toEqual([
      { destination: KEY.toLowerCase(), network: 5042002, domain: 26 },
      { destination: KEY.toLowerCase(), network: 84532, domain: 6 },
      { destination: KEY.toLowerCase(), network: 421614, domain: 3 }
    ]);
    expect(
      [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT].map(
        chain => burnTarget(chain, KEY).domain === chain.attestationSourceDomain
      )
    ).toEqual([false, false]);
  });
});

/** HTTP 429 as viem's http transport throws it. */
const http429 = () => new HttpRequestError({ status: 429, url: ARC_DRPC_URL, details: 'Too Many Requests' });
/** A request that outlived the transport timeout, as viem's http transport throws it. */
const timedOut = () => new TimeoutError({ body: {}, url: ARC_DRPC_URL });
/** A node's JSON-RPC error answer, as viem's http transport throws it. */
const nodeAnswer = (code: number, message: string) =>
  new RpcRequestError({ body: {}, error: { code, message }, url: ARC_DRPC_URL });
/** The block of every receipt depositChain answers, so an approve's. */
const APPROVE_BLOCK = hexToBigInt(hexOf(DEPOSIT_RECEIPT.blockNumber));
/** depositChain's head by default: past the approve's block, so the deposit's simulation and estimate run at it. */
const HEAD = APPROVE_BLOCK + 4n;

/**
 * The write side of Arc: a read-only endpoint first, which answers reads but refuses raw transactions, then drpc, which
 * takes them. `faults` lists what drpc answers, in order, before it answers a method normally (an eth_call or
 * eth_estimateGas by its function as `<method> <function>`); `sent` holds every raw transaction drpc was handed,
 * faulted or not, `calls` every request as `<endpoint> <method>`, `pins` each head read as `eth_blockNumber` and each
 * simulation and estimate of an approve or a deposit as `<method> <function> <block>` (`none` when it names no block),
 * and `onCall` sees each request as it arrives. The head is `heads` in turn, the last one repeating; `revert` answers a
 * deposit's eth_call, only past `revertPast` (or at latest) when that is set.
 */
function depositChain(opts: {
  allowance: bigint;
  revert?: Hex;
  revertPast?: bigint;
  alreadyKnown?: boolean;
  faults?: Record<string, Error[]>;
  heads?: bigint[];
  onCall?: (call: string) => void;
}) {
  const sent: Hex[] = [];
  const nonces: number[] = [];
  const calls: string[] = [];
  const pins: string[] = [];
  const faults = new Map(Object.entries(opts.faults ?? {}).map(([method, errors]) => [method, [...errors]]));
  const heads = [...(opts.heads ?? [HEAD])];
  const reverts = (block: unknown) =>
    opts.revertPast === undefined || !isHex(block) || hexToBigInt(block) > opts.revertPast;
  const answer =
    (at: 'read-only' | 'drpc'): Rpc =>
    (method, params) => {
      calls.push(`${at} ${method}`);
      opts.onCall?.(`${at} ${method}`);
      const probe = method === 'eth_sendRawTransaction' && params[0] === '0x00';
      if (at === 'read-only' && method === 'eth_sendRawTransaction') throw rpcError(-32601, 'method not supported');
      if (method === 'eth_sendRawTransaction' && !probe) {
        const raw = params[0];
        if (!isHex(raw)) throw new Error('raw transaction is not hex');
        sent.push(raw);
        nonces.push(parseTransaction(raw).nonce ?? -1);
      }
      const call = method === 'eth_call' || method === 'eth_estimateGas' ? callOf(params) : undefined;
      if (call && (call.functionName === 'approve' || call.functionName === 'depositToRemote')) {
        pins.push(`${method} ${call.functionName} ${call.block === undefined ? 'none' : String(call.block)}`);
      }
      if (method === 'eth_blockNumber') pins.push(method);
      const faultKey = call ? `${method} ${call.functionName}` : method;
      const fault = probe ? undefined : (faults.get(faultKey) ?? faults.get(method))?.shift();
      if (fault) throw fault;
      switch (method) {
        case 'eth_blockNumber':
          return toHex((heads.length > 1 ? heads.shift() : heads[0]) ?? HEAD);
        case 'eth_chainId':
          return toHex(ARC_CHAIN_ID);
        case 'eth_getTransactionCount':
          return '0x5';
        case 'eth_estimateGas':
          return '0x20551';
        case 'eth_maxPriorityFeePerGas':
          return '0x0';
        case 'eth_getBlockByNumber':
          return {
            number: '0x3f6763c',
            hash: `0x${'11'.repeat(32)}`,
            timestamp: '0x6a87a0a0',
            baseFeePerGas: '0x5d21dba00',
            transactions: []
          };
        case 'eth_call': {
          const call = callOf(params);
          if (call.functionName === 'allowance') return encodeUint(opts.allowance);
          if (call.functionName === 'approve') return encodeBool(true);
          if (opts.revert && reverts(call.block)) throw rpcError(3, 'execution reverted', opts.revert);
          return '0x';
        }
        case 'eth_sendRawTransaction': {
          const raw = params[0];
          if (probe) throw rpcError(-32602, 'failed to decode signed transaction');
          if (opts.alreadyKnown && sent.length === 1) throw rpcError(-32000, 'already known');
          return keccak256(hexOf(String(raw)));
        }
        case 'eth_getTransactionReceipt':
          return { ...DEPOSIT_RECEIPT, transactionHash: params[0], logs: [], status: '0x1' };
        default:
          throw new Error(`unexpected ${method}`);
      }
    };
  const clients = { 'read-only': stubClient(answer('read-only')), drpc: stubClient(answer('drpc')) };
  const clock = fakeClock();
  return {
    sent,
    nonces,
    calls,
    pins,
    clock,
    deps: {
      endpoints: ['https://read-only.example', ARC_DRPC_URL],
      publicClient: (endpoint: string) => (endpoint === ARC_DRPC_URL ? clients.drpc : clients['read-only']),
      clock
    }
  };
}

describe('submitDepositToMiden', () => {
  const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const recipientHex = '0xf2f42cda8d010f417d1cad5dc4d52b';

  it('approves exactly the units, then deposits to Miden, on the first endpoint that takes writes', async () => {
    const chain = depositChain({ allowance: 0n });
    const submission = await submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'exact' },
      chain.deps
    );

    expect(submission.endpoint).toBe(ARC_DRPC_URL);
    expect(submission.approved).toBe(true);
    expect(chain.nonces).toEqual([5, 6]);
    expect([submission.approveHash, submission.depositHash]).toEqual(chain.sent.map(raw => keccak256(raw)));
    const [approve, deposit] = chain.sent.map(raw => parseTransaction(raw));
    expect(approve?.to).toBe(ARC_USDC.toLowerCase());
    expect(decodeFunctionData({ abi: CALL_ABI, data: approve?.data ?? '0x' })).toEqual({
      functionName: 'approve',
      args: [ARC_XRESERVE, DEPOSIT_UNITS]
    });
    expect(deposit?.to).toBe(ARC_XRESERVE.toLowerCase());
    expect(decodeFunctionData({ abi: CALL_ABI, data: deposit?.data ?? '0x' })).toEqual({
      functionName: 'depositToRemote',
      args: [DEPOSIT_UNITS, 10007, midenAccountHexToXReserveRecipient(recipientHex), ARC_USDC, 0n, '0x']
    });
    expect(approve?.chainId).toBe(ARC_CHAIN_ID);
    // With no fault, every read and send goes to the write endpoint; the read-only one only answered the probes.
    expect(chain.calls.filter(call => call.startsWith('read-only'))).toEqual([
      'read-only eth_chainId',
      'read-only eth_sendRawTransaction'
    ]);
  });

  it("skips the approve when 'if-short' finds the allowance already covers the units", async () => {
    const chain = depositChain({ allowance: DEPOSIT_UNITS });
    const submission = await submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' },
      chain.deps
    );
    expect(submission.approved).toBe(false);
    expect(submission.approveHash).toBeUndefined();
    expect(chain.nonces).toEqual([5]);
    expect(chain.pins).toEqual(['eth_call depositToRemote latest', 'eth_estimateGas depositToRemote none']);
  });

  // Only a pinned call can meet a node that lacks its block; unpinned, the answer is the node's own failure.
  it("fails an unpinned deposit simulation answered 'block not found' at once, as a revert", async () => {
    const chain = depositChain({
      allowance: DEPOSIT_UNITS,
      faults: { 'eth_call depositToRemote': [nodeAnswer(-32001, 'block not found')] }
    });
    await expect(
      submitDepositToMiden({ privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' }, chain.deps)
    ).rejects.toThrow('xReserve depositToRemote would revert on rpc.drpc.testnet.arc.io: ');
    expect(chain.pins).toEqual(['eth_call depositToRemote latest']);
    expect([chain.sent, chain.clock.slept]).toEqual([[], []]);
  });

  // One endpoint URL is a pool of nodes: one behind the approve reads a short allowance at its own latest, and the
  // approve's block alone misses state changed since. The head is read once, so the estimate runs where the
  // simulation did.
  it("simulates and estimates the deposit at the head past the approve's block, the approve at latest", async () => {
    const chain = depositChain({ allowance: 0n, heads: [HEAD, HEAD + 3n] });
    await submitDepositToMiden({ privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'exact' }, chain.deps);
    expect(chain.pins).toEqual([
      'eth_call approve latest',
      'eth_estimateGas approve none',
      'eth_blockNumber',
      `eth_call depositToRemote ${toHex(HEAD)}`,
      `eth_estimateGas depositToRemote ${toHex(HEAD)}`
    ]);
    expect(chain.calls.filter(call => call.endsWith('eth_blockNumber'))).toEqual(['drpc eth_blockNumber']);
  });

  // The receipt came from a node ahead of the one that answered the head read.
  it("simulates and estimates the deposit at the approve's block when the head read is behind it", async () => {
    const chain = depositChain({ allowance: 0n, heads: [APPROVE_BLOCK - 2n] });
    await submitDepositToMiden({ privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'exact' }, chain.deps);
    expect(chain.pins).toEqual([
      'eth_call approve latest',
      'eth_estimateGas approve none',
      'eth_blockNumber',
      `eth_call depositToRemote ${toHex(APPROVE_BLOCK)}`,
      `eth_estimateGas depositToRemote ${toHex(APPROVE_BLOCK)}`
    ]);
  });

  // What Arc's endpoints answered on 2026-10-16 for a block past their head.
  it.each([
    ['drpc', 26, 'Unknown block'],
    ['QuickNode and arc.io', -32001, `block not found: ${toHex(HEAD)}`]
  ])(
    "asks the deposit's simulation and estimate again while a node on %s lacks the block",
    async (_on, code, message) => {
      const chain = depositChain({
        allowance: 0n,
        faults: {
          'eth_call depositToRemote': [nodeAnswer(code, message)],
          'eth_estimateGas depositToRemote': [nodeAnswer(code, message)]
        }
      });
      const submission = await submitDepositToMiden(
        { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'exact' },
        chain.deps
      );
      expect(submission.depositHash).toBe(keccak256(chain.sent[1] ?? '0x'));
      expect(chain.pins.filter(pin => pin.includes('depositToRemote'))).toEqual([
        ...Array(2).fill(`eth_call depositToRemote ${toHex(HEAD)}`),
        ...Array(2).fill(`eth_estimateGas depositToRemote ${toHex(HEAD)}`)
      ]);
      expect(chain.clock.slept).toEqual([2_000, 2_000]);
    }
  );

  it.each([
    ['simulation', 'eth_call depositToRemote', 'xReserve depositToRemote could not be simulated'],
    ['gas estimate', 'eth_estimateGas depositToRemote', 'Arc gas estimate']
  ])('fails a deposit %s whose node stays behind its pinned block, naming the block', async (_what, call, head) => {
    const behind = () => nodeAnswer(26, 'Unknown block');
    const chain = depositChain({ allowance: 0n, faults: { [call]: [behind(), behind(), behind(), behind()] } });
    await expect(
      submitDepositToMiden({ privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'exact' }, chain.deps)
    ).rejects.toThrow(`${head} at block ${HEAD} on rpc.drpc.testnet.arc.io, still behind it after 3 retries: `);
    expect(chain.sent).toHaveLength(1);
    expect(chain.clock.slept).toEqual([2_000, 4_000, 8_000]);
  });

  it('reports an allowance revert at the pinned block as a revert, at once', async () => {
    const short = nodeAnswer(3, 'execution reverted: ERC20: transfer amount exceeds allowance');
    const chain = depositChain({ allowance: 0n, faults: { 'eth_call depositToRemote': [short] } });
    const failure = submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'exact' },
      chain.deps
    );
    await expect(failure).rejects.toThrow(
      `xReserve depositToRemote would revert at block ${HEAD} on rpc.drpc.testnet.arc.io: `
    );
    await expect(failure).rejects.toThrow('transfer amount exceeds allowance');
    expect(chain.pins.filter(pin => pin.startsWith('eth_call depositToRemote'))).toHaveLength(1);
    expect([chain.sent.length, chain.clock.slept]).toEqual([1, []]);
  });

  // The node runs the deposit at its head, so a refusal that began after the approve's block must fail here, unsent.
  it("reports a refusal that came after the approve's block as a revert at the head, sending no deposit", async () => {
    const paused = encodeErrorResult({ abi: XRESERVE_HARNESS_ABI, errorName: 'DomainDepositsPaused', args: [10007] });
    const chain = depositChain({ allowance: 0n, revert: paused, revertPast: APPROVE_BLOCK });
    const failure = submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'exact' },
      chain.deps
    );
    await expect(failure).rejects.toThrow(
      `xReserve depositToRemote would revert at block ${HEAD} on rpc.drpc.testnet.arc.io: `
    );
    await expect(failure).rejects.toThrow('DomainDepositsPaused(10007)');
    expect(chain.pins.filter(pin => pin.includes('depositToRemote'))).toEqual([
      `eth_call depositToRemote ${toHex(HEAD)}`
    ]);
    expect([chain.sent.length, chain.clock.slept]).toEqual([1, []]);
  });

  it('decodes a deposit revert before sending it', async () => {
    const paused = encodeErrorResult({ abi: XRESERVE_HARNESS_ABI, errorName: 'DomainDepositsPaused', args: [10007] });
    const chain = depositChain({ allowance: DEPOSIT_UNITS, revert: paused });
    await expect(
      submitDepositToMiden({ privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' }, chain.deps)
    ).rejects.toThrow('xReserve depositToRemote would revert on rpc.drpc.testnet.arc.io: ');
    await expect(
      submitDepositToMiden({ privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' }, chain.deps)
    ).rejects.toThrow('DomainDepositsPaused(10007)');
    expect(chain.sent).toEqual([]);
  });

  it("counts a node's 'already known' as sent, by the transaction's own hash", async () => {
    const chain = depositChain({ allowance: DEPOSIT_UNITS, alreadyKnown: true });
    const submission = await submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' },
      chain.deps
    );
    expect(submission.depositHash).toBe(keccak256(chain.sent[0] ?? '0x'));
  });

  // arc.io answers bursts with 429 or -32005, and any endpoint can stall past the transport timeout.
  it.each([
    ['HTTP 429', http429],
    ['JSON-RPC -32005', () => rpcError(-32005, 'rate limit exceeded')],
    ['a request timeout', timedOut]
  ])('sends again after the send answers %s once, re-broadcasting the same signed bytes', async (_what, fault) => {
    const chain = depositChain({ allowance: DEPOSIT_UNITS, faults: { eth_sendRawTransaction: [fault()] } });
    const submission = await submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' },
      chain.deps
    );
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1]).toBe(chain.sent[0]);
    expect(submission.depositHash).toBe(keccak256(chain.sent[0] ?? '0x'));
    expect(chain.clock.slept).toEqual([2_000]);
  });

  it("counts 'nonce too low' on a resend of the same bytes as sent: the first send landed", async () => {
    const chain = depositChain({
      allowance: DEPOSIT_UNITS,
      faults: { eth_sendRawTransaction: [timedOut(), rpcError(-32000, 'nonce too low')] }
    });
    const submission = await submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' },
      chain.deps
    );
    expect(chain.sent[1]).toBe(chain.sent[0]);
    expect(submission.depositHash).toBe(keccak256(chain.sent[0] ?? '0x'));
  });

  it.each([
    ['insufficient funds for gas * price + value', 'a refusal'],
    ['nonce too low', "a first send's spent nonce"]
  ])('fails at once on %s (%s), naming the write endpoint by its host', async (message, _why) => {
    const chain = depositChain({
      allowance: DEPOSIT_UNITS,
      faults: { eth_sendRawTransaction: [rpcError(-32000, message)] }
    });
    const failure = submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' },
      chain.deps
    );
    await expect(failure).rejects.toThrow(
      /^Arc transaction 0x[0-9a-f]{64} was not sent on rpc\.drpc\.testnet\.arc\.io: /
    );
    await expect(failure).rejects.toThrow(message);
    expect(chain.sent).toHaveLength(1);
    expect(chain.clock.slept).toEqual([]);
  });

  it('gives up on a send after three retries, 2, 4 and 8 s apart', async () => {
    const chain = depositChain({
      allowance: DEPOSIT_UNITS,
      faults: { eth_sendRawTransaction: [http429(), http429(), http429(), http429()] }
    });
    await expect(
      submitDepositToMiden({ privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' }, chain.deps)
    ).rejects.toThrow('was not sent on rpc.drpc.testnet.arc.io: HTTP request failed.');
    expect(chain.sent).toHaveLength(4);
    expect(chain.clock.slept).toEqual([2_000, 4_000, 8_000]);
  });

  it('moves a pre-send read that answers -32005 to the next endpoint', async () => {
    const chain = depositChain({
      allowance: DEPOSIT_UNITS,
      faults: { eth_getTransactionCount: [rpcError(-32005, 'rate limit exceeded')] }
    });
    const submission = await submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' },
      chain.deps
    );
    expect(submission.endpoint).toBe(ARC_DRPC_URL);
    expect(chain.calls.filter(call => call.endsWith('eth_getTransactionCount'))).toEqual([
      'drpc eth_getTransactionCount',
      'read-only eth_getTransactionCount'
    ]);
    expect(chain.sent).toHaveLength(1);
  });

  it.each([
    ['HTTP 429', http429],
    ['JSON-RPC -32005', () => rpcError(-32005, 'rate limit exceeded')]
  ])('simulates the deposit again after the simulation answers %s once, then deposits', async (_what, fault) => {
    const chain = depositChain({ allowance: DEPOSIT_UNITS, faults: { 'eth_call depositToRemote': [fault()] } });
    const submission = await submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' },
      chain.deps
    );
    expect(chain.sent).toHaveLength(1);
    expect(submission.depositHash).toBe(keccak256(chain.sent[0] ?? '0x'));
    expect(chain.clock.slept).toEqual([2_000]);
  });

  it('reports a simulation that stays rate-limited as not simulated, never as a revert', async () => {
    const limited = () => rpcError(-32005, 'rate limit exceeded');
    const chain = depositChain({
      allowance: DEPOSIT_UNITS,
      faults: { 'eth_call depositToRemote': [limited(), limited(), limited(), limited()] }
    });
    const failure = submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' },
      chain.deps
    );
    await expect(failure).rejects.toThrow(
      'xReserve depositToRemote could not be simulated on rpc.drpc.testnet.arc.io: '
    );
    await expect(failure).rejects.not.toThrow('would revert');
    expect(chain.sent).toEqual([]);
    expect(chain.clock.slept).toEqual([2_000, 4_000, 8_000]);
  });

  // An endpoint a block behind the approve reads a short allowance, so the deposit would decode a revert it never had.
  it('keeps every simulation and gas estimate on the write endpoint through transient errors', async () => {
    const chain = depositChain({
      allowance: 0n,
      faults: {
        'eth_call approve': [http429()],
        'eth_call depositToRemote': [rpcError(-32005, 'rate limit exceeded'), timedOut()],
        eth_estimateGas: [timedOut(), http429()]
      }
    });
    const submission = await submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'exact' },
      chain.deps
    );
    expect(submission.approved).toBe(true);
    expect(chain.sent).toHaveLength(2);
    expect(chain.calls.filter(call => call.startsWith('read-only'))).toEqual([
      'read-only eth_chainId',
      'read-only eth_sendRawTransaction'
    ]);
    expect(chain.calls.filter(call => call.endsWith('eth_estimateGas'))).toEqual(Array(4).fill('drpc eth_estimateGas'));
  });

  it('sends nothing when the step was aborted before its approve', async () => {
    const controller = new AbortController();
    controller.abort(new Error('deposit_submit exceeded its 120000 ms budget'));
    const chain = depositChain({ allowance: 0n });
    const failure = submitDepositToMiden(
      { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'exact' },
      chain.deps,
      controller.signal
    );
    await expect(failure).rejects.toThrow('USDC approve not sent: deposit_submit exceeded its 120000 ms budget');
    await expect(failure).rejects.toMatchObject({ name: 'AbortError' });
    expect(chain.sent).toEqual([]);
  });

  it('sends no deposit once its step is aborted after the approve went out', async () => {
    const controller = new AbortController();
    const chain = depositChain({
      allowance: 0n,
      onCall: call => {
        if (call === 'drpc eth_getTransactionReceipt') {
          controller.abort(new Error('deposit_submit exceeded its 120000 ms budget'));
        }
      }
    });
    await expect(
      submitDepositToMiden(
        { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'exact' },
        chain.deps,
        controller.signal
      )
    ).rejects.toThrow('xReserve depositToRemote not sent: deposit_submit exceeded its 120000 ms budget');
    expect(
      chain.sent.map(raw => decodeFunctionData({ abi: CALL_ABI, data: parseTransaction(raw).data ?? '0x' }))
    ).toMatchObject([{ functionName: 'approve' }]);
    const afterAbort = chain.calls.slice(chain.calls.indexOf('drpc eth_getTransactionReceipt'));
    expect(afterAbort.filter(call => call.endsWith('eth_sendRawTransaction'))).toEqual([]);
  });

  it('never re-sends a deposit whose step was aborted while its send was retried', async () => {
    const controller = new AbortController();
    let sends = 0;
    const chain = depositChain({
      allowance: DEPOSIT_UNITS,
      faults: { eth_sendRawTransaction: [timedOut()] },
      onCall: call => {
        // The first drpc send is the write probe, the second the deposit's own.
        if (call === 'drpc eth_sendRawTransaction' && ++sends === 2) {
          controller.abort(new Error('deposit_submit exceeded its 120000 ms budget'));
        }
      }
    });
    await expect(
      submitDepositToMiden(
        { privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' },
        chain.deps,
        controller.signal
      )
    ).rejects.toThrow(
      /^xReserve depositToRemote resend of 0x[0-9a-f]{64} not sent: deposit_submit exceeded its 120000 ms budget$/
    );
    expect(chain.sent).toHaveLength(1);
    expect(chain.clock.slept).toEqual([2_000]);
  });
});

describe('waitForReceipt chain budgets', () => {
  const hash = hexOf(arcVectors.deposit.transactionHash);
  const ethereum = { ...ARC_PAYOUT, chainId: 1, chain: mainnet, label: 'Ethereum' };

  it('accepts an Ethereum mainnet receipt mined after the two-minute L2 deadline', async () => {
    const clock = fakeClock();
    const client = stubClient(() => (clock.now() >= 300_000 ? DEPOSIT_RECEIPT : null));
    await expect(
      waitForReceipt(
        [ARC_DRPC_URL],
        { endpoints: [ARC_DRPC_URL], payoutChain: ethereum, publicClient: () => client, clock },
        hash
      )
    ).resolves.toMatchObject({ status: 'success', blockNumber: 66290091n });
    expect(clock.now()).toBe(300_000);
  });

  it('bounds an Ethereum mainnet receipt that never arrives', async () => {
    const clock = fakeClock();
    const client = stubClient(() => null);
    await expect(
      waitForReceipt(
        [ARC_DRPC_URL],
        { endpoints: [ARC_DRPC_URL], payoutChain: ethereum, publicClient: () => client, clock },
        hash
      )
    ).rejects.toThrow('has no receipt after 600000 ms');
    expect(clock.now()).toBe(600_000);
  });

  it.each([ARC_PAYOUT, BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT, ETHEREUM_SEPOLIA_PAYOUT])(
    'keeps the two-minute receipt deadline on $label',
    async payoutChain => {
      const clock = fakeClock();
      const client = stubClient(() => (clock.now() >= 150_000 ? DEPOSIT_RECEIPT : null));
      await expect(
        waitForReceipt(
          [ARC_DRPC_URL],
          { endpoints: [ARC_DRPC_URL], payoutChain, publicClient: () => client, clock },
          hash
        )
      ).rejects.toThrow('has no receipt after 120000 ms');
      expect(clock.now()).toBe(120_000);
    }
  );

  it('rejects a reverted Ethereum mainnet receipt without waiting', async () => {
    const clock = fakeClock();
    const client = stubClient(() => ({ ...DEPOSIT_RECEIPT, status: '0x0' }));
    await expect(
      waitForReceipt(
        [ARC_DRPC_URL],
        { endpoints: [ARC_DRPC_URL], payoutChain: ethereum, publicClient: () => client, clock },
        hash
      )
    ).rejects.toThrow('Ethereum transaction ' + hash + ' reverted in block 66290091');
    expect(clock.slept).toEqual([]);
  });
});

describe('confirmDepositToMiden', () => {
  it("reads xReserve's DepositedToRemote from the captured 0x370bf19a receipt", async () => {
    const client = stubClient(method => {
      if (method !== 'eth_getTransactionReceipt') throw new Error(`unexpected ${method}`);
      return DEPOSIT_RECEIPT;
    });
    const confirmed = await confirmDepositToMiden(
      { endpoint: ARC_DRPC_URL, depositHash: hexOf(arcVectors.deposit.transactionHash), approved: false },
      { endpoints: [ARC_DRPC_URL], publicClient: () => client, clock: fakeClock() }
    );
    expect(confirmed).toEqual({
      approveBlock: undefined,
      depositBlock: 66290091n,
      event: {
        value: 2_000_000_000n,
        localDepositor: '0xe88F781e6Cc8B7496F259200b57E22cb9457FF99',
        remoteRecipient: '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100',
        remoteDomain: 10007,
        remoteToken: '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600',
        maxFee: 0n,
        hookData: '0x',
        blockNumber: 66290091n
      },
      gasCostWei: 132433n * 25_000_000_000n
    });
  });

  it('refuses a reverted deposit at once, asking no other endpoint', async () => {
    const calls: string[] = [];
    const reverted = stubClient(() => ({ ...DEPOSIT_RECEIPT, status: '0x0' }), calls);
    const other = stubClient(() => DEPOSIT_RECEIPT, calls);
    const clock = fakeClock();
    await expect(
      confirmDepositToMiden(
        { endpoint: ARC_DRPC_URL, depositHash: hexOf(arcVectors.deposit.transactionHash), approved: false },
        {
          endpoints: [ARC_DRPC_URL, ARC_QUICKNODE_URL],
          publicClient: endpoint => (endpoint === ARC_DRPC_URL ? reverted : other),
          clock
        }
      )
    ).rejects.toThrow(`Arc transaction ${arcVectors.deposit.transactionHash} reverted in block 66290091`);
    expect(calls).toEqual(['eth_getTransactionReceipt']);
    expect(clock.slept).toEqual([]);
  });

  it('reads the receipt from the next endpoint when the write endpoint times out', async () => {
    const asked: string[] = [];
    const slow = 'https://slow.example/v2/token-in-path';
    const confirmed = await confirmDepositToMiden(
      { endpoint: slow, depositHash: hexOf(arcVectors.deposit.transactionHash), approved: false },
      {
        endpoints: [ARC_DRPC_URL, slow],
        publicClient: endpoint =>
          stubClient(method => {
            asked.push(`${endpoint} ${method}`);
            if (endpoint === slow) throw timedOut();
            return DEPOSIT_RECEIPT;
          }),
        clock: fakeClock()
      }
    );
    expect(confirmed.depositBlock).toBe(66290091n);
    expect(asked).toEqual([`${slow} eth_getTransactionReceipt`, `${ARC_DRPC_URL} eth_getTransactionReceipt`]);
  });

  it('fails at once on a receipt error that is not transient, naming the endpoint by its host', async () => {
    const operator = 'https://arc.example/v2/token-in-path';
    const failure = confirmDepositToMiden(
      { endpoint: operator, depositHash: hexOf(arcVectors.deposit.transactionHash), approved: false },
      {
        endpoints: [operator, ARC_DRPC_URL],
        publicClient: endpoint =>
          stubClient(() => {
            if (endpoint === operator) throw rpcError(-32602, 'invalid argument 0: hex string has length 62');
            return DEPOSIT_RECEIPT;
          }),
        clock: fakeClock()
      }
    );
    await expect(failure).rejects.toThrow(
      `Arc transaction ${arcVectors.deposit.transactionHash} receipt on arc.example: `
    );
    await expect(failure).rejects.not.toThrow('token-in-path');
  });
});

describe('waitForXReserveAttestation', () => {
  const hash = hexOf(arcVectors.deposit.transactionHash);

  it("polls Circle until the deposit's Miden entry is listed", async () => {
    const clock = fakeClock();
    const lists = [[], [capturedAttestation()]];
    const asked: string[] = [];
    const attestation = await waitForXReserveAttestation(hash, {
      baseUrl: ARC_ATTESTATION_API,
      timeoutMs: 120_000,
      clock,
      fetchList: async (txHash, { baseUrl }) => {
        asked.push(`${baseUrl} ${txHash}`);
        return lists.shift() ?? [];
      }
    });
    expect(attestation).toEqual(capturedAttestation());
    expect(asked).toEqual([`${ARC_ATTESTATION_API} ${hash}`, `${ARC_ATTESTATION_API} ${hash}`]);
    expect(clock.slept).toEqual([3_000]);
  });

  it('refuses two Miden entries for one deposit', async () => {
    await expect(
      waitForXReserveAttestation(hash, {
        baseUrl: ARC_ATTESTATION_API,
        timeoutMs: 120_000,
        clock: fakeClock(),
        fetchList: async () => [capturedAttestation(), capturedAttestation()]
      })
    ).rejects.toThrow('Circle lists 2 attestations');
  });

  it('names the domains it saw and the last error when none arrives', async () => {
    const answers: Array<XReserveAttestation[] | Error> = [
      [{ ...capturedAttestation(), remoteDomain: 10001 }],
      new Error('HTTP 503')
    ];
    await expect(
      waitForXReserveAttestation(hash, {
        baseUrl: ARC_ATTESTATION_API,
        timeoutMs: 6_000,
        clock: fakeClock(),
        fetchList: async () => {
          const next = answers.shift() ?? [];
          if (next instanceof Error) throw next;
          return next;
        }
      })
    ).rejects.toThrow('0 entries for domain 10007 after 6000 ms (domains listed: [10001]; last error: HTTP 503)');
  });
});

describe('decodeDepositIntent and assertDepositIntent', () => {
  const expected = {
    amount: 2_000_000_000n,
    remoteToken: hexOf('0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600'),
    remoteRecipient: hexOf('0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100'),
    localToken: ARC_USDC,
    localDepositor: addressOf('0xe88f781e6cc8b7496f259200b57e22cb9457ff99')
  };

  it('reads every field of the captured 0x370bf19a DepositIntent', () => {
    expect(decodeDepositIntent(capturedAttestation().payload)).toEqual({
      magic: '0x5a2e0acd',
      version: 1,
      amount: 2_000_000_000n,
      remoteDomain: 10007,
      remoteToken: '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600',
      remoteRecipient: '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100',
      localToken: '0x0000000000000000000000003600000000000000000000000000000000000000',
      localDepositor: '0x000000000000000000000000e88f781e6cc8b7496f259200b57e22cb9457ff99',
      maxFee: 0n,
      nonce: '0x335d432e805b61478619eced3af4f3d074e217df74d49eb797542275318e8a41',
      hookLength: 0,
      hookData: '0x'
    });
  });

  it('names the field a malformed payload fails on', () => {
    const payload = capturedAttestation().payload;
    expect(() => decodeDepositIntent(hexOf(`0x00000000${payload.slice(10)}`))).toThrow(
      'DepositIntent magic: 0x00000000'
    );
    expect(() => decodeDepositIntent(hexOf(`${payload.slice(0, 10)}00000002${payload.slice(18)}`))).toThrow(
      'DepositIntent version: 2'
    );
    expect(() => decodeDepositIntent(hexOf(`${payload}00`))).toThrow('241 bytes, expected 240 + hookLen 0');
    expect(() => decodeDepositIntent(hexOf(payload.slice(0, -2)))).toThrow('239 bytes, below the 240-byte header');
  });

  it("checks every field against the deposit and recovers Circle's attester", async () => {
    await expect(assertDepositIntent(capturedAttestation(), expected)).resolves.toMatchObject({
      signer: '0xad1b523Cf15F086EB4CE54A1eF1DE2D13Fd38816'
    });
  });

  it('names the field that differs', async () => {
    await expect(
      assertDepositIntent(capturedAttestation(), {
        ...expected,
        remoteRecipient: hexOf('0x00000000000000000000000000000000f2f42cda8d010f417d1cad5dc4d52b00')
      })
    ).rejects.toThrow(
      'remoteRecipient@76: 0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100, expected'
    );
    await expect(
      assertDepositIntent({ ...capturedAttestation(), messageHash: keccak256('0x00') }, expected)
    ).rejects.toThrow('messageHash');
  });
});
