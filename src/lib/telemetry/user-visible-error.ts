import type { StartupEligibilityDiagnostics } from 'lib/remote-config/geo';

import { captureCrash } from './crash';
import { annotateCrash } from './crash-diagnostics';
import { annotateUiProducer, validateUiEvidence, type UiEvidenceInput } from './ui-producer-diagnostics';
import {
  USER_ERROR_IDS,
  USER_ERROR_SURFACES,
  isUserErrorId,
  type UserErrorId,
  type UserErrorSurface
} from './user-visible-error-contract';

export {
  USER_ERROR_IDS,
  USER_ERROR_SURFACES,
  isUserErrorId,
  type UserErrorId,
  type UserErrorSurface
} from './user-visible-error-contract';

// Closed compound names and their words must survive recovery-phrase scrubbing intact.
const CLOSED_NAMES: ReadonlySet<string> = new Set(
  [...USER_ERROR_IDS, ...USER_ERROR_SURFACES].flatMap(value => [value, ...value.split('_')])
);

const PAIR_INTERVAL_MS = 60_000;
const REALM_WINDOW_MS = 600_000;
const REALM_LIMIT = 30;
const lastSentByPair = new Map<string, number>();
let sentAt: number[] = [];

function isUserErrorSurface(value: unknown): value is UserErrorSurface {
  return USER_ERROR_SURFACES.some(surface => surface === value);
}

export function reportUserVisibleError(
  id: UserErrorId,
  surface: UserErrorSurface,
  diagnostics?: StartupEligibilityDiagnostics | UiEvidenceInput
): void {
  try {
    if (!isUserErrorId(id) || !isUserErrorSurface(surface)) return;
    const now = performance.now();
    const pair = `${id}:${surface}`;
    const lastSent = lastSentByPair.get(pair);
    if (lastSent !== undefined && now - lastSent < PAIR_INTERVAL_MS) return;
    sentAt = sentAt.filter(time => now - time < REALM_WINDOW_MS);
    if (sentAt.length >= REALM_LIMIT) return;

    const report = new Error(`User-visible error: ${id}; surface ${surface}`);
    report.name = 'WalletUserVisibleError';
    // A reporter stack identifies this call site, not the failure, and can contain private paths.
    report.stack = undefined;
    annotateCrash(report, {
      ...(id === 'walletAccessUnavailableBody' && surface === 'startup' ? diagnostics : {}),
      userErrorId: id,
      userErrorSurface: surface
    });
    const evidence = validateUiEvidence(id, surface, diagnostics);
    if (evidence) annotateUiProducer(report, id, surface, evidence);
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
