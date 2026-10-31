import { createPublicClient, http, isAddress } from 'viem';

import { IBridgedSendExtraInputs, ITransaction, ITransactionStatus, IUsdcxBurn } from 'lib/miden/db/types';
import { checkpointProviderReceipt } from 'lib/miden/recovery/receipt-writer';
import * as Repo from 'lib/miden/repo';
import { getChain } from 'lib/walletconnect/config';

import { usdcxDestinations, ERC20_BALANCE_OF_ABI } from './constant';
import { readGatewayPayoutSource, scanUsdcxPayout, USDCX_PAYOUT_RESCAN_BLOCKS } from './payout-proof';

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

/** Paid when the payout mint is recorded; rows the old balance rule confirmed stay paid. */
export function isUsdcxPayoutConfirmed(burn: IUsdcxBurn | undefined): boolean {
  return burn?.phase === 'confirmed' && (!!burn.payout || !!burn.destinationBalanceConfirmed);
}

/** How long a confirmed burn may stay unpaid before the row says so. */
export const USDCX_PAYOUT_DELAYED_MS = 7_200_000;

/**
 * Confirmed, unpaid and past the delay. The clock starts when the burn first read confirmed; a row confirmed before
 * that was recorded counts from `settledAtMs`, the row's own settle time. A row the old balance rule confirmed is paid.
 * Only a row the scan can settle is ever late: a restored row is never polled and one without a saved snapshot has no
 * block to scan from, so both stay at Burn confirmed.
 */
export function isUsdcxPayoutDelayed(
  burn: IUsdcxBurn | undefined,
  settledAtMs: number | undefined,
  now = Date.now(),
  restoredFromBackup = false
): boolean {
  if (restoredFromBackup || burn?.phase !== 'confirmed' || !burn.destinationBalanceBefore) return false;
  if (isUsdcxPayoutConfirmed(burn)) return false;
  const since = burn.confirmedAt ?? settledAtMs;
  return since !== undefined && now - since >= USDCX_PAYOUT_DELAYED_MS;
}

export function isUsdcxDestinationPending(burn: IUsdcxBurn): boolean {
  return (
    burn.phase === 'confirmed' && !!burn.destinationBalanceBefore && !burn.payout && !burn.destinationBalanceConfirmed
  );
}

export interface UsdcxPayoutDeps {
  readSource?: typeof readGatewayPayoutSource;
  scan?: typeof scanUsdcxPayout;
}

/**
 * Records the mint that paid a confirmed burn. A balance increase proves nothing about this burn, so the scan looks
 * for the GatewayMinter mint whose transaction carries the burn's note id. Every network with a USDCx row is polled;
 * the destination's USDC and RPC come from the document for that row's chain. A failure before any chunk completes
 * (the source read, the block number) leaves the row and its cursor unchanged; a chunk failing mid-scan resumes after
 * the last chunk read in full. The cursor is saved 128 blocks below the last block read, never below where it was, so
 * every check reads those blocks again. `more` is true when the chunk cap stopped the scan below the head, so the
 * caller can check the row again without waiting out its back-off.
 */
export async function pollUsdcxDestination(
  tx: ITransaction,
  { readSource = readGatewayPayoutSource, scan = scanUsdcxPayout }: UsdcxPayoutDeps = {}
): Promise<{ more: boolean }> {
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
    return { more: false };
  }
  const usdc = burn.destinationUsdc ?? usdcxDestinations().get(extra.destinationNetwork)?.usdc;
  if (!usdc) return { more: false };

  const cursor = burn.payoutScannedBlock;
  const floor = BigInt(cursor ?? before.blockNumber);
  const { payout, scannedTo, head } = await scan({
    chainId: extra.destinationNetwork,
    recipient: extra.destinationAddress,
    usdc,
    burnNoteId: burn.noteId,
    amount: tx.amount,
    fromBlock: floor + 1n,
    source: await readSource()
  });
  const more = scannedTo !== undefined && head !== undefined && scannedTo < head;
  if (!payout && scannedTo === undefined) return { more };
  const resumeAfter =
    scannedTo !== undefined && scannedTo - USDCX_PAYOUT_RESCAN_BLOCKS > floor
      ? scannedTo - USDCX_PAYOUT_RESCAN_BLOCKS
      : floor;
  if (!payout && resumeAfter === floor) return { more };

  let retained: ITransaction | undefined;
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
    // A cursor another surface already moved is left alone, so two realms cannot walk it backwards.
    if (!payout && previous.payoutScannedBlock !== cursor) return;
    row.extraInputs = {
      ...current,
      usdcxBurn: payout ? { ...previous, payout } : { ...previous, payoutScannedBlock: resumeAfter.toString() }
    };
    retained = { ...row };
  });
  if (retained) await checkpointProviderReceipt(retained);
  return { more };
}
