import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  STARTUP_ELIGIBILITY_STAGES,
  STARTUP_ELIGIBILITY_REASONS,
  STARTUP_ELIGIBILITY_RETRIES
} from 'lib/remote-config/geo';
import {
  REOWN_NATIVE_ORIGINS,
  REOWN_WALLET_RESPONSE_CODES,
  REOWN_REQUEST_AGES,
  REOWN_PUBLICATIONS,
  REOWN_BACKGROUND_ANSWERS
} from 'lib/walletconnect/native-request-failure';

import {
  BACKGROUND_AGES,
  COMPLETION_GUARDS,
  COMPLETION_STEPS,
  CONFIRMATION_HANDLER_STATES,
  CONFIRMATION_REGISTRY_STATES,
  CONFIRMATION_REQUEST_SHAPES,
  CONSUME_VERDICTS,
  GUARDIAN_SIGNER_IN_SET,
  GUARDIAN_SIGNING_KEYS,
  HOT_KEY_ROTATION_PENDING,
  PAGE_NAVIGATIONS,
  PAGE_VISIBILITY,
  PROPOSAL_GUARDS,
  PROPOSAL_STEPS,
  SECURITY_CHANGE_ACTIONS,
  STORAGE_OPERATIONS,
  STORAGE_OWNERS
} from './crash-diagnostics';
import {
  DIAGNOSTIC_DURATIONS,
  DIAGNOSTIC_END_OUTCOMES,
  DIAGNOSTIC_LOG_EVENTS,
  DIAGNOSTIC_OPERATIONS,
  DIAGNOSTIC_STEP_OUTCOMES,
  DIAGNOSTIC_STEPS
} from './diagnostic-log-contract';
import { PROOF_WAIT_AVAILABILITIES } from './proof-wait-availability-diagnostics';
import {
  RELAY_CONNECTIVITY,
  RELAY_FAILURE_BUCKETS,
  RELAY_SERVICE,
  RELAY_SURFACES,
  RELAY_TRIGGERS,
  RELAY_VISIBILITY
} from './relay-diagnostics';
import { EXECUTION_ROUTES, AUTH_OBSERVATIONS, AUTH_ARG_PRESENCE } from './transaction-execution-diagnostics';
import {
  FEATURE_UNAVAILABLE_FEATURES,
  FEATURE_UNAVAILABLE_REASONS,
  SUBMISSION_FEEDBACK_BRANCHES,
  PENDING_RETRY_REASONS,
  RECIPIENT_VALIDATION_STAGES
} from './ui-producer-diagnostics';
import { USER_ERROR_IDS, USER_ERROR_SURFACES } from './user-visible-error';
import { EXTENSION_VIEW_COUNTS, SHARED_MEMORY_PROBES } from './wasm-startup';

const crashReportPolicy = (): string => {
  const policy = readFileSync(join(__dirname, '..', '..', '..', 'docs/privacy/index.md'), 'utf8');
  const section = policy.slice(policy.indexOf('### Crash reports'));
  return section.slice(0, section.indexOf('\n#', 1));
};

// The backticked values in the parenthetical that follows the field's phrase, so two fields in one sentence are
// each read from their own list.
const listedAfter = (text: string, phrase: string): string[] => {
  const at = text.indexOf(phrase);
  if (at === -1) return [];
  const open = text.indexOf('(', at + phrase.length);
  const close = text.indexOf(')', open);
  if (open === -1 || close === -1) return [];
  return [...text.slice(open, close).matchAll(/`([^`]+)`/g)].map(match => match[1] ?? '');
};

const FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['the execution route', EXECUTION_ROUTES],
  ['Proof-wait availability', PROOF_WAIT_AVAILABILITIES],
  ['the authentication observation', AUTH_OBSERVATIONS],
  ['auth argument presence', AUTH_ARG_PRESENCE],
  ['Startup eligibility stage', STARTUP_ELIGIBILITY_STAGES],
  ['startup eligibility reason', STARTUP_ELIGIBILITY_REASONS],
  ['startup eligibility retry', STARTUP_ELIGIBILITY_RETRIES],
  ["the node's consume verdict", CONSUME_VERDICTS],
  ['storage owner', STORAGE_OWNERS],
  ['storage operation', STORAGE_OPERATIONS],
  ['page visibility', PAGE_VISIBILITY],
  ['which message it was', USER_ERROR_IDS],
  ['which kind of display showed it', USER_ERROR_SURFACES],
  ['shared memory could still grow', SHARED_MEMORY_PROBES],
  ["the App's own pages", EXTENSION_VIEW_COUNTS],
  ['the state the background held for that approval', CONFIRMATION_HANDLER_STATES],
  ['the shape of the id the request carried', CONFIRMATION_REQUEST_SHAPES],
  ['what the background still remembered of recent approvals', CONFIRMATION_REGISTRY_STATES],
  ['how long the background had been running', BACKGROUND_AGES],
  ['how the approval window was last loaded', PAGE_NAVIGATIONS],
  ['reconnected to the background', ['true', 'false']],
  ['the preparation step that failed', PROPOSAL_STEPS],
  ['which check refused it', PROPOSAL_GUARDS],
  ['which security change failed', SECURITY_CHANGE_ACTIONS],
  ['two fixed events', DIAGNOSTIC_LOG_EVENTS],
  ['the operation it is about', DIAGNOSTIC_OPERATIONS],
  ['the step it describes', DIAGNOSTIC_STEPS],
  ['how that step ended', DIAGNOSTIC_STEP_OUTCOMES],
  ['how the operation ended', DIAGNOSTIC_END_OUTCOMES],
  ['how long it took, as a range', DIAGNOSTIC_DURATIONS],
  ['the finishing step that failed', COMPLETION_STEPS],
  ['which finishing check refused it', COMPLETION_GUARDS],
  ["is one of the account's signers on chain", GUARDIAN_SIGNER_IN_SET],
  ["which of the account's keys signed it", GUARDIAN_SIGNING_KEYS],
  ['still waiting for its everyday key to be replaced', HOT_KEY_ROTATION_PENDING],
  ['the label that says so', [RELAY_SERVICE]],
  ['changed in the 30 seconds before', RELAY_CONNECTIVITY],
  ["whether the App's window was on screen", RELAY_VISIBILITY],
  ['which App window it was', RELAY_SURFACES],
  ['whether the connect-wallet screen was open in that window', RELAY_TRIGGERS],
  ['whether the relay had connected in that window before', ['true', 'false']],
  ['how many relay failures that window had seen', RELAY_FAILURE_BUCKETS],
  ['; native origin', REOWN_NATIVE_ORIGINS],
  ['; wallet response code', REOWN_WALLET_RESPONSE_CODES],
  ['; request age', REOWN_REQUEST_AGES],
  ['; publication observation', REOWN_PUBLICATIONS],
  ['; background observation', REOWN_BACKGROUND_ANSWERS]
];

it.each(FIELDS)('the privacy policy lists exactly the values a crash report can carry after "%s"', (phrase, values) => {
  expect(new Set(listedAfter(crashReportPolicy(), phrase))).toEqual(new Set(values));
});

const mutationCases = FIELDS.flatMap(([phrase, values]) => values.map(value => ({ phrase, value })));

it.each(mutationCases)(
  'detects a missing $value or an extra value only in the list for "$phrase"',
  ({ phrase, value }) => {
    const policy = crashReportPolicy();
    const at = policy.indexOf(phrase);
    const open = at === -1 ? -1 : policy.indexOf('(', at + phrase.length);
    const close = open === -1 ? -1 : policy.indexOf(')', open);
    const list = policy.slice(open, close);
    const missing = policy.slice(0, open) + list.replace(`\`${value}\``, '') + policy.slice(close);
    const extra = policy.slice(0, close) + ', `unlisted_storage_value`' + policy.slice(close);
    expect(missing).not.toBe(policy);
    expect(extra).not.toBe(policy);
    for (const [registered, values] of FIELDS) {
      expect(new Set(listedAfter(missing, registered))).toEqual(
        new Set(registered === phrase ? values.filter(listed => listed !== value) : values)
      );
      expect(new Set(listedAfter(extra, registered))).toEqual(
        new Set(registered === phrase ? [...values, 'unlisted_storage_value'] : values)
      );
    }
  }
);

it("tells a value missing from one field's list, or listed but never sent, from a correct list", () => {
  const policy = crashReportPolicy();
  const withoutViewsValue = policy.replace('`4+` or `unavailable`)', '`4+`)');
  expect(withoutViewsValue).not.toBe(policy);
  expect(new Set(listedAfter(withoutViewsValue, "the App's own pages"))).not.toEqual(new Set(EXTENSION_VIEW_COUNTS));
  expect(new Set(listedAfter(withoutViewsValue, 'shared memory could still grow'))).toEqual(
    new Set(SHARED_MEMORY_PROBES)
  );
  const withExtraValue = policy.replace('`grew`,', '`grew`, `shrank`,');
  expect(withExtraValue).not.toBe(policy);
  expect(new Set(listedAfter(withExtraValue, 'shared memory could still grow'))).not.toEqual(
    new Set(SHARED_MEMORY_PROBES)
  );
});

it('states the retention of the diagnostic records once, apart from the 90 days of crash reports', () => {
  const policy = readFileSync(join(__dirname, '..', '..', '..', 'docs/privacy/index.md'), 'utf8');
  const section = (heading: string) => {
    const start = policy.indexOf(`## ${heading}`);
    return policy.slice(start, policy.indexOf('\n## ', start + 1));
  };
  const retention = section('How long we keep data')
    .split('\n')
    .filter(line => line.startsWith('- '));
  const ninetyDays = retention.filter(line => line.includes('90 days') && !line.includes('30 days'));
  expect(ninetyDays.some(line => /diagnostic records/i.test(line))).toBe(false);
  expect(retention.filter(line => line.includes('Diagnostic records') && line.includes('30 days'))).toHaveLength(1);
  expect(section('Who processes this data')).not.toContain('Sentry are configured to delete data after 90 days');
});

it.each([
  ['featureUnavailableFeature', FEATURE_UNAVAILABLE_FEATURES],
  ['featureUnavailableReason', FEATURE_UNAVAILABLE_REASONS],
  ['submissionFeedbackBranch', SUBMISSION_FEEDBACK_BRANCHES],
  ['pendingRetryReason', PENDING_RETRY_REASONS],
  ['recipientValidationStage', RECIPIENT_VALIDATION_STAGES]
] as const)('documents the exact closed UI producer values for %s', (field, values) => {
  expect(new Set(listedAfter(crashReportPolicy(), field))).toEqual(new Set(values));
});

it('documents every closed burnFeeFailure value', () => {
  expect(new Set(listedAfter(crashReportPolicy(), 'burnFeeFailure'))).toEqual(
    new Set([
      'configuration_failed',
      'native_asset_failed',
      'request_build_failed',
      'dry_run_failed',
      'result_decode_failed',
      'probe_mismatch',
      'busy_exhausted',
      'request_failed',
      'estimate_failed'
    ])
  );
});

it.each([
  ['mainnetAccessCheckFailure', ['endpoint_resolve', 'sdk_ready', 'rpc_client', 'invitation_check', 'unrecorded']],
  ['noteClaimFailureOrigin', ['queue_single', 'queue_batch', 'transaction_row']],
  ['uiFailureKind', ['network', 'rpc', 'proving', 'validation', 'storage', 'access_denied', 'timeout', 'unknown', 'unavailable']]
])('documents exact caller categories for %s', (field, values) => {
  expect(new Set(listedAfter(crashReportPolicy(), field))).toEqual(new Set(values));
});
