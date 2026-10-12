/**
 * The fixed numbers of the USDCx live suites (spec section 5), the Arc Testnet addresses and the chains a burn's payout
 * is read on, read from the product's own tables so the harness and the wallet cannot drift apart. Nothing here reads
 * the environment; an L2's `walletRpcUrl` is the wallet module's, whose project id follows WALLETCONNECT_PROJECT_ID.
 */
import os from 'os';
import path from 'path';
import type { Address, Chain, Hex } from 'viem';

import { getUsdcxDestination, getUsdcxXReserveSource } from '../../../src/lib/usdcx/constant';
import { ARC_TESTNET, getChain } from '../../../src/lib/walletconnect/config';
import { getBridgeNetworkByChainId } from '../../../src/screens/send-flow/bridge-networks';

export {
  minimumUsdcxPayout,
  USDCX_BURN_TAG,
  USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME,
  USDCX_DECIMALS,
  USDCX_DESTINATIONS,
  USDCX_REMOTE_DOMAIN
} from '../../../src/lib/usdcx/constant';
export { CLAIM_COST_FEE_MULTIPLE, FEE_RESERVE_MULTIPLE, isWorthClaiming } from '../../../src/lib/miden/fees/spendable';

/** The UI burn: 1 USDCx, the USDCx faucet's on-chain min_burn_amount; the review refuses anything less. */
export const BURN_UNITS = 1_000_000n;
/**
 * The deposit back: 0.001 USDC. The wallet claims a mint unattended only above base fee x 30 (210 at testnet's 7), and
 * a Guardian claim costs 133, so this is about 5x the one and 7.5x the other.
 */
export const DEPOSIT_UNITS = 1_000n;
/**
 * Arc gas is paid in USDC: approve plus depositToRemote use 187_847 gas, 0.0047 USDC at 25 gwei and 0.0061 at 32.5.
 * This covers them and the deposit's upfront gas check up to about 85 gwei.
 */
export const GAS_RESERVE_UNITS = 20_000n;
/** What the grant must leave above the burn for the burn's own fees. */
export const GRANT_MARGIN_UNITS = 1_000_000n;
/** One public faucet grant from the 10 USDCx tier: a 1 USDCx grant leaves 999_867, short of the 1_000_252 a burn takes. */
export const GRANT_UNITS = 10_000_000n;
/** D3: red this long after the burn's consume without a destination mint. */
export const PAYOUT_TIMEOUT_MS = 600_000;
/** Step 8b: the wallet's own confirmation of a payout the harness already proved. */
export const WALLET_CONFIRM_TIMEOUT_MS = 120_000;
export const ARC_LOG_CHUNK = 1000;
/** drpc refuses a 1000-block eth_getLogs with a misleading "ranges over 10000 blocks" message. */
export const ARC_DRPC_LOG_CHUNK = 100;

export const GATEWAY_MINTER: Address = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';
/** GatewayMinter's `AttestationUsed(address,address,bytes32,uint32,bytes32,bytes32,uint256)`, the payout's mint. */
export const ATTESTATION_USED_TOPIC: Hex = '0xbb312ce0cc311b2cb0746e09ccd2f91fdb9e2ac755d2f11c65300eb0d0fffd63';

export const ARC_DRPC_URL = 'https://rpc.drpc.testnet.arc.io';
export const ARC_QUICKNODE_URL = 'https://rpc.quicknode.testnet.arc.io';
export const ARC_PUBLIC_URL: string = ARC_TESTNET.rpcUrls.default.http[0];
/** arc.io is the wallet's only Arc RPC (burn snapshot and payout confirmation), so the harness reads it last. */
export const DEFAULT_ARC_RPCS: readonly string[] = [ARC_DRPC_URL, ARC_QUICKNODE_URL, ARC_PUBLIC_URL];
/** Each Arc request's transport timeout: a read moves to the next endpoint only once one has stalled this long. */
export const ARC_RPC_TIMEOUT_MS = 15_000;
/**
 * The budget of a step that reads Arc: every endpoint a run can have (an operator's `--arc-rpc`, then the defaults) may
 * stall for one transport timeout before the last one answers, plus 15 s.
 */
export const ARC_READ_STEP_BUDGET_MS = (DEFAULT_ARC_RPCS.length + 1) * ARC_RPC_TIMEOUT_MS + 15_000;
/** The harness Arc key and the per-run keys from before it, mode 0600, outside test-results and the repository. */
export const ARC_KEY_LEDGER_DIR = path.join(os.homedir(), '.miden-e2e', 'arc-keys');
/** R21: the one key every usdcx suite burns to and deposits from; scripts/e2e-real.mjs creates it on first use. */
export const HARNESS_ARC_KEY_FILE = path.join(ARC_KEY_LEDGER_DIR, 'harness.json');

export const ARC_CHAIN_ID: number = ARC_TESTNET.id;
const ARC_SOURCE = getUsdcxXReserveSource(ARC_TESTNET.id);
export const ARC_XRESERVE: Address = ARC_SOURCE.xReserve;
export const ARC_USDC: Address = ARC_SOURCE.usdc;
export const ARC_ATTESTATION_API: string = ARC_SOURCE.attestationApi;
export const ARC_CIRCLE_DOMAIN: number = ARC_SOURCE.domain;
export const GUARDIAN_ECDSA_SCHEME = 'ecdsa';

/** Every L2 endpoint below served 10_000-block eth_getLogs when probed (2026-10-11); 1000 keeps a scan to a few calls. */
export const L2_LOG_CHUNK = 1000;
/** Base Sepolia's own RPC refuses an eth_getLogs over more than 200 blocks (-32614 `limited to a 200 range`). */
export const BASE_OFFICIAL_LOG_CHUNK = 200;
const BASE_SEPOLIA_OFFICIAL_URL = 'https://sepolia.base.org';
/**
 * The harness's L2 read endpoints, in the order the payout gate tries them. drpc is left out: near the head it fails
 * even a 100-block log scan. Never the wallet's own RPC (rpc.walletconnect.org), whose reads the tests check.
 */
export const DEFAULT_BASE_SEPOLIA_RPCS: readonly string[] = [
  'https://base-sepolia-rpc.publicnode.com',
  'https://base-sepolia.gateway.tenderly.co',
  BASE_SEPOLIA_OFFICIAL_URL
];
export const DEFAULT_ARBITRUM_SEPOLIA_RPCS: readonly string[] = [
  'https://sepolia-rollup.arbitrum.io/rpc',
  'https://arbitrum-sepolia-rpc.publicnode.com',
  'https://arbitrum-sepolia.gateway.tenderly.co'
];
/** Ethereum Sepolia takes a burn, but Circle has never paid one out there (0xMiden/miden-usdcx#308). */
const ETHEREUM_SEPOLIA_CHAIN_ID = 11155111;

/**
 * A chain a burn's payout lands on: what the harness reads there, the domains the burn and the payout carry, and what
 * the Send flow and the details page show. Arc's values are exactly the ones its tests read before the L2 suite.
 */
export interface PayoutChain {
  chainId: number;
  /** The viem chain the harness's read clients are built on. */
  chain: Chain;
  /** How messages name the chain; Arc's `Arc` keeps every Arc message as it was. */
  label: string;
  rpcUrls: readonly string[];
  usdc: Address;
  /** The destination's Circle domain, which the burn note's attachment and its row carry: 26, 6 or 3. */
  burnDomain: number;
  /** `AttestationUsed.sourceDomain`, the Gateway source: Arc's 26 for every destination, never `burnDomain`. */
  attestationSourceDomain: number;
  logChunk(endpoint: string): number;
  /** The Send flow's chip test id, the review's `network=` and its Network row (bridge-networks.ts). */
  chip: string;
  reviewNetwork: string;
  networkName: string;
  /** The explorer the details page links (walletconnect/config.ts). */
  explorer: string;
  /** The wallet's own RPC for the chain, and the name a message gives it: never the URL, which carries a project id. */
  walletRpcUrl: string;
  walletRpcName: string;
}

const hostnameOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '';
  }
};

/** drpc refuses a 1000-block eth_getLogs on Arc with a misleading "ranges over 10000 blocks"; the rest take 1000. */
function arcLogChunk(endpoint: string): number {
  return hostnameOf(endpoint).includes('drpc') ? ARC_DRPC_LOG_CHUNK : ARC_LOG_CHUNK;
}

/**
 * The payout chain of `chainId`, its values read from the wallet's own tables; `reads` is the harness's side. Refuses
 * Ethereum Sepolia by name, and any chain the Send flow does not offer.
 */
export function payoutChainFor(
  chainId: number,
  reads: { rpcUrls: readonly string[]; logChunk(endpoint: string): number; label?: string; walletRpcName?: string }
): PayoutChain {
  if (chainId === ETHEREUM_SEPOLIA_CHAIN_ID) {
    throw new Error(
      'Ethereum Sepolia (11155111) is no harness payout chain: Circle consumes a burn to it but never pays it out ' +
        '(0xMiden/miden-usdcx#308)'
    );
  }
  const network = getBridgeNetworkByChainId(chainId);
  const evm = getChain(chainId);
  if (network === undefined || evm === undefined) throw new Error(`chain ${chainId} is not a Send destination`);
  const destination = getUsdcxDestination(chainId);
  return {
    chainId,
    chain: destination.chain,
    label: reads.label ?? network.name,
    rpcUrls: reads.rpcUrls,
    usdc: destination.usdc,
    burnDomain: destination.domain,
    attestationSourceDomain: ARC_CIRCLE_DOMAIN,
    logChunk: reads.logChunk,
    chip: `send-network-${network.id}`,
    reviewNetwork: network.id,
    networkName: network.name,
    explorer: evm.explorer,
    walletRpcUrl: evm.rpcUrl,
    walletRpcName: reads.walletRpcName ?? hostnameOf(evm.rpcUrl)
  };
}

export const ARC_PAYOUT: PayoutChain = payoutChainFor(ARC_CHAIN_ID, {
  rpcUrls: DEFAULT_ARC_RPCS,
  logChunk: arcLogChunk,
  label: 'Arc',
  walletRpcName: 'arc.io'
});
export const BASE_SEPOLIA_PAYOUT: PayoutChain = payoutChainFor(84532, {
  rpcUrls: DEFAULT_BASE_SEPOLIA_RPCS,
  logChunk: endpoint =>
    hostnameOf(endpoint) === hostnameOf(BASE_SEPOLIA_OFFICIAL_URL) ? BASE_OFFICIAL_LOG_CHUNK : L2_LOG_CHUNK
});
export const ARBITRUM_SEPOLIA_PAYOUT: PayoutChain = payoutChainFor(421614, {
  rpcUrls: DEFAULT_ARBITRUM_SEPOLIA_RPCS,
  logChunk: () => L2_LOG_CHUNK
});

/** viem's error text quotes the request URL, whose WalletConnect project id an operator's build may set. */
export function redactProjectId(text: string): string {
  return text.replace(/(projectId=)[^&\s"']+/g, '$1<redacted>');
}

/** Every wait in the Arc and Miden oracles runs on this, so unit tests drive time instead of sleeping. */
export interface ArcClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realArcClock: ArcClock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
};
