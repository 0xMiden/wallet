import { Address } from '@miden-sdk/miden-sdk/lazy';
import { BaseContract, BrowserProvider, ContractTransactionResponse, Overrides } from 'ethers';
import { EIP1193Provider, toHex } from 'viem';

import { getAgglayerL1Bridge } from 'lib/remote-config/values';
import { DEFAULT_CHAIN_ID } from 'lib/walletconnect/config';

import { AGGLAYER_BRIDGE_ABI } from './constant';
import { midenAccountIdToEvmAddr } from './miden-account-address';
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

//// @param: address always bech32
export const midenAddrToEvmAddr = (address: string): `0x${string}` => {
  return midenAccountIdToEvmAddr(Address.fromBech32(address).accountId().toString());
};

const ZERO_BYTES32 = '0x' + '00'.repeat(32);

// SMT proofs are fixed-size bytes32[32]; pad short proofs with zero hashes.
const padSmtProof = (proof: string[]): string[] => [...proof, ...Array(32).fill(ZERO_BYTES32)].slice(0, 32);

// The claim goes to the L1 bridge's address on whatever chain the wallet is on. On a chain where nothing lives at that
// address (Arc, after a USDCx deposit switched the wallet) it would succeed as a no-op and read as claimed, so the
// wallet is switched to Sepolia first and the claim is refused while it is anywhere else.
const ensureL1Chain = async (provider: EIP1193Provider): Promise<void> => {
  const onL1 = async () => Number(await provider.request({ method: 'eth_chainId' })) === DEFAULT_CHAIN_ID;
  if (await onL1()) return;
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(DEFAULT_CHAIN_ID) }] });
  if (!(await onL1())) throw new Error('Switch your EVM wallet to Sepolia to claim.');
};

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
  await ensureL1Chain(provider);
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
