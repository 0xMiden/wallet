import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, Hash } from 'viem';
import { encodeFunctionData, isHash, toHex } from 'viem';

import { walletRaised } from 'lib/telemetry/bridge-receive-failure';

import { readNativeFeeFields } from './fees';
import { NativeReown, unwrapNativeResult } from './native';

/**
 * Options for encoding and dispatching an EVM contract call over NativeReown or wagmi.
 *
 * Always sends zero native value (`0n`), including when invoking `payable` ABI functions such as
 * `depositForBurnWithHookAndFees`; no `value` option is exposed because all callers are zero-value.
 */
export interface SendEvmContractTransactionOptions<
  TAbi extends Abi | readonly unknown[],
  TFunctionName extends ContractFunctionName<TAbi, 'nonpayable' | 'payable'>
> {
  nativeReownAvailable: boolean;
  writeContract: (variables: {
    chainId: number;
    abi: TAbi;
    address: Address;
    functionName: TFunctionName;
    args: ContractFunctionArgs<TAbi, 'nonpayable' | 'payable', TFunctionName>;
  }) => Promise<Hash>;
  chainId: number;
  from?: string;
  address: Address;
  abi: TAbi;
  functionName: TFunctionName;
  args: ContractFunctionArgs<TAbi, 'nonpayable' | 'payable', TFunctionName>;
  /**
   * Runs after calldata encoding and applicable pre-send fee reads succeed, right before invoking
   * the signer.
   */
  beforeSend?: () => Promise<void>;
}

/**
 * Encodes and dispatches an EVM contract transaction over either NativeReown (sending `value: '0x0'`
 * with EIP-1559 fee headroom) or wagmi's writeContract (omitting `value`, defaulting to `0n`),
 * including for `payable` ABI functions invoked with zero value, and validates that the wallet
 * returns a transaction hash. Calldata is encoded upfront on both transports before fee reads or
 * `beforeSend`.
 */
export async function sendEvmContractTransaction<
  const TAbi extends Abi | readonly unknown[],
  TFunctionName extends ContractFunctionName<TAbi, 'nonpayable' | 'payable'>
>({
  nativeReownAvailable,
  writeContract,
  chainId,
  from,
  address,
  abi,
  functionName,
  args,
  beforeSend
}: SendEvmContractTransactionOptions<TAbi, TFunctionName>): Promise<Hash> {
  // Encode upfront across both transports so ABI errors throw before fee reads or beforeSend.
  const data = encodeFunctionData({
    abi: abi as Abi,
    functionName: functionName as string,
    args: args as readonly unknown[]
  });
  let hash: unknown;
  if (nativeReownAvailable) {
    const feeFields = await readNativeFeeFields(chainId);
    await beforeSend?.();
    const result = await NativeReown.sendTransaction({
      chainId,
      ...(from !== undefined ? { from } : {}),
      to: address,
      value: toHex(0n),
      data,
      ...feeFields
    });
    hash = unwrapNativeResult(result.hash);
  } else {
    await beforeSend?.();
    hash = await writeContract({
      chainId,
      abi,
      address,
      functionName,
      args
    });
  }
  if (typeof hash !== 'string' || !isHash(hash)) {
    throw walletRaised(new Error('The wallet returned no transaction hash.'));
  }
  return hash;
}
