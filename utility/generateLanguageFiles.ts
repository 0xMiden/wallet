const fs = require('fs');
const deepl = require('deepl-node');
const path = require('path');

// Translation engine: DeepL, via the official deepl-node SDK.
//
// The key comes from the DEEPL_API_KEY env var. In practice this only runs in the
// CI "translations" job (pr.yml), which supplies it from the repo secret of the
// same name — so that secret is the single home for the key. For a rare manual run,
// prefix the command with the var: `DEEPL_API_KEY=… yarn createTranslationFile`.
// deepl-node auto-selects the free (api-free.deepl.com, keys ending ":fx") or paid
// endpoint from the key, and retries on rate limits / transient errors.
const translator = process.env.DEEPL_API_KEY ? new deepl.Translator(process.env.DEEPL_API_KEY) : null;

// Map each locale directory to its DeepL target-language code. DeepL rejects or
// deprecates bare codes for regional variants, so this is NOT `dir.split('_')[0]`:
//   - en_GB → en-GB   (bare EN is deprecated as a DeepL *target*)
//   - pt    → pt-BR   (existing pt corpus is Brazilian; switch to pt-PT for European)
//   - zh_CN → zh-HANS / zh_TW → zh-HANT  (bare zh would make zh_TW Simplified!)
// Codes match deepl-node's TargetLanguageCode; the API is case-insensitive.
const LOCALE_TO_DEEPL: Record<string, string> = {
  de: 'de',
  en_GB: 'en-GB',
  es: 'es',
  fr: 'fr',
  ja: 'ja',
  ko: 'ko',
  pl: 'pl',
  pt: 'pt-BR',
  ru: 'ru',
  tr: 'tr',
  uk: 'uk',
  zh_CN: 'zh-HANS',
  zh_TW: 'zh-HANT',
};

// DeepL allows up to 50 texts per translate request; batching cuts a full rebuild
// from ~11k sequential calls to a few hundred.
const DEEPL_BATCH_SIZE = 50;

// Domain context sent with every request. DeepL does not translate it and does not
// bill for it — it only biases word-sense disambiguation toward the crypto/DeFi
// meaning, e.g. so "Position" reads as an investment position, not a job vacancy
// (which is why Polish "Current Positions" was coming out as "job offers").
const DEEPL_CONTEXT =
  'These are short UI labels for Miden, a self-custody cryptocurrency wallet with DeFi ' +
  'earning, lending, bridging and token swaps. Use finance/crypto word senses: "Position" ' +
  'means an investment/holding position, never a job; "Claim" means to collect or receive ' +
  'tokens owed to you, never a legal claim or assertion; "Bridge" means moving assets ' +
  'between blockchains, never a physical bridge ("bridge in progress" = a transfer is ' +
  'underway, not construction); "Withdraw" means taking funds out, never cancel; "Vault" ' +
  'is a secure asset store; "Accept"/"Decline" are what a user does with an incoming ' +
  'transfer of money, and a "pending transfer" is money waiting to be accepted. ' +
  '"Everyday key" is the name of the account\'s day-to-day signing key, a noun like ' +
  '"signing key": translate it as a kind of key, never as a frequency ("daily", ' +
  '"regularly") and never as vocabulary or terminology; rotating it means replacing it ' +
  'once, not on a schedule. "Recovery phrase" is the wallet\'s 12-word secret backup phrase ' +
  '(a mnemonic): use the term wallets in that language usually use for it. "Guardian switch" ' +
  '(and "switch" in a sentence about the Guardian) means replacing the account\'s Guardian ' +
  'co-signing service with another one: translate it as a change or replacement of the ' +
  'Guardian, never as a network or hardware switch, a toggle, a device or a key. "Burn" ' +
  '(and "burned") means destroying tokens so they leave circulation, never imprinting, ' +
  'recording or setting on fire. "Fill" (and "filled", "unfilled") means a swap order being ' +
  'matched by a counterparty, never filling in a form or field.';

const root = path.resolve(__dirname, '..');
// Use en.json as source of truth (flat format), not messages.json (Chrome extension format)
const englishFilePath = path.join(root, 'public/_locales/en/en.json');
const englishFile = require(englishFilePath);

// Product terms that must stay in English across every language (brand consistency).
// All case variations we protect; order longest-first so e.g. "Notes" wins over "Note".
const TECHNICAL_TERM_VARIANTS = [
  'Faucet',
  'faucet',
  'FAUCET',
  'Notes',
  'Note',
  'notes',
  'note',
  'NOTES',
  'NOTE',
  // "Guardian" is the co-signer feature name — kept English so it stops coming out as
  // "the newspaper", "maintenance officer" or "legal guardian" across languages.
  'Guardians',
  'Guardian',
  'guardians',
  'guardian',
  'GUARDIANS',
  'GUARDIAN',
  // "Blockchain" — kept English/consistent (some langs were rendering it "chain of
  // blocks", e.g. pl "łańcuch bloków", es "cadena de bloques").
  'Blockchain',
  'blockchain',
  'BLOCKCHAIN',
];

// A single regex that matches anything DeepL must NOT translate: "Miden $network$" as one
// span, the technical terms above (word-bounded) and Chrome i18n `$placeholder$` variables.
// Protected separately, DeepL moved the placeholder away from the noun it completes
// ("... 이용 중이십니다. $network$", #875).
const PROTECT_REGEX = new RegExp(
  '(' +
    '\\bMiden \\$[a-zA-Z_][a-zA-Z0-9_]*\\$|' +
    TECHNICAL_TERM_VARIANTS.map(t => `\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).join('|') +
    '|\\$[a-zA-Z_][a-zA-Z0-9_]*\\$' +
    ')',
  'g',
);

// DeepL has put an <x> tag against a neighbouring word or also translated the word beside it, and
// unwrapping left the two fused ("L’note", "notess", "Notnote", "dfaucet", #1399).
const ANY_TERM_REGEX = new RegExp(TECHNICAL_TERM_VARIANTS.join('|'), 'g');
const PLACEHOLDER_REGEX = /\$[a-zA-Z_][a-zA-Z0-9_]*\$/g;
// Japanese and Chinese write no spaces and Korean attaches particles to the noun, so their letters may
// touch a term.
const GLUE_LETTER =
  /^(?![\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}])[\p{L}\p{M}]$/u;
const APOSTROPHE = /^['’ʼ]$/;
// Endings a language attaches straight to a singular loanword ("blockchains", "Guardiana", "fauceta").
// Any other letters after a term, and any after a plural one ("notess"), are glue.
const TERM_ENDINGS: Record<string, string[]> = {
  de: ['s'],
  en: ['s'],
  es: ['s', 'es'],
  fr: ['s'],
  pl: ['a', 'u', 'owi', 'em', 'ie', 'y', 'i', 'owie', 'ów', 'om', 'ami', 'ach'],
  pt: ['s']
};

const termFamily = (term: string): string => term.toLowerCase().replace(/s$/, '');

// The words of `translation` that fuse a term `english` protects with a neighbouring word. Only the terms
// the English protects count, so a native word such as "Notez" or "Knoten" is not one. `language` is a
// locale directory or a DeepL code ("pt", "pt-BR").
function findGluedTerms(translation: string, english: string, language: string): string[] {
  const families = new Set(
    [...english.matchAll(PROTECT_REGEX)]
      .map(m => m[0])
      .filter(span => TECHNICAL_TERM_VARIANTS.includes(span))
      .map(termFamily)
  );
  const endings = TERM_ENDINGS[language.split(/[-_]/)[0].toLowerCase()] ?? [];
  const text = translation.replace(PLACEHOLDER_REGEX, placeholder => '$'.repeat(placeholder.length));
  const isGlueLetter = (i: number): boolean => i >= 0 && i < text.length && GLUE_LETTER.test(text[i]);
  const glued: string[] = [];
  for (const m of text.matchAll(ANY_TERM_REGEX)) {
    const term = m[0];
    if (!families.has(termFamily(term))) continue;
    const start = m.index;
    const end = start + term.length;
    let after = end;
    while (isGlueLetter(after)) after++;
    const ending = text.slice(end, after);
    // Every term starts with a consonant, and no shipped language elides before one ("L’note" is "La note").
    const elided = APOSTROPHE.test(text[start - 1] ?? '') && isGlueLetter(start - 2);
    const gluedAfter = ending !== '' && (/s$/i.test(term) || !endings.includes(ending));
    if (!isGlueLetter(start - 1) && !elided && !gluedAfter) continue;
    let from = elided ? start - 1 : start;
    while (isGlueLetter(from - 1)) from--;
    glued.push(translation.slice(from, after));
  }
  return glued;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Wrap every protected span in an <x>…</x> tag and XML-escape the rest, producing valid
// XML for DeepL's tagHandling='xml' + ignoreTags=['x']: DeepL translates only the text
// outside <x>, leaving terms and placeholders verbatim. Replaces the old placeholder /
// known-mistranslation dictionary workaround, which existed only because the free Google
// endpoint mangled these — DeepL's native tag handling makes it reliable.
function toDeepLXml(source: string): string {
  let out = '';
  let last = 0;
  for (const m of source.matchAll(PROTECT_REGEX)) {
    const idx = m.index as number;
    out += xmlEscape(source.slice(last, idx));
    out += `<x>${xmlEscape(m[0])}</x>`;
    last = idx + m[0].length;
  }
  out += xmlEscape(source.slice(last));
  return out;
}

// Inverse of toDeepLXml: strip the <x> wrappers DeepL preserved and unescape entities.
function fromDeepLXml(translated: string): string {
  return xmlUnescape(translated.replace(/<\/?x\s*>/g, ''));
}

// Translate an array of English source strings into `targetCode`, preserving technical
// terms and $placeholder$ variables. Order of the returned array matches the input.
async function translateBatch(sources: string[], targetCode: string): Promise<string[]> {
  if (sources.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < sources.length; i += DEEPL_BATCH_SIZE) {
    const chunk = sources.slice(i, i + DEEPL_BATCH_SIZE).map(toDeepLXml);
    const results = await translator.translateText(chunk, 'en', targetCode, {
      tagHandling: 'xml',
      ignoreTags: ['x'],
      outlineDetection: false,
      context: DEEPL_CONTEXT,
    });
    for (const r of results) out.push(fromDeepLXml(r.text));
  }
  return out;
}

// Extract $placeholder$ patterns from a message and generate Chrome i18n placeholders object
function generateChromePlaceholders(message: string): Record<string, { content: string }> | undefined {
  const placeholderRegex = /\$([a-zA-Z_][a-zA-Z0-9_]*)\$/g;
  const matches = [...message.matchAll(placeholderRegex)];

  if (matches.length === 0) {
    return undefined;
  }

  const placeholders: Record<string, { content: string }> = {};
  matches.forEach((match, index) => {
    const placeholderName = match[1].toLowerCase();
    // Chrome i18n uses $1, $2, etc. for substitution values
    placeholders[placeholderName] = { content: `$${index + 1}` };
  });

  return placeholders;
}

function buildEntry(message: string, englishMessage: string): any {
  const entry: any = { message, englishSource: englishMessage };
  const placeholders = generateChromePlaceholders(englishMessage);
  if (placeholders) entry.placeholders = placeholders;
  return entry;
}

// The marker of an entry whose message is the English text: format-locales.js leaves it out of the flat
// bundle and translateWithDiff translates it again on the next run.
const UNTRANSLATED = '(untranslated)';

// The entry written for a fresh DeepL translation. One that glues a protected term to a word is never
// written: the entry keeps the English under UNTRANSLATED until a later run gets it clean or a hand fix
// lands. No retry in the same run, since DeepL repeats the glue for the same request.
function translatedEntry(key: string, translation: string, english: string, language: string) {
  const glued = findGluedTerms(translation, english, language);
  if (glued.length === 0) return buildEntry(translation, english);
  console.warn(`Rejected the ${language} translation of ${key}, which glues ${glued.join(', ')}: keeping the English.`);
  return { ...buildEntry(english, english), englishSource: UNTRANSLATED };
}

// Translate every key of en.json into `code`, writing a throwaway tmp file (does not
// touch the real locale). Used by the `-c <code>` mode.
async function translateFile(code: string) {
  const keys = Object.keys(englishFile);
  const translations = await translateBatch(
    keys.map(k => englishFile[k]),
    code,
  );

  const newFile: any = {};
  keys.forEach((key, i) => {
    newFile[key] = translatedEntry(key, translations[i], englishFile[key], code);
  });

  fs.writeFileSync(path.join(root, 'utility/tmp-messages.json'), JSON.stringify(newFile, null, 2));
}

// Regenerate a locale's messages.json from en.json, translating only what changed:
// missing keys and keys whose English source moved. Untouched keys are copied as-is,
// stale keys (no longer in en.json) are dropped.
async function translateWithDiff(fileName: string, code: string, replaceFile: boolean) {
  const existingFile = require(fileName);
  const newFile: any = {}; // Start fresh - only include keys that exist in englishFile

  const removedKeys = Object.keys(existingFile).filter(k => !englishFile[k]);
  if (removedKeys.length > 0) {
    console.log(`Removing ${removedKeys.length} stale keys`);
  }

  // First pass: keep up-to-date entries, collect the ones that need (re)translation.
  const toTranslate: { key: string; english: string }[] = [];
  for (const key in englishFile) {
    const englishMessage = englishFile[key]; // en.json is flat: "key": "value"
    const existingItem = existingFile[key];
    const placeholders = generateChromePlaceholders(englishMessage);

    if (!existingItem) {
      // Missing translation - queue it
      toTranslate.push({ key, english: englishMessage });
    } else if (!existingItem.englishSource) {
      // Existing translation without englishSource - keep it, add the source (one-time migration)
      const entry: any = { ...existingItem, englishSource: englishMessage };
      if (placeholders) entry.placeholders = placeholders;
      newFile[key] = entry;
    } else if (existingItem.englishSource !== englishMessage) {
      // English source has changed - queue a re-translation
      toTranslate.push({ key, english: englishMessage });
    } else {
      // Up to date - copy through, refreshing placeholders
      const entry: any = { ...existingItem };
      if (placeholders) entry.placeholders = placeholders;
      newFile[key] = entry;
    }
  }

  // Second pass: translate the queued keys in batches, then slot them in.
  if (toTranslate.length > 0) {
    console.log(`Translating ${toTranslate.length} key(s) to ${code}...`);
    const translations = await translateBatch(
      toTranslate.map(t => t.english),
      code,
    );
    toTranslate.forEach((t, i) => {
      newFile[t.key] = translatedEntry(t.key, translations[i], t.english, code);
    });
  }

  // Re-emit in en.json key order so unchanged files stay diff-stable.
  const ordered: any = {};
  for (const key in englishFile) {
    if (newFile[key]) ordered[key] = newFile[key];
  }

  const filePath = replaceFile ? fileName : path.join(root, 'utility/tmp-messages.json');
  fs.writeFileSync(filePath, JSON.stringify(ordered, null, 2));
}

// Generate en/messages.json directly from en.json (no translation needed)
function generateEnglishMessages() {
  const newFile: any = {};
  for (const key in englishFile) {
    newFile[key] = buildEntry(englishFile[key], englishFile[key]);
  }
  const filePath = path.join(root, 'public/_locales/en/messages.json');
  fs.writeFileSync(filePath, JSON.stringify(newFile, null, 2));
  console.log('Generated en/messages.json from en.json');
}

async function updateAllLanguages() {
  const languageDirs = fs.readdirSync(path.join(root, 'public/_locales'));
  for (let i = 0; i < languageDirs.length; i++) {
    let languageDir = languageDirs[i];
    console.log('Updating translations for file: ', languageDir, '................................');
    if (languageDir === 'en') {
      // For English, just copy from en.json - no translation needed
      generateEnglishMessages();
      continue;
    }
    const filePath = path.join(root, `public/_locales/${languageDir}/messages.json`);
    const languageCode = LOCALE_TO_DEEPL[languageDir];
    if (!languageCode) {
      console.warn(`⚠️  No DeepL target mapping for locale "${languageDir}" — skipping (add it to LOCALE_TO_DEEPL).`);
      continue;
    }
    await translateWithDiff(filePath, languageCode, true);
  }
}

// Validate that every locale's $placeholder$ set matches en.json, dropping any key whose
// placeholders drifted. Makes no API calls (the `-e` mode); a safety net independent of
// the translation engine.
async function fixErrorsForLanguage(fileName: string, code: string, replaceFile: boolean) {
  const existingFile = require(fileName);
  let newFile: any = Object.assign({}, existingFile);

  for (const key in englishFile) {
    if (existingFile[key]) {
      const englishMessage = englishFile[key]; // en.json is flat: "key": "value"
      const otherMessage = existingFile[key].message;
      var regExp = /\$([^$)]+)\$/gm;
      var regExp2 = /\$([^$)]+)\$/gm;
      const englishMatches = englishMessage.match(regExp);
      const otherMatches = otherMessage.match(regExp2);
      if (englishMatches) {
        if (!otherMatches || englishMatches.length != otherMatches.length) {
          console.log('Removing: ', key, englishMatches, otherMatches);
          delete newFile[key];
          continue;
        }
        englishMatches.sort();
        otherMatches.sort();
        const thing = (englishMatches as any[]).map((item, i) => item != otherMatches[i]).filter(item => item);
        if (thing.length > 0) {
          console.log('Removing: ', key, englishMatches, otherMatches);
          delete newFile[key];
        }
      }
    }
  }

  const filePath = replaceFile ? fileName : path.join(root, 'utility/tmp-messages.json');
  fs.writeFileSync(filePath, JSON.stringify(newFile, null, 2));
}

async function fixAllPotentialErrors() {
  const languageDirs = fs.readdirSync(path.join(root, 'public/_locales'));
  for (let i = 0; i < languageDirs.length; i++) {
    let languageDir = languageDirs[i];
    console.log('Analyzing file for potential errors: ', languageDir, '................................');
    if (languageDir === 'en') {
      console.log('Skipping English File');
    }
    const filePath = path.join(root, `public/_locales/${languageDir}/messages.json`);
    const languageCode = languageDir.split('_')[0];
    await fixErrorsForLanguage(filePath, languageCode, true);
  }
}

// Export the pure, side-effect-free helpers for unit testing (no API calls).
module.exports = {
  toDeepLXml,
  fromDeepLXml,
  PROTECT_REGEX,
  generateChromePlaceholders,
  LOCALE_TO_DEEPL,
  findGluedTerms,
  translatedEntry
};

// CLI entry point — only when run directly (`ts-node generateLanguageFiles.ts`), never
// when required by a test.
if (require.main === module) {
  // eslint-disable-next-line import/order
  const argv = require('minimist')(process.argv.slice(2));

  // Every mode except -e (which only validates $placeholder$ counts) calls the DeepL
  // API. Without a key, skip gracefully instead of failing: this keeps fork PRs green
  // (forks don't receive the DEEPL_API_KEY secret — they check out and generate but
  // never push the diff back anyway) and gives local runs a clear, actionable message.
  const needsDeepLKey = !argv['e'];
  if (needsDeepLKey && !process.env.DEEPL_API_KEY) {
    console.warn('⚠️  DEEPL_API_KEY not set — skipping translation generation (locale files unchanged).');
    console.warn('    CI:     set the repo secret DEEPL_API_KEY (consumed by the "translations" job).');
    console.warn('    Manual: prefix the command, e.g.  DEEPL_API_KEY=<your key> yarn createTranslationFile');
    process.exit(0);
  }

  if (argv['c'] && argv['f']) {
    // yarn createTranslationFile -f public/_locales/ru/messages.json -c ru
    translateWithDiff(argv['f'], argv['c'], false);
  } else if (argv['c']) {
    // yarn createTranslationFile -c ru
    translateFile(argv['c']);
  } else if (argv['e']) {
    fixAllPotentialErrors();
  } else {
    // yarn createTranslationFile
    updateAllLanguages();
  }
}
