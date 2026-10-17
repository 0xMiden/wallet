import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIRMATION_HANDLER_STATES } from './crash-diagnostics';
import { EXTENSION_VIEW_COUNTS, SHARED_MEMORY_PROBES } from './wasm-startup';

const crashReportPolicy = (): string => {
  const policy = readFileSync(join(__dirname, '..', '..', '..', 'docs/privacy/index.md'), 'utf8');
  const section = policy.slice(policy.indexOf('### Crash reports'));
  return section.slice(0, section.indexOf('\n#', 1));
};

// The sentence that describes the field, so a value listed for another field cannot stand in for it.
const sentenceAbout = (phrase: string): string =>
  crashReportPolicy()
    .split(/(?<=\.)\s+/)
    .find(sentence => sentence.includes(phrase)) ?? '';

it.each([
  ['shared memory', SHARED_MEMORY_PROBES],
  ["the App's own pages", EXTENSION_VIEW_COUNTS],
  ['dApp approval window', CONFIRMATION_HANDLER_STATES],
  ['reconnected', ['true', 'false']]
])('the privacy policy lists every value a crash report can carry for %s', (phrase, values) => {
  const sentence = sentenceAbout(phrase);
  expect(sentence).not.toBe('');
  for (const value of values) expect(sentence).toContain(`\`${value}\``);
});
