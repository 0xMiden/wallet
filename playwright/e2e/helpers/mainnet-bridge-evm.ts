import { createPublicClient, createWalletClient, http, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ERC20_ABI } from './arc-usdcx';
import { AGGLAYER_BRIDGE_ABI } from '../../../src/lib/agglayer/constant';
import { midenAddrToEvmAddr } from '../../../src/lib/agglayer/contract';
import type { AgglayerDeposit, AgglayerMerkleProof } from '../../../src/lib/agglayer/status';
import { XRESERVE_ABI } from '../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

function clientFor(chain: Chain, rpcUrl: string, key: Hex) {
  const account = privateKeyToAccount(key);
  const transport = http(rpcUrl);
  return {
    account,
    publicClient: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ account, chain, transport })
  };
}

/** Approve if needed, then `depositToRemote` of `units` with a zero Circle fee. */
export async function depositXReserve(args: {
  key: Hex;
  chain: Chain;
  rpcUrl: string;
  usdc: Address;
  xReserve: Address;
  units: bigint;
  remoteDomain: number;
  accountHex: string;
}): Promise<Hex> {
  const { publicClient, wallet, account } = clientFor(args.chain, args.rpcUrl, args.key);
  const allowance = await publicClient.readContract({
    address: args.usdc,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, args.xReserve]
  });
  if (allowance < args.units) {
    const approve = await wallet.writeContract({
      address: args.usdc,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [args.xReserve, args.units]
    });
    await publicClient.waitForTransactionReceipt({ hash: approve });
  }
  const recipient = midenAccountHexToXReserveRecipient(args.accountHex);
  const hash = await wallet.writeContract({
    address: args.xReserve,
    abi: XRESERVE_ABI,
    functionName: 'depositToRemote',
    args: [args.units, args.remoteDomain, recipient, args.usdc, 0n, '0x']
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Bridge `wei` of native ETH from Ethereum to the Miden account on Cedar (rollup 30). */
export async function bridgeEthToMiden(args: {
  key: Hex;
  chain: Chain;
  rpcUrl: string;
  bridge: Address;
  rollupId: number;
  midenAddress: string;
  wei: bigint;
}): Promise<Hex> {
  const { publicClient, wallet } = clientFor(args.chain, args.rpcUrl, args.key);
  const hash = await wallet.writeContract({
    address: args.bridge,
    abi: AGGLAYER_BRIDGE_ABI,
    functionName: 'bridgeAsset',
    args: [args.rollupId, midenAddrToEvmAddr(args.midenAddress), args.wei, ZERO, true, '0x'],
    value: args.wei
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function claimAgglayerOnEthereum(args: {
  key: Hex;
  chain: Chain;
  rpcUrl: string;
  bridge: Address;
  indexerUrl: string;
  deposit: AgglayerDeposit & { global_index?: string | number };
}): Promise<Hex> {
  const proof = await fetch(
    `${args.indexerUrl}/merkle-proof?deposit_cnt=${args.deposit.deposit_cnt}&net_id=${args.deposit.network_id}`
  ).then(async response => {
    if (!response.ok) throw new Error(`AggLayer merkle proof answered ${response.status}`);
    const body = (await response.json()) as { proof: AgglayerMerkleProof };
    return body.proof;
  });
  const pad = (leaves: string[]) => [...leaves, ...Array(32).fill(`0x${'00'.repeat(32)}`)].slice(0, 32);
  if (args.deposit.global_index === undefined) {
    throw new Error('AggLayer deposit has no global index, so the claim was not sent');
  }
  const { publicClient, wallet } = clientFor(args.chain, args.rpcUrl, args.key);
  const hash = await wallet.writeContract({
    address: args.bridge,
    abi: AGGLAYER_BRIDGE_ABI,
    functionName: 'claimAsset',
    args: [
      pad(proof.merkle_proof),
      pad(proof.rollup_merkle_proof),
      BigInt(args.deposit.global_index),
      proof.main_exit_root,
      proof.rollup_exit_root,
      args.deposit.orig_net,
      args.deposit.orig_addr,
      args.deposit.dest_net,
      args.deposit.dest_addr,
      BigInt(args.deposit.amount),
      args.deposit.metadata && args.deposit.metadata !== '0x' ? args.deposit.metadata : '0x'
    ]
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
