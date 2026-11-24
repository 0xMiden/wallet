/**
 * What the wallet asked a counterparty to sign for one executor-route deposit through its own deposit screen, checked
 * against what runUsdcxExecutorDeposit (usdcx/executor.ts) must ask: transactions only, on the source chain and from
 * the key; at most one approve, of the fee entry point, for the amount plus twice a quoted fee and only when the
 * allowance was short; and exactly one forwarded burn after it, every argument but Circle's signed quote rebuilt here
 * with the product's own builder. The quote is opaque, so the fee is the one the wallet wrote on its row with the burn.
 */
import {
  decodeFunctionData,
  formatUnits,
  isAddressEqual,
  isHash,
  isHex,
  type Address,
  type Hash,
  type Hex
} from 'viem';

import { ERC20_ABI } from './arc-usdcx';
import type { L2BridgeInSource } from './usdcx-constants';
import { buildExecutorBurnIntent } from '../../../src/lib/usdcx/executor';
import { CIRCLE_USDC_DECIMALS, TOKEN_MESSENGER_WITH_FEES_ABI } from '../../../src/lib/usdcx/protocol';

/** One request a counterparty answered, as its WcRequestLog records it. */
export interface SignedRequest {
  method: string;
  chainId?: string;
  params: unknown;
  result?: unknown;
  error?: string;
}

export interface ExecutorDepositExpectation {
  l2: L2BridgeInSource;
  units: bigint;
  /** The xReserve recipient the burn's hook must carry: the Miden account as bytes32. */
  recipient: Hex;
  depositor: Address;
  /** The fee the burn paid, as the wallet recorded it with the burn (`cctp.forwardFee`). */
  recordedFee: bigint;
  /** The key's allowance to the fee entry point, read before the deposit. */
  allowanceBefore: bigint;
}

export interface ExecutorDepositRequests {
  approve?: { hash: Hash; value: bigint };
  burn: { hash: Hash; hookData: Hex };
}

function firstParam(params: unknown): Record<string, unknown> {
  const [tx] = Array.isArray(params) ? params : [];
  return tx !== null && typeof tx === 'object' ? Object.fromEntries(Object.entries(tx)) : {};
}

const sameAddress = (value: unknown, address: Address): boolean =>
  typeof value === 'string' && isHex(value) && value.length === 42 && isAddressEqual(value, address);

function decodeOr<T>(decode: () => T): T | undefined {
  try {
    return decode();
  } catch {
    return undefined;
  }
}

export function executorDepositRequests(
  requests: readonly SignedRequest[],
  expected: ExecutorDepositExpectation
): ExecutorDepositRequests {
  const { source, payout } = expected.l2;
  const chainId = `eip155:${payout.chainId}`;
  const intent = buildExecutorBurnIntent(
    formatUnits(expected.units, CIRCLE_USDC_DECIMALS),
    source,
    expected.recipient,
    expected.depositor
  );
  const problems: string[] = [];
  const approves: Array<{ index: number; hash: Hash; value: bigint }> = [];
  const burns: Array<{ index: number; hash: Hash }> = [];
  for (const [index, request] of requests.entries()) {
    const where = `request ${index + 1} (${request.method} on ${request.chainId ?? 'no chain'})`;
    if (request.method !== 'eth_sendTransaction') {
      problems.push(`${where}: the deposit asks for transactions only`);
      continue;
    }
    if (request.chainId !== chainId) problems.push(`${where}: not on ${chainId}`);
    if (request.error !== undefined) problems.push(`${where}: answered with an error: ${request.error}`);
    const hash = request.result;
    if (typeof hash !== 'string' || !isHash(hash)) {
      problems.push(`${where}: returned no transaction hash`);
      continue;
    }
    const tx = firstParam(request.params);
    if (!sameAddress(tx.from, expected.depositor)) {
      problems.push(`${where}: from ${String(tx.from)}, not ${expected.depositor}`);
    }
    if (tx.value !== undefined && !(isHex(tx.value) && BigInt(tx.value) === 0n)) {
      problems.push(`${where}: carries value ${String(tx.value)}`);
    }
    const data = isHex(tx.data) ? tx.data : '0x';
    if (sameAddress(tx.to, source.usdc)) {
      const call = decodeOr(() => decodeFunctionData({ abi: ERC20_ABI, data }));
      if (call?.functionName !== 'approve') {
        problems.push(`${where}: calls the source USDC with something other than approve`);
        continue;
      }
      const [spender, value] = call.args;
      if (!isAddressEqual(spender, source.tokenMessengerWithFees)) {
        problems.push(`${where}: approves ${spender}, not the fee entry point ${source.tokenMessengerWithFees}`);
      }
      approves.push({ index, hash, value });
    } else if (sameAddress(tx.to, source.tokenMessengerWithFees)) {
      const call = decodeOr(() => decodeFunctionData({ abi: TOKEN_MESSENGER_WITH_FEES_ABI, data }));
      if (call?.functionName !== 'depositForBurnWithHookAndFees') {
        problems.push(`${where}: calls the fee entry point with something other than depositForBurnWithHookAndFees`);
        continue;
      }
      const [amount, destinationDomain, mintRecipient, burnToken, destinationCaller, hookData, claim] = call.args;
      // Decoding lowercases bytes32 and bytes, while addressToBytes32 keeps the checksum's case.
      const checks: ReadonlyArray<readonly [string, string | number | bigint, string | number | bigint]> = [
        ['amount', amount, expected.units],
        ['destinationDomain', destinationDomain, source.target.domain],
        ['mintRecipient', mintRecipient.toLowerCase(), intent.destinationCaller.toLowerCase()],
        ['burnToken', burnToken.toLowerCase(), source.usdc.toLowerCase()],
        ['destinationCaller', destinationCaller.toLowerCase(), intent.destinationCaller.toLowerCase()],
        ['hookData', hookData.toLowerCase(), intent.hookData.toLowerCase()],
        ['refundAddress', claim.refundAddress.toLowerCase(), expected.depositor.toLowerCase()]
      ];
      for (const [field, actual, wanted] of checks) {
        if (actual !== wanted) problems.push(`${where}: ${field} ${actual}, expected ${wanted}`);
      }
      burns.push({ index, hash });
    } else {
      problems.push(`${where}: to ${String(tx.to)}, neither the source USDC nor the fee entry point`);
    }
  }
  const [burn, ...extraBurns] = burns;
  if (!burn || extraBurns.length > 0) problems.push(`${burns.length} forwarded burns, expected exactly 1`);
  const [approve, ...extraApproves] = approves;
  if (extraApproves.length > 0) problems.push(`${approves.length} approves, expected at most 1`);
  if (approve && burn && approve.index > burn.index) problems.push('the approve came after the burn');
  if (approve) {
    const twiceFee = approve.value - expected.units;
    if (twiceFee <= 0n || twiceFee % 2n !== 0n) {
      problems.push(`the approve of ${approve.value} is not the amount ${expected.units} plus twice a quoted fee`);
    } else if (expected.allowanceBefore >= expected.units + twiceFee / 2n) {
      problems.push(
        `an approve, though the allowance before the deposit, ${expected.allowanceBefore}, covered the amount and ` +
          `the first fee ${twiceFee / 2n}`
      );
    }
    if (expected.units + expected.recordedFee > approve.value) {
      problems.push(`the burn's fee ${expected.recordedFee} is more than the approve of ${approve.value} covers`);
    }
  } else if (expected.allowanceBefore < expected.units + expected.recordedFee) {
    problems.push(
      `no approve, but the allowance before the deposit, ${expected.allowanceBefore}, does not cover the amount ` +
        `and the fee ${expected.recordedFee}`
    );
  }
  if (problems.length > 0 || !burn) {
    throw new Error(`the requests to the key differ from runUsdcxExecutorDeposit's:\n  ${problems.join('\n  ')}`);
  }
  return {
    ...(approve ? { approve: { hash: approve.hash, value: approve.value } } : {}),
    burn: { hash: burn.hash, hookData: intent.hookData }
  };
}
