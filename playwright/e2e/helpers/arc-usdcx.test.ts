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
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseTransaction,
  toBytes,
  toHex,
  type Address,
  type Hex,
  type PublicClient
} from 'viem';

import {
  arcEndpoints,
  assertDepositIntent,
  confirmDepositToMiden,
  decodeDepositIntent,
  KEY_MOVED_NOTE,
  LATE_PAYOUT_NOTE,
  PayoutGateError,
  PREFUNDED_KEY_NOTE,
  readArcUsdc,
  readArcUsdcSnapshot,
  readXReserveDomainState,
  scanArcLogs,
  submitDepositToMiden,
  waitForGatewayPayout,
  waitForXReserveAttestation,
  XRESERVE_HARNESS_ABI,
  type ArcClock
} from './arc-usdcx';
import arcVectors from './arc-usdcx.vectors.json';
import {
  ARC_ATTESTATION_API,
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_DRPC_URL,
  ARC_KEY_LEDGER_DIR,
  ARC_PUBLIC_URL,
  ARC_QUICKNODE_URL,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  BURN_UNITS,
  DEFAULT_ARC_RPCS,
  DEPOSIT_UNITS,
  FEE_RESERVE_MULTIPLE,
  GAS_RESERVE_UNITS,
  GATEWAY_MINTER,
  GRANT_MARGIN_UNITS,
  GRANT_UNITS,
  HARNESS_ARC_KEY_FILE,
  isWorthClaiming,
  minimumUsdcxPayout,
  PAYOUT_TIMEOUT_MS
} from './usdcx-constants';
import type { XReserveAttestation } from '../../../src/lib/usdcx/attestation';
import attestationVectors from '../../../src/lib/usdcx/attestation.vectors.json';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';

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

  it("sizes the run on the faucet's minimum burn, one 10 USDCx grant and a deposit the wallet claims", () => {
    expect([BURN_UNITS, GRANT_UNITS, GRANT_MARGIN_UNITS, DEPOSIT_UNITS, GAS_RESERVE_UNITS]).toEqual([
      1_000_000n,
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

  it('names every endpoint when none answers', async () => {
    const failing = stubClient(() => {
      throw rpcError(-32005, 'rate limit exceeded');
    });
    await expect(
      readArcUsdc(ARC_USDC, { endpoints: ['https://a', 'https://b'], publicClient: () => failing })
    ).rejects.toThrow(/no Arc endpoint answered\n {2}https:\/\/a: .*rate limit exceeded\n {2}https:\/\/b: /);
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
  head?: bigint;
}): Rpc {
  let head = world.head ?? 66483820n;
  let balanceReads = 0;
  const transactions = new Map<string, unknown>(
    arcVectors.payouts.map(payout => [payout.transaction.hash, payout.transaction])
  );
  return (method, params) => {
    switch (method) {
      case 'eth_blockNumber':
        head += 2n;
        return toHex(head);
      case 'eth_call': {
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

  it('fails uncorrelated at the deadline when no complete scan finds the log, saying the key held USDC before', async () => {
    const failure = waitForGatewayPayout(args, {
      endpoints: [ARC_DRPC_URL],
      publicClient: () => stubClient(payoutChain({ balances: [HELD + 983_600n], logs: history })),
      clock: fakeClock(CONSUME_MS)
    });
    await expect(failure).rejects.toMatchObject({ failure: 'uncorrelated' });
    await expect(failure).rejects.toThrow(
      `payout received but not correlated: ${ARC_DRPC_URL}: found 0 AttestationUsed logs after block 66483700 ` +
        `up to block 66483822; ${PREFUNDED_KEY_NOTE}`
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

/** The write side of Arc: two endpoints, the first refusing raw transactions, the second taking them. */
function depositChain(opts: { allowance: bigint; revert?: Hex; alreadyKnown?: boolean }) {
  const sent: Hex[] = [];
  const nonces: number[] = [];
  const rpc: Rpc = (method, params) => {
    switch (method) {
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
        if (opts.revert) throw rpcError(3, 'execution reverted', opts.revert);
        return '0x';
      }
      case 'eth_sendRawTransaction': {
        const raw = params[0];
        if (raw === '0x00') throw rpcError(-32602, 'failed to decode signed transaction');
        if (!isHex(raw)) throw new Error('raw transaction is not hex');
        sent.push(raw);
        nonces.push(parseTransaction(raw).nonce ?? -1);
        if (opts.alreadyKnown && sent.length === 1) throw rpcError(-32000, 'already known');
        return keccak256(raw);
      }
      case 'eth_getTransactionReceipt':
        return { ...DEPOSIT_RECEIPT, transactionHash: params[0], logs: [], status: '0x1' };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  const refusing = stubClient((method, params) => {
    if (method === 'eth_chainId') return toHex(ARC_CHAIN_ID);
    if (method === 'eth_sendRawTransaction' && params[0] === '0x00') throw rpcError(-32601, 'method not supported');
    throw new Error(`unexpected ${method} on the refusing endpoint`);
  });
  return {
    sent,
    nonces,
    deps: {
      endpoints: ['https://read-only.example', ARC_DRPC_URL],
      publicClient: (endpoint: string) => (endpoint === ARC_DRPC_URL ? stubClient(rpc) : refusing),
      clock: fakeClock()
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
  });

  it('decodes a deposit revert before sending it', async () => {
    const paused = encodeErrorResult({ abi: XRESERVE_HARNESS_ABI, errorName: 'DomainDepositsPaused', args: [10007] });
    const chain = depositChain({ allowance: DEPOSIT_UNITS, revert: paused });
    await expect(
      submitDepositToMiden({ privateKey: key, units: DEPOSIT_UNITS, recipientHex, approve: 'if-short' }, chain.deps)
    ).rejects.toThrow(`xReserve depositToRemote would revert on ${ARC_DRPC_URL}`);
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

  it('refuses a reverted deposit', async () => {
    const client = stubClient(() => ({ ...DEPOSIT_RECEIPT, status: '0x0' }));
    await expect(
      confirmDepositToMiden(
        { endpoint: ARC_DRPC_URL, depositHash: hexOf(arcVectors.deposit.transactionHash), approved: false },
        { endpoints: [ARC_DRPC_URL], publicClient: () => client, clock: fakeClock() }
      )
    ).rejects.toThrow(`Arc transaction ${arcVectors.deposit.transactionHash} reverted in block 66290091`);
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
