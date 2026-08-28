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
const CONNECTIVITY_GUARDIAN_KEYS = [
  'connectivityGuardianTitle',
  'connectivityGuardianBody',
  'connectivityGuardianCta'
] as const;
const GUARDIAN_SETUP_WARNING_KEYS = [
  'guardianSwitchSetupIncompleteTitle',
  'guardianSwitchEndpointNotSavedBody',
  'guardianSwitchRegistrationPendingBody'
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

/**
 * Denials, which have to be exempted rather than matched. Copy that says what the
 * Guardian is NOT — "Der Guardian ist keine App", "The Guardian is not an app" —
 * puts the banned noun next to the name while asserting the opposite of the
 * defect, so the noun alone cannot decide. A lookbehind on the noun is enough:
 * the connector has already consumed the negator by the time the noun is
 * reached, so requiring that it not be one rules the whole clause out.
 *
 * Only the languages whose accurate copy actually uses this construction, which
 * is the two that name the loan words `App`/`Website` at all.
 */
const NEGATORS: Record<string, string[]> = {
  en: [String.raw`not`, String.raw`not\s+an?`, String.raw`never`],
  en_GB: [String.raw`not`, String.raw`not\s+an?`, String.raw`never`],
  de: [String.raw`keine?`, String.raw`keinen`, String.raw`nicht`]
};

const nounNearGuardian = (nouns: string[], connector: string, negators: string[] = []): string => {
  const notNegated = negators.map(negator => `(?<!\\b${negator}\\s)`).join('');
  return nouns
    .map(noun => `${notNegated}${noun}${connector}Guardian|Guardian${connector}${notNegated}${noun}`)
    .join('|');
};

/**
 * `spaced` languages allow the intervening words; ja/ko/zh get particle-and-
 * punctuation adjacency only, which covers every form their known-bad strings
 * take (`Guardianアドレス`, `Guardianのアドレス`, `Guardian 주소`, `地址 Guardian`)
 * and is the only shape that cannot run past a sentence boundary in text with no
 * word spacing.
 */
const wrongThing = (
  nouns: string[],
  { extra = [], spaced = true, negators = [] }: { extra?: string[]; spaced?: boolean; negators?: string[] } = {}
): RegExp =>
  new RegExp(
    [nounNearGuardian(nouns, spaced ? `${PUNCT}${WORDS}${PUNCT}` : CJK_PUNCT, negators), ...extra].join('|'),
    'iu'
  );

// `\S*` rather than `\w*` for an inflected tail: `\w` is ASCII-only, so it
// matches neither the Turkish `ı` in `Guardian’ın adresi` nor the `а` in
// `адреса Guardian`, and such an alternative silently never fires.
const WRONG_THING_TERMS: Record<string, RegExp> = {
  // `\bapp\b`, because `nounNearGuardian` adds no boundaries and the pattern is
  // case-insensitive: bare `app` matched the first three letters of "approve",
  // so the accurate "Authenticate to approve this Guardian switch" read as
  // "app … Guardian". The other three nouns here cannot occur as a prefix of a
  // word this copy uses, so they stay unanchored to keep the plural forms.
  en: wrongThing(['address', 'page', 'site', String.raw`\bapps?\b`, String.raw`\bapplication`], {
    negators: NEGATORS.en
  }),
  en_GB: wrongThing(['address', 'page', 'site', String.raw`\bapps?\b`, String.raw`\bapplication`], {
    negators: NEGATORS.en_GB
  }),
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
  // `\b` on the ASCII nouns: unanchored, `App` matched inside `appliziert`, and
  // `nounNearGuardian` adds no boundaries of its own. The plural and `Applikation`
  // are spelled out because the boundary that fixes the substring match also drops
  // the inflected forms `Anwendung\S*` was covering for the native word.
  de: wrongThing(
    [
      String.raw`Adress\S*`,
      String.raw`Seite\S*`,
      String.raw`\bApps?\b`,
      String.raw`Anwendung\S*`,
      String.raw`\bApplikation`,
      String.raw`\bWebsites?\b`
    ],
    {
      negators: NEGATORS.de,
      extra: [String.raw`\bdie\s*[„“"«»]?\s*Guardian(?!-)`, String.raw`\beiner\s+anderen\s*[„“"«»]?\s*Guardian(?!-)`]
    }
  ),
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
 * An approval verb whose AGENT is the Guardian, rather than the bare verb.
 *
 * Bare stems cannot be used, because approval verbs appear throughout accurate
 * copy with the user as the agent — "Rotation is approved by your two on-device
 * keys", "Authenticate to approve this Guardian switch", and the same in all
 * fourteen locales. What makes the sentence wrong is the Guardian doing the
 * approving, so that is what these patterns require.
 *
 * Both directions, each with its own bound:
 *
 *  - **Guardian first** (`Guardian … approves`), which covers the verb-final
 *    languages outright: German `wird jede Transaktion genehmigen`, Turkish
 *    `Guardian … onaylar`, and Japanese and Korean, whose verb always trails.
 *  - **Passive** (`approved BY your Guardian`), which requires an explicit agent
 *    marker. Without the marker this direction would match "approve this
 *    Guardian switch", where the Guardian is the object; with it, it cannot match
 *    "approved by your two on-device keys", where the agent is the user's keys.
 *
 * Both stop at clause and sentence boundaries, so neither can pair a verb with a
 * Guardian belonging to a different statement. That is what keeps the accurate
 * comma-joined form — `Guardian 会共同签署每笔交易，批准由您的两个设备密钥完成` —
 * out: the Guardian co-signs in the first clause and the approval belongs to the
 * keys in the second.
 */
// Sentence AND clause enders, the latter because Chinese and Japanese join
// clauses with `，`/`、` where English would start a new sentence.
const CJK_BREAK = String.raw`[^。．！？!?、，；：\n]`;

// Wider than the noun family's WORDS: adverbs run long (`indiscriminately`, 16)
// and MT interposes whole policy phrases (`Your Guardian, based on your security
// policy, approves…` — six words), so allow six words of up to sixteen. Commas
// separate, periods do not: the span can cross a clause but never a sentence,
// which is what keeps "approved by your two on-device keys. The old Guardian is
// only notified" from pairing the verb with the next sentence's Guardian.
const POWER_WORDS = String.raw`(?:[\p{L}\p{M}]{1,16}[\s,]+){0,6}`;

// As PUNCT, plus the comma — every language here can put one straight after the
// subject (`Guardian, cüzdanınızdaki her işlemi onaylar`).
const POWER_PUNCT = String.raw`[\s«»„“”"'’(),\-]*`;

const wrongPower = (
  verbs: string[],
  {
    spaced = true,
    agents = [],
    agentOptional = false
  }: { spaced?: boolean; agents?: string[]; agentOptional?: boolean } = {}
): RegExp => {
  const subjectFirst = spaced
    ? `Guardian(?:['’]s)?${POWER_PUNCT}${POWER_WORDS}${POWER_PUNCT}(?:${verbs.join('|')})`
    : // CJK subjects are not whitespace-delimited from their verb, so bound by
      // character count instead of words. Twenty, on top of the three the particle
      // allowance ahead of it already covers, for twenty-three total: exactly the
      // longest shape in the corpus, the Japanese policy phrasing. Korean
      // `Guardian이 귀하의 모든 거래를 승인합니다` spans thirteen on its own. Sized to
      // the corpus so that shrinking it fails a test — slack nothing exercises is
      // just false-positive surface. One optional
      // clause mark is allowed just after the subject and its particle, which is
      // where Japanese puts it (`Guardianは、…を承認します`); a later one still ends
      // the span, so an approval belonging to a following clause stays out of
      // reach — `Guardianが共同署名します、承認はあなたの鍵です` is not flagged.
      `Guardian(?:['’]s)?${CJK_BREAK}{0,3}[、，]?${CJK_BREAK}{0,20}(?:${verbs.join('|')})`;

  if (agents.length === 0) return new RegExp(subjectFirst, 'iu');

  const agent = `(?:${agents.join('|')})${POWER_PUNCT}${POWER_WORDS}${POWER_PUNCT}`;
  const passive = `(?:${verbs.join('|')})${POWER_PUNCT}${POWER_WORDS}${POWER_PUNCT}${agentOptional ? `(?:${agent})?` : agent}Guardian`;
  return new RegExp(`${subjectFirst}|${passive}`, 'iu');
};

/**
 * The approval verbs themselves, kept separate from the patterns built out of
 * them so the one key whose implicit subject is the Guardian can be swept with
 * the bare stems (see the test near the bottom).
 *
 * Stems, so that "will approve", "must approve" and "approval" come along with
 * the same entry. `polic`, `authoris` and `authoriz` are deliberately absent:
 * as stems they matched "privacy policy" and "unauthorised device", and the
 * policy misdescription this suite exists to keep out — "approves or rejects
 * transactions based on your security policy" — contains `approv` anyway.
 */
// Unannotated so the keys stay literal: with `Record<string, string[]>` every
// lookup below widens to `string[] | undefined`.
const POWER_VERBS = {
  en: ['approv', 'endors', 'confirms every'],
  en_GB: ['approv', 'endors', 'confirms every'],
  de: ['genehmig', 'billigt'],
  es: ['aprob', 'aprueb', 'avala'],
  fr: ['approuv', 'avalise'],
  ja: [String.raw`承認`],
  ko: [String.raw`승인`],
  pl: ['zatwierdza', 'akceptuje ka'],
  pt: ['endoss', 'aprov'],
  ru: [String.raw`подтвержда`, String.raw`одобря`],
  tr: ['onayl'],
  uk: [String.raw`підтверджу`, String.raw`схвалю`],
  zh_CN: [String.raw`批准`, String.raw`核准`],
  zh_TW: [String.raw`批准`, String.raw`核准`]
};

const WRONG_POWER_TERMS: Record<string, RegExp> = {
  en: wrongPower(POWER_VERBS.en, { agents: ['by'] }),
  en_GB: wrongPower(POWER_VERBS.en_GB, { agents: ['by'] }),
  de: wrongPower(POWER_VERBS.de, { agents: ['durch', 'von', 'vom'] }),
  es: wrongPower(POWER_VERBS.es, { agents: ['por'] }),
  fr: wrongPower(POWER_VERBS.fr, { agents: ['par'] }),
  ja: wrongPower(POWER_VERBS.ja, { spaced: false }),
  ko: wrongPower(POWER_VERBS.ko, { spaced: false }),
  pl: wrongPower(POWER_VERBS.pl, { agents: ['przez'] }),
  pt: wrongPower(POWER_VERBS.pt, { agents: ['por', 'pelo', 'pela'] }),
  // Russian and Ukrainian mark the agent with the bare instrumental rather than a
  // preposition, so the possessive pronoun is the marker: `подтверждается вашим
  // Guardian`. Optional, because machine translation drops it as often as not
  // (`подтверждается Guardian`) and there is nothing to distinguish: unlike the
  // prepositional languages, no accurate shipped string in either locale has an
  // approval verb followed by the word Guardian within one sentence, so the
  // marker earns nothing here and costs the commonest phrasing.
  ru: wrongPower(POWER_VERBS.ru, {
    agents: [String.raw`вашим`, String.raw`вашего`, String.raw`вашей`],
    agentOptional: true
  }),
  // No agent marker for Turkish, Japanese, Korean or Chinese: all four are
  // verb-final, so a Guardian doing the approving always precedes its verb and
  // the subject-first pattern already covers it. Turkish `tarafından` even
  // follows the Guardian rather than preceding it.
  tr: wrongPower(POWER_VERBS.tr),
  uk: wrongPower(POWER_VERBS.uk, {
    agents: [String.raw`вашим`, String.raw`вашого`, String.raw`вашою`],
    agentOptional: true
  }),
  zh_CN: wrongPower(POWER_VERBS.zh_CN, { spaced: false }),
  zh_TW: wrongPower(POWER_VERBS.zh_TW, { spaced: false })
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
  ['zh_TW', 'Guardian 會批准每筆交易'],

  // The shapes an earlier, tighter version of these patterns let through. Each
  // one is a real machine-translation output shape rather than a contrivance,
  // and each exercises a specific part of the budget:
  //
  //   the policy phrasing #479 removed, in the two languages whose verb comes
  //   last and whose subject is not whitespace-delimited from it;
  ['ja', 'Guardianはあなたのセキュリティポリシーに基づいて取引を承認します'],
  ['ko', 'Guardian은 보안 정책에 따라 모든 거래를 승인하거나 거부합니다'],
  //   the polite topic marker, which puts a clause mark immediately after the
  //   subject;
  ['ja', 'Guardianは、お客様のすべての取引を承認します'],
  //   an honorific, which alone pushes the subject-to-verb distance past twelve
  //   characters — the corpus's own `ko` known-bad entry uses the same word;
  ['ko', 'Guardian이 귀하의 모든 거래를 승인합니다'],
  //   a parenthetical policy phrase, and a single adverb longer than twelve
  //   letters;
  ['en', 'Your Guardian, based on your security policy, approves transactions'],
  ['en', 'Your Guardian unconditionally approves every transaction'],
  //   the widest shapes the budgets allow, so that narrowing either one fails
  //   here rather than silently shrinking coverage: a sixteen-letter adverb, and
  //   six words of interposed policy language.
  ['en', 'Your Guardian indiscriminately approves every transaction'],
  ['en', 'Your Guardian, under the terms of its policy, approves every transaction'],
  //   German future tense, where the participle lands at the end of the clause —
  //   the normal shape for `wird`/`hat`/`muss`, which the shipped German warning
  //   already uses;
  ['de', 'Ihr Guardian wird jede Transaktion genehmigen'],
  //   and the passive, where the Guardian trails its verb. Caught only because an
  //   explicit agent marker is required, which is what tells it apart from
  //   "approved by your two on-device keys".
  ['ru', 'Каждая транзакция подтверждается вашим Guardian'],
  ['uk', 'Кожна транзакція підтверджується вашим Guardian'],
  ['es', 'Cada transacción es aprobada por tu Guardian'],
  ['pt', 'Cada transação é aprovada pelo seu Guardian'],
  ['fr', 'Chaque transaction est approuvée par votre Guardian'],
  ['pl', 'Każda transakcja jest zatwierdzana przez Twój Guardian'],
  ['tr', 'Guardian, cüzdanınızdaki her işlemi onaylar']
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
  // The accurate mechanism with the verb leading and a Guardian later in the
  // string — the shape the passive pattern has to tell apart from a real
  // misdescription. It clears because the agent after "by" is the user's keys,
  // and because the span cannot cross the sentence boundary to the next Guardian.
  ['en', 'Rotation is approved by your two on-device keys. The old Guardian is only notified.'],
  // The Guardian as the OBJECT of an approval the user performs.
  ['en', 'Authenticate to approve this Guardian switch.'],
  // Accurate copy that denies a capability, which is where an unanchored noun
  // list bites: "App" and "Website" appear precisely because the sentence is
  // saying the Guardian is not one.
  ['de', 'Der Guardian ist keine App.'],
  ['de', 'Der Guardian ist keine Website.'],
  // Comma-joined accuracy in the two languages that join clauses where English
  // would start a sentence: the Guardian co-signs in the first clause and the
  // approval belongs to the user's keys in the second.
  ['zh_CN', 'Guardian 会共同签署每笔交易，批准由您的两个设备密钥完成。'],
  ['ja', 'Guardianが共同署名します、承認はあなたの鍵です'],
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

  it('does not promise indefinite background retrying for a pending post-commit registration', () => {
    // The self-heal for a stuck `/configure` registration is a BOUNDED retry
    // with backoff, not an unbounded background loop — "the wallet keeps
    // retrying in the background" overstated that indefinitely. The copy must
    // both bound the claim and tell the user what to do if the bounded retry
    // doesn't land.
    const body = message('guardianSwitchRegistrationPendingBody');
    expect(body).not.toMatch(/keeps retrying/i);
    expect(body).toMatch(/limited number of times|a few times/i);
    expect(body).toMatch(/contact support/i);
  });

  it('does not steer the user into rotating again to repair an unsaved Guardian endpoint', () => {
    // "Open Guardian settings and select the new Guardian to finish" starts a
    // SECOND on-chain `update_guardian` write — Rotate Guardian is the only
    // Settings affordance and it always initiates a new switch. The verified
    // pointer-repair path is automatic drift detection + the home "needs your
    // input" prompt (`GuardianNeedsUrlBanner`), not a Settings selection.
    const body = message('guardianSwitchEndpointNotSavedBody');
    expect(body).not.toMatch(/select the new Guardian/i);
    expect(body).not.toMatch(/open Guardian settings/i);
    expect(body).toMatch(/won'?t start another switch/i);
  });

  it('does not claim the old Guardian has no role at all after a direct switch', () => {
    // The direct-switch path never contacts the outgoing operator, so the
    // wallet has no way to know whether it retains state from before the
    // switch — only that its on-chain CO-SIGNING authority is gone. "No longer
    // has any role" overstated a state the wallet cannot observe.
    const info1 = message('guardianSwitchSuccessInfo1');
    expect(info1).not.toMatch(/no longer has any role/i);
    expect(info1).toMatch(/can no longer co-sign/i);
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

  it('does not claim approval power on the bullet whose implicit subject is the Guardian', () => {
    // The one key the adjacency patterns above structurally cannot cover. It is a
    // subject-less bullet under a Guardian heading — "Co-signs every transaction
    // …" — so the #479 regression it exists to keep out ("Approves or rejects
    // transactions based on your security policy") carries no "Guardian" token
    // for a pattern to anchor on. Here the bare verb IS the defect, because the
    // Guardian is what the sentence is about; that is only safe on this key,
    // since everywhere else the approval verbs describe the USER's two keys.
    for (const [locale, verbs] of Object.entries(POWER_VERBS)) {
      const message = readMessages(locale)['guardianInfoWhatItDoesDescription']?.message ?? '';
      expect(message).not.toMatch(new RegExp(`(?:${verbs.join('|')})`, 'iu'));
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

  // The guardian-unreachable banner. DeepL only re-translates a key when its
  // ENGLISH source changes, so a bad machine translation is permanent until
  // someone corrects it by hand — and a hand correction is just as permanent
  // until someone reverts it by hand. These pin the corrections.
  describe('connectivity banner translations', () => {
    it('translates the unreachable title instead of shipping the English source', () => {
      // de shipped the English string verbatim, which reads as an untranslated
      // app rather than as a fallback.
      const de = readMessages('de')['connectivityGuardianTitle']?.message ?? '';
      expect(de).not.toBe(message('connectivityGuardianTitle'));
      expect(de).toBe('Guardian nicht erreichbar');
    });

    it('says "change the Guardian", not "switch to Guardian"', () => {
      // The CTA's object is the Guardian itself. Several locales rendered it as
      // navigation TO something called Guardian ("Wechseln Sie zu Guardian",
      // "Перейти на Guardian") or as a noun phrase ("Guardian de troca"), which
      // describes a different action than the button performs.
      const cta = (locale: string) => readMessages(locale)['connectivityGuardianCta']?.message ?? '';
      expect(cta('de')).toBe('Guardian wechseln');
      expect(cta('pt')).toBe('Trocar Guardian');
      // "d’Guardian" elides before a consonant, which is ungrammatical; the
      // wallet's own "Changer de portefeuille" is the pattern.
      expect(cta('fr')).toBe('Changer de Guardian');
      expect(cta('tr')).toBe('Guardian’ı değiştir');
      expect(cta('uk')).toBe('Змінити Guardian');
    });

    it('ships and keeps the Guardian connectivity and setup warnings in sync in every locale', () => {
      // The flat bundle is what the UI renders; messages.json is what the
      // generator reads. The latter must have an englishSource equal to the
      // current English so format-locales emits the real translation into the
      // former rather than silently omitting it as stale.
      for (const locale of LOCALES) {
        const localeMessages = readMessages(locale);
        const flat: Record<string, string> = JSON.parse(
          fs.readFileSync(path.join(LOCALES_DIR, locale, `${locale}.json`), 'utf8')
        );
        for (const key of [...CONNECTIVITY_GUARDIAN_KEYS, ...GUARDIAN_SETUP_WARNING_KEYS]) {
          expect(localeMessages[key]?.message).toBeTruthy();
          expect(flat[key]).toBeTruthy();
          expect(flat[key]).toBe(localeMessages[key]?.message);
        }
      }
    });
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
