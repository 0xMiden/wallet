/**
 * @jest-environment node
 */
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  isHex,
  keccak256,
  parseTransaction,
  toHex,
  type Hex,
  type PublicClient
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ERC20_ABI } from './arc-usdcx';
import arcVectors from './arc-usdcx.vectors.json';
import { DEPOSIT_UNITS, L2_BRIDGE_IN_SOURCES, type L2BridgeInSource } from './usdcx-constants';
import { l2KeyShortfall, l2Reads, readL2KeyFunds, submitL2Deposit } from './usdcx-l2-deposit';
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

function baseSepolia(): L2BridgeInSource {
  const found = L2_BRIDGE_IN_SOURCES.find(l2 => l2.payout.chainId === 84532);
  if (!found) throw new Error('L2_BRIDGE_IN_SOURCES lost Base Sepolia');
  return found;
}

function dataOf(params: readonly unknown[]): Hex {
  const [request] = params;
  const data: unknown = request !== null && typeof request === 'object' ? Reflect.get(request, 'data') : undefined;
  if (!isHex(data)) throw new Error('eth_call without data');
  return data;
}

/**
 * One L2 behind a stub EIP-1193 provider: viem's own encoding, signing and decoding run, the chain answers are canned.
 * `balanceReads` keeps the calldata of every balanceOf read, so a test can tell whose balance the deposit read.
 */
function l2Chain(l2: L2BridgeInSource, opts: { allowance: bigint; usdc?: bigint; servedChainId?: number }) {
  const sent: Hex[] = [];
  const balanceReads: Hex[] = [];
  const rpc = (method: string, params: readonly unknown[]): unknown => {
    switch (method) {
      case 'eth_chainId':
        return toHex(opts.servedChainId ?? l2.payout.chainId);
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_estimateGas':
        return '0xaae60';
      case 'eth_maxPriorityFeePerGas':
        return '0x5f5e100';
      case 'eth_getBlockByNumber':
        return {
          number: '0x10',
          hash: `0x${'11'.repeat(32)}`,
          timestamp: '0x6a87a0a0',
          baseFeePerGas: '0x5b8d80',
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
        return { ...arcVectors.deposit.receipt, transactionHash: params[0], logs: [], status: '0x1' };
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
  return { sent, balanceReads, publicClient: () => client };
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

  it('sends no approve when the allowance covers the amount and the fee', async () => {
    const l2 = baseSepolia();
    const chain = l2Chain(l2, { allowance: 1_000_000n });

    const submission = await submitL2Deposit(
      { privateKey: KEY, l2, units: DEPOSIT_UNITS, recipientHex: RECIPIENT_HEX, arc: { endpoints: [] } },
      { publicClient: chain.publicClient, isRemoteDomainRegistered: async () => true, fetchQuote: quotesInTurn(QUOTE) }
    );

    expect(chain.sent.map(raw => parseTransaction(raw).nonce)).toEqual([7]);
    expect([submission.approveHash, submission.quotes, chain.balanceReads.length]).toEqual([undefined, [QUOTE], 1]);
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
});

describe('l2KeyShortfall', () => {
  const enough = { label: 'Base Sepolia', address: DEPOSITOR, maxFeePerGas: 7_200_000n, units: 1_000n, fee: 22_404n };

  it('asks for ETH first, naming the chain, the address and the minimum', () => {
    expect(l2KeyShortfall({ ...enough, wei: 0n, usdc: 0n })).toBe(
      `top up the key on Base Sepolia: ${DEPOSITOR} holds 0 ETH, below the 0.0000072 ETH one bridge-in needs ` +
        `(1000000 gas at 0.0072 gwei); send Base Sepolia ETH to ${DEPOSITOR}`
    );
  });

  it('asks for USDC to cover the deposit and twice the fee its approve covers', () => {
    expect(l2KeyShortfall({ ...enough, wei: 10n ** 16n, usdc: 40_000n })).toBe(
      `top up the key on Base Sepolia: ${DEPOSITOR} holds 0.04 USDC, below the 0.045808 USDC one bridge-in needs ` +
        "(the 0.001 deposit and twice Circle's 0.022404 fee, which its approve covers); a green usdcx-burn-l2 run " +
        'pays it about 0.99 USDC there'
    );
  });

  it('asks for nothing when both suffice', () => {
    expect(l2KeyShortfall({ ...enough, wei: 10n ** 16n, usdc: 1_977_802n })).toBeUndefined();
  });
});
