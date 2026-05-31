import { Address } from '@miden-sdk/miden-sdk/lazy';
import { BaseContract, BrowserProvider, ContractTransactionResponse, Overrides, parseUnits } from 'ethers';
import { EIP1193Provider } from 'viem';

import { AGGLAYER_BRIDGE_ABI, AGGLAYER_CONTRACT_ADDRESS, MIDEN_CHAIN_ID } from './constant';

// ethers can't derive per-method types from a runtime ABI, so the dynamic
// methods only exist on Contract via an index signature (and read as possibly
// `undefined` under noUncheckedIndexedAccess). Declare the methods we call.
interface AgglayerBridgeContract extends BaseContract {
  bridgeAsset(
    destinationNetwork: number,
    destinationAddress: string,
    amount: bigint,
    token: string,
    forceUpdateGlobalExitRoot: boolean,
    permitData: string,
    overrides?: Overrides
  ): Promise<ContractTransactionResponse>;
}

const ZERO_BYTE = '00';
//// @param: address always bech32
export const midenAddrToEvmAddr = (address: string): `0x${string}` => {
  const hexAddr = Address.fromBech32(address).accountId().toString();

  const strippedHexAddr = hexAddr.startsWith('0x') ? hexAddr.slice(2) : hexAddr;
  return ('0x' + ZERO_BYTE.repeat(4) + strippedHexAddr + ZERO_BYTE) as `0x${string}`;
};

interface BridgeParmas {
  toMidenAddress: string; // bech32 encoded miden address
  provider: EIP1193Provider;
  amount: string; // human-readable amount, e.g. "1.5"
  tokenAddr: string | 'native';
  decimals?: number;
  network: 'sepolia';
}

export const bridgeAgglayer = async ({
  toMidenAddress,
  tokenAddr = 'native',
  amount,
  provider,
  decimals = 18,
  network = 'sepolia'
}: BridgeParmas) => {
  const ethersProvider = new BrowserProvider(provider);
  const signer = await ethersProvider.getSigner();

  const midenEvmAddr = midenAddrToEvmAddr(toMidenAddress);
  const agglayerContract = BaseContract.from<AgglayerBridgeContract>(
    AGGLAYER_CONTRACT_ADDRESS.get(network)!,
    AGGLAYER_BRIDGE_ABI,
    signer
  );
  const amountInBaseUnits = parseUnits(amount, decimals);
  const token = tokenAddr === 'native' ? '0x0000000000000000000000000000000000000000' : tokenAddr;

  // Native ETH bridges are payable — the amount rides as msg.value.
  const overrides = tokenAddr === 'native' ? { value: amountInBaseUnits } : {};
  // Returns once broadcast (tx has a hash); caller tracks finalization via the
  // bridge indexer rather than blocking on the L1 receipt here.
  return agglayerContract.bridgeAsset(MIDEN_CHAIN_ID, midenEvmAddr, amountInBaseUnits, token, true, '0x', overrides);
};
