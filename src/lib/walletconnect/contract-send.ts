import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, Hash } from 'viem';
import { encodeFunctionData, isHash, toHex } from 'viem';

import { walletRaised } from 'lib/telemetry/bridge-receive-failure';

import { readNativeFeeFields } from './fees';
import { NativeReown, unwrapNativeResult } from './native';

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
    value?: bigint;
  }) => Promise<Hash>;
  chainId: number;
  from?: Address;
  address: Address;
  abi: TAbi;
  functionName: TFunctionName;
  args: ContractFunctionArgs<TAbi, 'nonpayable' | 'payable', TFunctionName>;
  value?: bigint;
  /** Runs after pre-send fee reads succeed and right before invoking the signer. */
  beforeSend?: () => Promise<void>;
}

/**
 * Encodes and dispatches an EVM contract transaction over either NativeReown (adding EIP-1559 fee
 * headroom) or wagmi's writeContract, validating that the wallet returns a transaction hash.
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
  value,
  beforeSend
}: SendEvmContractTransactionOptions<TAbi, TFunctionName>): Promise<Hash> {
  let hash: unknown;
  if (nativeReownAvailable) {
    const feeFields = await readNativeFeeFields(chainId);
    await beforeSend?.();
    const data = encodeFunctionData({
      abi: abi as Abi,
      functionName: functionName as string,
      args: args as readonly unknown[]
    });
    const result = await NativeReown.sendTransaction({
      chainId,
      ...(from !== undefined ? { from } : {}),
      to: address,
      value: toHex(value ?? 0n),
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
      args,
      ...(value !== undefined ? { value } : {})
    });
  }
  if (!isHash(hash)) {
    throw walletRaised(new Error('The wallet returned no transaction hash.'));
  }
  return hash;
}
