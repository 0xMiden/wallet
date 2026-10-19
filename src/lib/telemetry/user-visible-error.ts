import { captureCrash } from './crash';
import { annotateCrash } from './crash-diagnostics';

export const USER_ERROR_SURFACES = Object.freeze<
  readonly [
    'inline',
    'field',
    'passcode',
    'notice',
    'review',
    'dialog',
    'status_screen',
    'prompt',
    'startup',
    'browser_alert',
    'os_notification',
    'native_toast'
  ]
>([
  'inline',
  'field',
  'passcode',
  'notice',
  'review',
  'dialog',
  'status_screen',
  'prompt',
  'startup',
  'browser_alert',
  'os_notification',
  'native_toast'
]);

export type UserErrorSurface = (typeof USER_ERROR_SURFACES)[number];

export const USER_ERROR_IDS = Object.freeze<
  readonly [
    'biometricFailed',
    'confirmError',
    'couldNotDecodeTransaction',
    'couldNotVerifyBySimulation',
    'dappLoadFailed',
    'devEndpointSaveFailed',
    'earnUnavailableOnNetwork',
    'failedToParseSigningPayload',
    'guardianEndpointUnchanged',
    'guardianSwitchAlreadyInProgress',
    'guardianUrlMismatch',
    'guardianUrlNoOnChainGuardian',
    'guardianUrlStaleRetry',
    'guardianUrlUnreachable',
    'hiddenTokensError',
    'hiddenTokensUnreadable',
    'incorrectPasscode',
    'incorrectPassword',
    'invalidPayload',
    'invalidUrl',
    'raw_account_export_failed',
    'raw_bridge_connect_failed',
    'raw_confirm_approval_failed',
    'raw_confirm_payload_failed',
    'raw_dapp_approval_failed',
    'raw_faucet_id_save_failed',
    'raw_guardian_replace_hot_key_failed',
    'raw_guardian_switch_failed',
    'raw_guardian_url_save_failed',
    'raw_secret_reveal_failed',
    'raw_seed_remove_failed',
    'raw_seed_reveal_failed',
    'raw_seed_verification_reveal_failed',
    'raw_send_submit_failed',
    'required',
    'seedRemovalFailed',
    'smthWentWrong',
    'spendingLimitInvalidAmount',
    'spendingLimitLoadFailed',
    'spendingLimitSaveFailed',
    'tokenDecimalsInvalid',
    'tokenMetadataSaveError',
    'tokenNameInvalid',
    'tokenSymbolInvalid',
    'unlockPasswordErrorDelay',
    'usdcxFaucetUnavailable'
  ]
>([
  'biometricFailed',
  'confirmError',
  'couldNotDecodeTransaction',
  'couldNotVerifyBySimulation',
  'dappLoadFailed',
  'devEndpointSaveFailed',
  'earnUnavailableOnNetwork',
  'failedToParseSigningPayload',
  'guardianEndpointUnchanged',
  'guardianSwitchAlreadyInProgress',
  'guardianUrlMismatch',
  'guardianUrlNoOnChainGuardian',
  'guardianUrlStaleRetry',
  'guardianUrlUnreachable',
  'hiddenTokensError',
  'hiddenTokensUnreadable',
  'incorrectPasscode',
  'incorrectPassword',
  'invalidPayload',
  'invalidUrl',
  'raw_account_export_failed',
  'raw_bridge_connect_failed',
  'raw_confirm_approval_failed',
  'raw_confirm_payload_failed',
  'raw_dapp_approval_failed',
  'raw_faucet_id_save_failed',
  'raw_guardian_replace_hot_key_failed',
  'raw_guardian_switch_failed',
  'raw_guardian_url_save_failed',
  'raw_secret_reveal_failed',
  'raw_seed_remove_failed',
  'raw_seed_reveal_failed',
  'raw_seed_verification_reveal_failed',
  'raw_send_submit_failed',
  'required',
  'seedRemovalFailed',
  'smthWentWrong',
  'spendingLimitInvalidAmount',
  'spendingLimitLoadFailed',
  'spendingLimitSaveFailed',
  'tokenDecimalsInvalid',
  'tokenMetadataSaveError',
  'tokenNameInvalid',
  'tokenSymbolInvalid',
  'unlockPasswordErrorDelay',
  'usdcxFaucetUnavailable'
]);

export type UserErrorId = (typeof USER_ERROR_IDS)[number];

// Closed compound names and their words must survive recovery-phrase scrubbing intact.
const CLOSED_NAMES: ReadonlySet<string> = new Set(
  [...USER_ERROR_IDS, ...USER_ERROR_SURFACES].flatMap(value => [value, ...value.split('_')])
);

const PAIR_INTERVAL_MS = 60_000;
const REALM_WINDOW_MS = 600_000;
const REALM_LIMIT = 30;
const lastSentByPair = new Map<string, number>();
let sentAt: number[] = [];

export function isUserErrorId(value: unknown): value is UserErrorId {
  return USER_ERROR_IDS.some(id => id === value);
}

function isUserErrorSurface(value: unknown): value is UserErrorSurface {
  return USER_ERROR_SURFACES.some(surface => surface === value);
}

export function reportUserVisibleError(id: UserErrorId, surface: UserErrorSurface): void {
  try {
    if (!isUserErrorId(id) || !isUserErrorSurface(surface)) return;
    const now = Date.now();
    const pair = `${id}:${surface}`;
    const lastSent = lastSentByPair.get(pair);
    if (lastSent !== undefined && now - lastSent < PAIR_INTERVAL_MS) return;
    sentAt = sentAt.filter(time => now - time < REALM_WINDOW_MS);
    if (sentAt.length >= REALM_LIMIT) return;

    const report = new Error(`User-visible error: ${id}; surface ${surface}`);
    report.name = 'WalletUserVisibleError';
    // A reporter stack identifies this call site, not the failure, and can contain private paths.
    report.stack = undefined;
    annotateCrash(report, { userErrorId: id, userErrorSurface: surface });
    lastSentByPair.set(pair, now);
    sentAt.push(now);
    captureCrash(report, 'manual', { initializeIfNeeded: true, level: 'warning', closedNames: CLOSED_NAMES });
  } catch {
    // Reporting must never interrupt the error display.
  }
}

export function _resetUserVisibleErrorLimitsForTest(): void {
  lastSentByPair.clear();
  sentAt = [];
}
