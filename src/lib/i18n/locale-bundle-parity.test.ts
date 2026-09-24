import fs from 'fs';
import path from 'path';

/**
 * Guards on the SHIPPED locale artefacts. Two files exist per locale and they are
 * not interchangeable:
 *
 *   - `public/_locales/<loc>/messages.json` — Chrome-extension format, produced by
 *     the CI DeepL job (`utility/generateLanguageFiles.ts`).
 *   - `public/_locales/<loc>/<loc>.json` — the FLAT map `src/i18n.ts` imports and
 *     hands to i18next as `resources`. Every `t('…')` in the app resolves against
 *     this one, so it is the file the user actually sees.
 *
 * The flat bundle is derived from `messages.json` by `format-locales.js`. That
 * step used to have no caller at all (not a package script, not a workflow), so
 * the runtime bundles were frozen at whenever someone last ran it by hand while
 * the DeepL job kept refreshing `messages.json` — es/es.json had 469 of en's 924
 * keys, 172 keys that no longer existed in English, and `close` = "Cerca"
 * (= "nearby"), the exact #469 defect the parity test below pins. The parity test
 * passed throughout, because it read `messages.json` on both sides.
 *
 * So this file asserts BOTH halves: the translation parity (on messages.json) AND
 * the derivation (flat bundle === flatten(messages.json)), which is what makes the
 * first half say anything about what ships.
 */

const LOCALES_DIR = path.join(__dirname, '../../../public/_locales');
const I18N_SOURCE = path.join(__dirname, '../../i18n.ts');

type Entry = { message: string; englishSource?: string; placeholders?: Record<string, unknown> };

const loadMessages = (locale: string): Record<string, Entry> =>
  JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'messages.json'), 'utf8'));

const loadFlat = (locale: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, `${locale}.json`), 'utf8'));

const enSource: Record<string, string> = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en/en.json'), 'utf8'));
const en = loadMessages('en');
const es = loadMessages('es');

/**
 * Keys whose stored `englishSource` no longer matches en.json — the English text
 * changed and the translation still describes superseded copy. `format-locales.js`
 * omits these from the flat bundle so i18next falls back to accurate English, and
 * `translateWithDiff` re-translates exactly these on the next DeepL run.
 */
const staleKeys = (locale: string): string[] =>
  Object.entries(loadMessages(locale))
    .filter(([key, entry]) => entry.englishSource !== enSource[key])
    .map(([key]) => key);

/**
 * The non-English locale directories `src/i18n.ts` imports a flat bundle from.
 * Kept as a literal so a bundle silently dropped from `resources` shows up as a
 * failing assertion rather than as one fewer thing being checked; the first test
 * pins it against the real import list.
 */
const RUNTIME_LOCALES = ['de', 'es', 'fr', 'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh_CN', 'zh_TW'];

/** Every locale dir carrying both artefacts, minus `en` (whose en.json is the SOURCE). */
const DERIVED_LOCALES = fs
  .readdirSync(LOCALES_DIR)
  .filter(
    dir =>
      dir !== 'en' &&
      fs.existsSync(path.join(LOCALES_DIR, dir, 'messages.json')) &&
      fs.existsSync(path.join(LOCALES_DIR, dir, `${dir}.json`))
  );

// Read a required entry's message; throws (failing the test with a clear reason)
// if the key is absent. Keeps indexed access type-safe under
// `noUncheckedIndexedAccess`, which treats `Record` lookups as possibly-undefined.
const msg = (bundle: Record<string, Entry>, key: string): string => {
  const entry = bundle[key];
  if (!entry) throw new Error(`locale is missing key: ${key}`);
  return entry.message;
};

describe('runtime locale bundles (the files src/i18n.ts actually renders from)', () => {
  it('checks every non-English bundle src/i18n.ts imports', () => {
    // `import es from '../public/_locales/es/es.json';` — one line per locale.
    const source = fs.readFileSync(I18N_SOURCE, 'utf8');
    const imported = [...source.matchAll(/_locales\/([A-Za-z_]+)\/\1\.json/g)].map(m => m[1]!);
    expect(imported.filter(loc => loc !== 'en').sort()).toEqual([...RUNTIME_LOCALES].sort());
  });

  it.each(DERIVED_LOCALES)('%s.json is the current-translation flatten of messages.json', locale => {
    // The invariant `format-locales.js` establishes. Without it the DeepL job
    // refreshes messages.json while the rendered bundle keeps whatever it had.
    const expected = Object.fromEntries(
      Object.entries(loadMessages(locale))
        .filter(([key, entry]) => entry.englishSource === enSource[key])
        .map(([key, entry]) => [key, entry.message])
    );
    expect(loadFlat(locale)).toEqual(expected);
  });

  it('every en.json SOURCE value is a flat string, not a Chrome message object', () => {
    // en.json is the FLAT source map i18n.ts installs directly as resources.en.translation. The
    // Chrome `{ "message": ... }` wrapper belongs only to the GENERATED _locales/<loc>/messages.json.
    // An object value here does not throw: i18next resolves it through its handle-as-object path and
    // the screen renders "key '<name> (en)' returned an object instead of string" as its user-facing
    // copy. A suite that stubs react-i18next with its own map cannot see that, which is exactly how
    // one shipped. Generation would also double-wrap it as {"message":{"message":...}} and hand the
    // translator an object for every other locale.
    const nonString = Object.entries(enSource)
      .filter(([, value]) => typeof value !== 'string')
      .map(([key]) => key);
    expect(nonString).toEqual([]);
  });

  it('every key in the en.json SOURCE reaches en/messages.json', () => {
    // The comparison set for every other test in this file is
    // `Object.keys(en/messages.json)`. So a key added to the hand-authored
    // `en.json` source and never propagated is not merely untested — it is
    // absent from the thing the tests compare against, and the whole suite
    // reads green while the UI renders the raw key name.
    //
    // That is not hypothetical: six guardian strings shipped in exactly this
    // state for two rounds. `format-locales.js` cannot catch it either, since
    // it skips `en` by design (en.json is its source, not its output).
    const unpropagated = Object.keys(enSource).filter(key => !(key in en));
    expect(unpropagated).toEqual([]);
  });

  it.each(RUNTIME_LOCALES)('%s translates every shipped English key it has a current translation for', locale => {
    const bundle = loadFlat(locale);
    const missing = Object.keys(en).filter(key => !(key in bundle));
    // The only permitted gap is a key awaiting re-translation, which renders as
    // accurate English via `fallbackLng` until the next DeepL run.
    expect(missing.sort()).toEqual(staleKeys(locale).sort());
  });

  it.each(RUNTIME_LOCALES)('%s uses $-delimited placeholders, never {{…}}', locale => {
    // `src/i18n.ts` configures `interpolation.prefix/suffix = '$'`, so a stale
    // `{{origin}}` renders literally — e.g. the "reset permissions for X?" prompt
    // asking the user to confirm without naming the site.
    const offenders = Object.entries(loadFlat(locale))
      .filter(([, value]) => value.includes('{{'))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it('renders the Spanish "Close" action as Cerrar in the bundle the UI reads (#469)', () => {
    expect(loadFlat('es').close).toBe('Cerrar');
  });

  it('regenerates the bundles as part of the translation pipeline', () => {
    // `format-locales.js` had no caller anywhere in the tree — not a package
    // script, not a workflow step — which is how the runtime bundles drifted
    // ~450 keys behind messages.json while every gate stayed green. The CI job
    // (.github/workflows/pr.yml) runs `createTranslationFile` and then commits
    // whatever changed under public/_locales/, so the flatten has to be part of
    // that script for the drift to be visible.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
    expect(pkg.scripts.createTranslationFile).toContain('format-locales.js');
  });
});

// #469 — the Spanish locale shipped an incomplete/incorrect translation set:
// keys missing entirely (falling back to English) and at least one wrong
// action translation ("Close" rendered as "Cerca"/"Acerca" = near/about). These
// guards keep es structurally complete and pin the known-wrong fixes so the
// translation bot (which only re-translates when the English source changes)
// can't silently drift them back.
describe('es locale parity with en (#469)', () => {
  it('has a Spanish entry for every shipped English key (no English fallback)', () => {
    const missing = Object.keys(en).filter(key => !(key in es));
    expect(missing).toEqual([]);
  });

  it("preserves each key's placeholder set so $x$ substitutions still resolve", () => {
    const mismatches: string[] = [];
    for (const [key, enEntry] of Object.entries(en)) {
      const esEntry = es[key];
      if (!esEntry) continue;
      const enPlaceholders = Object.keys(enEntry.placeholders ?? {}).sort();
      const esPlaceholders = Object.keys(esEntry.placeholders ?? {}).sort();
      if (JSON.stringify(enPlaceholders) !== JSON.stringify(esPlaceholders)) {
        mismatches.push(`${key}: en[${enPlaceholders}] vs es[${esPlaceholders}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('translates "Close" as the action Cerrar, not the wrong "Cerca"/"Acerca" (#469)', () => {
    expect(msg(es, 'close')).toBe('Cerrar');
  });

  it('does not leave the fixed common UI terms in English', () => {
    // A curated subset of the entries this PR translated — guards against a
    // regression back to the English source. Excludes the repo's protected
    // TECHNICAL_TERMS (Seed Phrase / Note(s) / Faucet), which generateLanguageFiles
    // intentionally keeps in English across every locale. (The broader
    // Spanish-quality audit is a native-speaker follow-up per the issue.)
    for (const key of ['withdrawalFailed', 'totalPaid', 'transactionComplete', 'depositIntentLabel']) {
      expect(msg(es, key)).not.toBe(msg(en, key));
    }
  });
});

// Chrome parses `public/_locales/<loc>/messages.json` itself, before a line of the
// extension runs, and REJECTS THE WHOLE EXTENSION when a `$name$` in `message` has
// no matching `placeholders` entry:
//
//   Failed to load extension from: <dist>. Variable $tvl$ used but not defined.
//
// The unpacked extension then never loads, so Playwright's `--load-extension`
// persistent context never comes up and every blockchain spec dies at
// `browserType.launchPersistentContext: Timeout 180000ms exceeded` before any
// assertion runs — on every PR stacked above the one that added the key, reading
// like CI infrastructure flake rather than a one-line locale defect. `tsc`, jest and
// `yarn lint:i18n` (which lints `src`, not `public/_locales`) are all blind to it;
// this is the only gate that sees it.
describe('Chrome i18n placeholder declarations', () => {
  const ALL_LOCALES = fs
    .readdirSync(LOCALES_DIR)
    .filter(dir => fs.existsSync(path.join(LOCALES_DIR, dir, 'messages.json')));

  it.each(ALL_LOCALES)('%s declares every $placeholder$ its messages use', locale => {
    const undeclared: string[] = [];
    for (const [key, entry] of Object.entries(loadMessages(locale))) {
      // Chrome matches placeholder names case-insensitively.
      const declared = new Set(Object.keys(entry.placeholders ?? {}).map(name => name.toLowerCase()));
      for (const [, name] of entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
        if (!declared.has(name!.toLowerCase())) undeclared.push(`${key}: $${name}$`);
      }
    }
    expect(undeclared).toEqual([]);
  });
});

describe('hand-copied English is queued for translation', () => {
  // A non-English entry whose message is the English text is only acceptable while it is marked for
  // the next DeepL run; `translateWithDiff` re-translates an entry whose englishSource is stale, so
  // the explicit sentinel is what puts it in that queue. (en_GB is not a runtime bundle, and a real
  // British entry may legitimately equal the English.)
  const COPIED_KEYS = [
    'earnNoActivePositionsTitle',
    'earnNoActivePositionsBody',
    'tokenActivityEmptyTitle',
    'tokenActivityEmptyBody'
  ];
  it.each(RUNTIME_LOCALES)('%s translates or explicitly queues each copied key', locale => {
    const messages = loadMessages(locale);
    const neither = COPIED_KEYS.filter(
      key => messages[key]?.message === en[key]?.message && messages[key]?.englishSource !== '(untranslated)'
    );
    expect(neither).toEqual([]);
  });
});

describe('the history load-error string', () => {
  // A new key reaches every derived bundle, en_GB included: translated, or English queued for DeepL.
  it.each(DERIVED_LOCALES)('%s carries tokenActivityLoadError, translated or queued', locale => {
    const entry = loadMessages(locale).tokenActivityLoadError;
    expect(entry).toBeDefined();
    expect(entry!.message !== en.tokenActivityLoadError?.message || entry!.englishSource === '(untranslated)').toBe(
      true
    );
  });

  it('covers en_GB, which the runtime list leaves out', () => {
    expect(DERIVED_LOCALES).toContain('en_GB');
  });
});

describe('retired keys', () => {
  // The vault row's TVL line was dropped because the earn API has no TVL; its string goes with it.
  it('no locale bundle carries earnVaultTvl', () => {
    const carriers = fs.readdirSync(LOCALES_DIR).flatMap(dir =>
      ['messages.json', `${dir}.json`]
        .map(file => path.join(LOCALES_DIR, dir, file))
        .filter(file => fs.existsSync(file) && 'earnVaultTvl' in JSON.parse(fs.readFileSync(file, 'utf8')))
        .map(file => path.relative(LOCALES_DIR, file))
    );
    expect(carriers).toEqual([]);
  });
});
