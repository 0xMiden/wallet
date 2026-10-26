import { AllowedPrivateData, PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';

/**
 * Human-readable list of the private-data categories an `AllowedPrivateData`
 * bitmask covers, e.g. `"Assets, Notes"`. Empty string for
 * `AllowedPrivateData.None`.
 *
 * Shared by every platform's connect prompt — the extension popup's
 * `PrivateDataPermissionBanner`, the mobile `DappConfirmationModal` and the
 * desktop `DesktopDappConfirmationModal` — so the three cannot describe the same
 * grant differently. It is only true while all three IMPORT it: the extension
 * banner used to keep a private copy, and it had already drifted (it branched on
 * `privateDataPermission === Auto` alone, so an `Auto` request with an empty
 * `AllowedPrivateData` mask promised standing access the handlers never grant).
 * The category names are the wire-level names from the wallet adapter and are
 * deliberately not translated, matching the extension banner they were lifted
 * from.
 */
export function formatAllowedPrivateData(data: AllowedPrivateData): string {
  const parts: string[] = [];
  if (data & AllowedPrivateData.Assets) parts.push('Assets');
  if (data & AllowedPrivateData.Notes) parts.push('Notes');
  if (data & AllowedPrivateData.Storage) parts.push('Storage');
  return parts.join(', ');
}

/**
 * True when approving this request would hand the origin STANDING access to
 * private account data — `Auto` permission with at least one category allowed.
 * Under `Auto` the three private-data handlers in `lib/miden/back/dapp.ts`
 * short-circuit and serve without ever prompting again, so this is the case
 * that needs an explicit, informed gesture from the user rather than a bare
 * "Approve".
 */
export function grantsStandingPrivateDataAccess(
  privateDataPermission: PrivateDataPermission | undefined,
  allowedPrivateData: AllowedPrivateData | undefined
): boolean {
  return (
    privateDataPermission === PrivateDataPermission.Auto &&
    (allowedPrivateData ?? AllowedPrivateData.None) !== AllowedPrivateData.None
  );
}
