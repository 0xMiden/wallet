import { carryMainnetAccessCode } from 'lib/carried-mainnet-code';
import { resetStorageDestructive } from 'lib/miden/reset';
import { applyEndpointOverride, buildNetworkChoiceOverride } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { isExtension } from 'lib/platform';

/**
 * The step of a reset that did not finish. `prepare`: nothing was wiped. `wipe`: the wipe rejected,
 * part way or whole, and the reload still ran or is about to. `reload`: the wipe ran and no reload
 * started, so the closed storage handles and the in-memory state outlive it.
 */
export type ResetAndReloadStep = 'prepare' | 'wipe' | 'reload';

export class ResetAndReloadError extends Error {
  constructor(
    readonly step: ResetAndReloadStep,
    readonly cause: unknown
  ) {
    super(`The wallet reset did not finish at the ${step} step`);
    this.name = 'ResetAndReloadError';
  }
}

/**
 * Wipe the wallet (`resetStorageDestructive`) and reload, under that function's caller contract: report a
 * rejected wipe and then reload, and report a reload that cannot start. The endpoint override is kept.
 *
 * On the extension the page that calls this can close during the wipe (a popup closes when it loses
 * focus), and nothing after that await runs then, so a `pagehide` reload is armed before the wipe and
 * kept until this function's own reload has been attempted; the extension reloads once either way. The
 * polyfill is fetched first, since a `pagehide` listener cannot wait for an import, and a fetch that
 * fails stops the reset before the wipe. Off the extension there is no background worker to resync
 * with, so the page reloads in place.
 *
 * `onWipeError` runs when the wipe rejects, before the reload. Throws `ResetAndReloadError` for the
 * `prepare` and `reload` steps. `accessCode`, a mainnet code the node accepted before the switch, is
 * kept past the wipe for the mainnet code step.
 */
export async function resetWalletAndReload(
  onWipeError: (error: unknown) => Promise<void>,
  targetNetwork?: MIDEN_NETWORK_NAME,
  accessCode?: string
): Promise<void> {
  // Set by whichever extension reload runs first, the pagehide listener's or the one below, so it runs once.
  let reloaded = false;
  let reloadOnce: (() => void) | undefined;
  if (isExtension()) {
    try {
      // Dynamic import: `webextension-polyfill` throws at module-evaluation time when `chrome.runtime.id` is
      // absent, and this module is bundled for every platform.
      const browser = (await import('webextension-polyfill')).default;
      reloadOnce = () => {
        browser.runtime.reload();
        reloaded = true;
      };
      window.addEventListener('pagehide', reloadOnce, { once: true });
    } catch (error) {
      throw new ResetAndReloadError('prepare', error);
    }
  }
  try {
    try {
      await resetStorageDestructive();
      if (targetNetwork) await applyEndpointOverride(buildNetworkChoiceOverride(targetNetwork));
      // The wallet is already wiped and switched, so a code that cannot be kept is no failed reset:
      // the code step asks for it again.
      if (accessCode)
        await carryMainnetAccessCode(accessCode).catch(error =>
          console.warn('[reset-and-reload] Could not keep the accepted access code', error)
        );
    } catch (error) {
      await onWipeError(error);
    }
    try {
      if (reloadOnce) {
        // A listener reload that threw left the flag down, so this one retries and reports.
        if (!reloaded) reloadOnce();
      } else {
        window.location.reload();
      }
    } catch (error) {
      throw new ResetAndReloadError('reload', error);
    }
  } finally {
    if (reloadOnce) window.removeEventListener('pagehide', reloadOnce);
  }
}
