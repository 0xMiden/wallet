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

// Pinned, because everything below is a loop over LOCALES: a discovery that
// silently returned one locale — or none — would report a green sweep while
// checking nothing. This list is the assertion that the sweep has a subject.
const EXPECTED_LOCALES = ['de', 'en', 'en_GB', 'es', 'fr', 'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh_CN', 'zh_TW'];

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
 * The rotation warning, held apart from the receipt keys above. It is the one
 * place the UI explains what the OLD Guardian can still do, and the only
 * Guardian copy whose subject is the user's keys rather than the Guardian — so
 * it is swept for the "wrong thing" family only. Six locales rendered it as
 * "your old Guardian ADDRESS", the exact confusion the receipt's "your wallet
 * address did not change" bullet has to survive.
 */
const ROTATION_WARNING_KEYS = ['oldGuardianCantBlockTitle', 'oldGuardianCantBlockBody'] as const;

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
/**
 * Whatever a translation puts between the noun and the word "Guardian":
 * articles and prepositions in any of the languages here, plus the quotes,
 * brackets and dashes the locale files wrap the product name in. Written once
 * because hand-listing `(du |de la )?` per language is exactly how the guard let
 * `adresse « Guardian »` and `адрес «Guardian»` through — the noun and the name
 * were adjacent in meaning but not in the pattern.
 */
const NEAR = String.raw`[\s«»„“”"'’(),.\-]*(?:de |del |de la |du |da |do |der |die |das |dem |den |the |el |la |le |les |di )?[\s«»„“”"'’(),.\-]*`;

const nounNearGuardian = (nouns: string[]): string =>
  nouns.map(noun => `${noun}${NEAR}Guardian|Guardian${NEAR}${noun}`).join('|');

const wrongThing = (nouns: string[], extra: string[] = [], caseInsensitive = true): RegExp =>
  new RegExp([nounNearGuardian(nouns), ...extra].join('|'), caseInsensitive ? 'i' : '');

// `\S*` rather than `\w*` for an inflected tail: `\w` is ASCII-only, so it
// matches neither the Turkish `ı` in `Guardian’ın adresi` nor the `а` in
// `адреса Guardian`, and such an alternative silently never fires.
const WRONG_THING_TERMS: Record<string, RegExp> = {
  en: wrongThing(['address', 'page', 'site', 'app']),
  en_GB: wrongThing(['address', 'page', 'site', 'app']),
  de: wrongThing([String.raw`Adress\S*`]),
  es: wrongThing([String.raw`direcci[oó]n`, String.raw`p[aá]gina`, 'sitio', String.raw`aplicaci[oó]n`]),
  fr: wrongThing(['adresse', 'page', 'site'], ['faire tourner', 'Guardiane']),
  ja: wrongThing([String.raw`アドレス`, String.raw`ページ`, String.raw`サイト`], [String.raw`最新情報`], false),
  ko: wrongThing([String.raw`주소`], [], false),
  pl: wrongThing([String.raw`adres\S*`, String.raw`stron\S*`, String.raw`witryn\S*`]),
  pt: wrongThing([String.raw`endere[cç]o`, String.raw`p[aá]gina`]),
  ru: wrongThing([String.raw`адрес\S*`, String.raw`сайт\S*`]),
  // Turkish glues the possessive onto the name — `Guardian’ın adresine` — so the
  // name side needs an inflectional tail that the shared connector, which stops
  // at the first non-punctuation character, cannot supply. Kept local to `tr`: a
  // `\S*` tail is safe between whitespace-delimited words and dangerous in CJK,
  // where it would run to the end of the sentence.
  tr: wrongThing([String.raw`adres\S*`], [String.raw`Guardian\S*\s*adres`]),
  uk: wrongThing([String.raw`адрес\S*`, String.raw`сайт\S*`, String.raw`список`, String.raw`верс\S+`], [], true),
  zh_CN: wrongThing([String.raw`地址`], [], false),
  zh_TW: wrongThing(
    [String.raw`地址`, String.raw`帳戶`],
    [String.raw`最新\s?Guardian`, String.raw`新版\s?Guardian`],
    false
  )
};

/**
 * "Wrong power" is tracked separately from "wrong thing" because the approval
 * verbs are only false when the GUARDIAN is doing the approving. The rotation
 * warning says the opposite and is correct: the switch "is approved by your two
 * on-device keys". Sweeping that string for `genehmigt` / `aprueba` / `承認`
 * would flag the very sentence that states the accurate mechanism, so these
 * patterns apply to the receipt keys only.
 */
const WRONG_POWER_TERMS: Record<string, RegExp> = {
  en: /approves|policy/i,
  en_GB: /approves|policy/i,
  de: /genehmig|billigt/i,
  es: /aprob|aprueb|avala/i,
  fr: /approuv|avalise/i,
  ja: /承認/,
  ko: /승인/,
  pl: /zatwierdza|akceptuje ka/i,
  pt: /endoss|aprov/i,
  ru: /подтвержда|одобря/i,
  tr: /onayl/i,
  uk: /підтверджу|схвалю/i,
  zh_CN: /批准|核准/,
  zh_TW: /批准|核准/
};

/** Union of both families, for the strings where the Guardian is the subject. */
const bannedForReceipt = (locale: string): RegExp | undefined => {
  const thing = WRONG_THING_TERMS[locale];
  const power = WRONG_POWER_TERMS[locale];
  if (!thing || !power) return undefined;
  return new RegExp(`${thing.source}|${power.source}`, thing.flags.includes('i') ? 'i' : '');
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

/**
 * The rotation-warning strings as they actually shipped, before this sweep
 * covered them. Six locales called the co-signer an address; several wrapped the
 * product name in quotes, which is how they slipped past a pattern that expected
 * the noun and the name to be adjacent.
 */
const KNOWN_BAD_WARNING: Array<[string, string]> = [
  ['es', 'Tu antigua dirección de Guardian no puede bloquear esto'],
  ['fr', 'L’ancienne adresse « Guardian » est simplement informée.'],
  ['ru', 'Старый адрес «Guardian» получает лишь уведомление.'],
  ['pl', 'Twój stary adres Guardian nie może tego zablokować'],
  ['pt', 'O antigo endereço Guardian é apenas notificado.'],
  ['tr', 'Eski Guardian adresiniz bunu engelleyemez'],
  ['tr', 'Eski Guardian adresine yalnızca bildirim gönderilir.'],
  ['ko', '기존 Guardian 주소에는 단지 알림만 전송됩니다.']
];

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
      for (const key of [...GUARDIAN_RECEIPT_KEYS, ...ROTATION_WARNING_KEYS]) {
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
      const banned = bannedForReceipt(locale);
      if (!banned) continue;
      const localeMessages = readMessages(locale);
      for (const key of GUARDIAN_RECEIPT_KEYS) {
        expect(localeMessages[key]?.message ?? '').not.toMatch(banned);
      }
    }
  });

  it('does not call the Guardian an address on the rotation warning, in any translation', () => {
    // Only the "wrong thing" family here: this string's whole job is to say the
    // switch is approved by the USER's two keys, so the approval verbs are
    // accurate. What is not accurate is naming the co-signer an address, which
    // six locales did.
    for (const locale of LOCALES) {
      const banned = WRONG_THING_TERMS[locale];
      if (!banned) continue;
      const localeMessages = readMessages(locale);
      for (const key of ROTATION_WARNING_KEYS) {
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
      const banned = bannedForReceipt(locale);
      expect(banned).toBeDefined();
      expect(bad).toMatch(banned!);
    }
    for (const [locale, bad] of KNOWN_BAD_WARNING) {
      const banned = WRONG_THING_TERMS[locale];
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
      expect(WRONG_THING_TERMS[locale]).toBeDefined();
      expect(WRONG_POWER_TERMS[locale]).toBeDefined();
    }
  });

  it('sweeps every locale the wallet ships, so a green run cannot mean an empty sweep', () => {
    expect([...LOCALES].sort()).toEqual([...EXPECTED_LOCALES].sort());
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
