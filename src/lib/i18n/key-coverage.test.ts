/**
 * Every translation key the UI asks for must exist in the source of truth.
 *
 * WHY THIS EXISTS. `public/_locales/en/en.json` is the flat source of truth;
 * every per-locale `messages.json` under `public/_locales` is GENERATED from it
 * by `utility/generateLanguageFiles.ts`, which drops any key en.json does not
 * have ("stale keys"). So a key added straight to the messages.json files —
 * the natural place to add it, since that is where the translations live — is
 * silently deleted the next time CI regenerates them, and the label renders
 * blank in production.
 *
 * Nothing caught that. The parity tests compare the locales against EACH OTHER,
 * and the generator removes the key from all of them at once, so they stay
 * perfectly consistent while the string disappears. This test compares against
 * the source instead, which is the only direction that can see it.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const SOURCE_OF_TRUTH = path.join(ROOT, 'public/_locales/en/en.json');

/**
 * Keys asked for by code that predates this test, each rendering an empty
 * string today. Listed rather than fixed because they are unrelated to the
 * change that added this file, and an allowlist keeps them visible instead of
 * letting the test be deleted to make room for them.
 *
 * - `faceId`: the hot-key label on the Rotate Guardian review screen, blank
 *   whenever the device reports Face ID.
 * - `importSeedPhraseError`: the red error line under the seed-phrase import
 *   field, blank on every failed import.
 */
const KNOWN_MISSING = new Set(['faceId', 'importSeedPhraseError']);

/**
 * A `t('someKey')` call with a literal key. Dynamic keys (`t(variable)`,
 * `t(`x${y}`)`) are out of reach of a static check and are simply not matched;
 * this is a floor on coverage, not a ceiling.
 */
const LITERAL_T_CALL = /\bt\(\s*['"`]([A-Za-z][A-Za-z0-9_]*)['"`]/g;

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    // Test files are excluded: they mock `t` to echo its argument, so the keys
    // they pass are assertions about rendering, not strings a user ever sees.
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe('translation keys used by the UI exist in en.json', () => {
  const englishKeys: Record<string, string> = JSON.parse(fs.readFileSync(SOURCE_OF_TRUTH, 'utf8'));

  const requestedKeys = new Map<string, string[]>();
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const match of contents.matchAll(LITERAL_T_CALL)) {
      const key = match[1];
      if (key === undefined) continue;
      requestedKeys.set(key, [...(requestedKeys.get(key) ?? []), path.relative(ROOT, file)]);
    }
  }

  // Guards the guard: a regex that stops matching would make this file pass
  // while checking nothing at all.
  it('finds the keys the UI asks for', () => {
    expect(requestedKeys.size).toBeGreaterThan(200);
  });

  it('has every one of them in the source of truth', () => {
    const missing = [...requestedKeys]
      .filter(([key]) => !(key in englishKeys) && !KNOWN_MISSING.has(key))
      .map(([key, files]) => `${key} (used in ${files[0]})`);

    // A key here renders as an empty string. If it was just added, add it to
    // public/_locales/en/en.json — NOT to the generated messages.json files.
    expect(missing).toEqual([]);
  });

  it('still needs every allowlisted key, so the list cannot outlive its entries', () => {
    const staleAllowances = [...KNOWN_MISSING].filter(key => key in englishKeys || !requestedKeys.has(key));

    expect(staleAllowances).toEqual([]);
  });
});
