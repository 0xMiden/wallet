import fs from 'fs';
import path from 'path';

// #479 — the Guardian explainer copy must describe the CURRENT product, not
// future policy capabilities. The wallet's Guardian is an OpenZeppelin multisig
// co-signer (see src/lib/miden/guardian/account.ts): every transaction needs the
// Guardian's signature plus one of the user's keys, `update_guardian` needs both
// user keys, and there is NO policy/limits engine. So the copy must:
//   - never claim the Guardian "approves or rejects based on your security policy"
//   - state plainly that it co-signs every transaction
//   - explain what changes (and what stays the same) when the Guardian is switched
// These guards pin the accuracy fix so it can't silently regress to overpromising.

const LOCALES_DIR = path.join(__dirname, '../../../public/_locales');
const EN_DIR = path.join(LOCALES_DIR, 'en');

type Entry = { message: string };
const readMessages = (locale: string): Record<string, Entry> =>
  JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'messages.json'), 'utf8'));

const LOCALES = fs
  .readdirSync(LOCALES_DIR)
  .filter(entry => fs.existsSync(path.join(LOCALES_DIR, entry, 'messages.json')));

const messages = readMessages('en');
const enJson: Record<string, string> = JSON.parse(fs.readFileSync(path.join(EN_DIR, 'en.json'), 'utf8'));

const message = (key: string): string => {
  const entry = messages[key];
  if (!entry) throw new Error(`en/messages.json is missing key: ${key}`);
  return entry.message;
};

const whatItDoes = message('guardianInfoWhatItDoesDescription');
const switching = message('guardianInfoSwitchingIsEasyDescription');

// The rotation success receipt repeats the switching explainer's promises to a
// user who has just rotated, so it is bound by the same accuracy guard.
const SUCCESS_RECEIPT_KEYS = [
  'guardianSwitchSuccessInfo1',
  'guardianSwitchSuccessInfo2',
  'guardianSwitchSuccessInfo3',
  'guardianSwitchSuccessInfo4'
] as const;

// The whole receipt surface, labels included — every string that tells the user
// what their Guardian is or does.
const GUARDIAN_RECEIPT_KEYS = [
  'currentGuardianLabel',
  'newGuardianLabel',
  'guardianSwitchSuccessTitle',
  'guardianSwitchSuccessInfoTitle',
  ...SUCCESS_RECEIPT_KEYS
] as const;

/**
 * Per-language wording that misdescribes the Guardian, gathered from real
 * regressions in these files. Two families:
 *
 *  - **Wrong thing.** The Guardian is a co-signer — not an address, page, site,
 *    list, version, or news feed. Machine translation reached for all of those.
 *  - **Wrong power.** "Approves"/"confirms"/"endorses" every transaction claims a
 *    policy engine the wallet does not have; #479 removed exactly that claim from
 *    the English explainer, and it came straight back in translation.
 *
 * English is checked separately (and more strictly) by the tests above.
 */
const BANNED_TERMS: Record<string, RegExp> = {
  de: /\bAdresse Guardian\b|\bGuardian-Adresse\b|\bgenehmigt\b/i,
  es: /\bdirecci[oó]n Guardian\b|\bp[aá]gina .?Guardian\b|\bsitio Guardian\b|\bapruebe?a?\b/i,
  fr: /\badresse Guardian\b|\bpage Guardian\b|\bsite Guardian\b|\bapprouve\b|\bfaire tourner\b/i,
  ja: /最新情報|承認します/,
  ko: /Guardian 주소|승인합니다/,
  pl: /\badres Guardian\b|\bstrona Guardian\b|\bzatwierdza\b/i,
  pt: /\bendere[cç]o Guardian\b|\bp[aá]gina Guardian\b|\bendossa\b|\baprova\b/i,
  // No `\b` on the Cyrillic alternatives: JS word boundaries are ASCII-only, so
  // `\bсайт` never matches — the guard silently passed everything.
  ru: /адрес Guardian|сайт Guardian|будет подтверждать|одобряет/i,
  tr: /\bGuardian adresi/i,
  uk: /адреса Guardian|сайт Guardian|список .?Guardian|версія Guardian|підтверджує/i,
  zh_CN: /地址 Guardian|Guardian 地址|批准/,
  zh_TW: /地址 Guardian|Guardian 地址|最新Guardian|新版 Guardian|批准/
};

describe('Guardian explainer copy accuracy (#479)', () => {
  it('does not claim a security-policy / approve-reject engine the product does not have', () => {
    // The inaccurate original: "Approves or rejects transactions based on your
    // security policy." There is no policy engine — it is a fixed co-signer.
    expect(whatItDoes).not.toMatch(/policy/i);
    expect(whatItDoes).not.toMatch(/approves or rejects/i);
  });

  it('states plainly that the Guardian co-signs every transaction', () => {
    expect(whatItDoes).toMatch(/co-?signs?/i);
  });

  it('explains what changes and what stays the same when the Guardian is switched', () => {
    // The issue asks specifically for "what changes when the Guardian provider is
    // switched". Accurate answer: only the co-signer changes; funds/account are
    // untouched.
    expect(switching).toMatch(/co-?sign|provider/i);
    expect(switching).toMatch(/stay the same|unchanged|same/i);
  });

  it('does not claim a Guardian-removal capability the wallet does not expose', () => {
    // The product has only a `switch-guardian` flow (RotateGuardian requires
    // picking a DIFFERENT endpoint) — no remove/disable-Guardian action exists.
    // Guarding against the "or remove one entirely" overstatement.
    expect(switching).not.toMatch(/\bremove\b|\bdisable\b|\bdelete\b/i);
  });

  it('does not claim a Guardian-removal capability on the rotation success receipt either', () => {
    // The receipt shipped with "You can rotate or remove your Guardian again at
    // any time", reintroducing on a second surface the exact overstatement this
    // suite removed from the explainer. Several translations then rendered it as
    // removing the RECOVERY PHRASE, which is worse than merely inaccurate.
    for (const key of SUCCESS_RECEIPT_KEYS) {
      expect(message(key)).not.toMatch(/\bremove\b|\bdisable\b|\bdelete\b/i);
    }
  });

  it('ships the whole receipt surface in every locale', () => {
    for (const locale of LOCALES) {
      const localeMessages = readMessages(locale);
      for (const key of GUARDIAN_RECEIPT_KEYS) {
        expect(localeMessages[key]?.message).toBeTruthy();
      }
    }
  });

  it('does not misdescribe the Guardian in any translation', () => {
    // The English guards above are blind to the translations, which is where the
    // damage actually shipped: the receipt has read "your new Guardian ADDRESS",
    // "New Guardian PAGE", "the latest Guardian NEWS", and — worst — "your new
    // Guardian will APPROVE every transaction", the capability #479 exists to deny.
    for (const locale of LOCALES) {
      const banned = BANNED_TERMS[locale];
      if (!banned) continue;
      const localeMessages = readMessages(locale);
      for (const key of GUARDIAN_RECEIPT_KEYS) {
        expect(localeMessages[key]?.message ?? '').not.toMatch(banned);
      }
    }
  });

  it('does not claim a Guardian-removal capability in any translation', () => {
    const removal =
      /\bremove\b|\bdisable\b|\bdelete\b|\bentfernen\b|\beliminar\b|\bsupprimer\b|\bretirer\b|\busuń|\bremover\b|\bудалить\b|\bвидалити\b|\bkaldır|\bsil\b|削除|삭제|删除|刪除/i;
    for (const locale of LOCALES) {
      const localeMessages = readMessages(locale);
      for (const key of SUCCESS_RECEIPT_KEYS) {
        expect(localeMessages[key]?.message ?? '').not.toMatch(removal);
      }
    }
  });

  it('keeps en/messages.json and en/en.json in sync for the changed keys (generator source of truth)', () => {
    for (const key of [
      'guardianInfoWhatItDoesDescription',
      'guardianInfoSwitchingIsEasyDescription',
      ...SUCCESS_RECEIPT_KEYS
    ]) {
      expect(enJson[key]).toBe(message(key));
    }
  });
});
