/**
 * Flatten every locale's Chrome-extension `messages.json` into the flat
 * `<loc>/<loc>.json` bundle the RUNTIME actually renders from.
 *
 * There are two artefacts per locale and they are NOT interchangeable:
 *   - `public/_locales/<loc>/messages.json` — Chrome i18n format
 *     (`{ key: { message, englishSource, placeholders } }`). Produced by
 *     `utility/generateLanguageFiles.ts` (the CI DeepL job).
 *   - `public/_locales/<loc>/<loc>.json` — the flat `{ key: string }` map that
 *     `src/i18n.ts` imports and hands to i18next as `resources`. This is what
 *     every `t('…')` in the app resolves against.
 *
 * This script is the ONLY writer of the second file, so it has to run after the
 * translation job or the shipped UI keeps rendering whatever was last generated
 * by hand. It is wired into `package.json`'s `createTranslationFile` script for
 * exactly that reason.
 *
 * `en` is skipped ON PURPOSE: `public/_locales/en/en.json` is the hand-authored
 * SOURCE of truth (`generateLanguageFiles.ts` reads it and derives
 * `en/messages.json` from it), so regenerating it from the derived file would
 * discard any English key added since the last translation run.
 */
const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, 'public', '_locales');
const englishFile = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'en.json'), 'utf-8'));

for (const langDir of fs.readdirSync(localesDir)) {
  // See the module comment: en.json is the source, not a derived artefact.
  if (langDir === 'en') continue;

  const messagesPath = path.join(localesDir, langDir, 'messages.json');
  if (!fs.existsSync(messagesPath)) continue;

  const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf-8'));
  const formattedMessages = {};
  let stale = 0;
  for (const key of Object.keys(messages)) {
    // Emit only translations that are CURRENT. `englishSource` is the exact
    // English text the entry was translated from, so a mismatch against en.json
    // means the English changed and this translation still describes superseded
    // copy — `translateWithDiff` re-translates precisely these on the next run.
    // Omitting a stale entry makes i18next fall back to English (`fallbackLng`),
    // which is accurate, instead of rendering a confident translation of text the
    // product no longer says. That matters most for security copy: the
    // `confirmPrivateDataPermissionDescription` correction (the grant IS
    // revocable) would otherwise ship as "cannot be revoked" in 13 languages.
    if (messages[key].englishSource !== englishFile[key]) {
      stale++;
      continue;
    }
    formattedMessages[key] = messages[key].message;
  }

  const outputPath = path.join(localesDir, langDir, `${langDir}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(formattedMessages, null, 2)}\n`);
  console.log(`${langDir}: wrote ${Object.keys(formattedMessages).length} keys (${stale} awaiting re-translation)`);
}
