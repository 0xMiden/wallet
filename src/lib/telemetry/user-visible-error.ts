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

export const USER_ERROR_IDS = Object.freeze<readonly ['raw_send_submit_failed', 'usdcxFaucetUnavailable']>([
  'raw_send_submit_failed',
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
