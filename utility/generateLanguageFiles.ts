const fs = require('fs');
const translate = require('translate').default;
const path = require('path');

const root = path.resolve(__dirname, '..');
// Use en.json as source of truth (flat format), not messages.json (Chrome extension format)
const englishFilePath = path.join(root, 'public/_locales/en/en.json');
const englishFile = require(englishFilePath);

// Technical terms that should NOT be translated - kept in English across all languages
// These are the canonical forms that will be preserved
const TECHNICAL_TERMS = ['Seed Phrase', 'Faucet', 'Note'] as const;

// All case variations of technical terms for matching
// Order matters: longer phrases should come first to avoid partial matches
const TECHNICAL_TERM_VARIANTS = [
  'Seed Phrase',
  'Seed phrase',
  'seed phrase',
  'SEED PHRASE',
  'Faucet',
  'faucet',
  'FAUCET',
  'Notes',
  'Note',
  'notes',
  'note',
  'NOTES',
  'NOTE',
];

// Map from any variant to canonical form (for post-processing restoration)
const TERM_CANONICAL_MAP: Record<string, string> = {
  'seed phrase': 'Seed Phrase',
  'Seed phrase': 'Seed Phrase',
  'SEED PHRASE': 'Seed Phrase',
  faucet: 'Faucet',
  FAUCET: 'Faucet',
  note: 'Note',
  notes: 'Notes',
  NOTE: 'Note',
  NOTES: 'Notes',
};

// Special term translations per language (e.g., "Tokens" -> "Tokeny" in Polish)
const SPECIAL_TERM_TRANSLATIONS: Record<string, Record<string, string>> = {
  pl: {
    Tokens: 'Tokeny',
    tokens: 'tokeny',
  },
};

// Protect technical terms before translation by replacing with XML-style placeholders
// XML tags are typically preserved by translation APIs
function protectTerms(text: string): { protected: string; replacements: Map<string, string> } {
  const replacements = new Map<string, string>();
  let protected_ = text;
  let placeholderIdx = 0;

  for (const term of TECHNICAL_TERM_VARIANTS) {
    // Use word boundaries to avoid partial matches within words
    // Escape special regex characters in the term
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedTerm}\\b`, 'g');

    // Check if term exists in the text
    if (protected_.match(regex)) {
      // Use XML-style placeholder that translation APIs typically preserve
      const placeholder = `<x id="${placeholderIdx}"/>`;
      replacements.set(placeholder, term);
      protected_ = protected_.replace(regex, placeholder);
      placeholderIdx++;
    }
  }

  return { protected: protected_, replacements };
}

// Restore technical terms after translation
function restoreTerms(text: string, replacements: Map<string, string>, languageCode: string): string {
  let restored = text;

  for (const [placeholder, originalTerm] of replacements) {
    // Check if there's a special translation for this term in this language
    const specialTranslations = SPECIAL_TERM_TRANSLATIONS[languageCode];
    const replacement = specialTranslations?.[originalTerm] ?? originalTerm;

    // Escape the placeholder for regex (handle special chars in XML tags)
    const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Also match variations that translation APIs might produce (with spaces, different quotes, etc.)
    // e.g., <x id="0"/> might become <x id="0" /> or <x id = "0"/>
    const flexiblePattern = escapedPlaceholder
      .replace(/id="(\d+)"/, 'id\\s*=\\s*["\']?$1["\']?')
      .replace(/\/>/, '\\s*\\/?\\s*>');

    restored = restored.replace(new RegExp(flexiblePattern, 'g'), replacement);
  }

  return restored;
}

// Known translations of technical terms in various languages that should be reverted to English
// This catches cases where the placeholder protection failed
const KNOWN_TRANSLATIONS: Record<string, string> = {
  // German
  'Seed-Phrase': 'Seed Phrase',
  'Seed-Phrasen': 'Seed Phrases',
  'Startphrase': 'Seed Phrase',
  'Seed-phrase': 'Seed Phrase',
  'Wasserhahn': 'Faucet',
  'Notiz': 'Note',
  'Notizen': 'Notes',
  'Hinweis': 'Note',
  'Hinweise': 'Notes',
  'Noten': 'Notes',
  'Note-': 'Note ',
  'Notetyp': 'Note Type',
  'Notedaten': 'Note Data',
  // Spanish
  'Frase semilla': 'Seed Phrase',
  'frase semilla': 'Seed Phrase',
  'Grifo': 'Faucet',
  'grifo': 'Faucet',
  'Nota': 'Note',
  'Notas': 'Notes',
  'nota': 'Note',
  'notas': 'Notes',
  // French
  'Phrase de récupération': 'Seed Phrase',
  'phrase de récupération': 'Seed Phrase',
  'Phrase secrète': 'Seed Phrase',
  'Robinet': 'Faucet',
  'robinet': 'Faucet',
  // Polish (note: Polish has grammatical cases that modify word endings)
  'Fraza odzyskiwania': 'Seed Phrase',
  'fraza odzyskiwania': 'Seed Phrase',
  'Fraza ziarna': 'Seed Phrase',
  'Fraza nasion': 'Seed Phrase',
  'fraza nasion': 'Seed Phrase',
  'Kran': 'Faucet',
  'kran': 'Faucet',
  'Notatka': 'Note',
  'Notatki': 'Notes',
  'notatka': 'Note',
  'notatki': 'Notes',
  'notatek': 'Notes',
  'notatkę': 'Note',
  'notatkom': 'Notes',
  // Portuguese
  'Frase semente': 'Seed Phrase',
  'frase semente': 'Seed Phrase',
  'Torneira': 'Faucet',
  'torneira': 'Faucet',
  // Italian
  'Frase seme': 'Seed Phrase',
  'frase seme': 'Seed Phrase',
  'Frase seed': 'Seed Phrase',
  'Rubinetto': 'Faucet',
  'rubinetto': 'Faucet',
  // Russian
  'Сид-фраза': 'Seed Phrase',
  'сид-фраза': 'Seed Phrase',
  'Сид фраза': 'Seed Phrase',
  'Мнемоническая фраза': 'Seed Phrase',
  'Кран': 'Faucet',
  'кран': 'Faucet',
  'Заметка': 'Note',
  'Заметки': 'Notes',
  // Chinese
  '助记词': 'Seed Phrase',
  '水龙头': 'Faucet',
  '笔记': 'Note',
  '备注': 'Note',
  // Japanese
  'シードフレーズ': 'Seed Phrase',
  'シード・フレーズ': 'Seed Phrase',
  'フォーセット': 'Faucet',
  '蛇口': 'Faucet',
  'ノート': 'Note',
  'メモ': 'Note',
  // Korean
  '시드문구': 'Seed Phrase',
  '시드 문구': 'Seed Phrase',
  '시드구문': 'Seed Phrase',
  '수도꼭지': 'Faucet',
  '노트': 'Note',
  '메모': 'Note',
  // Dutch
  'Zaadzin': 'Seed Phrase',
  'zaadzin': 'Seed Phrase',
  'Kraan': 'Faucet',
  'kraan': 'Faucet',
  // Turkish
  'Tohum ifadesi': 'Seed Phrase',
  'tohum ifadesi': 'Seed Phrase',
  'Musluk': 'Faucet',
  'musluk': 'Faucet',
  // Ukrainian
  'Сід-фраза': 'Seed Phrase',
  'сід-фраза': 'Seed Phrase',
  'Мнемонічна фраза': 'Seed Phrase',
};

// Post-process translated text to fix any technical terms that escaped the placeholder protection
// Also takes englishSource to ensure correct singular/plural matching
function fixEscapedTerms(text: string, englishSource?: string): string {
  let fixed = text;

  // Determine if English source uses singular or plural forms
  const sourceHasNote = englishSource && /\bNote\b/i.test(englishSource) && !/\bNotes\b/i.test(englishSource);
  const sourceHasNotes = englishSource && /\bNotes\b/i.test(englishSource);

  // Replace known translations back to English
  for (const [translated, english] of Object.entries(KNOWN_TRANSLATIONS)) {
    // Skip singular/plural mismatch fixes when we know the correct form
    if (sourceHasNote && english === 'Notes') continue;
    if (sourceHasNotes && english === 'Note') continue;

    // Use word boundaries where possible, but be careful with non-ASCII characters
    const escapedTranslated = translated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // For non-ASCII, don't use word boundaries as they don't work well
    const hasNonAscii = /[^\x00-\x7F]/.test(translated);
    const regex = hasNonAscii
      ? new RegExp(escapedTranslated, 'g')
      : new RegExp(`\\b${escapedTranslated}\\b`, 'g');
    fixed = fixed.replace(regex, english);
  }

  // If source is singular but we replaced with plural, fix it
  if (sourceHasNote && /\bNotes\b/.test(fixed)) {
    fixed = fixed.replace(/\bNotes\b/g, 'Note');
  }

  return fixed;
}

async function translateFile(code: string) {
  let newFile: any = {};
  for (const key in englishFile) {
    const englishMessage = englishFile[key]; // en.json is flat: "key": "value"
    const newMessage = await translateSegment(englishMessage, code);
    const entry: any = {
      message: newMessage,
      englishSource: englishMessage
    };

    // Add Chrome i18n placeholders if the message contains $placeholder$ patterns
    const placeholders = generateChromePlaceholders(englishMessage);
    if (placeholders) {
      entry.placeholders = placeholders;
    }

    newFile[key] = entry;
  }

  // Post-process ALL entries to fix any technical terms that escaped protection
  for (const key in newFile) {
    if (newFile[key]?.message) {
      const fixedMessage = fixEscapedTerms(newFile[key].message, newFile[key].englishSource);
      if (fixedMessage !== newFile[key].message) {
        console.log(`Fixing escaped terms in "${key}"`);
        newFile[key].message = fixedMessage;
      }
    }
  }

  const filePath = path.join(root, 'utility/tmp-messages.json');
  fs.writeFileSync(filePath, JSON.stringify(newFile, null, 2));
}

async function translateWithDiff(fileName: string, code: string, replaceFile: boolean) {
  const existingFile = require(fileName);
  let newFile: any = {}; // Start fresh - only include keys that exist in englishFile

  // Count removed keys for logging
  const removedKeys = Object.keys(existingFile).filter(k => !englishFile[k]);
  if (removedKeys.length > 0) {
    console.log(`Removing ${removedKeys.length} stale keys`);
  }

  for (const key in englishFile) {
    const englishMessage = englishFile[key]; // en.json is flat: "key": "value"
    const existingItem = existingFile[key];

    // Generate Chrome i18n placeholders if needed
    const placeholders = generateChromePlaceholders(englishMessage);

    if (!existingItem) {
      // Missing translation - translate it
      console.log(`Translating "${key}" (missing)`);
      const newMessage = await translateSegment(englishMessage, code);
      const entry: any = {
        message: newMessage,
        englishSource: englishMessage
      };
      if (placeholders) entry.placeholders = placeholders;
      newFile[key] = entry;
    } else if (!existingItem.englishSource) {
      // Existing translation without englishSource - add it without re-translating
      // (one-time migration for existing translations)
      const entry: any = { ...existingItem, englishSource: englishMessage };
      if (placeholders) entry.placeholders = placeholders;
      newFile[key] = entry;
    } else if (existingItem.englishSource !== englishMessage) {
      // English source has changed - re-translate
      console.log(`Translating "${key}" (English changed)`);
      const newMessage = await translateSegment(englishMessage, code);
      const entry: any = {
        message: newMessage,
        englishSource: englishMessage
      };
      if (placeholders) entry.placeholders = placeholders;
      newFile[key] = entry;
    } else {
      // Translation is up to date - but ensure placeholders are present
      const entry: any = { ...existingItem };
      if (placeholders) entry.placeholders = placeholders;
      newFile[key] = entry;
    }
  }

  // Post-process ALL entries to fix any technical terms that escaped protection
  // (including existing translations that weren't re-translated)
  for (const key in newFile) {
    if (newFile[key]?.message) {
      const fixedMessage = fixEscapedTerms(newFile[key].message, newFile[key].englishSource);
      if (fixedMessage !== newFile[key].message) {
        console.log(`Fixing escaped terms in "${key}"`);
        newFile[key].message = fixedMessage;
      }
    }
  }

  const filePath = replaceFile ? fileName : path.join(root, 'utility/tmp-messages.json');
  fs.writeFileSync(filePath, JSON.stringify(newFile, null, 2));
}

async function translateSegment(segment: string, code: string) {
  try {
    // Step 1: Protect technical terms before any translation
    const { protected: protectedSegment, replacements: termReplacements } = protectTerms(segment);

    let translated: string;

    if (protectedSegment.indexOf('$') > 0) {
      // Handle $placeholder$ variables
      const formattedSegments = [...protectedSegment.matchAll(/\'?\$(.*?)\$\'?/g)];
      const formattedReplacements = formattedSegments.map(seg => seg[0]);
      const replacements = formattedSegments.map(seg => seg[1]);
      const splits = protectedSegment.split(/\'?\$(.*?)\$\'?/g);
      let replacementIdx = 0;
      translated = '';
      for (let i = 0; i < splits.length; i++) {
        const split = splits[i];
        if (split == replacements[replacementIdx]) {
          translated = translated.concat(` ${formattedReplacements[replacementIdx]} `);
          replacementIdx += 1;
        } else {
          if (!/[\w]+/g.test(split)) {
            translated = translated.concat(split);
          } else {
            const text = await translate(split, code);
            translated = translated.concat(text);
          }
        }
      }
    } else {
      translated = (await translate(protectedSegment, code)) as string;
    }

    // Step 2: Restore technical terms after translation
    translated = restoreTerms(translated, termReplacements, code);

    // Step 3: Fix any technical terms that escaped the placeholder protection
    translated = fixEscapedTerms(translated, segment);

    return translated;
  } catch {
    return segment;
  }
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

// Generate en/messages.json directly from en.json (no translation needed)
function generateEnglishMessages() {
  const newFile: any = {};
  for (const key in englishFile) {
    const message = englishFile[key];
    const entry: any = {
      message: message,
      englishSource: message
    };

    // Add Chrome i18n placeholders if the message contains $placeholder$ patterns
    const placeholders = generateChromePlaceholders(message);
    if (placeholders) {
      entry.placeholders = placeholders;
    }

    newFile[key] = entry;
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
    const languageCode = languageDir.split('_')[0];
    await translateWithDiff(filePath, languageCode, true);
  }
}

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

// eslint-disable-next-line import/order
const argv = require('minimist')(process.argv.slice(2));
const code = argv['_'][0];
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
