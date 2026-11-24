import {
  createPublicClient,
  http,
  isAddressEqual,
  pad,
  parseEventLogs,
  type Hash,
  type Hex,
  type Log,
  type PublicClient
} from 'viem';

import { GATEWAY_MINTER_ABI, XRESERVE_HARNESS_ABI } from './arc-usdcx';
import { bridgeLoops, type UsdcxLoop } from './mainnet-bridge-plan';
import { mainnetChain, mainnetRpc, xreserveSource, type MainnetUsdcxDocument } from './mainnet-bridge-sources';

const ARC_MAINNET_CHAIN_ID = 5042;
/** Circle's Gateway names the xReserve chain as every mint's source, whatever chain it pays on. */
const GATEWAY_SOURCE_DOMAIN = 26;

/** The two reads the proof makes on the payout chain; a viem `PublicClient` is one. */
export interface PayoutReadClient {
  getTransactionReceipt(args: { hash: Hash }): Promise<{ logs: readonly Log[] }>;
  getTransaction(args: { hash: Hash }): Promise<{ input: Hex }>;
}

export interface MainnetPayoutArgs {
  chainId: number;
  /** The mint the wallet recorded on the burn row (`usdcxBurn.payout.transactionHash`). */
  transactionHash: `0x${string}`;
  recipient: `0x${string}`;
  /** The chain's mainnet USDC, from the mainnet document. */
  usdc: `0x${string}`;
  burnNoteId: string;
  burnUnits: bigint;
  /** `usdcxBurn.payout.value`. */
  walletValue: bigint;
  gatewayMinter: `0x${string}`;
  /** `getRemoteDomainDepositor(midenDomain)` on the Arc xReserve. */
  depositor: `0x${string}`;
  client?: PayoutReadClient;
}

/**
 * Proves the mint the wallet recorded for a mainnet USDCx burn on chain, independently of the wallet's own scan: its
 * receipt holds exactly one `AttestationUsed` from `gatewayMinter` for (`usdc`, `recipient`), from the Gateway source
 * domain and Miden's depositor, of exactly the value the wallet recorded and at most the burn, and its calldata carries
 * the burn note id. Throws naming the chain, the note id and the first mismatch; returns the value and Circle's fee.
 */
export async function verifyMainnetPayout(args: MainnetPayoutArgs): Promise<{ value: bigint; fee: bigint }> {
  const client =
    args.client ?? createPublicClient({ chain: mainnetChain(args.chainId), transport: http(mainnetRpc(args.chainId)) });
  const refuse = (reason: string) =>
    new Error(`chain ${args.chainId} burn ${args.burnNoteId}: payout mint ${args.transactionHash} ${reason}`);
  const noteHex = args.burnNoteId.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(noteHex)) throw refuse('cannot be tied to a burn note id that is not hex');

  const receipt = await client.getTransactionReceipt({ hash: args.transactionHash });
  const mints = parseEventLogs({
    abi: GATEWAY_MINTER_ABI,
    eventName: 'AttestationUsed',
    logs: [...receipt.logs]
  }).filter(
    log =>
      isAddressEqual(log.address, args.gatewayMinter) &&
      isAddressEqual(log.args.token, args.usdc) &&
      isAddressEqual(log.args.recipient, args.recipient)
  );
  const [mint] = mints;
  if (mints.length !== 1 || !mint) {
    throw refuse(
      `found ${mints.length} AttestationUsed logs from ${args.gatewayMinter} for ${args.usdc} to ${args.recipient}`
    );
  }
  const { sourceDomain, sourceDepositor, value } = mint.args;
  if (sourceDomain !== GATEWAY_SOURCE_DOMAIN)
    throw refuse(`sourceDomain ${sourceDomain}, expected ${GATEWAY_SOURCE_DOMAIN}`);
  const depositor = pad(args.depositor);
  if (sourceDepositor.toLowerCase() !== depositor.toLowerCase()) {
    throw refuse(`sourceDepositor ${sourceDepositor}, expected ${depositor}`);
  }
  if (value !== args.walletValue) throw refuse(`value ${value}, the wallet recorded ${args.walletValue}`);
  // A zero or larger mint is not this burn's payout, so a fee is never negative or the whole burn.
  if (value <= 0n || value > args.burnUnits) {
    throw refuse(`value ${value} is not between 1 and the burn's ${args.burnUnits}`);
  }
  const transaction = await client.getTransaction({ hash: args.transactionHash });
  if (!transaction.input.toLowerCase().includes(noteHex)) {
    throw refuse(`calldata lacks the burn note id ${args.burnNoteId}`);
  }
  return { value, fee: args.burnUnits - value };
}

/** The Gateway minter and Miden's depositor, read from the Arc mainnet xReserve the mainnet document names. */
export async function readMainnetGatewaySource(
  doc: MainnetUsdcxDocument,
  client?: Pick<PublicClient, 'readContract'>
): Promise<{ gatewayMinter: `0x${string}`; depositor: `0x${string}` }> {
  const arc = bridgeLoops(Object.values(doc.supportedEvmChains)).find(
    (loop): loop is UsdcxLoop =>
      loop.kind === 'usdcx' && loop.route === 'xreserve' && loop.chainId === ARC_MAINNET_CHAIN_ID
  );
  if (!arc) throw new Error('the mainnet document names no Arc xReserve');
  const source = xreserveSource(doc, arc);
  const reader = client ?? createPublicClient({ chain: source.chain, transport: http(mainnetRpc(arc.chainId)) });
  const [gatewayMinter, depositor] = await Promise.all([
    reader.readContract({ address: source.xReserve, abi: XRESERVE_HARNESS_ABI, functionName: 'gatewayMinter' }),
    reader.readContract({
      address: source.xReserve,
      abi: XRESERVE_HARNESS_ABI,
      functionName: 'getRemoteDomainDepositor',
      args: [source.midenDomain ?? doc['bridge-providers'].usdcx.midenDomain]
    })
  ]);
  return { gatewayMinter, depositor };
}
