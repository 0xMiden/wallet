import { createPublicClient, http, isAddress } from 'viem';

import { IBridgedSendExtraInputs, ITransaction, ITransactionStatus, IUsdcxBurn } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getChain } from 'lib/walletconnect/config';

import { CIRCLE_USDC_ADDRESS, ERC20_BALANCE_OF_ABI } from './constant';

export interface UsdcxBalanceSnapshot {
  balance: string;
  blockNumber: string;
}

/** Read USDC in six-decimal base units at one block. RPC errors stop this check. */
export async function readUsdcxDestinationBalance(chainId: number, recipient: string): Promise<UsdcxBalanceSnapshot> {
  const chain = getChain(chainId);
  const token = CIRCLE_USDC_ADDRESS.get(chainId);
  if (!chain || !token || !isAddress(recipient)) throw new Error('Invalid USDC destination');
  const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 15_000, retryCount: 0 }) });
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const balance = await client.readContract({
    address: token,
    abi: ERC20_BALANCE_OF_ABI,
    functionName: 'balanceOf',
    args: [recipient],
    blockNumber
  });
  return { balance: balance.toString(), blockNumber: blockNumber.toString() };
}

export function isUsdcxDestinationPending(burn: IUsdcxBurn): boolean {
  return burn.phase === 'confirmed' && !!burn.destinationBalanceBefore && !burn.destinationBalanceConfirmed;
}

/** A balance increase is an estimate of arrival; it does not identify a bridge transfer. */
export async function pollUsdcxDestination(tx: ITransaction, readBalance = readUsdcxDestinationBalance): Promise<void> {
  const extra: IBridgedSendExtraInputs | undefined = tx.extraInputs;
  const burn = extra?.usdcxBurn;
  const before = burn?.destinationBalanceBefore;
  if (
    getEffectiveNetworkName() !== 'testnet' ||
    tx.restoredFromBackup ||
    tx.type !== 'bridged-send' ||
    tx.status !== ITransactionStatus.Completed ||
    extra?.provider !== 'usdcx' ||
    !burn ||
    !isUsdcxDestinationPending(burn) ||
    !before ||
    !tx.amount ||
    tx.amount <= 0n
  ) {
    return;
  }

  const observed = await readBalance(extra.destinationNetwork, extra.destinationAddress);
  if (BigInt(observed.blockNumber) <= BigInt(before.blockNumber)) return;
  if (BigInt(observed.balance) < BigInt(before.balance) + tx.amount) return;

  await Repo.transactions.where({ id: tx.id }).modify(row => {
    const current: IBridgedSendExtraInputs | undefined = row.extraInputs;
    const previous = current?.usdcxBurn;
    if (
      row.restoredFromBackup ||
      row.status !== ITransactionStatus.Completed ||
      current?.provider !== 'usdcx' ||
      current.destinationNetwork !== extra.destinationNetwork ||
      current.destinationAddress !== extra.destinationAddress ||
      row.amount !== tx.amount ||
      !previous ||
      previous.noteId !== burn.noteId ||
      !isUsdcxDestinationPending(previous) ||
      previous.destinationBalanceBefore?.balance !== before.balance ||
      previous.destinationBalanceBefore?.blockNumber !== before.blockNumber
    ) {
      return;
    }
    row.extraInputs = {
      ...current,
      usdcxBurn: { ...previous, destinationBalanceConfirmed: observed }
    };
  });
}
