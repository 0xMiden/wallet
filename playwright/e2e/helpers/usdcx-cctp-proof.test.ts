/**
 * @jest-environment node
 */
import { createPublicClient, custom, isHex, pad, type Chain, type Hex, type PublicClient } from 'viem';

import { type ArcClock } from './arc-usdcx';
import sepoliaVectors from './usdcx-bridge-in-ethereum-sepolia.vectors.json';
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

/** A third party's executor deposit from `chainId` to Arc, captured, with the bridge-in source it was sent from. */
function captured(file: typeof vectors | typeof sepoliaVectors, chainId: number) {
  const l2 = L2_BRIDGE_IN_SOURCES.find(source => source.payout.chainId === chainId);
  if (!l2) throw new Error(`L2_BRIDGE_IN_SOURCES lost chain ${chainId}`);
  const [iris] = file.iris.body.messages;
  if (!iris) throw new Error(`the ${l2.payout.label} vectors lost their Iris message`);
  return {
    l2,
    vectors: file,
    units: BigInt(file.expected.units),
    fee: BigInt(file.expected.fee),
    nonce: hex(file.expected.nonce),
    burnHash: hex(file.burn.transactionHash),
    forwardHash: hex(file.forward.transactionHash),
    depositor: hex(file.expected.depositor),
    iris,
    irisMessage: hex(iris.message)
  };
}
type Captured = ReturnType<typeof captured>;

const BASE = captured(vectors, 84532);
/** Ethereum Sepolia is CCTP's domain 0, so nothing may read a source domain as unset. */
const SEPOLIA = captured(sepoliaVectors, 11155111);
/** Each captured deposit, with the source domain its message must carry. */
const CAPTURED: Array<[chain: string, deposit: Captured, domain: number]> = [
  ['Base Sepolia', BASE, 6],
  ['Ethereum Sepolia', SEPOLIA, 0]
];
const L2: L2BridgeInSource = BASE.l2;
const UNITS = BASE.units;
const FEE = BASE.fee;
const NONCE = BASE.nonce;
const FORWARD_HASH = BASE.forwardHash;
const DEPOSITOR = BASE.depositor;
const IRIS_ENTRY = BASE.iris;
const IRIS_MESSAGE = BASE.irisMessage;

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

const burnReads = (deposit: Captured = BASE) => ({
  endpoints: deposit.l2.payout.rpcUrls,
  payoutChain: deposit.l2.payout,
  publicClient: () => receiptClient(deposit.l2.payout.chain, deposit.vectors.burn.receipt),
  clock: fakeClock()
});
const arcReads = (receipt: unknown = vectors.forward.receipt) => ({
  endpoints: ['https://rpc.quicknode.testnet.arc.io'],
  publicClient: () => receiptClient(ARC_TESTNET, receipt),
  clock: fakeClock()
});

/** The captured burn's MessageSent message, read through the gate itself. */
async function sentMessage(deposit: Captured = BASE): Promise<Hex> {
  const { l2, units, depositor } = deposit;
  const proof = await confirmL2Burn(submission({}, deposit), { l2, units, depositor }, burnReads(deposit));
  return proof.sentMessage;
}

/** The deposit as the key would have signed it: the captured burn's own hook data and fee. */
function submission(overrides: Partial<L2DepositSubmission> = {}, deposit: Captured = BASE): L2DepositSubmission {
  const { l2 } = deposit;
  const hookData = decodeCctpMessage(deposit.irisMessage).body.hookData;
  const quote = { signedQuote: hex('0x'), feeTotalAmount: deposit.fee };
  return {
    endpoint: l2.payout.rpcUrls[0] ?? '',
    burnHash: deposit.burnHash,
    signed: { amount: deposit.units, destinationCaller: addressToBytes32(l2.source.target.executor), hookData },
    quotes: [quote],
    burnQuote: quote,
    submitted: {
      usdcxRemoteRecipient: deposit.vectors.expected.remoteRecipient,
      cctp: { sourceDomain: l2.source.domain, forwarded: true, forwardFee: deposit.vectors.expected.fee }
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

  it.each(CAPTURED)("reads the %s message as Circle's own decoding of it reads", (_chain, deposit, domain) => {
    const circle = deposit.iris.decodedMessage;
    const body = circle.decodedMessageBody;
    const word = (address: string) => pad(hex(address.toLowerCase()));
    expect(decodeCctpMessage(deposit.irisMessage)).toEqual({
      version: 1,
      sourceDomain: domain,
      destinationDomain: Number(circle.destinationDomain),
      nonce: circle.nonce,
      sender: word(circle.sender),
      recipient: word(circle.recipient),
      destinationCaller: word(circle.destinationCaller),
      minFinalityThreshold: Number(circle.minFinalityThreshold),
      finalityThresholdExecuted: Number(circle.finalityThresholdExecuted),
      body: {
        version: 1,
        burnToken: word(body.burnToken),
        mintRecipient: word(body.mintRecipient),
        amount: BigInt(body.amount),
        messageSender: word(body.messageSender),
        maxFee: BigInt(body.maxFee),
        feeExecuted: BigInt(body.feeExecuted),
        expirationBlock: BigInt(body.expirationBlock),
        hookData: body.hookData.toLowerCase()
      }
    });
    expect(Number(circle.sourceDomain)).toBe(domain);
  });

  it('refuses a message shorter than a burn message', () => {
    expect(() => decodeCctpMessage('0x01')).toThrow('CCTP message length: 1 bytes');
  });
});

describe('confirmL2Burn', () => {
  it.each(CAPTURED)(
    'proves the captured %s burn: from the depositor to the fee entry point, one MessageSent as signed, the exact debit',
    async (_chain, deposit, domain) => {
      const { l2, units, depositor } = deposit;
      const proof = await confirmL2Burn(submission({}, deposit), { l2, units, depositor }, burnReads(deposit));
      expect({ debit: proof.debit, block: proof.blockNumber, sourceDomain: proof.fields.sourceDomain }).toEqual({
        debit: units + deposit.fee,
        block: BigInt(deposit.vectors.burn.receipt.blockNumber),
        sourceDomain: domain
      });
      expect(sameBurnMessage(proof.sentMessage, deposit.irisMessage)).toBe(true);
    }
  );

  it("names the source domain when a burn from another domain is checked against Ethereum Sepolia's 0", async () => {
    await expect(
      confirmL2Burn(submission(), { l2: SEPOLIA.l2, units: UNITS, depositor: DEPOSITOR }, burnReads())
    ).rejects.toThrow(/\n {2}sourceDomain: 6, expected 0\n/);
  });

  it('names hookData when one signed byte differs', async () => {
    const { signed } = submission();
    const flipped = hex(`${signed.hookData.slice(0, -2)}${signed.hookData.endsWith('00') ? '01' : '00'}`);
    await expect(
      confirmL2Burn(
        submission({ signed: { ...signed, hookData: flipped } }),
        { l2: L2, units: UNITS, depositor: DEPOSITOR },
        burnReads()
      )
    ).rejects.toThrow(/hookData: 0x/);
  });

  it('names the debit when Circle took other than the quoted fee', async () => {
    const quote = { signedQuote: hex('0x'), feeTotalAmount: FEE - 1n };
    await expect(
      confirmL2Burn(
        submission({ quotes: [quote], burnQuote: quote }),
        { l2: L2, units: UNITS, depositor: DEPOSITOR },
        burnReads()
      )
    ).rejects.toThrow(`USDC debit: ${UNITS + FEE}, expected ${UNITS + FEE - 1n}`);
  });

  it('names the sender when the key did not send the burn', async () => {
    await expect(
      confirmL2Burn(
        submission(),
        { l2: L2, units: UNITS, depositor: '0x4D4A180C637a71FCB9b5BD1186C8ce23C40EBa81' },
        burnReads()
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
  const args = async (deposit: Captured = BASE) => ({
    l2: deposit.l2,
    burnHash: deposit.burnHash,
    sentMessage: await sentMessage(deposit)
  });

  it.each(CAPTURED)(
    "reads the captured %s message through the wallet's own Iris parser, under its source domain",
    async (_chain, deposit, domain) => {
      const iris = jest.fn(async () => ({ ok: true, status: 200, json: async () => deposit.vectors.iris.body }));
      Object.defineProperty(globalThis, 'fetch', { value: iris, writable: true, configurable: true });
      const forward = await waitForIrisForward(await args(deposit), { timeoutMs: 60_000, clock: fakeClock() });
      expect(forward).toEqual({
        nonce: deposit.nonce,
        forwardTxHash: deposit.forwardHash,
        forwardState: 'COMPLETE',
        seenAtMs: 0
      });
      expect(iris).toHaveBeenCalledWith(
        `https://iris-api-sandbox.circle.com/v2/messages/${domain}?transactionHash=${deposit.burnHash}`,
        expect.anything()
      );
    }
  );

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

  it.each(CAPTURED)(
    "proves the captured %s forward executed this burn's nonce into xReserve for its recipient",
    async (_chain, deposit) => {
      const { l2, vectors: capture } = deposit;
      const proof = await confirmArcForward(
        deposit.forwardHash,
        {
          l2,
          nonce: deposit.nonce,
          units: deposit.units,
          remoteRecipient: hex(capture.expected.remoteRecipient),
          remoteToken: hex(capture.expected.remoteToken)
        },
        arcReads(capture.forward.receipt)
      );
      expect({
        block: proof.blockNumber,
        value: proof.deposit.value,
        depositor: proof.deposit.localDepositor.toLowerCase(),
        recipient: proof.deposit.remoteRecipient
      }).toEqual({
        block: BigInt(capture.forward.receipt.blockNumber),
        value: deposit.units,
        depositor: l2.source.target.handler.toLowerCase(),
        recipient: capture.expected.remoteRecipient
      });
    }
  );

  it("refuses the forward of a burn from another source domain than Ethereum Sepolia's 0", async () => {
    await expect(confirmArcForward(FORWARD_HASH, { ...expected, l2: SEPOLIA.l2 }, arcReads())).rejects.toThrow(
      'MessageReceived sourceDomain: 6, expected 0'
    );
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
