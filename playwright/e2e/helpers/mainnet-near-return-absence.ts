import { createPublicClient, erc20Abi, getAddress, http, parseAbiItem } from 'viem';
import { fetchOneClickStatus } from '../../../src/lib/one-click/client';
import { hashOneClickQuote } from '../../../src/lib/one-click/signature';
import {
  assertNearReturnCustody,
  hasNoNearReturnProviderActivity
} from '../../../scripts/mainnet-near-return-provenance.mjs';
import { mainnetChain, mainnetRpc } from './mainnet-bridge-sources';
import type { MainnetNearCheckpoint } from './mainnet-near-checkpoint';
import { createMainnetOneClickOriginFetcher } from './mainnet-one-click-origin';

// This block predates the single attested retired quote; this is not a general recovery scan.
const scanStart = 526087751n;
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export async function verifyRetiredNearReturnAbsence(
  state: MainnetNearCheckpoint,
  extensionId: string,
  signal: AbortSignal
): Promise<void> {
  const quote = state.reverseQuote;
  if (
    state.sourceRunId !== '44318071333' ||
    state.phase !== 'recovery-required' ||
    state.evm.chainId !== 42161 ||
    state.forwardReceived !== '9975787' ||
    state.returnAmount !== state.forwardReceived ||
    state.evmNonceBefore === undefined ||
    !quote ||
    state.transactions?.length ||
    state.consumeAuthority ||
    state.returnNoteId ||
    state.returnMidenTxId ||
    state.returnProviderTxId ||
    state.paidEvmFees !== '0' ||
    process.env.MAINNET_NEAR_REPLACEMENT_PROVENANCE !== 'true'
  )
    throw new Error('NEAR retired return lacks exact unsubmitted authority');
  signal.throwIfAborted();
  const account = getAddress(state.evm.account);
  const token = getAddress(state.evm.token);
  const client = createPublicClient({
    chain: mainnetChain(state.evm.chainId),
    transport: http(mainnetRpc(state.evm.chainId), { retryCount: 0, fetchOptions: { signal } })
  });
  const fetcher = createMainnetOneClickOriginFetcher(state.serviceUrl, extensionId, (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
  );
  const [status, start, finalized, chainId] = await Promise.all([
    fetchOneClickStatus({ serviceUrl: state.serviceUrl, chains: [], midenAssets: [] }, quote.depositAddress, undefined, undefined, fetcher),
    client.getBlock({ blockNumber: scanStart }),
    client.getBlock({ blockTag: 'finalized' }),
    client.getChainId()
  ]);
  if (
    hashOneClickQuote(status.quoteResponse) !== quote.quoteHash ||
    !hasNoNearReturnProviderActivity(status) ||
    start.timestamp * 1_000n > BigInt(Date.parse(status.quoteResponse.timestamp)) ||
    chainId !== state.evm.chainId ||
    finalized.number < scanStart ||
    finalized.number - scanStart > 1_000_000n
  )
    throw new Error('NEAR retired return has ambiguous provider or finalized chain evidence');
  for (let fromBlock = scanStart; fromBlock <= finalized.number; fromBlock += 10_000n) {
    signal.throwIfAborted();
    const end = fromBlock + 9_999n;
    const logs = await client.getLogs({
      address: token,
      event: transfer,
      args: { to: getAddress(quote.depositAddress) },
      fromBlock,
      toBlock: end < finalized.number ? end : finalized.number
    });
    if (logs.length) throw new Error('NEAR retired return deposit activity found');
  }
  const read = async (block: { blockTag: 'latest' | 'pending' } | { blockNumber: bigint }) => {
    const [nonce, native, balance] = await Promise.all([
      client.getTransactionCount({ address: account, ...block }),
      client.getBalance({ address: account, ...block }),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account], ...block })
    ]);
    return { nonce, native, token: balance };
  };
  const [latest, pending, finalizedCustody] = await Promise.all([
    read({ blockTag: 'latest' }),
    read({ blockTag: 'pending' }),
    read({ blockNumber: finalized.number })
  ]);
  assertNearReturnCustody(
    {
      nonce: state.evmNonceBefore,
      native: BigInt(state.evm.nativeBalance),
      token: BigInt(state.evm.tokenBalance) + BigInt(state.forwardReceived)
    },
    quote.deadline,
    { latest, pending, finalized: finalizedCustody, finalizedTimestamp: finalized.timestamp }
  );
  signal.throwIfAborted();
}
