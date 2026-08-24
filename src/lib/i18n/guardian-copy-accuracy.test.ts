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
  // The review screen's only error copy, now that the same-endpoint guard runs
  // there rather than after the credential prompt.
  'guardianEndpointUnchanged',
  ...SUCCESS_RECEIPT_KEYS
] as const;

/**
 * Per-language wording that misdescribes the Guardian. Two families:
 *
 *  - **Wrong thing.** The Guardian is a co-signer — not an address, page, site,
 *    app, list, version, or news feed. Machine translation reached for all of
 *    those. "Address" is the dangerous one, because the receipt's own second
 *    bullet promises the wallet ADDRESS did not change.
 *  - **Wrong power.** "Approves"/"confirms"/"endorses" every transaction claims a
 *    policy engine the wallet does not have; #479 removed exactly that claim from
 *    the English explainer, and it came straight back in translation.
 *
 * Written as stems with optional function words rather than whole words, because
 * the inflected forms are what MT actually produces: `adresu Guardian` (Polish
 * genitive), `endereço DO Guardian`, `Guardian’ın adresi`, `Guardianアドレス` with
 * no space. Note `\b` is ASCII-only in JS, so it must not be used against
 * Cyrillic or CJK — `/\bсайт/` can never match.
 *
 * Where a noun is legitimate elsewhere in the same string (every locale's second
 * bullet says "your WALLET address"), the pattern requires Guardian adjacency
 * rather than banning the noun outright.
 */
const BANNED_TERMS: Record<string, RegExp> = {
  en: /Guardian (address|page|site|app)|approves|policy/i,
  en_GB: /Guardian (address|page|site|app)|approves|policy/i,
  // `\S*` rather than `\w*` for the inflected tail: `\w` is ASCII-only, so it
  // matches neither the Turkish `ı` in `Guardian’ın adresi` nor the `а` in
  // `адреса Guardian`, and the alternative silently never fires.
  de: /Adress\S* Guardian|Guardian[-\s]?Adress|genehmig|billigt/i,
  es: /direcci[oó]n (del |de la )?Guardian|p[aá]gina .{0,3}Guardian|sitio (del )?Guardian|aplicaci[oó]n .{0,3}Guardian|aprob|aprueb|avala/i,
  fr: /adresse (du |de la )?Guardian|page (du )?Guardian|site (du )?Guardian|approuv|avalise|faire tourner|Guardiane/i,
  ja: /最新情報|承認|Guardian\s?(アドレス|ページ|サイト)/,
  ko: /Guardian\s?주소|승인/,
  pl: /adres\S* Guardian|stron\S* Guardian|witryn\S* Guardian|zatwierdza|akceptuje ka/i,
  pt: /endere[cç]o (do |da )?Guardian|p[aá]gina (do )?Guardian|endoss|aprov/i,
  ru: /адрес\S* Guardian|Guardian[-\s]адрес|сайт Guardian|подтвержда|одобря/i,
  tr: /Guardian\S*\s*adres|adresi Guardian|onayl/i,
  uk: /адрес\S* Guardian|Guardian[-\s]адрес|сайт Guardian|список .{0,2}Guardian|верс\S+ Guardian|підтверджу|схвалю/i,
  zh_CN: /Guardian\s?地址|地址\s?Guardian|批准|核准/,
  zh_TW: /Guardian\s?(地址|帳戶)|地址\s?Guardian|最新\s?Guardian|新版\s?Guardian|批准|核准/
};

/**
 * Real strings these files have shipped, one per locale that has a pattern. The
 * sweep below asserts each is caught, because a banned-term guard that matches
 * nothing is indistinguishable from no guard at all — and this one has already
 * silently passed everything once, when `\b` was left in front of Cyrillic.
 */
const KNOWN_BAD: Array<[string, string]> = [
  ['en', 'Your new Guardian address approves every transaction'],
  ['en_GB', 'Your new Guardian page is reachable'],
  ['de', 'Ihre neue Adresse Guardian ist erreichbar'],
  ['es', 'Nueva página «Guardian»'],
  ['es', 'Tu nueva dirección del Guardian firmará'],
  ['fr', 'Vous avez réussi à faire tourner vos «Guardian» !'],
  ['fr', 'Votre nouvelle adresse du Guardian cosigne'],
  ['ja', 'Guardianの最新情報'],
  ['ja', 'Guardianアドレスが到達可能'],
  ['ko', '귀하의 새로운 Guardian 주소가 접근 가능해야'],
  ['ko', 'Guardian주소를 승인합니다'],
  ['pl', 'Nowa strona Guardian'],
  ['pl', 'przejść na inny adresu Guardian'],
  ['pt', 'mudar para um endereço do Guardian diferente'],
  ['ru', 'Новый сайт Guardian'],
  ['ru', 'Ваш новый адрес Guardian подтверждает каждую транзакцию'],
  ['tr', 'Yeni Guardian adresiniz her işlemi onaylayacaktır'],
  ['tr', 'farklı bir Guardian’ın adresine geçebilirsiniz'],
  ['uk', 'Поточний список «Guardian»'],
  ['uk', 'Нова версія Guardian'],
  ['uk', 'ваша нова адреса Guardian підписує'],
  ['zh_CN', '您的新地址 Guardian 将对每笔交易进行联署'],
  ['zh_CN', '新Guardian地址'],
  ['zh_TW', '最新Guardian'],
  ['zh_TW', '切換至不同的 Guardian 帳戶']
];

// Removal verbs, as stems for the same reason: `\busuń` misses the Polish
// infinitive `usunąć`, `\bsil\b` dies on the Turkish suffix in `silinebilir`, and
// the Cyrillic and CJK alternatives can carry no `\b` at all.
const REMOVAL_TERMS =
  /\bremove|\bdisable|\bdelete|entfern|l[oö]sch|elimin|quitar|supprim|enlev|usun|usuw|remov|apagar|excluir|удал|видал|kaldır|silin|\bsil\b|çıkar|削除|解除|제거|삭제|移除|删除|刪除/i;

const KNOWN_BAD_REMOVAL = [
  'You can rotate or remove your Guardian again at any time',
  'Sie können Ihren Guardian jederzeit entfernt',
  'Puedes eliminar tu Guardian',
  'Vous pouvez supprimer votre Guardian',
  'Możesz usunąć swojego Guardiana',
  'Você pode remover seu Guardian',
  'Вы можете удалить своего Guardian',
  'Ви можете видалити свого Guardian',
  "Guardian'ınızı kaldırabilirsiniz",
  'Guardian’ınız silinebilir',
  'Guardianを削除できます',
  'Guardian을 제거할 수 있습니다',
  '您可以移除您的 Guardian',
  '您可以刪除您的 Guardian'
];

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
    for (const locale of LOCALES) {
      const localeMessages = readMessages(locale);
      for (const key of SUCCESS_RECEIPT_KEYS) {
        expect(localeMessages[key]?.message ?? '').not.toMatch(REMOVAL_TERMS);
      }
    }
  });

  it('has guards that actually fire — every known-bad string this copy has shipped is caught', () => {
    // Without this, a typo or an ASCII `\b` in front of a Cyrillic alternative
    // turns a guard into decoration and nothing tells you.
    for (const [locale, bad] of KNOWN_BAD) {
      const banned = BANNED_TERMS[locale];
      expect(banned).toBeDefined();
      expect(bad).toMatch(banned!);
    }
    for (const bad of KNOWN_BAD_REMOVAL) {
      expect(bad).toMatch(REMOVAL_TERMS);
    }
  });

  it('guards every locale that ships the receipt', () => {
    // A locale with no pattern is a locale nobody is checking.
    for (const locale of LOCALES) {
      expect(BANNED_TERMS[locale]).toBeDefined();
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
