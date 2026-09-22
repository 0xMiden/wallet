/**
 * Deliberate-violation harness for the two consent guards.
 *
 * Two things are protected here and both are consent integrity, which is the
 * entire basis of the telemetry feature:
 *
 * 1. **The browser-level permission gate.** Firefox's own data-collection
 *    consent, ANDed with the wallet's setting. Its failure modes are silent in
 *    both directions — read an absent mechanism as a refusal and telemetry dies
 *    on Chrome and mobile; read a refusal as absence and we collect from someone
 *    who declined. Neither throws. So each direction gets its own mutation.
 *
 * 2. **The consent copy.** `helpImproveWalletDescription` is the string that
 *    makes the opt-in informed, so every clause in it is deleted in turn and the
 *    prompt's tests must notice. A disclosure nobody asserts on is a disclosure
 *    that quietly shrinks.
 *
 * Nothing is left on disk: every edited file is restored from an in-memory copy
 * before the next mutation runs, and the tree is checked at the end.
 *
 * Usage: node scripts/telemetry-consent-mutations.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const HELPERS = 'src/lib/settings/helpers.ts';
const EN_JSON = 'public/_locales/en/en.json';

const GATE_TEST = 'src/lib/telemetry/browser-consent.test.ts';
const COPY_TEST = 'src/screens/onboarding/common/HelpImproveWallet.test.tsx';

// ---------------------------------------------------------------------------
// Anchors, read from the tree so a drifted anchor fails loudly rather than
// silently matching nothing.
// ---------------------------------------------------------------------------

const GATE_BODY = `  if (!(await readMirroredSetting(TELEMETRY_STORAGE_KEY, DEFAULT_TELEMETRY))) return false;
  return isDataCollectionPermitted();`;

const GRANT_CHECK = `return Array.isArray(dataCollection) && dataCollection.includes(TECHNICAL_AND_INTERACTION);`;

const FAIL_CLOSED = `    ${GRANT_CHECK}
  } catch {
    return false;
  }`;

const ABSENT_KEY = `if (dataCollection === undefined) return true;`;
const EXTENSION_GUARD = `if (!isExtension()) return true;`;
const PERMISSION_NAME = `const TECHNICAL_AND_INTERACTION = 'technicalAndInteraction';`;

const DESCRIPTION =
  '"helpImproveWalletDescription": "Shares which parts of Wallet you use, where you get stuck, ' +
  "broad error categories, the app version, and your platform, so we can fix what's breaking. " +
  'If the app crashes, it also sends a crash report with the error and where it happened in the ' +
  'code, scrubbed to remove sensitive data before sending. Never your keys, recovery phrase, ' +
  'password, addresses, balances, amounts, or transaction contents. No tracking across other apps ' +
  'or sites, nothing used for advertising, and nothing sold or shared with data brokers. You can ' +
  'change this any time.",';

/**
 * Delete one clause from the disclosure. The whole string is the anchor, so a
 * clause that has already been reworded fails as a broken anchor instead of
 * quietly matching somewhere else in a 900-key file.
 */
function withoutClause(clause) {
  if (!DESCRIPTION.includes(clause)) throw new Error(`clause not in the disclosure: ${clause}`);
  return { file: EN_JSON, find: DESCRIPTION, replace: DESCRIPTION.replace(clause, '') };
}

const copyMutation = (clause, guards) => ({
  name: `the disclosure clause "${clause.trim()}" deleted`,
  test: COPY_TEST,
  guards,
  edits: [withoutClause(clause)]
});

/** Each entry: one broken promise, and the guard meant to notice. */
const MUTATIONS = [
  // -------------------------------------------------------------------------
  // The browser-level permission gate.
  // -------------------------------------------------------------------------
  {
    name: 'the browser permission never consulted at all (AND removed)',
    test: GATE_TEST,
    guards: 'sends nothing when the browser denies',
    edits: [
      {
        file: HELPERS,
        find: GATE_BODY,
        replace: `  return readMirroredSetting(TELEMETRY_STORAGE_KEY, DEFAULT_TELEMETRY);`
      }
    ]
  },
  {
    name: 'OR instead of AND, so either consent alone is enough',
    test: GATE_TEST,
    guards: 'sends nothing when the browser denies / when the wallet setting is off',
    edits: [
      {
        file: HELPERS,
        find: GATE_BODY,
        replace: `  const stored = await readMirroredSetting(TELEMETRY_STORAGE_KEY, DEFAULT_TELEMETRY);
  return stored || (await isDataCollectionPermitted());`
      }
    ]
  },
  {
    name: 'the permission read failing OPEN on a thrown error',
    test: GATE_TEST,
    guards: 'sends nothing when reading the permission throws',
    edits: [
      {
        file: HELPERS,
        find: FAIL_CLOSED,
        replace: `    ${GRANT_CHECK}
  } catch {
    return true;
  }`
      }
    ]
  },
  {
    name: 'an ABSENT data_collection key read as a refusal (breaks Chrome and old Firefox)',
    test: GATE_TEST,
    guards: 'still sends on Chrome, where the concept does not exist',
    edits: [{ file: HELPERS, find: ABSENT_KEY, replace: `if (dataCollection === undefined) return false;` }]
  },
  {
    name: 'a PRESENT data_collection key treated as a grant without reading it',
    test: GATE_TEST,
    guards: 'sends nothing when the browser denies (present-but-empty is a refusal)',
    edits: [{ file: HELPERS, find: GRANT_CHECK, replace: `return true;` }]
  },
  {
    name: 'the array guard dropped, so a bare string satisfies includes()',
    test: GATE_TEST,
    guards: 'is false when the browser answer is malformed rather than an array',
    edits: [
      {
        file: HELPERS,
        find: GRANT_CHECK,
        replace: `return dataCollection.includes(TECHNICAL_AND_INTERACTION);`
      }
    ]
  },
  {
    name: 'the extension guard inverted, so only non-extensions abstain correctly',
    test: GATE_TEST,
    guards: 'sends on mobile / sends nothing when the browser denies',
    edits: [{ file: HELPERS, find: EXTENSION_GUARD, replace: `if (isExtension()) return true;` }]
  },
  {
    name: 'off-extension failing CLOSED, which silently kills telemetry on iOS and Android',
    test: GATE_TEST,
    guards: 'sends on mobile, where there is no extension permission model at all',
    edits: [{ file: HELPERS, find: EXTENSION_GUARD, replace: `if (!isExtension()) return false;` }]
  },
  {
    name: 'the wrong data type checked, so our own permission is never the one read',
    test: GATE_TEST,
    guards: 'is true only when both consents agree',
    edits: [{ file: HELPERS, find: PERMISSION_NAME, replace: `const TECHNICAL_AND_INTERACTION = 'healthInfo';` }]
  },
  {
    name: 'the browser consulted before the local setting, leaking an API call for opted-out users',
    test: GATE_TEST,
    guards: 'does not consult the browser when the wallet setting is already off',
    edits: [
      {
        file: HELPERS,
        find: GATE_BODY,
        replace: `  if (!(await isDataCollectionPermitted())) return false;
  return readMirroredSetting(TELEMETRY_STORAGE_KEY, DEFAULT_TELEMETRY);`
      }
    ]
  },

  // -------------------------------------------------------------------------
  // The manifests and the gate naming the same permission.
  // -------------------------------------------------------------------------
  ...['public/manifest.json', 'public/manifest.v2.json'].map(file => ({
    name: `a different data type declared to Firefox in ${file}`,
    test: GATE_TEST,
    guards: 'is the same string in the manifest as the gate checks',
    edits: [{ file, find: `"optional": ["technicalAndInteraction"]`, replace: `"optional": ["healthInfo"]` }]
  })),

  // -------------------------------------------------------------------------
  // The consent copy — the new crash-reporting clause first, since it is the
  // one this run exists to protect.
  // -------------------------------------------------------------------------
  copyMutation('If the app crashes, ', 'names crash reporting — /if the app crashes/'),
  copyMutation('it also sends a crash report', 'names crash reporting — /crash report/'),
  copyMutation(' and where it happened in the code', 'names crash reporting — /where it happened in the code/'),
  copyMutation(', scrubbed to remove sensitive data before sending', 'names crash reporting — /scrubbed to remove sensitive data/'),
  {
    name: '"anonymous" smuggled into the new crash-reporting clause',
    test: COPY_TEST,
    guards: 'never claims anonymity, in the buttons or the body',
    edits: [
      {
        file: EN_JSON,
        find: DESCRIPTION,
        replace: DESCRIPTION.replace('it also sends a crash report', 'it also sends an anonymous crash report')
      }
    ]
  },

  // ...and every pre-existing clause, so the new assertions have not been
  // bolted onto a string whose other halves nobody checks.
  copyMutation('which parts of Wallet you use, ', 'names what IS collected — /which parts of Wallet you use/'),
  copyMutation('where you get stuck, ', 'names what IS collected — /where you get stuck/'),
  copyMutation('broad error categories, ', 'names what IS collected — /broad error categories/'),
  copyMutation('the app version, ', 'names what IS collected — /the app version/'),
  copyMutation('and your platform, ', 'names what IS collected — /your platform/'),
  copyMutation('Never your keys, ', 'names what is NOT collected — /never your keys/'),
  copyMutation('recovery phrase, ', 'names what is NOT collected — /recovery phrase/'),
  copyMutation('password, ', 'names what is NOT collected — /password/'),
  copyMutation('addresses, ', 'names what is NOT collected — /addresses/'),
  copyMutation('balances, ', 'names what is NOT collected — /balances/'),
  copyMutation('amounts, ', 'names what is NOT collected — /amounts/'),
  copyMutation('or transaction contents. ', 'names what is NOT collected — /transaction contents/'),
  copyMutation('No tracking across other apps or sites, ', 'rules out tracking — /no tracking across other apps or sites/'),
  copyMutation('nothing used for advertising, ', 'rules out advertising — /nothing used for advertising/'),
  copyMutation(
    'and nothing sold or shared with data brokers. ',
    'rules out sale to brokers — /nothing sold or shared with data brokers/'
  ),
  copyMutation('You can change this any time.', 'tells the user the choice is reversible — /change this any time/')
];

// ---------------------------------------------------------------------------

function apply(edit, restorers) {
  const path = resolve(ROOT, edit.file);
  const original = readFileSync(path, 'utf8');
  restorers.push(() => writeFileSync(path, original));
  if (!original.includes(edit.find)) throw new Error(`anchor not found in ${edit.file}:\n${edit.find}`);
  const mutated = original.replace(edit.find, edit.replace);
  if (mutated === original) throw new Error(`mutation changed nothing in ${edit.file}`);
  writeFileSync(path, mutated);
}

function run(testFile) {
  try {
    execFileSync('node', ['node_modules/.bin/jest', testFile], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    return { failed: false, output: '' };
  } catch (error) {
    return { failed: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const failingTests = output => [
  ...new Set([...output.matchAll(/●\s+(.+?)\s+›\s+(.+)/g)].map(match => `${match[2]}`.trim()))
];

/**
 * Content snapshot of every file a mutation can touch, taken before anything
 * runs and compared after everything has.
 *
 * Deliberately not `git status`: this harness is meant to be run while the
 * change it protects is still uncommitted, and a git-based check reports the
 * author's own work-in-progress as mutation residue. Comparing bytes answers
 * the question actually being asked — did every mutation get undone.
 */
const touched = [...new Set(MUTATIONS.flatMap(mutation => mutation.edits.map(edit => edit.file)))];
const snapshot = new Map(touched.map(file => [file, readFileSync(resolve(ROOT, file), 'utf8')]));

// A red baseline reports every mutation as killed, which is the one way this
// harness could claim a perfect score while proving nothing.
for (const testFile of [GATE_TEST, COPY_TEST]) {
  const baseline = run(testFile);
  if (baseline.failed) {
    console.error(`BASELINE IS RED for ${testFile} — every mutation below would report as killed for the wrong reason.`);
    console.error(baseline.output);
    process.exit(1);
  }
}
console.log('baseline: green (both suites)\n');

let killed = 0;
let survived = 0;
let broken = 0;

for (const [index, mutation] of MUTATIONS.entries()) {
  const restorers = [];
  const label = `${String(index + 1).padStart(2, '0')}. ${mutation.name}`;
  let result;
  try {
    for (const edit of mutation.edits) apply(edit, restorers);
    result = run(mutation.test);
  } catch (error) {
    broken++;
    console.log(`BROKEN  ${label}\n        ${error.message.split('\n')[0]}`);
    continue;
  } finally {
    for (const restore of restorers.reverse()) restore();
  }

  if (result.failed) {
    killed++;
    console.log(`KILLED  ${label}\n        tripped: ${failingTests(result.output).join('; ')}`);
  } else {
    survived++;
    console.log(`SURVIVED ${label}\n        guard that should have caught it: ${mutation.guards}`);
  }
}

console.log(`\n${killed} killed, ${survived} survived, ${broken} broken anchors, ${MUTATIONS.length} total`);

// A leftover mutation would silently poison every later run.
const unrestored = touched.filter(file => readFileSync(resolve(ROOT, file), 'utf8') !== snapshot.get(file));
if (unrestored.length > 0) {
  console.error(`\nNOT RESTORED:\n${unrestored.join('\n')}`);
  process.exit(1);
}
console.log('every mutated file restored byte-for-byte');

process.exit(survived === 0 && broken === 0 ? 0 : 1);
