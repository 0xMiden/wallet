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
  // The two explainer strings this suite was originally written for (#479), in
  // the per-locale sweep and not just the English assertions further down. They
  // were the last keys still checked in English only, and every mistranslation
  // the sweep was built to catch was sitting in them: "the Guardian
  // application" (es), the invented "l'Guardiane" (fr), "a different Guardian
  // ADDRESS" (pl/pt/ru/tr), "a different Guardian ACCOUNT" (zh_TW), and a
  // feminine article treating it as an app (de).
  'guardianInfoWhatItDoesDescription',
  'guardianInfoSwitchingIsEasyDescription',
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
 * Whatever a translation puts between the noun and the word "Guardian": the
 * quotes, brackets and dashes these files wrap the product name in, plus up to
 * two short words for the articles, prepositions and adjectives every language
 * here inserts (`adresse « Guardian »`, `адрес «Guardian»`, `versão atual de
 * Guardian`, `endereço do Guardian`). Deliberately loose — a false positive
 * costs one reading of a flagged string, while the misses this replaces shipped
 * "your current Guardian page" to users. Whitespace-anchored, so it collapses to
 * nothing for the CJK patterns, which rely on adjacency.
 */
// Quotes and brackets only — no sentence terminators, or the pattern reaches
// across a full stop and flags two unrelated clauses.
const PUNCT = String.raw`[\s«»„“”"'’()\-]*`;

// As PUNCT, plus the genitive/attributive particles. Without them the sweep only
// saw the spaced forms (`Guardian アドレス`) and missed the idiomatic ones —
// `Guardianのアドレス`, `Guardian의 주소`, `Guardian的地址` — which are the
// shapes machine translation actually produces in these languages.
const CJK_PUNCT = String.raw`[\s«»„“”"'’()\-の的의와과]*`;

// Up to two intervening words, counted as LETTERS rather than `\S`: a character
// budget in a script without spaces buys a whole clause, so `地址不是钱包的
// Guardian` ("the address is not the wallet's Guardian") looked like a hit.
const WORDS = String.raw`(?:[\p{L}\p{M}]{1,12}\s+){0,2}`;

const nounNearGuardian = (nouns: string[], connector: string): string =>
  nouns.map(noun => `${noun}${connector}Guardian|Guardian${connector}${noun}`).join('|');

/**
 * `spaced` languages allow the intervening words; ja/ko/zh get particle-and-
 * punctuation adjacency only, which covers every form their known-bad strings
 * take (`Guardianアドレス`, `Guardianのアドレス`, `Guardian 주소`, `地址 Guardian`)
 * and is the only shape that cannot run past a sentence boundary in text with no
 * word spacing.
 */
const wrongThing = (
  nouns: string[],
  { extra = [], spaced = true }: { extra?: string[]; spaced?: boolean } = {}
): RegExp =>
  new RegExp([nounNearGuardian(nouns, spaced ? `${PUNCT}${WORDS}${PUNCT}` : CJK_PUNCT), ...extra].join('|'), 'iu');

// `\S*` rather than `\w*` for an inflected tail: `\w` is ASCII-only, so it
// matches neither the Turkish `ı` in `Guardian’ın adresi` nor the `а` in
// `адреса Guardian`, and such an alternative silently never fires.
const WRONG_THING_TERMS: Record<string, RegExp> = {
  en: wrongThing(['address', 'page', 'site', 'app']),
  en_GB: wrongThing(['address', 'page', 'site', 'app']),
  // German needs a gender check as well as a noun check: MT rendered it as *die*
  // Guardian and *einer anderen* Guardian — feminine, which in German reads as
  // "the Guardian app/site" rather than the person/service that co-signs. The
  // noun list cannot see that, because the noun is right and only the article is
  // wrong. `der`/`einem` are the correct masculine forms and are not matched.
  // `(?!-)` on the gender extras, because a `Guardian-<noun>` compound takes the
  // COMPOUND's gender, so "die Guardian-Signatur" and "die Guardian-Betreiber"
  // are correct German. Without it the sweep flagged both, and the `de`
  // KNOWN_GOOD entry has no compound in it, so nothing here would have noticed.
  // The wrong-noun half of such a compound is still caught by the noun list.
  de: wrongThing([String.raw`Adress\S*`, String.raw`Seite\S*`, 'App', String.raw`Anwendung\S*`, 'Website'], {
    extra: [String.raw`\bdie\s*[„“"«»]?\s*Guardian(?!-)`, String.raw`\beiner\s+anderen\s*[„“"«»]?\s*Guardian(?!-)`]
  }),
  es: wrongThing([String.raw`direcci[oó]n`, String.raw`p[aá]gina`, 'sitio', String.raw`aplicaci[oó]n`]),
  fr: wrongThing(['adresse', 'page', 'site'], { extra: ['faire tourner', 'Guardiane'] }),
  ja: wrongThing([String.raw`アドレス`, String.raw`ページ`, String.raw`サイト`], {
    extra: [String.raw`最新情報`],
    spaced: false
  }),
  ko: wrongThing([String.raw`주소`, String.raw`페이지`, String.raw`사이트`, String.raw`앱`], { spaced: false }),
  pl: wrongThing([String.raw`adres\S*`, String.raw`stron\S*`, String.raw`witryn\S*`]),
  pt: wrongThing([String.raw`endere[cç]o`, String.raw`p[aá]gina`, String.raw`vers[aã]o`]),
  ru: wrongThing([String.raw`адрес\S*`, String.raw`сайт\S*`]),
  // Turkish glues the possessive onto the name — `Guardian’ın adresine` — so the
  // name side needs an inflectional tail that the shared connector, which stops
  // at the first non-punctuation character, cannot supply. Kept local to `tr`: a
  // `\S*` tail is safe between whitespace-delimited words and dangerous in CJK,
  // where it would run to the end of the sentence.
  tr: wrongThing([String.raw`adres\S*`], { extra: [String.raw`Guardian\S*\s*adres`] }),
  uk: wrongThing([String.raw`адрес\S*`, String.raw`сайт\S*`, String.raw`список`, String.raw`верс\S+`]),
  // `版` is "version". Both Chinese locales called the previous provider the
  // "old-VERSION Guardian", which describes a software release rather than the
  // Guardian being switched away from — the same class of error as "Guardian
  // address" in the European locales.
  zh_CN: wrongThing([String.raw`地址`, String.raw`页面`, String.raw`网站`, String.raw`应用`], {
    extra: [String.raw`[旧新最]版\s?Guardian`],
    spaced: false
  }),
  zh_TW: wrongThing([String.raw`地址`, String.raw`帳戶`, String.raw`頁面`, String.raw`網站`, String.raw`應用`], {
    extra: [String.raw`最新\s?Guardian`, String.raw`[舊新]版\s?Guardian`],
    spaced: false
  })
};

/**
 * "Wrong power" is tracked separately from "wrong thing" because the approval
 * verbs are only false when the GUARDIAN is doing the approving. The rotation
 * warning says the opposite and is correct: the switch "is approved by your two
 * on-device keys". Sweeping that string for `genehmigt` / `aprueba` / `承認`
 * would flag the very sentence that states the accurate mechanism, so these
 * patterns apply to the receipt keys only.
 */
/**
 * An approval verb with the Guardian in front of it, rather than the bare verb.
 *
 * Bare stems flagged accurate copy: `approv` matched "Your two device keys
 * approve the switch, not the Guardian" — the sentence that states the correct
 * mechanism, and now a receipt key — while `polic` matched "privacy policy" and
 * `authoris` matched "unauthorised device". The verb is only wrong when the
 * GUARDIAN is the one doing it, so require the Guardian to be its subject.
 *
 * Directional on purpose. A passive misdescription ("every transaction is
 * approved by your Guardian") puts the verb first and is NOT caught — matching
 * both directions is what produced the false positives above, since the accurate
 * sentence also has the Guardian trailing the verb, and telling those apart needs
 * per-locale negation handling. Every misdescription machine translation has
 * actually emitted here is Guardian-first; see KNOWN_BAD_POWER.
 */
const wrongPower = (verbs: string[], { spaced = true }: { spaced?: boolean } = {}): RegExp =>
  new RegExp(
    // For CJK a bounded run of any non-sentence-ending character, since the
    // subject is not whitespace-delimited from the verb: `Guardian会批准`,
    // `Guardianがすべての取引を承認`. Capped, and stopping at sentence enders, so
    // it cannot reach a verb belonging to the next sentence.
    `Guardian(?:['’]s)?${spaced ? `${PUNCT}${WORDS}${PUNCT}` : String.raw`[^。．！？!?\n]{0,12}`}(?:${verbs.join('|')})`,
    'iu'
  );

const WRONG_POWER_TERMS: Record<string, RegExp> = {
  // Stems, like every other locale here. `approves` alone missed "will approve",
  // "must approve", "approval" and the near-synonyms the doc comment above
  // already names — five of the six phrasings MT actually produces.
  en: wrongPower(['approv', 'polic', 'endors', 'confirms every', 'authoris', 'authoriz']),
  en_GB: wrongPower(['approv', 'polic', 'endors', 'confirms every', 'authoris', 'authoriz']),
  de: wrongPower(['genehmig', 'billigt']),
  es: wrongPower(['aprob', 'aprueb', 'avala']),
  fr: wrongPower(['approuv', 'avalise']),
  ja: wrongPower([String.raw`承認`], { spaced: false }),
  ko: wrongPower([String.raw`승인`], { spaced: false }),
  pl: wrongPower(['zatwierdza', 'akceptuje ka']),
  pt: wrongPower(['endoss', 'aprov']),
  ru: wrongPower([String.raw`подтвержда`, String.raw`одобря`]),
  tr: wrongPower(['onayl']),
  uk: wrongPower([String.raw`підтверджу`, String.raw`схвалю`]),
  zh_CN: wrongPower([String.raw`批准`, String.raw`核准`], { spaced: false }),
  zh_TW: wrongPower([String.raw`批准`, String.raw`核准`], { spaced: false })
};

/**
 * Union of both families, for the strings where the Guardian is the subject.
 *
 * Flags are carried over from BOTH operands rather than rebuilt: composing the
 * sources into a new pattern silently drops any flag the new one lacks, and `u`
 * is load-bearing — without it `\p{L}` in the connector stops meaning "a letter"
 * and the alternative it sits in can never match. A guard that quietly matches
 * nothing is the exact failure this suite exists to prevent, so the union is
 * taken mechanically instead of listing flags by hand.
 */
const bannedForReceipt = (locale: string): RegExp | undefined => {
  const thing = WRONG_THING_TERMS[locale];
  const power = WRONG_POWER_TERMS[locale];
  if (!thing || !power) return undefined;
  const flags = [...new Set([...thing.flags, ...power.flags])].join('');
  return new RegExp(`${thing.source}|${power.source}`, flags);
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
  // "Guardian page", the defect class round 8 widened the sweep for. It was
  // pinned in en/pl/ru and invisible in de, ko and both Chinese locales, which
  // had no pattern for page, app or site at all.
  ['de', 'Ihre neue Guardian-Seite ist erreichbar'],
  ['de', 'Die Guardian-App wurde aktualisiert'],
  ['ko', 'Guardian 페이지가 변경되었습니다'],
  ['ko', 'Guardian 앱을 여세요'],
  ['zh_CN', 'Guardian 页面已更改'],
  ['zh_TW', 'Guardian 頁面已更改'],
  ['zh_TW', '最新Guardian'],
  // Regenerated by the translation bot after the English source was corrected —
  // the bot has no notion of what a Guardian is, so the guard has to be the
  // thing that catches this, on every regeneration.
  ['pl', 'To już jest wasza obecna strona Guardian.'],
  ['tr', 'Bu, halihazırda kullandığınız Guardian adresidir.'],
  ['pt', 'Essa já é a sua versão atual de Guardian.'],
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
  ['ko', '기존 Guardian 주소에는 단지 알림만 전송됩니다.'],
  ['zh_CN', '您的旧版Guardian无法阻止此操作'],
  ['zh_TW', '您的舊版 Guardian 無法阻止此事'],
  // The explainer strings as they actually shipped, before this sweep reached
  // them. Pinned so re-adding the keys can never quietly stop mattering.
  ['es', 'ni tu dispositivo ni la aplicación «Guardian» pueden mover fondos'],
  ['fr', "ni votre appareil ni l'Guardiane ne peuvent"],
  ['pl', 'przejść na inny adres Guardian'],
  ['pt', 'mudar para um endereço Guardian diferente'],
  ['ru', 'перейти на другой адрес Guardian'],
  ['tr', 'farklı bir Guardian adresine geçebilirsiniz'],
  ['zh_TW', '切換至不同的 Guardian 帳戶'],
  ['de', 'weder Ihr Gerät noch die „Guardian“ können Gelder']
];

/**
 * One approval claim per locale, asserted against WRONG_POWER_TERMS directly.
 * `bannedForReceipt` ORs the two families, so a KNOWN_BAD hit can be satisfied
 * entirely by the noun pattern — which left ten of the fourteen approval
 * patterns never proven to fire at all. That is the "guard becomes decoration"
 * failure this suite exists to prevent, applied to itself.
 */
const KNOWN_BAD_POWER: Array<[string, string]> = [
  ['en', 'Your new Guardian will approve every transaction'],
  ['en_GB', 'The Guardian approves transactions based on your security policy'],
  ['de', 'Ihr Guardian genehmigt jede Transaktion'],
  ['es', 'Tu Guardian aprueba cada transacción'],
  ['fr', 'Votre Guardian approuve chaque transaction'],
  ['ja', 'Guardianがすべての取引を承認します'],
  ['ko', 'Guardian이 모든 거래를 승인합니다'],
  ['pl', 'Twój Guardian zatwierdza każdą transakcję'],
  ['pt', 'Seu Guardian aprova todas as transações'],
  ['ru', 'Ваш Guardian подтверждает каждую транзакцию'],
  ['tr', 'Guardian her işlemi onaylar'],
  ['uk', 'Ваш Guardian підтверджує кожну транзакцію'],
  ['zh_CN', 'Guardian 会批准每笔交易'],
  ['zh_TW', 'Guardian 會批准每筆交易']
];

/**
 * Idiomatic CJK misdescriptions using the genitive particle rather than a space.
 * These are the forms machine translation actually emits, and a punctuation-only
 * connector missed all three.
 */
const KNOWN_BAD_CJK_PARTICLE: Array<[string, string]> = [
  ['ja', 'Guardianのアドレスは変わりません'],
  ['ko', 'Guardian의 주소가 변경되었습니다'],
  ['zh_CN', 'Guardian的地址已更改']
];

/**
 * The other half of the self-test: strings the guard must NOT flag. Every
 * pattern here is a stem-plus-connector, so an over-broad connector would reject
 * correct copy — and the failure mode would be a red build on a good
 * translation, which is how a guard gets deleted. These are the real shipped
 * strings plus the near-misses that motivated each narrowing: a sentence
 * boundary between the noun and "Guardian", and a Chinese clause long enough
 * that a character-budget connector spanned it.
 */
const KNOWN_GOOD: Array<[string, string]> = [
  ['en', 'Your wallet address did not change. Your Guardian co-signs every transaction.'],
  ['en', 'This is already your current Guardian.'],
  // The accurate statement of the mechanism, which the bare `approv` stem flagged
  // — and it lives in a receipt key, so it was swept.
  ['en', 'Your two device keys approve the switch, not the Guardian.'],
  ['en', 'Read our privacy policy for details.'],
  ['en', 'Sign in again from an unauthorised device.'],
  // `Guardian-<noun>` compounds: correct German, since the compound carries its
  // own gender, but "die Guardian…" read as a gender error to the sweep.
  ['de', 'Die Guardian-Signatur bleibt erforderlich.'],
  ['de', 'Wir benachrichtigen die Guardian-Betreiber.'],
  ['en_GB', 'Your wallet address has not changed. Your Guardian co-signs every transaction.'],
  ['pt', 'O endereço da sua carteira não muda. O Guardian co-assina cada transação.'],
  ['de', 'Ihre Wallet-Adresse bleibt gleich. Ihr Guardian signiert weiterhin mit.'],
  ['es', 'Tu dirección de wallet no cambia. El Guardian co-firma cada transacción.'],
  ['fr', 'Votre adresse de portefeuille ne change pas. Votre Guardian co-signe.'],
  ['pl', 'Twój adres portfela się nie zmienia. Twój Guardian współpodpisuje.'],
  ['ru', 'Ваш адрес кошелька не меняется. Ваш Guardian подписывает вместе с вами.'],
  ['tr', 'Cüzdan adresiniz değişmez. Guardian her işlemi birlikte imzalar.'],
  ['uk', 'Ваша адреса гаманця не змінюється. Ваш Guardian підписує разом із вами.'],
  ['ja', 'ウォレットのアドレスは変わりません。Guardianが共同署名します。'],
  ['ko', '지갑 주소는 변경되지 않습니다. Guardian이 공동 서명합니다.'],
  ['zh_CN', '您的钱包地址不会改变，Guardian 会共同签署每笔交易。'],
  ['zh_TW', '您的錢包地址不會改變，Guardian 會共同簽署每筆交易。']
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

  it('proves each family fires on its own, not just their union', () => {
    for (const [locale, bad] of KNOWN_BAD_POWER) {
      const power = WRONG_POWER_TERMS[locale];
      expect(power).toBeDefined();
      expect(bad).toMatch(power!);
    }
    // Every locale that ships must appear above; otherwise its approval pattern
    // is unexercised and could be a typo that never fires. Compared as a set, so
    // that adding a SECOND phrasing for a locale — the obvious response to finding
    // a new machine-translation failure — is allowed. As sorted arrays it was not.
    expect([...new Set(KNOWN_BAD_POWER.map(([locale]) => locale))].sort()).toEqual([...EXPECTED_LOCALES].sort());

    for (const [locale, bad] of KNOWN_BAD_CJK_PARTICLE) {
      const thing = WRONG_THING_TERMS[locale];
      expect(thing).toBeDefined();
      expect(bad).toMatch(thing!);
    }
  });

  it('leaves correct copy alone, so the patterns cannot pass by rejecting everything', () => {
    for (const [locale, good] of KNOWN_GOOD) {
      const banned = bannedForReceipt(locale);
      expect(banned).toBeDefined();
      expect(good).not.toMatch(banned!);
      const thing = WRONG_THING_TERMS[locale];
      expect(thing).toBeDefined();
      expect(good).not.toMatch(thing!);
      expect(good).not.toMatch(REMOVAL_TERMS);
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
    // Every key this suite guards, not just the receipt bullets: `en.json` is
    // what the app reads at runtime and `messages.json` is what the translation
    // generator reads, so a key corrected in one and not the other ships the
    // wrong English AND regenerates every locale from the stale source.
    for (const key of [
      'guardianInfoWhatItDoesDescription',
      'guardianInfoSwitchingIsEasyDescription',
      ...GUARDIAN_RECEIPT_KEYS,
      ...ROTATION_WARNING_KEYS
    ]) {
      expect(enJson[key]).toBe(message(key));
    }
  });
});
