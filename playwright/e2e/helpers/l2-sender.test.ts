/**
 * @jest-environment node
 */
import {
  createPublicClient,
  custom,
  hexToBigInt,
  isHex,
  keccak256,
  parseTransaction,
  RpcRequestError,
  toHex,
  type Hex,
  type PublicClient
} from 'viem';

import arcVectors from './arc-usdcx.vectors.json';
import { createL2Sender, type L2Transaction } from './l2-sender';
import { L2_BRIDGE_IN_SOURCES, type L2BridgeInSource } from './usdcx-constants';

const KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const RECEIPT_BLOCK = 48_206_800n;
const clock = { now: () => 0, sleep: async () => undefined };

function l2On(chainId: number): L2BridgeInSource {
  const found = L2_BRIDGE_IN_SOURCES.find(l2 => l2.payout.chainId === chainId);
  if (!found) throw new Error(`L2_BRIDGE_IN_SOURCES lost chain ${chainId}`);
  return found;
}

/** The block a call ran at, or `unpinned` when it named none (viem then sends `latest` or no block). */
function blockOf(params: readonly unknown[]): string {
  const [, block] = params;
  return isHex(block) ? hexToBigInt(block).toString() : 'unpinned';
}

/**
 * One L2 behind a stub EIP-1193 provider: viem's own signing and encoding run, the answers are canned. `calls` lists
 * each nonce read and each eth_call and eth_estimateGas with the block it ran at. Every receipt is in RECEIPT_BLOCK and
 * the head is `head`; `revertCall` makes that eth_call (0 for the first) revert; `priorityFee` is the tip oracle's bid.
 */
function l2Chain(
  on: L2BridgeInSource,
  opts: { head?: bigint; servedChainId?: number; revertCall?: number; priorityFee?: bigint } = {}
) {
  const sent: Hex[] = [];
  const calls: string[] = [];
  let callIndex = 0;
  const rpc = (method: string, params: readonly unknown[]): unknown => {
    switch (method) {
      case 'eth_chainId':
        return toHex(opts.servedChainId ?? on.payout.chainId);
      case 'eth_getTransactionCount':
        calls.push(method);
        return '0x7';
      case 'eth_blockNumber':
        return toHex(opts.head ?? RECEIPT_BLOCK + 3n);
      case 'eth_call':
        calls.push(`eth_call ${blockOf(params)}`);
        if (callIndex++ === opts.revertCall) {
          throw new RpcRequestError({
            body: {},
            error: { code: 3, message: 'execution reverted' },
            url: 'https://l2.example'
          });
        }
        return '0x';
      case 'eth_estimateGas':
        calls.push(`eth_estimateGas ${blockOf(params)}`);
        return '0xaae60';
      case 'eth_maxPriorityFeePerGas':
        return toHex(opts.priorityFee ?? 1_000_000n);
      case 'eth_getBlockByNumber':
        return {
          number: '0x10',
          hash: `0x${'11'.repeat(32)}`,
          timestamp: '0x6a87a0a0',
          baseFeePerGas: '0x5b8d80',
          transactions: []
        };
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
    chain: on.payout.chain,
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
  return { sent, calls, publicClient: () => client };
}

const l2 = l2On(84532);
const APPROVE: L2Transaction = { to: l2.source.usdc, data: '0x095ea7b3', value: 0n };
const BURN: L2Transaction = { to: l2.source.tokenMessengerWithFees, data: '0xabcdef01', value: 0n };

const senderOn = (chain: ReturnType<typeof l2Chain>) =>
  createL2Sender(
    { privateKey: KEY, l2, allowedTargets: [l2.source.usdc, l2.source.tokenMessengerWithFees] },
    { publicClient: chain.publicClient, clock }
  );

describe('createL2Sender', () => {
  it("reads the nonce once, counts it locally, and runs the second send at the head past the first one's block", async () => {
    const chain = l2Chain(l2);
    const sender = await senderOn(chain);

    const approve = await sender.send(APPROVE);
    const burn = await sender.send(BURN);

    const [first, second] = chain.sent.map(raw => parseTransaction(raw));
    expect([first?.chainId, first?.nonce, second?.nonce]).toEqual([84532, 7, 8]);
    expect([first?.to, second?.to]).toEqual([APPROVE.to.toLowerCase(), BURN.to.toLowerCase()]);
    expect(sender.sent).toEqual([approve, burn]);
    expect(sender.sent).toEqual(chain.sent.map(raw => keccak256(raw)));
    const head = String(RECEIPT_BLOCK + 3n);
    expect(chain.calls).toEqual([
      'eth_getTransactionCount',
      'eth_call unpinned',
      'eth_estimateGas unpinned',
      `eth_call ${head}`,
      `eth_estimateGas ${head}`
    ]);
    expect(sender.endpoint).toBe(l2.payout.rpcUrls[0]);
  });

  it("pins the second send at the first one's block when the write endpoint's head is behind it", async () => {
    const chain = l2Chain(l2, { head: RECEIPT_BLOCK - 2n });
    const sender = await senderOn(chain);

    await sender.send(APPROVE);
    await sender.send(BURN);

    expect(chain.calls.slice(-2)).toEqual([`eth_call ${RECEIPT_BLOCK}`, `eth_estimateGas ${RECEIPT_BLOCK}`]);
  });

  it('gives two sends asked at once consecutive nonces', async () => {
    const chain = l2Chain(l2);
    const sender = await senderOn(chain);

    await Promise.all([sender.send(APPROVE), sender.send(BURN)]);

    expect(chain.sent.map(raw => parseTransaction(raw).nonce)).toEqual([7, 8]);
  });

  it('sends nothing when the second call would revert at its pin, and names the block', async () => {
    const chain = l2Chain(l2, { revertCall: 1 });
    const sender = await senderOn(chain);

    await sender.send(APPROVE);
    await expect(sender.send(BURN)).rejects.toThrow(`would revert at block ${RECEIPT_BLOCK + 3n}`);
    expect(chain.sent).toHaveLength(1);
  });

  it('refuses a target it was not given, sending nothing', async () => {
    const chain = l2Chain(l2);
    const sender = await senderOn(chain);

    await expect(sender.send({ ...APPROVE, to: '0x000000000000000000000000000000000000dEaD' })).rejects.toThrow(
      'refused: the key sends only to'
    );
    expect(chain.sent).toEqual([]);
  });

  it('refuses a transaction that carries ETH, sending nothing', async () => {
    const chain = l2Chain(l2);
    const sender = await senderOn(chain);

    await expect(sender.send({ ...APPROVE, value: 1n })).rejects.toThrow('refused: it carries 1 wei');
    expect(chain.sent).toEqual([]);
  });

  it('sends nothing once its signal is aborted', async () => {
    const chain = l2Chain(l2);
    const sender = await senderOn(chain);
    const stopping = new AbortController();
    stopping.abort(new Error('the counterparty stopped'));

    await expect(sender.send(APPROVE, stopping.signal)).rejects.toThrow('not sent: the counterparty stopped');
    expect(chain.sent).toEqual([]);
  });

  it('refuses an endpoint that serves another chain', async () => {
    await expect(senderOn(l2Chain(l2, { servedChainId: 1 }))).rejects.toThrow('no Base Sepolia endpoint takes writes');
  });

  // Sepolia's tip oracle follows signers who bid up to 1.5 gwei; its sends tip at most 0.01 gwei, as the Chrome
  // sender's do (#1508).
  it.each([
    ['Ethereum Sepolia with its cap', 11155111, 10_000_000n],
    ['Base Sepolia, which has no cap, with the oracle tip', 84532, 1_500_000_000n]
  ])('tips on %s when the oracle bids 1.5 gwei', async (_on, chainId, tip) => {
    const on = l2On(chainId);
    const chain = l2Chain(on, { priorityFee: 1_500_000_000n });
    const sender = await createL2Sender(
      { privateKey: KEY, l2: on, allowedTargets: [on.source.usdc] },
      { publicClient: chain.publicClient, clock }
    );

    await sender.send({ to: on.source.usdc, data: '0x095ea7b3', value: 0n });

    // viem's max fee: the 0.006 gwei base fee at 1.2x, plus the tip bid.
    const [sent] = chain.sent.map(raw => parseTransaction(raw));
    expect([sent?.chainId, sent?.maxPriorityFeePerGas, sent?.maxFeePerGas]).toEqual([chainId, tip, 7_200_000n + tip]);
  });
});
