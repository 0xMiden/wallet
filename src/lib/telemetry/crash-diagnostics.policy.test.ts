import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIRMATION_HANDLER_STATES } from './crash-diagnostics';
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
  ['shared memory could still grow', SHARED_MEMORY_PROBES],
  ["the App's own pages", EXTENSION_VIEW_COUNTS],
  ['the state the background held for that approval', CONFIRMATION_HANDLER_STATES],
  ['reconnected to the background', ['true', 'false']]
];

it.each(FIELDS)('the privacy policy lists exactly the values a crash report can carry after "%s"', (phrase, values) => {
  expect(new Set(listedAfter(crashReportPolicy(), phrase))).toEqual(new Set(values));
});

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
