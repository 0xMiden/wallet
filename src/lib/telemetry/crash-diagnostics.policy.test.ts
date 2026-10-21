import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  REOWN_NATIVE_ORIGINS,
  REOWN_WALLET_RESPONSE_CODES,
  REOWN_REQUEST_AGES,
  REOWN_PUBLICATIONS,
  REOWN_BACKGROUND_ANSWERS
} from 'lib/walletconnect/native-request-failure';

import {
  BACKGROUND_AGES,
  CONFIRMATION_HANDLER_STATES,
  CONFIRMATION_REGISTRY_STATES,
  CONFIRMATION_REQUEST_SHAPES,
  PAGE_NAVIGATIONS,
  PAGE_VISIBILITY,
  PROPOSAL_GUARDS,
  PROPOSAL_STEPS,
  STORAGE_OPERATIONS,
  STORAGE_OWNERS
} from './crash-diagnostics';
import {
  RELAY_CONNECTIVITY,
  RELAY_FAILURE_BUCKETS,
  RELAY_SERVICE,
  RELAY_SURFACES,
  RELAY_TRIGGERS,
  RELAY_VISIBILITY
} from './relay-diagnostics';
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
