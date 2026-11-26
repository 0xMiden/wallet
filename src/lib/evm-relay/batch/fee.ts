import { decodeFunctionData, encodeFunctionData, erc20Abi, zeroAddress, type Address } from 'viem';

import type { BatchCall } from './calibur';

/** A fee that a batch pays to the relayer. The zero `token` is the native coin. `amount` is in base units. */
export interface RelayFee {
  token: Address;
  recipient: Address;
  amount: bigint;
}

/** True for the zero address, which means the native coin. */
export function isNativeToken(token: Address): boolean {
  return token.toLowerCase() === zeroAddress;
}

/**
 * The call that pays the fee. In `deduct` mode it is the LAST call of the batch.
 * - ERC-20: `transfer(recipient, amount)` on the token, with no value.
 * - Native coin: a plain transfer of `amount` to the recipient, with no data.
 */
export function buildFeeCall(fee: RelayFee): BatchCall {
  if (fee.amount <= 0n) throw new Error('The fee amount must be above 0');
  if (isNativeToken(fee.recipient)) throw new Error('The fee recipient must not be the zero address');
  if (isNativeToken(fee.token)) return { to: fee.recipient, value: fee.amount, data: '0x' };
  return {
    to: fee.token,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [fee.recipient, fee.amount] })
  };
}

/** The fee that a call pays, or null when the call is not a fee call of the shapes that `buildFeeCall` gives. */
export function readFeeCall(call: BatchCall): RelayFee | null {
  if (call.data === '0x') {
    return call.value > 0n ? { token: zeroAddress, recipient: call.to, amount: call.value } : null;
  }
  if (call.value !== 0n) return null;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    if (decoded.functionName !== 'transfer') return null;
    const [recipient, amount] = decoded.args;
    return { token: call.to, recipient, amount };
  } catch {
    // The data is not an ERC-20 call.
    return null;
  }
}
