// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/{cctp-message,cctp-status,arc-status-server}.ts (MIT).
import { isHex, padHex, parseAbi, parseEventLogs, size, slice, type Address, type Hex, type TransactionReceipt } from 'viem';

import type { UsdcxExecutorSource } from 'lib/usdcx/constant';

const messageAbi = parseAbi(['event MessageSent(bytes message)']);
const executionAbi = parseAbi(['event Executed(bytes4 indexed transport,uint8 version,address indexed handler,address indexed token,uint256 amount,bytes32 nonce)']);
const depositAbi = parseAbi(['event DepositedToRemote(address indexed localToken,uint256 value,address indexed localDepositor,bytes32 indexed remoteRecipient,uint32 remoteDomain,bytes32 remoteToken,uint256 maxFee,bytes hookData)']);
export type CctpReceipt = Pick<TransactionReceipt, 'status' | 'transactionHash' | 'logs'>;

export function decodeCctpMessage(message: Hex) {
  if (!isHex(message) || message.length % 2 !== 0 || size(message) <= 376) throw new Error('Unsupported Circle message');
  const bytes: Hex = `0x${message.slice(2).toLowerCase()}`;
  const field = (offset: number, length: number) => slice(bytes, offset, offset + length);
  const uint = (offset: number, length: number) => BigInt(field(offset, length));
  return {
    transfer: {
      version: Number(uint(0, 4)), sourceDomain: Number(uint(4, 4)), destinationDomain: Number(uint(8, 4)),
      sender: field(44, 32), recipient: field(76, 32), destinationCaller: field(108, 32),
      minFinalityThreshold: Number(uint(140, 4)), burnVersion: Number(uint(148, 4)),
      burnToken: field(152, 32), mintRecipient: field(184, 32), amount: uint(216, 32),
      messageSender: field(248, 32), maxFee: uint(280, 32), hookData: slice(bytes, 376)
    },
    nonce: field(12, 32), finalityThresholdExecuted: Number(uint(144, 4)),
    feeExecuted: uint(312, 32), expirationBlock: uint(344, 32)
  };
}

/** Source MessageSent uses EMPTY_NONCE; Circle fills it and three execution fields during attestation. */
export function matchesCctpSourceMessage(original: Hex, candidate: Hex): boolean {
  try {
    const source = decodeCctpMessage(original);
    const actual: Record<string, unknown> = decodeCctpMessage(candidate).transfer;
    return Object.entries(source.transfer).every(([key, expected]) => actual[key] === expected);
  } catch { return false; }
}

export function assertCctpSourceMessage(raw: Hex, source: UsdcxExecutorSource, amount: bigint, hook: Hex): void {
  const { transfer } = decodeCctpMessage(raw);
  const padded = (address: Address) => padHex(address, { size: 32 }).toLowerCase();
  if (!source.tokenMessenger || transfer.version !== 1 || transfer.burnVersion !== 1 ||
      transfer.sourceDomain !== source.domain || transfer.destinationDomain !== source.target.domain ||
      transfer.sender !== padded(source.tokenMessenger) || transfer.destinationCaller !== padded(source.target.executor) ||
      transfer.burnToken !== padded(source.usdc) || transfer.mintRecipient !== padded(source.target.executor) ||
      transfer.amount !== amount || transfer.hookData !== hook.toLowerCase())
    throw new Error('Circle source message does not match the original burn');
}

export function sourceMessageFromReceipt(receipt: CctpReceipt, hash: Hex, transmitter: Address): Hex {
  if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== hash.toLowerCase())
    throw new Error('Circle source receipt does not match the original burn');
  const messages = parseEventLogs({ abi: messageAbi, eventName: 'MessageSent',
    logs: receipt.logs.filter(log => log.address.toLowerCase() === transmitter.toLowerCase()) });
  if (messages.length !== 1) throw new Error('Circle source receipt has no unique message');
  return `0x${messages[0].args.message.slice(2).toLowerCase()}`;
}

export function assertCctpArcReceipt(
  receipt: CctpReceipt, hash: Hex, source: UsdcxExecutorSource, original: Hex, attested: Hex,
  expected: { amount: bigint; recipient: Hex; token: Hex }
): void {
  if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
      !matchesCctpSourceMessage(original, attested)) throw new Error('Circle execution does not match the original source');
  const message = decodeCctpMessage(attested);
  const { target } = source;
  const executions = parseEventLogs({ abi: executionAbi, eventName: 'Executed',
    logs: receipt.logs.filter(log => log.address.toLowerCase() === target.executor.toLowerCase())
  }).filter(({ args }) => args.version === 1 && args.handler.toLowerCase() === target.handler.toLowerCase() &&
    args.token.toLowerCase() === target.usdc.toLowerCase() && args.amount === expected.amount && args.nonce.toLowerCase() === message.nonce);
  const deposits = parseEventLogs({ abi: depositAbi, eventName: 'DepositedToRemote',
    logs: receipt.logs.filter(log => log.address.toLowerCase() === target.xReserve.toLowerCase())
  }).filter(({ args }) => args.localToken.toLowerCase() === target.usdc.toLowerCase() &&
    args.localDepositor.toLowerCase() === target.handler.toLowerCase() && args.value === expected.amount &&
    args.remoteDomain === target.midenDomain && args.remoteToken.toLowerCase() === expected.token.toLowerCase() &&
    args.remoteRecipient.toLowerCase() === expected.recipient.toLowerCase() && args.maxFee === 0n && args.hookData === '0x');
  if (executions.length !== 1 || deposits.length !== 1) throw new Error('Circle execution or deposit proof is not unique');
}
