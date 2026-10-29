import { simulatedBytesToView } from 'app/confirm/decode';
import { midenClientProxy, runsWasmInThisRealm } from 'lib/miden/back/miden-client-proxy';
import type { DryRunResult } from 'lib/miden/sdk/dry-run-request';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';
import { initBridgeConfig } from 'lib/remote-config/runtime';
import type { UsdcxBurnFeeEstimate } from 'lib/shared/types';

import { buildUsdcxBurnRequest } from './burn';
import type { BurnFeeFailure } from './burn-fee-failure';
import { getUsdcxDestination } from './constant';

/**
 * The amount the dry run burns. The fee follows the cycles of the burn, not its amount, so one
 * base unit gives the same fee as a full-balance burn, and every balance can fund it. A dry run of
 * the full balance would fail the same way the real burn does when the fee does not fit.
 */
const USDCX_BURN_FEE_PROBE_AMOUNT = 1n;

/**
 * The recipient the probe burns to. The withdrawal payload is a fixed-size encoding of the destination address, so
 * any well-formed address costs the same, and the estimate is keyed on the account and chain alone.
 */
export const USDCX_BURN_FEE_PROBE_RECIPIENT = '0x1111111111111111111111111111111111111111';

/**
 * Headroom on the measured fee, in percent. The kernel charges `baseFee x (floor(log2(cycles)) + 1)`,
 * so a real burn that takes a few more cycles than the dry run can move up one tier (one base fee).
 * 25% covers several tiers.
 */
const USDCX_BURN_FEE_MARGIN_PERCENT = 25n;

/** How long an estimate waits for the WASM lock. One that has not won it by then answers busy without a dry run. */
export const USDCX_BURN_FEE_LOCK_WAIT_MS = 30_000;

/**
 * The inline dry run's ceiling, counted from the moment the lock is held. Offscreen the proxy's own deadline on the
 * forwarded op bounds it instead: a JS timeout there is safe, since the WASM runs in that realm behind its mutex.
 */
const USDCX_BURN_FEE_DRY_RUN_DEADLINE_MS = 30_000;

const BUSY: UsdcxBurnFeeEstimate = { outcome: 'busy' };

const inFlight = new Map<string, Promise<UsdcxBurnFeeEstimate>>();

/**
 * How much of the native asset to hold back so that a USDCx burn can pay its own cost, in base units.
 *
 * A burn costs more than the static `FEE_RESERVE_MULTIPLE` reserve: on mainnet its fee plus the faucet execution
 * sponsorship came to 36 base fees against a reserve of 30, so a "Max" burn failed with a vault shortfall. This
 * dry-runs a burn of `USDCX_BURN_FEE_PROBE_AMOUNT` to the destination chain and measures everything the burn takes
 * from the vault in the native asset beyond the burned amount: the kernel's fee note and any other output the
 * transaction adds. The result includes `USDCX_BURN_FEE_MARGIN_PERCENT` headroom.
 *
 * The dry run goes through `midenClientProxy.dryRunTransaction`, so it never syncs or imports a note, and on the
 * extension it runs on the offscreen document's client rather than building the service worker's own. Concurrent
 * callers for one account and chain share the estimate in flight.
 *
 * Answers `measured` with the reserve, which is 0n for a burn that costs nothing, `busy` when the lock was not won
 * within `USDCX_BURN_FEE_LOCK_WAIT_MS` so nothing ran, and `failed` when the dry run could not measure the cost (it
 * failed, its result did not show the probe, or the destination is not configured). A WebAssembly trap is rethrown,
 * never read as an unmeasured cost.
 */
export function estimateUsdcxBurnFeeReserve(
  accountPublicKey: string,
  destinationChainId: number
): Promise<UsdcxBurnFeeEstimate> {
  const key = `${accountPublicKey}|${destinationChainId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const estimate = measureBurnFeeReserve(accountPublicKey, destinationChainId).finally(() => inFlight.delete(key));
  inFlight.set(key, estimate);
  return estimate;
}

async function measureBurnFeeReserve(
  accountPublicKey: string,
  destinationChainId: number
): Promise<UsdcxBurnFeeEstimate> {
  let failure: BurnFeeFailure = 'configuration_failed';
  try {
    // This handler can run before the realm hydrated the bridge config, and the burn request reads
    // the USDCx faucet and the destination domain from it.
    await initBridgeConfig();
    const { domain } = getUsdcxDestination(destinationChainId);
    failure = 'native_asset_failed';
    const nativeFaucetId = await getNativeAssetId();
    failure = 'request_build_failed';
    const { requestBytes } = buildUsdcxBurnRequest(
      accountPublicKey,
      USDCX_BURN_FEE_PROBE_AMOUNT,
      USDCX_BURN_FEE_PROBE_RECIPIENT,
      domain
    );
    failure = 'dry_run_failed';
    const result = await dryRunUnderLock(accountRefToSdk(accountPublicKey).toString(), requestBytes);
    if (result === null) {
      console.warn('[usdcx burn fee] the WASM lock stayed busy, so no dry run ran');
      return BUSY;
    }
    failure = 'result_decode_failed';
    const view = simulatedBytesToView(result);
    if (!view) return { outcome: 'failed', failure };
    const fee = view.fee?.faucetId === nativeFaucetId ? view.fee.amount : 0n;
    const outgoing = view.outgoing
      .filter(asset => asset.faucetId === nativeFaucetId)
      .reduce((sum, asset) => sum + asset.amount, 0n);
    const cost = fee + outgoing - USDCX_BURN_FEE_PROBE_AMOUNT;
    // The probe's own unit leaves as a native output, so a correct match never costs less than zero. A result that
    // shows less matched the wrong faucet: a failed measurement, not a free burn.
    if (cost < 0n || outgoing < USDCX_BURN_FEE_PROBE_AMOUNT) return { outcome: 'failed', failure: 'probe_mismatch' };
    return { outcome: 'measured', reserve: cost + (cost * USDCX_BURN_FEE_MARGIN_PERCENT + 99n) / 100n };
  } catch (err) {
    // The lock has already retired the client for a trap; reading it as "unmeasured" would hide it from every caller.
    if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) throw err;
    console.warn('[usdcx burn fee] could not estimate the burn fee', err);
    return { outcome: 'failed', failure };
  }
}

/** The dry run under the WASM lock, or null when the lock was not won within `USDCX_BURN_FEE_LOCK_WAIT_MS`. */
function dryRunUnderLock(accountIdHex: string, requestBytes: Uint8Array): Promise<DryRunResult | null> {
  let gaveUp = false;
  let lockWaitTimer: ReturnType<typeof setTimeout> | undefined;
  const lockWait = new Promise<null>(resolve => {
    lockWaitTimer = setTimeout(() => {
      gaveUp = true;
      resolve(null);
    }, USDCX_BURN_FEE_LOCK_WAIT_MS);
  });
  const label = 'usdcx-burn-fee';
  const dryRun = withWasmClientLock(
    async hold => {
      clearTimeout(lockWaitTimer);
      // Nobody waits for an estimate that gave up, so its hold ends before any call on the client.
      if (gaveUp) return null;
      return midenClientProxy.dryRunTransaction(accountIdHex, requestBytes, hold);
    },
    runsWasmInThisRealm() ? { watchdogMs: USDCX_BURN_FEE_DRY_RUN_DEADLINE_MS, label } : { label }
  );
  return Promise.race([dryRun, lockWait]);
}
