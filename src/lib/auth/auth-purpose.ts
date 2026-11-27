import { getMessage } from 'lib/i18n';

const REASON_KEYS = {
  unlock: 'authReasonUnlock',
  'view-recovery-phrase': 'authReasonViewRecoveryPhrase',
  'reveal-private-key': 'authReasonRevealPrivateKey',
  'reveal-everyday-key': 'authReasonRevealEverydayKey',
  'export-account-file': 'authReasonExportAccountFile',
  'export-wallet-file': 'authReasonExportWalletFile',
  'change-spending-limit': 'authReasonChangeSpendingLimit',
  'over-limit-transaction': 'authReasonOverLimitTransaction',
  'remove-device': 'authReasonRemoveDevice',
  'switch-guardian': 'authReasonSwitchGuardian',
  'set-up': 'authReasonSetUp'
} as const;

/** The action a device authentication prompt is for. Callers name one; they never send prompt text. */
export type AuthPurpose = keyof typeof REASON_KEYS;

/** The localized prompt text. An unknown value (the intercom is untyped at runtime) gives no text, so native uses its own. */
export const authPromptReason = (purpose: AuthPurpose): string | undefined =>
  Object.prototype.hasOwnProperty.call(REASON_KEYS, purpose) ? getMessage(REASON_KEYS[purpose]) : undefined;
