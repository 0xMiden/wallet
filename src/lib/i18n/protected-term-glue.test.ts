/**
 * The DeepL job keeps protected terms (note, faucet, Guardian, blockchain) verbatim inside `<x>` tags, but DeepL
 * has put a tag against a neighbouring word or also translated the word beside it, and unwrapping left the two
 * fused: "L’note", "notess", "Notnote", "dfaucet" (#1399). The generator rejects such a translation, and no shipped
 * locale may carry one, whether a job or a hand edit wrote it.
 */

import fs from 'fs';
import path from 'path';

type Entry = { message: string; englishSource: string; placeholders?: Record<string, { content: string }> };
type Generator = {
  findGluedTerms: (translation: string, english: string, language: string) => string[];
  translatedEntry: (key: string, translation: string, english: string, language: string) => Entry;
};

// generateLanguageFiles.ts is a CommonJS script (module.exports), so it has no ES exports to import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findGluedTerms, translatedEntry }: Generator = require('../../../utility/generateLanguageFiles');

const LOCALES_DIR = path.resolve(__dirname, '../../../public/_locales');
const LOCALES = fs.readdirSync(LOCALES_DIR).filter(dir => fs.existsSync(path.join(LOCALES_DIR, dir, 'messages.json')));
const loadMessages = (locale: string): Record<string, Entry> =>
  JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'messages.json'), 'utf8'));

// [label, language, English source, translation, glued words]
const GLUED_FORMS: [string, string, string, string, string[]][] = [
  [
    'fr elision before a consonant',
    'fr',
    'The burn note and destination address are public.',
    'L’note de la destruction et l’adresse de destination sont publiques.',
    ['L’note']
  ],
  [
    'fr doubled plural',
    'fr',
    'Published burn notes cannot be reclaimed.',
    'Les notess de destruction publiées ne peuvent pas être récupérées.',
    ['notess']
  ],
  ['fr elision and doubled plural', 'fr', 'Request Private Notes', "Demande d'Notess confidentielles", ["d'Notess"]],
  [
    'pl doubled into the word before',
    'pl',
    'The note that burns the USDCx and the destination address are public. A published note cannot be reclaimed.',
    'Notnote, która powoduje spalenie tokenów USDCx, oraz adres docelowy są publiczne. Opublikowanej notnote nie można cofnąć.',
    ['Notnote', 'notnote']
  ],
  ['pl letter before', 'pl', 'Reset to faucet values', 'Przywróć wartości domyślne dfaucet', ['dfaucet']],
  ['ru Cyrillic word before', 'ru', 'Input notes consumed', 'Использовано входные данныеnotes', ['данныеnotes']],
  ['es doubled plural', 'es', 'Input notes consumed', 'noteses de entrada consumidas', ['noteses']],
  ['tr word before', 'tr', 'Output notes created', 'Çıktınotes dosyası oluşturuldu', ['Çıktınotes']],
  ['es two words fused', 'es', 'Miden Faucet', 'MidenFaucet', ['MidenFaucet']],
  [
    'es Guardian fused on both sides',
    'es',
    'This removes the recovery phrase and Guardian recovery keys.',
    'Esto elimina la frase de recuperación y las llaves de recuperacióGuardianes.',
    ['recuperacióGuardianes']
  ],
  [
    'fr elision and a letter after',
    'fr',
    'The faucet keeps its own values.',
    'L’faucete conserve ses propres valeurs.',
    ['L’faucete']
  ],
  [
    'fr glue beside a clean faucet',
    'fr',
    'The faucet keeps its own values.',
    'Le faucet garde les valeurs du dfaucet.',
    ['dfaucet']
  ],
  [
    'fr doubled plural beside clean terms',
    'fr',
    'The note and notes are public.',
    'La note et les notes notess sont publiques.',
    ['notess']
  ],
  [
    'fr glue beside a native word and a clean term',
    'fr',
    'Write down the note ID',
    "Notez l'ID de la note notnote",
    ['notnote']
  ]
];

// [label, language, English source, translation]
const ACCEPTED_FORMS: [string, string, string, string][] = [
  [
    'a term before punctuation',
    'pl',
    'The note that burns the USDCx and the destination address are public.',
    'Note, która powoduje spalenie tokenów USDCx, oraz adres docelowy są publiczne.'
  ],
  ['a term at the start', 'fr', 'Input notes consumed', 'Notes d’entrée consommées'],
  ['a term at the end', 'fr', 'Requesting tokens from the faucet…', 'Demande de jetons auprès du faucet'],
  ['a Turkish apostrophe suffix', 'tr', 'Choose your Guardian', "Guardian'ınızı seçin"],
  ['an English possessive', 'en', "Unable to read the USDCx faucet's burn policy.", "the USDCx faucet's burn policy"],
  [
    'a correct French elision beside a term',
    'fr',
    'The burn note and destination address are public.',
    'La note de destruction et l’adresse de destination sont publiques.'
  ],
  [
    'a $placeholder$ beside a term or naming one',
    'fr',
    'Note $noteId$ sent by the faucet $faucetId$',
    'Elle ($noteId$) a été envoyée par le faucet $faucetId$'
  ],
  [
    'a Polish case ending',
    'pl',
    'Paid in $symbol$, including faucet execution sponsorship',
    'Opłacone w $symbol$, w tym sponsorowanie uruchomienia fauceta'
  ],
  ['a Polish declension of Guardian', 'pl', 'Guardian switch submitted', 'Zmiana Guardiana wysłana'],
  ['a French plural', 'fr', 'Move funds between blockchain networks', 'Déplacez des fonds entre blockchains'],
  [
    'a German genitive',
    'de',
    "Unable to read the USDCx faucet's burn policy.",
    'Die Verbrennungsrichtlinie des USDCx-faucets kann nicht gelesen werden.'
  ],
  ['a native word the English does not protect', 'fr', 'Write down your recovery phrase.', 'Notez votre phrase.'],
  ['a native German word', 'de', 'Cannot reach the Miden node', 'Der Knoten „Miden“ ist nicht erreichbar'],
  [
    'a native German word beside a protected term',
    'de',
    'The node returned the note',
    'Der Knoten hat die note zurückgegeben'
  ],
  ['a native French word beside a protected term', 'fr', 'Write down the note ID', "Notez l'ID de la note"],
  [
    'a native French word beside a term and a pronoun',
    'fr',
    'Write down the note ID, then send the note.',
    "Notez l'ID de la note, puis envoyez-la."
  ],
  ['a native Portuguese word beside a protected term', 'pt', 'Write down the note ID', 'Anote o ID da note'],
  ['a native Portuguese word with a DeepL code', 'pt-BR', 'Write down the note ID', 'Anote o ID da note'],
  ['a native Spanish word beside a protected term', 'es', 'Write down the note ID', 'Anote el ID de la note'],
  ['Japanese around a term', 'ja', 'What is a Guardian?', 'Guardianとは何ですか？'],
  ['Chinese before a term', 'zh_CN', 'Choose your Guardian', '选择您的Guardian'],
  ['a Korean particle', 'ko', 'Choose your Guardian', 'Guardian를 선택하세요']
];

describe('findGluedTerms', () => {
  it.each(GLUED_FORMS)('flags %s', (_label, language, english, translation, glued) => {
    expect(findGluedTerms(translation, english, language)).toEqual(glued);
  });

  it.each(ACCEPTED_FORMS)('accepts %s', (_label, language, english, translation) => {
    expect(findGluedTerms(translation, english, language)).toEqual([]);
  });

  it('reads the language from a DeepL code as from a locale directory', () => {
    expect(findGluedTerms('Transferência entre blockchains', 'Bridge between blockchain networks', 'pt-BR')).toEqual(
      []
    );
    expect(findGluedTerms('noteses de entrada consumidos', 'Input notes consumed', 'pt-BR')).toEqual(['noteses']);
  });
});

describe('translatedEntry', () => {
  it('writes a clean translation with its English source and placeholders', () => {
    expect(translatedEntry('usdcxStepBurned', 'Сожжено в $network$', 'Burned on $network$', 'ru')).toEqual({
      message: 'Сожжено в $network$',
      englishSource: 'Burned on $network$',
      placeholders: { network: { content: '$1' } }
    });
  });

  it('rejects a tagged term glued into a native word', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const entry = translatedEntry('gluedKey', 'A<x>note</x> é pública.', 'The note is public.', 'pt');
      expect(entry).toEqual({ message: 'The note is public.', englishSource: '(untranslated)' });
      expect(entry.message).not.toMatch(/<\/?x\s*>/);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toBe(
        '::warning title=Rejected translation::pt gluedKey glues Anote; keeping the English.'
      );
    } finally {
      log.mockRestore();
    }
  });

  it('writes a native Spanish word beside a clean tagged term without tags', () => {
    expect(translatedEntry('noteId', 'Anote el ID de la <x>note</x>', 'Write down the note ID', 'es')).toEqual({
      message: 'Anote el ID de la note',
      englishSource: 'Write down the note ID'
    });
  });

  it('checks a glued tagged span even beside a clean tagged term', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const entry = translatedEntry(
        'gluedKey',
        'A <x>note</x> e A<x>note</x> são públicas.',
        'The note and the note are public.',
        'pt'
      );
      expect(entry).toEqual({ message: 'The note and the note are public.', englishSource: '(untranslated)' });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toBe(
        '::warning title=Rejected translation::pt gluedKey glues Anote; keeping the English.'
      );
    } finally {
      log.mockRestore();
    }
  });

  it('keeps the English, queued for the next run, instead of a glued translation and flags the key on the checks', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const entry = translatedEntry(
        'gluedKey',
        'Opublikowanej notnote za $amount$ nie można cofnąć.',
        'A published note for $amount$ cannot be reclaimed.',
        'pl'
      );
      // The sentinel keeps the key out of the flat bundle (English fallback) and makes the next run re-translate it.
      expect(entry).toEqual({
        message: 'A published note for $amount$ cannot be reclaimed.',
        englishSource: '(untranslated)',
        placeholders: { amount: { content: '$1' } }
      });
      // A GitHub Actions annotation, so the rejection shows on the pull request rather than only in the job log.
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toEqual(
        expect.stringMatching(/^::warning title=Rejected translation::pl gluedKey .*notnote/)
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe('shipped locales', () => {
  it('reads every locale', () => {
    expect(LOCALES).toEqual(expect.arrayContaining(['en', 'de', 'es', 'fr', 'ja', 'ko', 'pl', 'pt', 'ru', 'tr']));
  });

  it.each(LOCALES)('%s glues no protected term to a word', locale => {
    const glued = Object.entries(loadMessages(locale)).flatMap(([key, entry]) =>
      findGluedTerms(entry.message, entry.englishSource, locale).map(word => `${key}: ${word}`)
    );
    expect(glued).toEqual([]);
  });

  it('names the Russian USDCx burn step with a real word (#1399)', () => {
    // "Сжето" is an invented word, not glue, so only this pin keeps it out.
    expect(loadMessages('ru').usdcxStepBurned?.message).toBe('Сожжено в $network$');
  });
});
