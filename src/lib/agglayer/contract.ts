import { BaseContract, BrowserProvider, ContractTransactionResponse, Overrides } from 'ethers';
import { EIP1193Provider } from 'viem';

import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { getAgglayerL1Bridge } from 'lib/remote-config/values';

import { AGGLAYER_BRIDGE_ABI } from './constant';
import { AgglayerDeposit, fetchMerkleProof } from './status';

// ethers can't derive per-method types from a runtime ABI, so the dynamic
// methods only exist on Contract via an index signature (and read as possibly
// `undefined` under noUncheckedIndexedAccess). Declare the methods we call.
interface AgglayerBridgeContract extends BaseContract {
  claimAsset(
    smtProofLocalExitRoot: string[],
    smtProofRollupExitRoot: string[],
    globalIndex: bigint,
    mainnetExitRoot: string,
    rollupExitRoot: string,
    originNetwork: number,
    originAddress: string,
    destinationNetwork: number,
    destinationAddress: string,
    amount: bigint,
    metadata: string,
    overrides?: Overrides
  ): Promise<ContractTransactionResponse>;
}

const ZERO_BYTE = '00';
//// @param: address is any account reference accountRefToSdk parses (bech32, composite `<address>_<suffix>` or hex)
export const midenAddrToEvmAddr = (address: string): `0x${string}` => {
  const hexAddr = accountRefToSdk(address).toString();

  const strippedHexAddr = hexAddr.startsWith('0x') ? hexAddr.slice(2) : hexAddr;
  return ('0x' + ZERO_BYTE.repeat(4) + strippedHexAddr + ZERO_BYTE) as `0x${string}`;
};

const ZERO_BYTES32 = '0x' + '00'.repeat(32);

// SMT proofs are fixed-size bytes32[32]; pad short proofs with zero hashes.
const padSmtProof = (proof: string[]): string[] => [...proof, ...Array(32).fill(ZERO_BYTES32)].slice(0, 32);

// Claim a Miden→EVM (L2→L1) bridge deposit on L1. Mirrors the bridge-service
// `claimAsset` flow: pull the merkle proof for the deposit, build the two
// fixed-size SMT proof arrays, and submit `claimAsset` from the connected EVM
// wallet (which must be the deposit's destination address).
export const claimAgglayerDeposit = async ({
  deposit,
  provider
}: {
  deposit: AgglayerDeposit;
  provider: EIP1193Provider;
}): Promise<ContractTransactionResponse> => {
  const l1Bridge = getAgglayerL1Bridge();
  const proof = await fetchMerkleProof(deposit.deposit_cnt, deposit.network_id);

  const ethersProvider = new BrowserProvider(provider);
  const signer = await ethersProvider.getSigner();
  const agglayerContract = BaseContract.from<AgglayerBridgeContract>(l1Bridge, AGGLAYER_BRIDGE_ABI, signer);

  return agglayerContract.claimAsset(
    padSmtProof(proof.merkle_proof),
    padSmtProof(proof.rollup_merkle_proof),
    BigInt(deposit.global_index),
    proof.main_exit_root,
    proof.rollup_exit_root,
    deposit.orig_net,
    deposit.orig_addr,
    deposit.dest_net,
    deposit.dest_addr,
    BigInt(deposit.amount),
    deposit.metadata && deposit.metadata !== '0x' ? deposit.metadata : '0x'
  );
};
