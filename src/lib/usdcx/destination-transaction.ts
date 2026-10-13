import { createPublicClient, http, isAddress, parseAbiItem } from 'viem';

import { initBridgeConfig } from 'lib/remote-config/runtime';
import { getChain } from 'lib/walletconnect/config';

import { getUsdcxDestinations, minimumUsdcxPayout } from './chains';

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
  await initBridgeConfig();
  const token = getUsdcxDestinations().get(chainId)?.usdc;
  // The payout is the sent amount minus Circle's fee, so match the range the balance check accepts. A burn the fee
  // allowance takes whole has no such range.
  const minimum = minimumUsdcxPayout(chainId, amount);
  if (!chain || !token || !isAddress(recipient) || minimum <= 0n) return undefined;
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
