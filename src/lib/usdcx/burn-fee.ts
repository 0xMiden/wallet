import { simulatedBytesToView } from 'app/confirm/decode';
import { simulateCustomTransaction } from 'lib/miden/back/simulate-custom-tx';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';
import { initBridgeConfig } from 'lib/remote-config/runtime';
import { u8ToB64 } from 'lib/shared/helpers';

import { buildUsdcxBurnRequest } from './burn';
import { getUsdcxDestination } from './constant';

/**
 * The amount the dry run burns. The fee follows the cycles of the burn, not its amount, so one
 * base unit gives the same fee as a full-balance burn, and every balance can fund it. A dry run of
 * the full balance would fail the same way the real burn does when the fee does not fit.
 */
const USDCX_BURN_FEE_PROBE_AMOUNT = 1n;

/**
 * Headroom on the measured fee, in percent. The kernel charges `baseFee x (floor(log2(cycles)) + 1)`,
 * so a real burn that takes a few more cycles than the dry run can move up one tier (one base fee).
 * 25% covers several tiers.
 */
const USDCX_BURN_FEE_MARGIN_PERCENT = 25n;

/**
 * How much of the native asset to hold back so that a USDCx burn can pay its own cost, in base units.
 *
 * A burn costs more than the static `FEE_RESERVE_MULTIPLE` reserve: on mainnet a burn paid 36 base
 * fees against a reserve of 30, so a "Max" burn failed with a vault shortfall. This dry-runs a burn of
 * `USDCX_BURN_FEE_PROBE_AMOUNT` to the same destination and measures everything the burn takes from
 * the vault in the native asset beyond the burned amount: the kernel's fee note and any other output
 * the transaction adds. The result includes `USDCX_BURN_FEE_MARGIN_PERCENT` headroom.
 *
 * Returns `null` when the dry run cannot measure the cost (the simulation failed or timed out, or the
 * destination is not configured). The caller then falls back to the static reserve.
 */
export async function estimateUsdcxBurnFeeReserve(
  senderPublicKey: string,
  destinationAddress: string,
  destinationChainId: number
): Promise<bigint | null> {
  try {
    // This handler can run before the realm hydrated the bridge config, and the burn request reads
    // the USDCx faucet and the destination domain from it.
    await initBridgeConfig();
    const { domain } = getUsdcxDestination(destinationChainId);
    const nativeFaucetId = await getNativeAssetId();
    const { requestBytes } = buildUsdcxBurnRequest(
      senderPublicKey,
      USDCX_BURN_FEE_PROBE_AMOUNT,
      destinationAddress,
      domain
    );
    const result = await simulateCustomTransaction({
      address: senderPublicKey,
      transactionRequest: u8ToB64(requestBytes)
    });
    if (result.error) {
      console.warn('[usdcx burn fee] the dry run failed', result.error);
      return null;
    }
    const view = simulatedBytesToView(result);
    if (!view) return null;
    const fee = view.fee?.faucetId === nativeFaucetId ? view.fee.amount : 0n;
    const outgoing = view.outgoing
      .filter(asset => asset.faucetId === nativeFaucetId)
      .reduce((sum, asset) => sum + asset.amount, 0n);
    const cost = fee + outgoing - USDCX_BURN_FEE_PROBE_AMOUNT;
    if (cost <= 0n) return null;
    return cost + (cost * USDCX_BURN_FEE_MARGIN_PERCENT + 99n) / 100n;
  } catch (err) {
    console.warn('[usdcx burn fee] could not estimate the burn fee', err);
    return null;
  }
}
