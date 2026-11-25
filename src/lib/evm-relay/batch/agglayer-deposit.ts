import { encodeFunctionData, parseAbi, zeroAddress, type Address } from 'viem';

import type { BatchCall } from './calibur';
import { ERC20_ABI } from './erc20';
import { midenAccountHexToEvmAddress } from './miden-account';

/** The Agglayer bridge of one EVM chain and the Agglayer network ID of Miden (not an EVM chain ID). */
export interface AgglayerDepositConfig {
  bridgeAddress: Address;
  /** A uint32. */
  midenNetworkId: number;
  forceUpdateGlobalExitRoot: boolean;
}

/** The fee that the batch pays to the relayer, in the deposited token. */
export interface RelayFee {
  recipient: Address;
  /** Base units. */
  amount: bigint;
}

export interface AgglayerDepositParams {
  /** The ERC-20 token. The zero address means the native coin. */
  token: Address;
  /** The amount that is bridged (after the fee), base units. */
  amount: bigint;
  /** The Miden account that receives the deposit: `0x` and 30 hex characters. */
  midenAccountHex: string;
  /** Null when the relayer sponsors the deposit. */
  fee: RelayFee | null;
}

export const BRIDGE_ASSET_ABI = parseAbi([
  'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) payable'
]);

/** True when the token is the native coin. */
export function isNativeToken(token: Address): boolean {
  return token.toLowerCase() === zeroAddress;
}

function checkParams(params: AgglayerDepositParams): void {
  if (params.amount <= 0n) throw new Error('The deposit amount must be greater than zero');
  if (params.fee === null) return;
  if (params.fee.amount <= 0n) throw new Error('The relay fee amount must be greater than zero');
  if (params.fee.recipient.toLowerCase() === zeroAddress) {
    throw new Error('The relay fee recipient must not be the zero address');
  }
}

/** The fee call: an ERC-20 transfer, or a value transfer of the native coin. */
function feeCall(token: Address, fee: RelayFee): BatchCall {
  if (isNativeToken(token)) return { to: fee.recipient, value: fee.amount, data: '0x' };
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [fee.recipient, fee.amount] })
  };
}

/**
 * The calls that bridge a deposit to the Miden account. The order is: the fee call (when there is a fee), the approve
 * of the bridge (ERC-20 only), the `bridgeAsset` call. A native deposit sends `amount` as the value of `bridgeAsset`.
 * Throws when a parameter is not valid.
 */
export function buildAgglayerDepositCalls(config: AgglayerDepositConfig, params: AgglayerDepositParams): BatchCall[] {
  checkParams(params);
  const native = isNativeToken(params.token);
  const token = native ? zeroAddress : params.token;
  const bridge: BatchCall = {
    to: config.bridgeAddress,
    value: native ? params.amount : 0n,
    data: encodeFunctionData({
      abi: BRIDGE_ASSET_ABI,
      functionName: 'bridgeAsset',
      args: [
        config.midenNetworkId,
        midenAccountHexToEvmAddress(params.midenAccountHex),
        params.amount,
        token,
        config.forceUpdateGlobalExitRoot,
        '0x'
      ]
    })
  };
  const calls: BatchCall[] = params.fee === null ? [] : [feeCall(token, params.fee)];
  if (!native) {
    calls.push({
      to: token,
      value: 0n,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [config.bridgeAddress, params.amount] })
    });
  }
  calls.push(bridge);
  return calls;
}
