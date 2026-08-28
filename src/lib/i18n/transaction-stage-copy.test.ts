/**
 * Every stage the transaction pipeline can stamp must have copy in en.json.
 *
 * WHY THIS EXISTS. The in-progress transaction view does not call
 * `t('transactionStageProving')`; it calls `t(getStageTitleKey(stage))`. That is
 * a DYNAMIC key, and `key-coverage.test.ts` says so in its own docs: it matches
 * `t('literal')` only and is "a floor on coverage, not a ceiling". So the whole
 * stage-copy family — the largest dynamic key family in the app, and the one that
 * grows every time a pipeline stage is added — sat outside every i18n check.
 * `yarn lint:i18n` cannot see it either: the raw strings are in the helper's
 * return statements, not in JSX.
 *
 * Adding a stage is therefore the exact shape of change that ships a blank title
 * to the screen a user stares at while their transaction runs. `signing-locally`
 * (the offline guardian rotation) was one.
 *
 * The stage list is the source of truth, so this test cannot go stale: a new
 * member of `TRANSACTION_STAGES` is checked the moment it exists, with no test
 * edit at all.
 */

import fs from 'fs';
import path from 'path';

import { TRANSACTION_STAGES } from 'lib/miden/db/types';
import { GUARDIAN_TRANSACTION_STEPS, STANDARD_TRANSACTION_STEPS } from 'screens/generating-transaction/constants';
import { getStageDescriptionKey, getStageTitleKey } from 'screens/generating-transaction/helper';

const englishKeys: Record<string, string> = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../public/_locales/en/en.json'), 'utf8')
);

describe('stage copy resolved through dynamic keys exists in en.json', () => {
  it.each(TRANSACTION_STAGES)('has a non-empty title and description for the %s stage', stage => {
    for (const key of [getStageTitleKey(stage), getStageDescriptionKey(stage)]) {
      expect(typeof englishKeys[key]).toBe('string');
      expect(englishKeys[key]).not.toBe('');
    }
  });

  // The step rows are the other dynamic family on the same screen: each step's
  // `labelKey` reaches `t()` through the step definition, never as a literal.
  it.each([...GUARDIAN_TRANSACTION_STEPS, ...STANDARD_TRANSACTION_STEPS])('has copy for the $id step row', step => {
    expect(typeof englishKeys[step.labelKey]).toBe('string');
    expect(englishKeys[step.labelKey]).not.toBe('');
  });
});
