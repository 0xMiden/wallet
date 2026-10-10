import { createPublicClient, http, isAddress, parseAbiItem } from 'viem';

import { getChain } from 'lib/walletconnect/config';

import { CIRCLE_USDC_ADDRESS, minimumUsdcxPayout } from './constant';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const MAX_SEARCH_BLOCKS = 2_000n;

/** One bounded log request. A matching transfer is a hint, not proof of this burn's payout. */
export async function findUsdcxDestinationTransaction({
  chainId,
  recipient,
  amount,
  beforeBlock,
  confirmedBlock
}: {
  chainId: number;
  recipient: string;
  amount: bigint;
  beforeBlock: string;
  confirmedBlock: string;
}): Promise<string | undefined> {
  const chain = getChain(chainId);
  const token = CIRCLE_USDC_ADDRESS.get(chainId);
  if (!chain || !token || !isAddress(recipient) || amount <= 0n) return undefined;
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
  // The payout is the sent amount minus Circle's fee, so match the range the balance check accepts.
  const minimum = minimumUsdcxPayout(chainId, amount);
  const matches = logs.filter(log => !log.removed && log.args.value >= minimum && log.args.value <= amount);
  return matches.length === 1 ? (matches[0]?.transactionHash ?? undefined) : undefined;
}
