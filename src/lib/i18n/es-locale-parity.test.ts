import fs from 'fs';
import path from 'path';

// #469 — the Spanish locale shipped an incomplete/incorrect translation set:
// keys missing entirely (falling back to English) and at least one wrong
// action translation ("Close" rendered as "Cerca"/"Acerca" = near/about). These
// guards keep es structurally complete and pin the known-wrong fixes so the
// translation bot (which only re-translates when the English source changes)
// can't silently drift them back.

const LOCALES_DIR = path.join(__dirname, '../../../public/_locales');

type Entry = { message: string; englishSource?: string; placeholders?: Record<string, unknown> };
const load = (locale: string): Record<string, Entry> =>
  JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'messages.json'), 'utf8'));

const en = load('en');
const es = load('es');

describe('es locale parity with en (#469)', () => {
  it('has a Spanish entry for every shipped English key (no English fallback)', () => {
    const missing = Object.keys(en).filter(key => !(key in es));
    expect(missing).toEqual([]);
  });

  it("preserves each key's placeholder set so $x$ substitutions still resolve", () => {
    const mismatches: string[] = [];
    for (const key of Object.keys(en)) {
      if (!es[key]) continue;
      const enPlaceholders = Object.keys(en[key].placeholders ?? {}).sort();
      const esPlaceholders = Object.keys(es[key].placeholders ?? {}).sort();
      if (JSON.stringify(enPlaceholders) !== JSON.stringify(esPlaceholders)) {
        mismatches.push(`${key}: en[${enPlaceholders}] vs es[${esPlaceholders}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('translates "Close" as the action Cerrar, not the wrong "Cerca"/"Acerca" (#469)', () => {
    expect(es.close.message).toBe('Cerrar');
  });

  it('does not leave the fixed common UI terms in English', () => {
    // A curated subset of the entries this PR translated — guards against a
    // regression back to the English source. (The broader Spanish-quality audit
    // is a native-speaker follow-up per the issue.)
    for (const key of ['seedPhrase', 'notesSection', 'note', 'withdrawalFailed', 'totalPaid', 'transactionComplete']) {
      expect(es[key].message).not.toBe(en[key].message);
    }
  });
});
