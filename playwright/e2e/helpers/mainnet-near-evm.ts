import type { Address, Hash, Hex } from 'viem';
import type { MainnetNearCheckpoint } from './mainnet-near-checkpoint';

export interface MainnetNearEvmEnvelope {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
export async function inspectMainnetNearSignedTransfer(
  _state: MainnetNearCheckpoint, _envelope: MainnetNearEvmEnvelope, _raw: Hex
): Promise<Hash> {
  throw new Error('Actual native NEAR signed ERC20 transfer inspection is not implemented');
}
