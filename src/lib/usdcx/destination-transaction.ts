import { createPublicClient, http, isAddress, parseAbiItem } from 'viem';

import { getChain } from 'lib/walletconnect/config';

import { usdcxDestinations, minimumUsdcxPayout } from './constant';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const MAX_SEARCH_BLOCKS = 2_000n;

/** One bounded log request. A matching transfer is a hint, not proof of this burn's payout. */
export async function findUsdcxDestinationTransaction({
  chainId,
  recipient,
  amount,
  beforeBlock,
  confirmedBlock,
  savedToken,
  savedFeeAllowance
}: {
  chainId: number;
  recipient: string;
  amount: bigint;
  beforeBlock: string;
  confirmedBlock: string;
  savedToken?: string;
  savedFeeAllowance?: string;
}): Promise<string | undefined> {
  const chain = getChain(chainId);
  const token = savedToken ?? usdcxDestinations().get(chainId)?.usdc;
  // The payout is the sent amount minus Circle's fee, so match the range the balance check accepts. A burn the fee
  // allowance takes whole has no such range.
  const minimum =
    savedFeeAllowance === undefined ? minimumUsdcxPayout(chainId, amount) : amount - BigInt(savedFeeAllowance);
  if (!chain || !token || !isAddress(token) || !isAddress(recipient) || minimum <= 0n) return undefined;
  const toBlock = BigInt(confirmedBlock);
  const firstBlock = BigInt(beforeBlock) + 1n;
  if (firstBlock > toBlock) return undefined;
  const windowStart = toBlock - MAX_SEARCH_BLOCKS + 1n;
  const fromBlock = firstBlock > windowStart ? firstBlock : windowStart;
  const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  const logs = await client.getLogs({
    address: token,
    event: TRANSFER_EVENT,
    args: { to: recipient },
    fromBlock,
    toBlock,
    strict: true
  });
  const matches = logs.filter(log => !log.removed && log.args.value >= minimum && log.args.value <= amount);
  return matches.length === 1 ? (matches[0]?.transactionHash ?? undefined) : undefined;
}
