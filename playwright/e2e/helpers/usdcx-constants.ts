/**
 * The fixed numbers of the USDCx live suites (spec section 5) and the Arc Testnet addresses, read from the product's
 * own tables so the harness and the wallet cannot drift apart. Nothing here reads the environment.
 */
import os from 'os';
import path from 'path';
import type { Address, Hex } from 'viem';

import { getUsdcxXReserveSource } from '../../../src/lib/usdcx/constant';
import { ARC_TESTNET } from '../../../src/lib/walletconnect/config';

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

/** Every wait in the Arc and Miden oracles runs on this, so unit tests drive time instead of sleeping. */
export interface ArcClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realArcClock: ArcClock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
};
