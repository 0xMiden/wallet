import { createPublicClient, http, isAddress } from 'viem';

import { IBridgedSendExtraInputs, ITransaction, ITransactionStatus, IUsdcxBurn } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { getChain } from 'lib/walletconnect/config';

import { usdcxDestinations, ERC20_BALANCE_OF_ABI, minimumUsdcxPayout } from './constant';

export interface UsdcxBalanceSnapshot {
  balance: string;
  blockNumber: string;
}

/** One destination read's request timeout, and the whole budget of the snapshot taken before a burn. */
const DESTINATION_READ_TIMEOUT_MS = 15_000;
/** The waits before the snapshot's second and third attempts. */
const SNAPSHOT_BACKOFF_MS = [1_000, 2_000];

/** Read USDC in six-decimal base units at one block. RPC errors stop this check. */
export async function readUsdcxDestinationBalance(
  chainId: number,
  recipient: string,
  timeoutMs = DESTINATION_READ_TIMEOUT_MS,
  savedToken?: `0x${string}`
): Promise<UsdcxBalanceSnapshot> {
  const chain = getChain(chainId);
  const token = savedToken ?? usdcxDestinations().get(chainId)?.usdc;
  if (!chain || !token || !isAddress(recipient)) throw new Error('Invalid USDC destination');
  const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: timeoutMs, retryCount: 0 }) });
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

export interface UsdcxSnapshotDeps {
  read?: typeof readUsdcxDestinationBalance;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Rejects once `ms` elapse: a read is two sequential requests, each allowed the budget's remainder by viem. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('USDCx destination balance read timed out')), Math.max(ms, 0));
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The balance a burn is later confirmed against, read before the burn is queued. Arc's public RPC answers
 * intermittent 429s, so a failed read is tried twice more after a backoff, every attempt drawing on the 15 s one read
 * used to have. The last error is rethrown: a burn whose every attempt fails still fails before any row exists.
 */
export async function readUsdcxDestinationSnapshot(
  chainId: number,
  recipient: string,
  { read = readUsdcxDestinationBalance, now = Date.now, sleep = wait }: UsdcxSnapshotDeps = {},
  savedToken?: `0x${string}`
): Promise<UsdcxBalanceSnapshot> {
  const deadline = now() + DESTINATION_READ_TIMEOUT_MS;
  const attempt = async (backoffs: readonly number[]): Promise<UsdcxBalanceSnapshot> => {
    try {
      const remaining = deadline - now();
      const request =
        savedToken === undefined
          ? read(chainId, recipient, remaining)
          : read(chainId, recipient, remaining, savedToken);
      return await within(request, remaining);
    } catch (error) {
      const [backoff, ...later] = backoffs;
      if (backoff === undefined || now() + backoff >= deadline) throw error;
      await sleep(backoff);
      return attempt(later);
    }
  };
  return attempt(SNAPSHOT_BACKOFF_MS);
}

export function isUsdcxDestinationPending(burn: IUsdcxBurn): boolean {
  return burn.phase === 'confirmed' && !!burn.destinationBalanceBefore && !burn.destinationBalanceConfirmed;
}

/**
 * A balance increase is an estimate of arrival; it does not identify a bridge transfer. Every network with a
 * USDCx row is polled; the destination's USDC and RPC come from the document for that row's chain.
 */
export async function pollUsdcxDestination(tx: ITransaction, readBalance = readUsdcxDestinationBalance): Promise<void> {
  const extra: IBridgedSendExtraInputs | undefined = tx.extraInputs;
  const burn = extra?.usdcxBurn;
  const before = burn?.destinationBalanceBefore;
  if (
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

  // Circle deducts its fee from the payout, so the balance rises by less than the sent amount. A burn the fee
  // allowance takes whole has no floor an unrelated credit could not meet, so it stays at Burn confirmed.
  const minimum =
    burn.payoutFeeAllowance === undefined
      ? minimumUsdcxPayout(extra.destinationNetwork, tx.amount)
      : tx.amount - BigInt(burn.payoutFeeAllowance);
  if (minimum <= 0n) return;

  const observed = await readBalance(
    extra.destinationNetwork,
    extra.destinationAddress,
    DESTINATION_READ_TIMEOUT_MS,
    burn.destinationUsdc
  );
  if (BigInt(observed.blockNumber) <= BigInt(before.blockNumber)) return;
  if (BigInt(observed.balance) < BigInt(before.balance) + minimum) return;

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
