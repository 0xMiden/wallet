/**
 * @jest-environment node
 */
import { createPublicClient, custom, isHex, pad, type Chain, type Hex, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';

import { type ArcClock } from './arc-usdcx';
import vectors from './usdcx-bridge-in.vectors.json';
import {
  confirmArcForward,
  confirmL2Burn,
  decodeCctpMessage,
  sameBurnMessage,
  waitForIrisForward
} from './usdcx-cctp-proof';
import { L2_BRIDGE_IN_SOURCES, type L2BridgeInSource } from './usdcx-constants';
import type { L2DepositSubmission } from './usdcx-l2-deposit';
import type { CctpMessage } from '../../../src/lib/usdcx/cctp';
import { addressToBytes32 } from '../../../src/lib/usdcx/executor';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';

function hex(value: unknown): Hex {
  if (!isHex(value)) throw new Error(`${String(value)} is not hex`);
  return value;
}

const BASE = L2_BRIDGE_IN_SOURCES.find(l2 => l2.payout.chainId === baseSepolia.id);
if (!BASE) throw new Error('L2_BRIDGE_IN_SOURCES lost Base Sepolia');
const L2: L2BridgeInSource = BASE;
const UNITS = BigInt(vectors.expected.units);
const FEE = BigInt(vectors.expected.fee);
const NONCE = hex(vectors.expected.nonce);
const BURN_HASH = hex(vectors.burn.transactionHash);
const FORWARD_HASH = hex(vectors.forward.transactionHash);
const DEPOSITOR = hex(vectors.expected.depositor);
const [IRIS_ENTRY] = vectors.iris.body.messages;
if (!IRIS_ENTRY) throw new Error('the vectors lost their Iris message');
const IRIS_MESSAGE = hex(IRIS_ENTRY.message);

/** A client whose every receipt read answers `receipt` for the hash asked, through viem's own receipt formatter. */
function receiptClient(chain: Chain, receipt: unknown): PublicClient {
  return createPublicClient({
    chain,
    cacheTime: 0,
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method !== 'eth_getTransactionReceipt') throw new Error(`unexpected ${method}`);
          const [hash] = Array.isArray(params) ? params : [];
          return { ...(receipt !== null && typeof receipt === 'object' ? receipt : {}), transactionHash: hash };
        }
      },
      { retryCount: 0 }
    )
  });
}

function fakeClock(): ArcClock & { slept: number[] } {
  let now = 0;
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

const baseReads = (receipt: unknown = vectors.burn.receipt) => ({
  endpoints: L2.payout.rpcUrls,
  payoutChain: L2.payout,
  publicClient: () => receiptClient(baseSepolia, receipt),
  clock: fakeClock()
});
const arcReads = (receipt: unknown = vectors.forward.receipt) => ({
  endpoints: ['https://rpc.quicknode.testnet.arc.io'],
  publicClient: () => receiptClient(ARC_TESTNET, receipt),
  clock: fakeClock()
});

/** The captured burn's MessageSent message, read through the gate itself. */
async function sentMessage(): Promise<Hex> {
  const proof = await confirmL2Burn(submission(), { l2: L2, units: UNITS, depositor: DEPOSITOR }, baseReads());
  return proof.sentMessage;
}

/** The deposit as the key would have signed it: the captured burn's own hook data and fee. */
function submission(overrides: Partial<L2DepositSubmission> = {}): L2DepositSubmission {
  const hookData = decodeCctpMessage(IRIS_MESSAGE).body.hookData;
  const quote = { signedQuote: hex('0x'), feeTotalAmount: FEE };
  return {
    endpoint: L2.payout.rpcUrls[0] ?? '',
    burnHash: BURN_HASH,
    signed: { amount: UNITS, destinationCaller: addressToBytes32(L2.source.target.executor), hookData },
    quotes: [quote],
    burnQuote: quote,
    submitted: {
      usdcxRemoteRecipient: vectors.expected.remoteRecipient,
      cctp: { sourceDomain: 6, forwarded: true, forwardFee: vectors.expected.fee }
    },
    ...overrides
  };
}

const irisEntry = (overrides: Partial<CctpMessage> = {}): CctpMessage => ({
  message: IRIS_MESSAGE,
  attestation: hex(IRIS_ENTRY.attestation),
  status: 'complete',
  eventNonce: NONCE,
  forwardState: 'COMPLETE',
  forwardTxHash: FORWARD_HASH,
  ...overrides
});

describe('decodeCctpMessage', () => {
  it("reads the captured burn's CCTP V2 message and its burn body", () => {
    const fields = decodeCctpMessage(IRIS_MESSAGE);
    expect({ ...fields, body: { ...fields.body, hookData: fields.body.hookData.length } }).toEqual({
      version: 1,
      sourceDomain: 6,
      destinationDomain: 26,
      nonce: NONCE,
      sender: pad('0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa'),
      recipient: pad('0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa'),
      destinationCaller: addressToBytes32(L2.source.target.executor).toLowerCase(),
      minFinalityThreshold: 1000,
      finalityThresholdExecuted: 1000,
      body: {
        version: 1,
        burnToken: pad(L2.source.usdc).toLowerCase(),
        mintRecipient: addressToBytes32(L2.source.target.executor).toLowerCase(),
        amount: UNITS,
        messageSender: pad(L2.source.tokenMessengerWithFees).toLowerCase(),
        maxFee: 0n,
        feeExecuted: 0n,
        expirationBlock: 67_693_175n,
        hookData: 2 + 704 * 2
      }
    });
  });

  it('refuses a message shorter than a burn message', () => {
    expect(() => decodeCctpMessage('0x01')).toThrow('CCTP message length: 1 bytes');
  });
});

describe('confirmL2Burn', () => {
  it('proves the captured burn: from the depositor to the fee entry point, one MessageSent as signed, the exact debit', async () => {
    const proof = await confirmL2Burn(submission(), { l2: L2, units: UNITS, depositor: DEPOSITOR }, baseReads());
    expect({ debit: proof.debit, block: proof.blockNumber, sourceDomain: proof.fields.sourceDomain }).toEqual({
      debit: UNITS + FEE,
      block: BigInt(vectors.burn.receipt.blockNumber),
      sourceDomain: 6
    });
    expect(sameBurnMessage(proof.sentMessage, IRIS_MESSAGE)).toBe(true);
  });

  it('names hookData when one signed byte differs', async () => {
    const { signed } = submission();
    const flipped = hex(`${signed.hookData.slice(0, -2)}${signed.hookData.endsWith('00') ? '01' : '00'}`);
    await expect(
      confirmL2Burn(
        submission({ signed: { ...signed, hookData: flipped } }),
        { l2: L2, units: UNITS, depositor: DEPOSITOR },
        baseReads()
      )
    ).rejects.toThrow(/hookData: 0x/);
  });

  it('names the debit when Circle took other than the quoted fee', async () => {
    const quote = { signedQuote: hex('0x'), feeTotalAmount: FEE - 1n };
    await expect(
      confirmL2Burn(
        submission({ quotes: [quote], burnQuote: quote }),
        { l2: L2, units: UNITS, depositor: DEPOSITOR },
        baseReads()
      )
    ).rejects.toThrow(`USDC debit: ${UNITS + FEE}, expected ${UNITS + FEE - 1n}`);
  });

  it('names the sender when the key did not send the burn', async () => {
    await expect(
      confirmL2Burn(
        submission(),
        { l2: L2, units: UNITS, depositor: '0x4D4A180C637a71FCB9b5BD1186C8ce23C40EBa81' },
        baseReads()
      )
    ).rejects.toThrow(/from: 0x92a119667e0e6733116a8d6416a66b2ce8dc0e94, expected 0x4d4a/);
  });
});

describe('sameBurnMessage', () => {
  it('ignores only the bytes Circle fills in after the burn', async () => {
    const sent = await sentMessage();
    expect(sameBurnMessage(sent, IRIS_MESSAGE)).toBe(true);
    // amount, at body offset 68: not Circle's to change
    const amountAt = 2 + (148 + 68 + 31) * 2;
    const changed = hex(`${sent.slice(0, amountAt)}ff${sent.slice(amountAt + 2)}`);
    expect(sameBurnMessage(changed, IRIS_MESSAGE)).toBe(false);
  });
});

describe('waitForIrisForward', () => {
  const args = async () => ({ l2: L2, burnHash: BURN_HASH, sentMessage: await sentMessage() });

  it("reads the captured message through the wallet's own Iris parser", async () => {
    const iris = jest.fn(async () => ({ ok: true, status: 200, json: async () => vectors.iris.body }));
    Object.defineProperty(globalThis, 'fetch', { value: iris, writable: true, configurable: true });
    const forward = await waitForIrisForward(await args(), { timeoutMs: 60_000, clock: fakeClock() });
    expect(forward).toEqual({ nonce: NONCE, forwardTxHash: FORWARD_HASH, forwardState: 'COMPLETE', seenAtMs: 0 });
    expect(iris).toHaveBeenCalledWith(
      `https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=${BURN_HASH}`,
      expect.anything()
    );
  });

  it('waits through pending reads and a 404, then returns the forward', async () => {
    const reads: CctpMessage[][] = [
      [],
      [
        irisEntry({
          status: 'pending_confirmations',
          attestation: 'PENDING',
          forwardState: undefined,
          forwardTxHash: undefined
        })
      ],
      [irisEntry({ forwardTxHash: undefined, forwardState: 'PENDING' })],
      [irisEntry()]
    ];
    const clock = fakeClock();
    const forward = await waitForIrisForward(await args(), {
      timeoutMs: 60_000,
      clock,
      fetchMessages: async () => reads.shift() ?? []
    });
    expect([forward.forwardTxHash, clock.slept]).toEqual([FORWARD_HASH, [3_000, 3_000, 3_000]]);
  });

  it('fails at once on a forward Circle gave up, and never executes on Arc', async () => {
    const clock = fakeClock();
    await expect(
      waitForIrisForward(await args(), {
        timeoutMs: 60_000,
        clock,
        fetchMessages: async () => [irisEntry({ forwardState: 'FAILED', forwardTxHash: undefined })]
      })
    ).rejects.toThrow('Circle gave up forwarding burn');
    expect(clock.slept).toEqual([]);
  });

  it('times out naming the last status and forward state', async () => {
    await expect(
      waitForIrisForward(await args(), {
        timeoutMs: 9_000,
        clock: fakeClock(),
        fetchMessages: async () => [
          irisEntry({
            status: 'pending_confirmations',
            attestation: 'PENDING',
            forwardTxHash: undefined,
            forwardState: undefined
          })
        ]
      })
    ).rejects.toThrow(/within 9000 ms: status pending_confirmations, attestation pending, forwardState none/);
  });

  it('refuses two messages for one burn', async () => {
    await expect(
      waitForIrisForward(await args(), {
        timeoutMs: 9_000,
        clock: fakeClock(),
        fetchMessages: async () => [irisEntry(), irisEntry()]
      })
    ).rejects.toThrow('Iris lists 2 messages for burn');
  });

  it('refuses an attested message that is not the burn', async () => {
    const amountAt = 2 + (148 + 68 + 31) * 2;
    const other = hex(`${IRIS_MESSAGE.slice(0, amountAt)}ff${IRIS_MESSAGE.slice(amountAt + 2)}`);
    await expect(
      waitForIrisForward(await args(), {
        timeoutMs: 9_000,
        clock: fakeClock(),
        fetchMessages: async () => [irisEntry({ message: other })]
      })
    ).rejects.toThrow("differs from the burn's MessageSent");
  });
});

describe('confirmArcForward', () => {
  const expected = {
    l2: L2,
    nonce: NONCE,
    units: UNITS,
    remoteRecipient: hex(vectors.expected.remoteRecipient),
    remoteToken: hex(vectors.expected.remoteToken)
  };

  it("proves the captured forward executed this burn's nonce into xReserve for its recipient", async () => {
    const proof = await confirmArcForward(FORWARD_HASH, expected, arcReads());
    expect({
      block: proof.blockNumber,
      value: proof.deposit.value,
      depositor: proof.deposit.localDepositor.toLowerCase(),
      recipient: proof.deposit.remoteRecipient
    }).toEqual({
      block: BigInt(vectors.forward.receipt.blockNumber),
      value: UNITS,
      depositor: L2.source.target.handler.toLowerCase(),
      recipient: expected.remoteRecipient
    });
  });

  it("refuses an execution of another burn's nonce", async () => {
    const other = hex(`0x${'ab'.repeat(32)}`);
    await expect(confirmArcForward(FORWARD_HASH, { ...expected, nonce: other }, arcReads())).rejects.toThrow(
      `0 MessageReceived for nonce ${other}, expected 1`
    );
  });

  it('refuses a deposit to another Miden account', async () => {
    const other = hex(`0x${'00'.repeat(16)}${'cd'.repeat(15)}00`);
    await expect(confirmArcForward(FORWARD_HASH, { ...expected, remoteRecipient: other }, arcReads())).rejects.toThrow(
      `remoteRecipient: ${expected.remoteRecipient}, expected ${other}`
    );
  });

  it('refuses a forward that reverted', async () => {
    await expect(
      confirmArcForward(FORWARD_HASH, expected, arcReads({ ...vectors.forward.receipt, status: '0x0' }))
    ).rejects.toThrow('reverted');
  });
});
