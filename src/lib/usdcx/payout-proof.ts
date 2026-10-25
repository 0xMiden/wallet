import {
  bytesToHex,
  createPublicClient,
  getAddress,
  hexToBytes,
  http,
  pad,
  parseAbi,
  parseAbiItem,
  PublicClient
} from 'viem';

import { getChain } from 'lib/walletconnect/config';

import { getUsdcxRemoteDomain, usdcxSourceChains } from './constant';

const XRESERVE_ABI = parseAbi([
  'function gatewayMinter() view returns (address)',
  'function getRemoteDomainDepositor(uint32 remoteDomain) view returns (address)'
]);
const ATTESTATION_USED = parseAbiItem(
  'event AttestationUsed(address indexed token, address indexed recipient, bytes32 indexed transferSpecHash, uint32 sourceDomain, bytes32 sourceDepositor, bytes32 sourceSigner, uint256 value)'
);

const PAYOUT_READ_TIMEOUT_MS = 15_000;
export const USDCX_PAYOUT_LOG_CHUNK = 10_000n;
export const USDCX_PAYOUT_CHUNKS_PER_CHECK = 5;
/** Blocks below the last one read that the next check reads again, for logs that lag their head and short reorgs. */
export const USDCX_PAYOUT_RESCAN_BLOCKS = 128n;

export type PayoutReadClient = Pick<PublicClient, 'getBlockNumber' | 'getLogs' | 'getTransaction' | 'readContract'>;

/** The mint that paid one burn: Circle's GatewayMinter transaction, the block it landed in, and the USDC it minted. */
export interface UsdcxPayout {
  transactionHash: `0x${string}`;
  blockNumber: string;
  value: string;
}

/** What identifies Circle's payout mints for USDCx: the minter, the depositor it credits, and the source domain. */
export interface GatewayPayoutSource {
  gatewayMinter: `0x${string}`;
  /** The xReserve's depositor for Miden as the 32-byte lowercase word `AttestationUsed` logs. */
  depositor: `0x${string}`;
  sourceDomain: number;
}

function readClient(chainId: number): PayoutReadClient {
  const chain = getChain(chainId);
  if (!chain) throw new Error(`USDCx payout proof is not configured for chain ${chainId}`);
  return createPublicClient({ transport: http(chain.rpcUrl, { timeout: PAYOUT_READ_TIMEOUT_MS, retryCount: 0 }) });
}

const sources = new Map<string, Promise<GatewayPayoutSource>>();

/**
 * The minter and depositor come from the Arc xReserve itself, so a Circle redeploy needs no wallet release. They are
 * cached for the session; a failed read is dropped so the next poll asks again.
 */
export function readGatewayPayoutSource({ client }: { client?: PayoutReadClient } = {}): Promise<GatewayPayoutSource> {
  const origin = [...usdcxSourceChains().values()].find(entry => entry.route === 'xreserve');
  if (origin?.route !== 'xreserve')
    return Promise.reject(new Error('USDCx has no xReserve source to read a payout from'));
  const midenDomain = origin.midenDomain ?? getUsdcxRemoteDomain();
  const key = `${origin.chain.id}:${origin.xReserve}:${midenDomain}`;
  const cached = sources.get(key);
  if (cached) return cached;
  const read = (async (): Promise<GatewayPayoutSource> => {
    const rpc = client ?? readClient(origin.chain.id);
    const gatewayMinter = await rpc.readContract({
      address: origin.xReserve,
      abi: XRESERVE_ABI,
      functionName: 'gatewayMinter'
    });
    const depositor = await rpc.readContract({
      address: origin.xReserve,
      abi: XRESERVE_ABI,
      functionName: 'getRemoteDomainDepositor',
      args: [midenDomain]
    });
    return {
      gatewayMinter: getAddress(gatewayMinter),
      depositor: bytesToHex(hexToBytes(pad(depositor))),
      sourceDomain: origin.domain
    };
  })();
  sources.set(key, read);
  read.catch(() => sources.delete(key));
  return read;
}

interface PayoutScanArgs {
  chainId: number;
  recipient: string;
  usdc: `0x${string}`;
  burnNoteId: string;
  amount: bigint;
  fromBlock: bigint;
  source: GatewayPayoutSource;
  client?: PayoutReadClient;
}

/**
 * Looks for the GatewayMinter mint that paid one burn. An AttestationUsed log for the row's token and recipient is not
 * enough: a manual transfer or another burn's payout can credit the same recipient, so the mint's calldata must carry
 * this burn's note id. At most five 10,000-block chunks are read per call; `scannedTo` is the last block of the last
 * chunk that was read in full, so a caller resumes after it and no range is skipped when an RPC fails mid-scan.
 */
export async function scanUsdcxPayout({
  chainId,
  recipient,
  usdc,
  burnNoteId,
  amount,
  fromBlock,
  source,
  client = readClient(chainId)
}: PayoutScanArgs): Promise<{ payout?: UsdcxPayout; scannedTo?: bigint }> {
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  if (latest < fromBlock) return {};
  const last = fromBlock + BigInt(USDCX_PAYOUT_CHUNKS_PER_CHECK) * USDCX_PAYOUT_LOG_CHUNK - 1n;
  const end = latest < last ? latest : last;
  const noteId = burnNoteId.replace(/^0x/i, '').toLowerCase();
  const holder = getAddress(recipient);
  let scannedTo: bigint | undefined;
  for (let start = fromBlock; start <= end; start += USDCX_PAYOUT_LOG_CHUNK) {
    const stop = start + USDCX_PAYOUT_LOG_CHUNK - 1n < end ? start + USDCX_PAYOUT_LOG_CHUNK - 1n : end;
    try {
      const logs = await client.getLogs({
        address: source.gatewayMinter,
        event: ATTESTATION_USED,
        args: { token: usdc, recipient: holder },
        fromBlock: start,
        toBlock: stop,
        strict: true
      });
      const ordered = [...logs].sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1
      );
      for (const log of ordered) {
        const { sourceDomain, sourceDepositor, value } = log.args;
        if (log.removed || sourceDomain !== source.sourceDomain) continue;
        if (sourceDepositor.toLowerCase() !== source.depositor || value <= 0n || value > amount) continue;
        const transaction = await client.getTransaction({ hash: log.transactionHash });
        if (!transaction.input.toLowerCase().includes(noteId)) continue;
        return {
          payout: {
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber.toString(),
            value: value.toString()
          }
        };
      }
    } catch {
      return { scannedTo };
    }
    scannedTo = stop;
  }
  return { scannedTo };
}
