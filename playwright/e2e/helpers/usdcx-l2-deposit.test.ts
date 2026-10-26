/**
 * @jest-environment node
 */
import {
  concat,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  hexToBigInt,
  isHex,
  keccak256,
  parseTransaction,
  RpcRequestError,
  toHex,
  type Hex,
  type PublicClient
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

import { ERC20_ABI } from './arc-usdcx';
import arcVectors from './arc-usdcx.vectors.json';
import {
  ARBITRUM_SEPOLIA_PAYOUT,
  BASE_SEPOLIA_PAYOUT,
  DEPOSIT_UNITS,
  ETHEREUM_SEPOLIA_PAYOUT,
  L2_BRIDGE_IN_SOURCES,
  type L2BridgeInSource
} from './usdcx-constants';
import { l2KeyShortfall, l2Reads, payoutKeyProblem, readL2KeyFunds, submitL2Deposit } from './usdcx-l2-deposit';
import type { CctpBurnQuote } from '../../../src/lib/usdcx/cctp';
import { buildDepositForBurnWithHookAndFeesArgs, buildExecutorBurnIntent } from '../../../src/lib/usdcx/executor';
import { TOKEN_MESSENGER_WITH_FEES_ABI } from '../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';

const KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const { address: DEPOSITOR } = privateKeyToAccount(KEY);
const RECIPIENT_HEX = '0xf2f42cda8d010f417d1cad5dc4d52b';
const RECIPIENT = midenAccountHexToXReserveRecipient(RECIPIENT_HEX);
/** Circle's sandbox priced a 0.001 USDC forwarded burn at 22_404 on 2026-10-16; the second quote moved a little. */
const QUOTE: CctpBurnQuote = { signedQuote: '0x0102', feeTotalAmount: 22_404n };
const REQUOTE: CctpBurnQuote = { signedQuote: '0x0304', feeTotalAmount: 22_500n };
const CALL_ABI = [...ERC20_ABI, ...TOKEN_MESSENGER_WITH_FEES_ABI];
const RECEIPT_BLOCK = 48_206_800n;
/** The write endpoint's head by default: past the approve's block, so the burn runs at it. */
const HEAD = RECEIPT_BLOCK + 6n;
const AT_HEAD = toHex(HEAD);

function l2On(chainId: number): L2BridgeInSource {
  const found = L2_BRIDGE_IN_SOURCES.find(l2 => l2.payout.chainId === chainId);
  if (!found) throw new Error(`L2_BRIDGE_IN_SOURCES lost chain ${chainId}`);
  return found;
}

function baseSepolia(): L2BridgeInSource {
  return l2On(84532);
}

function ethereumMainnet(): L2BridgeInSource {
  const sepolia = l2On(11155111);
  const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  return {
    payout: { ...sepolia.payout, chainId: 1, chain: mainnet, usdc, maxPriorityFeeCap: undefined },
    source: {
      ...sepolia.source,
      chain: mainnet,
      domain: 0,
      usdc,
      tokenMessengerWithFees: '0x71f54f818671cd0d7ea140da213e5c8b5c92a408'
    }
  };
}

function dataOf(params: readonly unknown[]): Hex {
  const [request] = params;
  const data: unknown = request !== null && typeof request === 'object' ? Reflect.get(request, 'data') : undefined;
  if (!isHex(data)) throw new Error('eth_call without data');
  return data;
}

/** A node's JSON-RPC error answer, as viem's http transport throws it. */
function nodeAnswer(code: number, message: string, data?: Hex): RpcRequestError {
  return new RpcRequestError({ body: {}, error: { code, message, data }, url: 'https://l2.example' });
}

/** A quote past its deadline block, as Base Sepolia refused the first live run's burn: `0x1504ec95(1, D, at)`. */
function quoteExpired(deadline: bigint, at: bigint): RpcRequestError {
  const args = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1n, deadline, at]);
  return nodeAnswer(3, 'execution reverted', concat(['0x1504ec95', args]));
}

function fakeClock() {
  const slept: number[] = [];
  return {
    slept,
    now: () => 0,
    sleep: async (ms: number) => {
      slept.push(ms);
    }
  };
}

/**
 * One L2 behind a stub EIP-1193 provider: viem's own encoding, signing and decoding run, the chain answers are canned.
 * `balanceReads` keeps the calldata of every balanceOf read, so a test can tell whose balance the deposit read. `pins`
 * lists each head read as `eth_blockNumber` and each simulation and estimate of an approve or a burn as
 * `<method> <function> <block>`, the block `none` when the call names none; `faults`, keyed `<method> <function>`, are
 * thrown in order before such a call answers normally. Every receipt is in RECEIPT_BLOCK. The head is `heads` in turn,
 * the last one repeating; a burn run past `quoteDeadline`, or at latest, reverts as an expired quote. The tip oracle
 * answers `priorityFee`, 0.1 gwei by default, over a 0.006 gwei base fee.
 */
function l2Chain(
  l2: L2BridgeInSource,
  opts: {
    allowance: bigint;
    usdc?: bigint;
    servedChainId?: number;
    faults?: Record<string, Error[]>;
    heads?: bigint[];
    quoteDeadline?: bigint;
    priorityFee?: bigint;
    baseFee?: bigint;
  }
) {
  const sent: Hex[] = [];
  const balanceReads: Hex[] = [];
  const pins: string[] = [];
  const faults = new Map(Object.entries(opts.faults ?? {}).map(([call, errors]) => [call, [...errors]]));
  const heads = [...(opts.heads ?? [HEAD])];
  const rpc = (method: string, params: readonly unknown[]): unknown => {
    if (method === 'eth_call' || method === 'eth_estimateGas') {
      const { functionName } = decodeFunctionData({ abi: CALL_ABI, data: dataOf(params) });
      if (functionName === 'approve' || functionName === 'depositForBurnWithHookAndFees') {
        const [, block] = params;
        pins.push(`${method} ${functionName} ${block === undefined ? 'none' : String(block)}`);
        const fault = faults.get(`${method} ${functionName}`)?.shift();
        if (fault) throw fault;
        const at = isHex(block) ? hexToBigInt(block) : undefined;
        const { quoteDeadline } = opts;
        if (functionName === 'depositForBurnWithHookAndFees' && quoteDeadline !== undefined) {
          if (at === undefined || at > quoteDeadline) throw quoteExpired(quoteDeadline, at ?? HEAD);
        }
      }
    }
    switch (method) {
      case 'eth_blockNumber':
        pins.push(method);
        return toHex((heads.length > 1 ? heads.shift() : heads[0]) ?? HEAD);
      case 'eth_chainId':
        return toHex(opts.servedChainId ?? l2.payout.chainId);
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_estimateGas':
        return '0xaae60';
      case 'eth_maxPriorityFeePerGas':
        return toHex(opts.priorityFee ?? 100_000_000n);
      case 'eth_getBlockByNumber':
        return {
          number: '0x10',
          hash: `0x${'11'.repeat(32)}`,
          timestamp: '0x6a87a0a0',
          baseFeePerGas: toHex(opts.baseFee ?? 6_000_000n),
          transactions: []
        };
      case 'eth_getBalance':
        return '0x2386f26fc10000';
      case 'eth_call': {
        const data = dataOf(params);
        const { functionName } = decodeFunctionData({ abi: CALL_ABI, data });
        if (functionName === 'allowance') return encodeAbiParameters([{ type: 'uint256' }], [opts.allowance]);
        if (functionName === 'balanceOf') {
          balanceReads.push(data);
          return encodeAbiParameters([{ type: 'uint256' }], [opts.usdc ?? 1_977_802n]);
        }
        if (functionName === 'approve') return encodeAbiParameters([{ type: 'bool' }], [true]);
        return '0x';
      }
      case 'eth_sendRawTransaction': {
        const [raw] = params;
        if (raw === '0x00') throw Object.assign(new Error('failed to decode signed transaction'), { code: -32602 });
        if (!isHex(raw)) throw new Error('raw transaction is not hex');
        sent.push(raw);
        return keccak256(raw);
      }
      case 'eth_getTransactionReceipt':
        return {
          ...arcVectors.deposit.receipt,
          transactionHash: params[0],
          blockNumber: toHex(RECEIPT_BLOCK),
          logs: [],
          status: '0x1'
        };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  const client: PublicClient = createPublicClient({
    chain: l2.payout.chain,
    cacheTime: 0,
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          return rpc(method, Array.isArray(params) ? params : []);
        }
      },
      { retryCount: 0 }
    )
  });
  return { sent, balanceReads, pins, publicClient: () => client };
}

function quotesInTurn(...quotes: CctpBurnQuote[]) {
  return async () => {
    const next = quotes.shift();
    if (!next) throw new Error('asked for one quote too many');
    return next;
  };
}

describe('submitL2Deposit', () => {
  it("approves the amount and twice the fee, quotes again, then signs the product's forwarded burn on Base Sepolia", async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n });

    const submission = await submitL2Deposit(
      { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
      {
        publicClient: chain.publicClient,
        isRemoteDomainRegistered: async () => true,
        fetchQuote: quotesInTurn(QUOTE, REQUOTE)
      }
    );

    const [approve, burn] = chain.sent.map(raw => parseTransaction(raw));
    expect([approve?.chainId, burn?.chainId, approve?.nonce, burn?.nonce]).toEqual([84532, 84532, 7, 8]);
    expect(approve?.to).toBe(l2.source.usdc.toLowerCase());
    expect(decodeFunctionData({ abi: CALL_ABI, data: approve?.data ?? '0x' })).toEqual({
      functionName: 'approve',
      args: [l2.source.tokenMessengerWithFees, DEPOSIT_UNITS + 2n * QUOTE.feeTotalAmount]
    });
    const intent = buildExecutorBurnIntent(formatUnits(DEPOSIT_UNITS, 6), l2.source, RECIPIENT, DEPOSITOR);
    const burnArgs = buildDepositForBurnWithHookAndFeesArgs(l2.source, intent, REQUOTE, DEPOSITOR);
    expect(burn?.to).toBe(l2.source.tokenMessengerWithFees.toLowerCase());
    // Compared as calldata: decoding lowercases bytes32 and bytes, while addressToBytes32 keeps the checksum's case.
    expect(burn?.data).toBe(
      encodeFunctionData({
        abi: TOKEN_MESSENGER_WITH_FEES_ABI,
        functionName: 'depositForBurnWithHookAndFees',
        args: burnArgs
      }).toLowerCase()
    );
    expect(submission).toEqual({
      endpoint: l2.payout.rpcUrls[0],
      approveHash: keccak256(chain.sent[0] ?? '0x'),
      burnHash: keccak256(chain.sent[1] ?? '0x'),
      signed: { amount: DEPOSIT_UNITS, destinationCaller: intent.destinationCaller, hookData: intent.hookData },
      quotes: [QUOTE, REQUOTE],
      burnQuote: REQUOTE,
      submitted: {
        usdcxRemoteRecipient: RECIPIENT.toLowerCase(),
        cctp: { sourceDomain: 6, forwarded: true, forwardFee: '22500' }
      }
    });
    // runUsdcxExecutorDeposit reads the key's own USDC before the first quote and again once the approve is mined.
    const keyBalance = encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [DEPOSITOR] });
    expect(chain.balanceReads).toEqual([keyBalance, keyBalance]);
  });

  it('keeps a mainnet burn eligible throughout the recorded rising-base-fee quote window', async () => {
    const l2 = ethereumMainnet();
    const chain = l2Chain(l2, { allowance: 10_000_000n, baseFee: 35_469_537n, priorityFee: 1_800n });
    await submitL2Deposit(
      { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
      { publicClient: chain.publicClient, isRemoteDomainRegistered: async () => true, fetchQuote: quotesInTurn(QUOTE) }
    );
    const [burn] = chain.sent.map(raw => parseTransaction(raw));
    expect(chain.sent).toHaveLength(1);
    expect(burn?.maxPriorityFeePerGas).toBe(1_800n);
    // Blocks 26271614-26271625, ending at the actual signed quote's deadline.
    const baseFees = [
      43_084_225n,
      47_624_525n,
      46_338_432n,
      46_596_902n,
      47_697_659n,
      48_859_342n,
      50_398_569n,
      50_143_819n,
      50_804_716n,
      48_019_026n,
      50_852_412n,
      49_873_956n
    ];
    expect(baseFees.every(baseFee => (burn?.maxFeePerGas ?? 0n) >= baseFee + 1_800n)).toBe(true);
  });

  it('sends no approve when the allowance covers the amount and the fee', async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 1_000_000n });

    const submission = await submitL2Deposit(
      { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
      { publicClient: chain.publicClient, isRemoteDomainRegistered: async () => true, fetchQuote: quotesInTurn(QUOTE) }
    );

    expect(chain.sent.map(raw => parseTransaction(raw).nonce)).toEqual([7]);
    expect([submission.approveHash, submission.quotes, chain.balanceReads.length]).toEqual([undefined, [QUOTE], 1]);
    expect(chain.pins).toEqual([
      'eth_call depositForBurnWithHookAndFees latest',
      'eth_estimateGas depositForBurnWithHookAndFees none'
    ]);
  });

  const depositOn = (l2: L2BridgeInSource, chain: ReturnType<typeof l2Chain>, clock = fakeClock()) =>
    submitL2Deposit(
      { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
      {
        publicClient: chain.publicClient,
        clock,
        isRemoteDomainRegistered: async () => true,
        fetchQuote: quotesInTurn(QUOTE, REQUOTE)
      }
    );

  // One endpoint URL is a pool of nodes: one behind the approve reads a short allowance at its own latest, and the
  // approve's block alone misses a quote deadline passed since. The head is read once, so the estimate runs where the
  // simulation did.
  it("simulates and estimates the burn at the head past the approve's block, the approve at latest", async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n, heads: [HEAD, HEAD + 4n] });

    await depositOn(l2, chain);

    expect(chain.pins).toEqual([
      'eth_call approve latest',
      'eth_estimateGas approve none',
      'eth_blockNumber',
      `eth_call depositForBurnWithHookAndFees ${AT_HEAD}`,
      `eth_estimateGas depositForBurnWithHookAndFees ${AT_HEAD}`
    ]);
  });

  // The receipt came from a node ahead of the one that answered the head read.
  it("simulates and estimates the burn at the approve's block when the head read is behind it", async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n, heads: [RECEIPT_BLOCK - 2n] });

    await depositOn(l2, chain);

    expect(chain.pins).toEqual([
      'eth_call approve latest',
      'eth_estimateGas approve none',
      'eth_blockNumber',
      `eth_call depositForBurnWithHookAndFees ${toHex(RECEIPT_BLOCK)}`,
      `eth_estimateGas depositForBurnWithHookAndFees ${toHex(RECEIPT_BLOCK)}`
    ]);
  });

  // What each source chain's endpoints answered on 2026-10-16 for a block past their head; viem reads Tenderly's code 3
  // as a revert.
  it.each([
    ['Base Sepolia', 84532, -32001, `block not found: ${AT_HEAD}`],
    ["Arbitrum Sepolia's own RPC", 421614, -32000, `unsupported block number ${HEAD}`],
    ["Arbitrum Sepolia's publicnode", 421614, -32000, 'header not found'],
    ["Arbitrum Sepolia's Tenderly", 421614, 3, 'header not found'],
    ['Ethereum Sepolia', 11155111, -32001, `block not found: ${AT_HEAD}`]
  ])(
    "asks the burn's simulation and estimate again while a node on %s lacks the block",
    async (_on, chainId, code, message) => {
      const l2 = l2On(chainId);
      const chain = l2Chain(l2, {
        allowance: 0n,
        faults: {
          'eth_call depositForBurnWithHookAndFees': [nodeAnswer(code, message)],
          'eth_estimateGas depositForBurnWithHookAndFees': [nodeAnswer(code, message)]
        }
      });
      const clock = fakeClock();

      const submission = await depositOn(l2, chain, clock);

      expect(submission.burnHash).toBe(keccak256(chain.sent[1] ?? '0x'));
      expect(chain.pins.filter(pin => pin.includes('depositForBurnWithHookAndFees'))).toEqual([
        `eth_call depositForBurnWithHookAndFees ${AT_HEAD}`,
        `eth_call depositForBurnWithHookAndFees ${AT_HEAD}`,
        `eth_estimateGas depositForBurnWithHookAndFees ${AT_HEAD}`,
        `eth_estimateGas depositForBurnWithHookAndFees ${AT_HEAD}`
      ]);
      expect(clock.slept).toEqual([2_000, 2_000]);
    }
  );

  // Ethereum Sepolia is an L1 and CCTP's domain 0: the route, the chain id and the domain the row keeps are its own.
  it("signs Ethereum Sepolia's approve and burn with its chain id, and keeps its source domain 0", async () => {
    const l2 = l2On(11155111);
    const chain = l2Chain(l2, { allowance: 0n });

    const submission = await depositOn(l2, chain);

    const [approve, burn] = chain.sent.map(raw => parseTransaction(raw));
    expect([approve?.chainId, burn?.chainId]).toEqual([11155111, 11155111]);
    expect([approve?.to, burn?.to]).toEqual([
      '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
      '0x8745d906d67c346e5eb1aeeed38eb87f34df0c0a'
    ]);
    expect([submission.endpoint, submission.submitted.cctp]).toEqual([
      'https://ethereum-sepolia-rpc.publicnode.com',
      { sourceDomain: 0, forwarded: true, forwardFee: '22500' }
    ]);
  });

  // Sepolia's tip oracle follows signers who bid up to 1.5 gwei, while the key holds about 0.002 ETH there.
  it.each([
    ['on Ethereum Sepolia with the cap when the oracle tips above it', 11155111, 1_500_000_000n, 10_000_000n],
    ['on Ethereum Sepolia with the oracle tip when it is below the cap', 11155111, 900_000n, 900_000n],
    ['on Base Sepolia, which has no cap, with the oracle tip', 84532, 1_500_000_000n, 1_500_000_000n]
  ])('signs the approve and the burn %s', async (_on, chainId, oracleTip, tip) => {
    const l2 = l2On(chainId);
    const chain = l2Chain(l2, { allowance: 0n, priorityFee: oracleTip });

    await depositOn(l2, chain);

    // viem's max fee: the 0.006 gwei base fee at 1.2x, plus the tip bid.
    const fees = chain.sent.map(raw => {
      const { maxPriorityFeePerGas, maxFeePerGas } = parseTransaction(raw);
      return { maxPriorityFeePerGas, maxFeePerGas };
    });
    expect(fees).toEqual([
      { maxPriorityFeePerGas: tip, maxFeePerGas: 7_200_000n + tip },
      { maxPriorityFeePerGas: tip, maxFeePerGas: 7_200_000n + tip }
    ]);
  });

  it('fails a burn whose node stays behind its pinned block, naming the block and the endpoint', async () => {
    const l2 = baseSepolia();
    const behind = () => nodeAnswer(-32001, `block not found: ${AT_HEAD}`);
    const chain = l2Chain(l2, {
      allowance: 0n,
      faults: { 'eth_call depositForBurnWithHookAndFees': [behind(), behind(), behind(), behind()] }
    });
    const clock = fakeClock();

    await expect(depositOn(l2, chain, clock)).rejects.toThrow(
      `forwarded burn could not be simulated at block ${HEAD} on base-sepolia-rpc.publicnode.com, ` +
        'still behind it after 3 retries: '
    );
    expect(chain.sent).toHaveLength(1);
    expect(clock.slept).toEqual([2_000, 4_000, 8_000]);
  });

  it('reports an allowance revert at the pinned block as a revert, at once', async () => {
    const l2 = baseSepolia();
    const short = nodeAnswer(3, 'execution reverted: ERC20: transfer amount exceeds allowance');
    const chain = l2Chain(l2, { allowance: 0n, faults: { 'eth_call depositForBurnWithHookAndFees': [short] } });
    const clock = fakeClock();

    const failure = depositOn(l2, chain, clock);

    await expect(failure).rejects.toThrow(
      `forwarded burn would revert at block ${HEAD} on base-sepolia-rpc.publicnode.com: `
    );
    await expect(failure).rejects.toThrow('transfer amount exceeds allowance');
    expect(chain.pins.filter(pin => pin.startsWith('eth_call depositForBurnWithHookAndFees'))).toHaveLength(1);
    expect([chain.sent.length, clock.slept]).toEqual([1, []]);
  });

  // The sequencer runs the burn at its head, so a quote whose deadline passed after the approve's block must fail here.
  it("reports a quote that expired after the approve's block as a revert at the head, sending no burn", async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n, quoteDeadline: RECEIPT_BLOCK + 2n });
    const clock = fakeClock();

    const failure = depositOn(l2, chain, clock);

    await expect(failure).rejects.toThrow(
      `forwarded burn would revert at block ${HEAD} on base-sepolia-rpc.publicnode.com: `
    );
    await expect(failure).rejects.toThrow('Encoded error signature "0x1504ec95" not found on ABI.');
    expect(chain.pins.filter(pin => pin.includes('depositForBurnWithHookAndFees'))).toEqual([
      `eth_call depositForBurnWithHookAndFees ${AT_HEAD}`
    ]);
    expect([chain.sent.length, clock.slept]).toEqual([1, []]);
  });

  // The product's own check (#1498), past the spec's l2_key step: the burn pulls Circle's fee on top of the amount.
  it("sends nothing when the key's USDC does not cover the amount and Circle's fee", async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n, usdc: DEPOSIT_UNITS + QUOTE.feeTotalAmount - 1n });

    await expect(
      submitL2Deposit(
        { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
        {
          publicClient: chain.publicClient,
          isRemoteDomainRegistered: async () => true,
          fetchQuote: quotesInTurn(QUOTE)
        }
      )
    ).rejects.toThrow('The burn needs 23404 USDC base units, the amount plus a fee of 22404, but the balance is 23403');
    expect(chain.sent).toEqual([]);
  });

  it('sends nothing when Arc has not registered Miden', async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n });

    await expect(
      submitL2Deposit(
        { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
        {
          publicClient: chain.publicClient,
          isRemoteDomainRegistered: async () => false,
          fetchQuote: quotesInTurn(QUOTE)
        }
      )
    ).rejects.toThrow('xReserve remote domain 10007 is not registered');
    expect(chain.sent).toEqual([]);
  });

  it('sends nothing once its step ran out of budget', async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n });
    const step = new AbortController();
    step.abort(new Error('deposit_submit exceeded its 300000 ms budget'));

    await expect(
      submitL2Deposit(
        { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
        {
          publicClient: chain.publicClient,
          isRemoteDomainRegistered: async () => true,
          fetchQuote: quotesInTurn(QUOTE)
        },
        step.signal
      )
    ).rejects.toThrow('USDC approve not sent');
    expect(chain.sent).toEqual([]);
  });

  it('refuses an endpoint that serves another chain, naming Base Sepolia', async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 0n, servedChainId: 5042002 });

    await expect(
      submitL2Deposit(
        { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
        {
          publicClient: chain.publicClient,
          isRemoteDomainRegistered: async () => true,
          fetchQuote: quotesInTurn(QUOTE)
        }
      )
    ).rejects.toThrow('no Base Sepolia endpoint takes writes');
  });
});

describe('readL2KeyFunds', () => {
  it("reads the key's ETH, its USDC and the fee a send would bid, on one endpoint", async () => {
    const l2 = baseSepolia();
    const funds = await readL2KeyFunds(
      DEPOSITOR,
      l2Reads(l2, { publicClient: l2Chain(l2, { allowance: 0n }).publicClient })
    );

    expect({ wei: funds.wei, usdc: funds.usdc }).toEqual({ wei: 10_000_000_000_000_000n, usdc: 1_977_802n });
    expect(funds.maxFeePerGas).toBeGreaterThanOrEqual(100_000_000n);
  });

  it("reads Ethereum Sepolia's bid with the tip its sends cap", async () => {
    const l2 = l2On(11155111);
    const chain = l2Chain(l2, { allowance: 0n, priorityFee: 1_500_000_000n });

    const funds = await readL2KeyFunds(DEPOSITOR, l2Reads(l2, { publicClient: chain.publicClient }));

    expect(funds.maxFeePerGas).toBe(7_200_000n + 10_000_000n);
  });

  it('funds the same mainnet fee ceiling that the burn signs and refuses the former budget', async () => {
    const l2 = ethereumMainnet();
    const chain = l2Chain(l2, { allowance: 10_000_000n, baseFee: 35_469_537n, priorityFee: 1_800n });
    const funds = await readL2KeyFunds(DEPOSITOR, l2Reads(l2, { publicClient: chain.publicClient }));
    await submitL2Deposit(
      { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
      { publicClient: chain.publicClient, isRemoteDomainRegistered: async () => true, fetchQuote: quotesInTurn(QUOTE) }
    );
    const [burn] = chain.sent.map(raw => parseTransaction(raw));
    expect(funds.maxFeePerGas).toBe(burn?.maxFeePerGas);
    expect(funds.maxFeePerGas).toBe(70_940_874n);
    expect(
      l2KeyShortfall({
        label: 'Ethereum',
        address: DEPOSITOR,
        wei: 1_100_000n * 42_565_244n,
        maxFeePerGas: funds.maxFeePerGas,
        usdc: funds.usdc,
        units: DEPOSIT_UNITS,
        fee: QUOTE.feeTotalAmount
      })
    ).toContain('below');
    expect(
      l2KeyShortfall({
        label: 'Ethereum',
        address: DEPOSITOR,
        wei: 1_100_000n * funds.maxFeePerGas,
        maxFeePerGas: funds.maxFeePerGas,
        usdc: funds.usdc,
        units: DEPOSIT_UNITS,
        fee: QUOTE.feeTotalAmount
      })
    ).toBeUndefined();
  });
});

describe('l2KeyShortfall', () => {
  const enough = { label: 'Base Sepolia', address: DEPOSITOR, maxFeePerGas: 7_200_000n, units: 1_000n, fee: 22_404n };

  it('asks for ETH first, naming the chain, the address and the minimum', () => {
    expect(l2KeyShortfall({ ...enough, wei: 0n, usdc: 0n })).toBe(
      `top up the key on Base Sepolia: ${DEPOSITOR} holds 0 ETH, below the 0.00000792 ETH one bridge-in needs ` +
        `(1100000 gas at 0.0072 gwei); send Base Sepolia ETH to ${DEPOSITOR}`
    );
  });

  it('asks for USDC to cover the deposit and twice the fee its approve covers', () => {
    expect(l2KeyShortfall({ ...enough, wei: 10n ** 16n, usdc: 40_000n })).toBe(
      `top up the key on Base Sepolia: ${DEPOSITOR} holds 0.04 USDC, below the 0.045808 USDC one bridge-in needs ` +
        "(the 0.001 deposit and twice Circle's 0.022404 fee, which its approve covers); a green usdcx-burn-l2 run " +
        "refills it with that run's payout"
    );
  });

  it("names the key's own refill when it has one", () => {
    expect(
      l2KeyShortfall({ ...enough, wei: 10n ** 16n, usdc: 40_000n, refill: 'a green iOS executor run pays it back' })
    ).toMatch(/which its approve covers\); a green iOS executor run pays it back$/);
  });

  it('asks for nothing when both suffice', () => {
    expect(l2KeyShortfall({ ...enough, wei: 10n ** 16n, usdc: 1_977_802n })).toBeUndefined();
  });
});

describe('payoutKeyProblem', () => {
  it("refuses a key with no Ethereum Sepolia USDC, naming Circle's fixed mint gas limit", () => {
    expect(payoutKeyProblem(ETHEREUM_SEPOLIA_PAYOUT, DEPOSITOR, 0n)).toBe(
      `${DEPOSITOR} holds no Ethereum Sepolia USDC, and Circle's forwarder cannot mint a payout to a recipient with no ` +
        'USDC under its fixed gas limit: fund the key with any amount of Ethereum Sepolia USDC first'
    );
  });

  it.each([
    ['Ethereum Sepolia holding 1 base unit', ETHEREUM_SEPOLIA_PAYOUT, 1n],
    ['Base Sepolia holding none', BASE_SEPOLIA_PAYOUT, 0n],
    ['Arbitrum Sepolia holding none', ARBITRUM_SEPOLIA_PAYOUT, 0n]
  ])('asks nothing of a key on %s', (_on, chain, usdc) => {
    expect(payoutKeyProblem(chain, DEPOSITOR, usdc)).toBeUndefined();
  });
});
