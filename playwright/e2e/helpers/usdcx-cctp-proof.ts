/**
 * The chain evidence of a usdcx-in-l2 deposit, hop by hop: the source burn and its CCTP message, Circle's attestation
 * and forward on Iris, and the Arc transaction that executed the message into xReserve. Every gate keys on this run's
 * burn hash or CCTP nonce: another party sends deposits through the same executor, handler and xReserve every few
 * minutes.
 */
import {
  hexToBigInt,
  hexToNumber,
  isAddressEqual,
  isHex,
  pad,
  parseAbi,
  parseEventLogs,
  size,
  slice,
  type Address,
  type Hash,
  type Hex
} from 'viem';

import {
  depositedToRemoteOf,
  errorText,
  startingAt,
  waitForReceipt,
  type ArcReadDeps,
  type DepositedToRemoteEvent
} from './arc-usdcx';
import { realArcClock, USDCX_REMOTE_DOMAIN, type ArcClock, type L2BridgeInSource } from './usdcx-constants';
import { fetchCctpMessages, isCctpForwardFailed, type CctpMessage } from '../../../src/lib/usdcx/cctp';
import { addressToBytes32 } from '../../../src/lib/usdcx/executor';
import { GENERIC_EXECUTOR_ABI } from '../../../src/lib/usdcx/protocol';

const CCTP_EVENTS = parseAbi([
  'event MessageSent(bytes message)',
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
]);
/** The CCTP V2 threshold a PRE_FINALITY quote buys, so Circle attests before source finality. */
const CCTP_FAST_FINALITY_THRESHOLD = 1000;
const HEADER_BYTES = 148;
const BURN_BODY_BYTES = 228;
/** What Circle fills in after the burn: the nonce, the threshold it attested at, the fee taken and the expiry block. */
const IRIS_FILLED: ReadonlyArray<readonly [number, number]> = [
  [12, 44],
  [144, 148],
  [HEADER_BYTES + 164, HEADER_BYTES + 196],
  [HEADER_BYTES + 196, HEADER_BYTES + 228]
];

function lower(value: string): Hex {
  const lowered = value.toLowerCase();
  if (!isHex(lowered)) throw new Error(`${value} is not hex`);
  return lowered;
}

export interface CctpMessageFields {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: {
    version: number;
    burnToken: Hex;
    mintRecipient: Hex;
    amount: bigint;
    messageSender: Hex;
    maxFee: bigint;
    feeExecuted: bigint;
    expirationBlock: bigint;
    hookData: Hex;
  };
}

/** A CCTP V2 message with a burn body: a 148-byte header, a 228-byte burn header, then the hook data. */
export function decodeCctpMessage(message: Hex): CctpMessageFields {
  const bytes = size(message);
  if (bytes < HEADER_BYTES + BURN_BODY_BYTES) {
    throw new Error(
      `CCTP message length: ${bytes} bytes, below the ${HEADER_BYTES + BURN_BODY_BYTES}-byte burn message`
    );
  }
  const at = (offset: number, length: number): Hex => lower(slice(message, offset, offset + length));
  const body = (offset: number, length: number): Hex => at(HEADER_BYTES + offset, length);
  return {
    version: hexToNumber(at(0, 4)),
    sourceDomain: hexToNumber(at(4, 4)),
    destinationDomain: hexToNumber(at(8, 4)),
    nonce: at(12, 32),
    sender: at(44, 32),
    recipient: at(76, 32),
    destinationCaller: at(108, 32),
    minFinalityThreshold: hexToNumber(at(140, 4)),
    finalityThresholdExecuted: hexToNumber(at(144, 4)),
    body: {
      version: hexToNumber(body(0, 4)),
      burnToken: body(4, 32),
      mintRecipient: body(36, 32),
      amount: hexToBigInt(body(68, 32)),
      messageSender: body(100, 32),
      maxFee: hexToBigInt(body(132, 32)),
      feeExecuted: hexToBigInt(body(164, 32)),
      expirationBlock: hexToBigInt(body(196, 32)),
      hookData: bytes === HEADER_BYTES + BURN_BODY_BYTES ? '0x' : lower(slice(message, HEADER_BYTES + BURN_BODY_BYTES))
    }
  };
}

/** Whether Iris's `attested` message is the burn's `sent` one, apart from the bytes Circle fills in after the burn. */
export function sameBurnMessage(sent: Hex, attested: Hex): boolean {
  if (size(sent) !== size(attested)) return false;
  const masked = (message: Hex): string =>
    IRIS_FILLED.reduce(
      (text, [from, to]) => `${text.slice(0, from * 2)}${'0'.repeat((to - from) * 2)}${text.slice(to * 2)}`,
      message.toLowerCase().slice(2)
    );
  return masked(sent) === masked(attested);
}

/** What confirmL2Burn reads of a deposit: the endpoint that took it, the burn, its hook data and the fee it paid. */
export interface L2BurnSubmission {
  endpoint: string;
  burnHash: Hash;
  signed: { hookData: Hex };
  burnQuote: { feeTotalAmount: bigint };
}

export interface L2BurnProof {
  sentMessage: Hex;
  fields: CctpMessageFields;
  /** The source USDC that left the depositor in the burn: the amount plus Circle's fee. */
  debit: bigint;
  blockNumber: bigint;
}

/**
 * The burn's receipt, read from its write endpoint first: from the key to the fee entry point, exactly one MessageSent
 * whose message carries what the key signed (domains, the executor as caller and mint recipient, the fast threshold,
 * the amount and the hook data byte for byte), and a USDC debit of exactly the amount plus the quoted fee.
 */
export async function confirmL2Burn(
  submission: L2BurnSubmission,
  expected: { l2: L2BridgeInSource; units: bigint; depositor: Address },
  reads: ArcReadDeps
): Promise<L2BurnProof> {
  const { source, payout } = expected.l2;
  const where = `burn ${submission.burnHash} on ${payout.label}`;
  const receipt = await waitForReceipt(startingAt(reads.endpoints, submission.endpoint), reads, submission.burnHash);
  const sent = parseEventLogs({ abi: CCTP_EVENTS, eventName: 'MessageSent', logs: receipt.logs });
  const [only] = sent;
  if (!only || sent.length !== 1) throw new Error(`${where}: ${sent.length} MessageSent logs, expected 1`);
  const fields = decodeCctpMessage(only.args.message);
  const debit = parseEventLogs({ abi: CCTP_EVENTS, eventName: 'Transfer', logs: receipt.logs })
    .filter(log => isAddressEqual(log.address, source.usdc) && isAddressEqual(log.args.from, expected.depositor))
    .reduce((sum, log) => sum + log.args.value, 0n);
  const executor = lower(addressToBytes32(source.target.executor));
  const checks: ReadonlyArray<readonly [string, string | number | bigint, string | number | bigint]> = [
    ['from', receipt.from.toLowerCase(), expected.depositor.toLowerCase()],
    ['to', (receipt.to ?? 'none').toLowerCase(), source.tokenMessengerWithFees.toLowerCase()],
    ['message version', fields.version, 1],
    ['sourceDomain', fields.sourceDomain, source.domain],
    ['destinationDomain', fields.destinationDomain, source.target.domain],
    ['destinationCaller', fields.destinationCaller, executor],
    ['minFinalityThreshold', fields.minFinalityThreshold, CCTP_FAST_FINALITY_THRESHOLD],
    ['burnToken', fields.body.burnToken, lower(pad(source.usdc))],
    ['mintRecipient', fields.body.mintRecipient, executor],
    ['amount', fields.body.amount, expected.units],
    ['hookData', fields.body.hookData, lower(submission.signed.hookData)],
    ['USDC debit', debit, expected.units + submission.burnQuote.feeTotalAmount]
  ];
  const problems = checks
    .filter(([, actual, wanted]) => actual !== wanted)
    .map(([field, actual, wanted]) => `${field}: ${actual}, expected ${wanted}`);
  if (problems.length > 0) {
    throw new Error(`the forwarded ${where} differs from what the key signed:\n  ${problems.join('\n  ')}`);
  }
  return { sentMessage: only.args.message, fields, debit, blockNumber: receipt.blockNumber };
}

export interface IrisForward {
  nonce: Hex;
  /** The Arc transaction Circle's forwarder sent: the execute the wallet adopts and xReserve's attestation keys on. */
  forwardTxHash: Hash;
  forwardState?: string;
  /** When the harness first read the message attested and forwarded. */
  seenAtMs: number;
}

/**
 * Polls Iris through the wallet's own parser (fetchCctpMessages) until it lists exactly one message for the burn,
 * attested, with a forward transaction: the message must be the burn's MessageSent apart from the bytes Circle fills
 * in, and the nonce Iris names must be the message's. A forward Circle gave up on fails at once: the wallet would offer
 * Execute on Arc, which the harness never does, since an Arc spend from the key could land in an Arc payout window.
 */
export async function waitForIrisForward(
  args: { l2: L2BridgeInSource; burnHash: Hash; sentMessage: Hex },
  opts: { timeoutMs: number; pollMs?: number; clock?: ArcClock; fetchMessages?: typeof fetchCctpMessages }
): Promise<IrisForward> {
  const clock = opts.clock ?? realArcClock;
  const fetchMessages = opts.fetchMessages ?? fetchCctpMessages;
  const { source } = args.l2;
  const where = `burn ${args.burnHash} on ${args.l2.payout.label}`;
  const deadline = clock.now() + opts.timeoutMs;
  let last = 'Iris listed no message (it answers 404 until it has indexed the burn)';
  for (;;) {
    let messages: CctpMessage[] | undefined;
    try {
      messages = await fetchMessages(source.domain, args.burnHash, { baseUrl: source.irisApi });
    } catch (error) {
      last = `Iris failed: ${errorText(error)}`;
    }
    if (messages !== undefined && messages.length > 1) {
      throw new Error(`Iris lists ${messages.length} messages for ${where}, expected 1`);
    }
    const entry = messages?.[0];
    if (entry !== undefined) {
      last =
        `status ${entry.status}, attestation ${entry.attestation === 'PENDING' ? 'pending' : 'signed'}, ` +
        `forwardState ${entry.forwardState ?? 'none'}, forwardTxHash ${entry.forwardTxHash ?? 'none'}`;
      if (isCctpForwardFailed(entry.forwardState)) {
        throw new Error(
          `Circle gave up forwarding ${where} (forwardState ${entry.forwardState}): the wallet would offer Execute ` +
            'on Arc, which the harness never does, since an Arc spend from the key could land in an Arc payout window'
        );
      }
      if (entry.status === 'complete' && entry.attestation !== 'PENDING' && entry.forwardTxHash !== undefined) {
        if (!sameBurnMessage(args.sentMessage, entry.message)) {
          throw new Error(`Iris attested a message for ${where} that differs from the burn's MessageSent`);
        }
        const { nonce } = decodeCctpMessage(entry.message);
        if (entry.eventNonce?.toLowerCase() !== nonce) {
          throw new Error(
            `Iris names nonce ${entry.eventNonce ?? 'none'} for ${where}, but its message carries ${nonce}`
          );
        }
        return { nonce, forwardTxHash: entry.forwardTxHash, forwardState: entry.forwardState, seenAtMs: clock.now() };
      }
    }
    if (clock.now() >= deadline) {
      throw new Error(
        `Circle has not attested and forwarded ${where} within ${opts.timeoutMs} ms: ${last}. A fast transfer ` +
          'forwarded 8-10 s after its burn when probed on 2026-10-16; the wallet tells users about 2 min'
      );
    }
    await clock.sleep(opts.pollMs ?? 3_000);
  }
}

export interface ArcForwardProof {
  blockNumber: bigint;
  deposit: DepositedToRemoteEvent;
}

/**
 * The Arc forward's receipt: exactly one MessageReceived of this burn's nonce from its source domain, called by the
 * executor; exactly one Executed by the executor through the DepositFor handler for the whole amount of Arc USDC and
 * this nonce; and exactly one xReserve DepositedToRemote of the amount, from the handler, to this Miden recipient and
 * token.
 */
export async function confirmArcForward(
  forwardTxHash: Hash,
  expected: { l2: L2BridgeInSource; nonce: Hex; units: bigint; remoteRecipient: Hex; remoteToken: Hex },
  arc: ArcReadDeps
): Promise<ArcForwardProof> {
  const { source } = expected.l2;
  const { target } = source;
  const where = `Arc forward ${forwardTxHash}`;
  const receipt = await waitForReceipt(arc.endpoints, arc, forwardTxHash);
  const problems: string[] = [];
  const received = parseEventLogs({ abi: CCTP_EVENTS, eventName: 'MessageReceived', logs: receipt.logs }).filter(
    log => log.args.nonce.toLowerCase() === expected.nonce
  );
  const [message] = received;
  if (!message || received.length !== 1) {
    problems.push(`${received.length} MessageReceived for nonce ${expected.nonce}, expected 1`);
  } else {
    if (message.args.sourceDomain !== source.domain) {
      problems.push(`MessageReceived sourceDomain: ${message.args.sourceDomain}, expected ${source.domain}`);
    }
    if (!isAddressEqual(message.args.caller, target.executor)) {
      problems.push(`MessageReceived caller: ${message.args.caller}, expected the executor ${target.executor}`);
    }
  }
  const executed = parseEventLogs({ abi: GENERIC_EXECUTOR_ABI, eventName: 'Executed', logs: receipt.logs }).filter(
    log => isAddressEqual(log.address, target.executor)
  );
  const [execution] = executed;
  if (!execution || executed.length !== 1) {
    problems.push(`${executed.length} Executed by the executor, expected 1`);
  } else {
    if (!isAddressEqual(execution.args.handler, target.handler)) {
      problems.push(`Executed handler: ${execution.args.handler}, expected ${target.handler}`);
    }
    if (!isAddressEqual(execution.args.token, target.usdc)) {
      problems.push(`Executed token: ${execution.args.token}, expected ${target.usdc}`);
    }
    if (execution.args.amount !== expected.units) {
      problems.push(`Executed amount: ${execution.args.amount}, expected ${expected.units}`);
    }
    if (execution.args.nonce.toLowerCase() !== expected.nonce) {
      problems.push(`Executed nonce: ${execution.args.nonce}, expected ${expected.nonce}`);
    }
  }
  const deposit = depositedToRemoteOf(receipt, where);
  const checks: ReadonlyArray<readonly [string, string | number | bigint, string | number | bigint]> = [
    ['value', deposit.value, expected.units],
    ['localDepositor', deposit.localDepositor.toLowerCase(), target.handler.toLowerCase()],
    ['remoteRecipient', deposit.remoteRecipient, expected.remoteRecipient.toLowerCase()],
    ['remoteDomain', deposit.remoteDomain, USDCX_REMOTE_DOMAIN],
    ['remoteToken', deposit.remoteToken, expected.remoteToken.toLowerCase()],
    ['maxFee', deposit.maxFee, 0n],
    ['hookData', deposit.hookData, '0x']
  ];
  for (const [field, actual, wanted] of checks) {
    if (actual !== wanted) problems.push(`${field}: ${actual}, expected ${wanted}`);
  }
  if (problems.length > 0) {
    throw new Error(`${where} does not execute this burn into xReserve as signed:\n  ${problems.join('\n  ')}`);
  }
  return { blockNumber: receipt.blockNumber, deposit };
}
