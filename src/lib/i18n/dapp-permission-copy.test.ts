import fs from 'fs';
import path from 'path';

/**
 * The dApp approval sheets' copy must describe what the wallet actually does. First, the
 * Connect-approval sheet's private-data risk copy must describe the grant the wallet
 * actually issues.
 *
 * `ConfirmPage` renders `confirmPrivateDataPermissionDescription` above a mandatory
 * "I understand the risk" checkbox whenever a dApp asks for Automatic private-data
 * access on a private account, and it was the ONLY security explanation of that
 * grant. It claimed the access "cannot be revoked" — which is false: Settings →
 * Authorized DApps lists the session and `removeDAppSession(origin)` →
 * `removeDApp(origin, accountId)` filters it (and its stored
 * `privateDataPermission`) out of `MidenDAppSessions` in two taps.
 *
 * False in that direction is the harmful direction: a user who believes the grant is
 * permanent won't look for the remediation that exists, and instead moves funds to a
 * new account or reinstalls. These guards pin the corrected copy.
 */

const LOCALES_DIR = path.join(__dirname, '../../../public/_locales');
const KEY = 'confirmPrivateDataPermissionDescription';

/** The retired claim. No shipped bundle may still assert it. */
const RETIRED_CLAIM = 'This will give permanent access to your account data and cannot be revoked.';

type Entry = { message: string; englishSource?: string };
const enJson: Record<string, string> = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en/en.json'), 'utf8'));
const enMessages: Record<string, Entry> = JSON.parse(
  fs.readFileSync(path.join(LOCALES_DIR, 'en/messages.json'), 'utf8')
);

/**
 * The flat `<locale>/<locale>.json` bundles `src/i18n.ts` loads into react-i18next.
 * They are derived from `messages.json` by `format-locales.js`, which the
 * `createTranslationFile` script runs right after the DeepL job — and which OMITS
 * any entry whose `englishSource` no longer matches en.json, so a translation of
 * the retired claim falls back to the corrected English rather than shipping.
 */
const RUNTIME_LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh_CN', 'zh_TW'];

const description = enJson[KEY];

describe('dApp private-data permission copy', () => {
  it('does not claim the grant is permanent or irrevocable', () => {
    expect(description).toBeDefined();
    expect(description).not.toMatch(/cannot be revoked/i);
    expect(description).not.toMatch(/permanent/i);
    expect(description).not.toMatch(/irrevocab/i);
  });

  it('points the user at the revocation path that actually exists', () => {
    // `Settings.tsx` mounts `DAppSettings` under the `authorizedDApps` tab, whose
    // label is exactly this string — keep the copy pointing at the real tab name.
    expect(description).toMatch(/revoke/i);
    expect(description).toContain(enJson.authorizedDApps!);
  });

  it('still frames the grant as standing access that stops the site from re-asking', () => {
    expect(description).toMatch(/ongoing|without asking again/i);
  });

  it('keeps en/en.json and en/messages.json in sync so the translation bot re-translates', () => {
    // `generateLanguageFiles.translateWithDiff` re-translates a key exactly when the
    // locale's stored `englishSource` differs from en.json — so both fields of the
    // English entry have to carry the NEW text for the other locales to refresh.
    const entry = enMessages[KEY];
    expect(entry).toBeDefined();
    expect(entry!.message).toBe(description);
    expect(entry!.englishSource).toBe(description);
  });

  it('leaves no shipped bundle still asserting the retired claim', () => {
    for (const locale of RUNTIME_LOCALES) {
      const flat: Record<string, string> = JSON.parse(
        fs.readFileSync(path.join(LOCALES_DIR, locale, `${locale}.json`), 'utf8')
      );
      expect(flat[KEY]).not.toBe(RETIRED_CLAIM);
    }
    // en_GB ships only through `messages.json` (src/i18n.ts does not load it), but
    // its flat bundle is checked in too — it must not carry the claim either.
    const enGb: Record<string, string> = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, 'en_GB/en_GB.json'), 'utf8')
    );
    expect(enGb[KEY]).not.toBe(RETIRED_CLAIM);
  });

  it('has no other English string claiming a wallet permission cannot be revoked', () => {
    const offenders = Object.entries(enJson).filter(([, value]) => /cannot be revoked/i.test(value));
    expect(offenders).toEqual([]);
  });
});

/**
 * The login approval's note must name what Bread signs. Without an object for "signs", DeepL rendered it in several
 * locales as the login key signing transactions, which it cannot do (#1580).
 */
describe('dApp login signature note', () => {
  const LOGIN_KEY = 'loginSignatureNote';
  const RETIRED_LOGIN_NOTE =
    "Bread signs with a key made only for $domain$. It can't move funds or change your account.";
  const note = enJson[LOGIN_KEY];

  // Each locale's word for a transaction: the defect lived in the translations (ru and uk said the key signs
  // transactions), so the guard reads what every locale ships, not only the English source.
  const TRANSACTION_WORD: Record<string, RegExp> = {
    de: /Transaktion/i,
    en: /transaction/i,
    en_GB: /transaction/i,
    es: /transac/i,
    fr: /transac/i,
    ja: /取引|トランザクション/,
    ko: /거래|트랜잭션/,
    pl: /transakc/i,
    pt: /transa[cç]/i,
    ru: /транзакц/i,
    // "İşlem" is also Turkish for a process, as in "oturum açma işlemi" (the sign-in process). /i does not fold İ to i.
    tr: /(?<!(?:açma|giriş) )[iİ]şlem/i,
    uk: /транзакц/i,
    zh_CN: /交易/,
    zh_TW: /交易/
  };
  const readJson = (file: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'));
  const shippedNotes = (locale: string): string[] => {
    const notes: string[] = [];
    const entry = readJson(`${locale}/messages.json`)[LOGIN_KEY];
    if (typeof entry === 'object' && entry !== null && 'message' in entry && typeof entry.message === 'string') {
      notes.push(entry.message);
    }
    const flatFile = `${locale}/${locale}.json`;
    if (fs.existsSync(path.join(LOCALES_DIR, flatFile))) {
      const flat = readJson(flatFile)[LOGIN_KEY];
      if (typeof flat === 'string') notes.push(flat);
    }
    return notes;
  };

  // Each pattern must catch its locale's own wording for signing transactions, and none of its sign-in wordings.
  const SIGNS_TRANSACTIONS: Record<string, string[]> = {
    de: ['Bread signiert Transaktionen'],
    en: ['Bread signs transactions'],
    en_GB: ['Bread signs transactions'],
    es: ['Bread firma transacciones'],
    fr: ['Bread signe des transactions'],
    ja: ['Breadは取引に署名します'],
    ko: ['Bread는 거래에 서명합니다'],
    pl: ['Bread podpisuje transakcje'],
    pt: ['Bread assina transações'],
    ru: ['Bread подписывает транзакции'],
    tr: ['Bread işlemleri imzalar', 'İşlemleri $domain$ için oluşturulmuş bir anahtarla Bread imzalar'],
    uk: ['Bread підписує транзакції'],
    zh_CN: ['Bread 签署交易'],
    zh_TW: ['Bread 簽署交易']
  };

  const SIGNS_IN: Record<string, string[]> = {
    de: ['Bread signiert diese Anmeldenachricht mit einem Schlüssel, der nur für $domain$ erstellt wurde'],
    en: [note!],
    en_GB: [note!],
    es: ['Bread firma este mensaje de inicio de sesión con una clave creada solo para $domain$'],
    fr: ['Bread signe ce message de connexion avec une clé créée uniquement pour $domain$'],
    ja: ['Breadはこのサインインメッセージに、$domain$専用に作成された鍵で署名します'],
    ko: ['Bread는 이 로그인 메시지에 $domain$ 전용 키로 서명합니다'],
    pl: ['Bread podpisuje tę wiadomość logowania kluczem utworzonym tylko dla $domain$'],
    pt: ['A Bread assina esta mensagem de início de sessão com uma chave criada só para $domain$'],
    ru: ['Bread подписывает это сообщение для входа ключом, созданным только для $domain$'],
    tr: [
      'Bread, bu oturum açma mesajını yalnızca $domain$ için oluşturulmuş bir anahtarla imzalar',
      'Bread, oturum açma işlemi için yalnızca $domain$ için oluşturulmuş bir anahtarla imza atar'
    ],
    uk: ['Bread підписує це повідомлення для входу ключем, створеним лише для $domain$'],
    zh_CN: ['Bread 使用专为 $domain$ 生成的密钥签署此登录消息'],
    zh_TW: ['Bread 使用專為 $domain$ 打造的金鑰簽署此登入訊息']
  };

  it.each(Object.keys(TRANSACTION_WORD))(
    'tells the %s wording for signing transactions from its sign-in wording',
    locale => {
      expect(SIGNS_TRANSACTIONS[locale]!.length).toBeGreaterThan(0);
      for (const signs of SIGNS_TRANSACTIONS[locale]!) expect(signs).toMatch(TRANSACTION_WORD[locale]!);
      expect(SIGNS_IN[locale]!.length).toBeGreaterThan(0);
      for (const signIn of SIGNS_IN[locale]!) expect(signIn).not.toMatch(TRANSACTION_WORD[locale]!);
    }
  );

  it('names the sign-in message as what Bread signs', () => {
    expect(note).toBeDefined();
    expect(note).toContain('sign-in message');
  });

  it.each(Object.keys(TRANSACTION_WORD))('never says the %s note signs transactions, and keeps the site', locale => {
    const notes = shippedNotes(locale);
    expect(notes.length).toBeGreaterThan(0);
    for (const shipped of notes) {
      expect(shipped).toContain('$domain$');
      expect(shipped).not.toMatch(TRANSACTION_WORD[locale]!);
    }
  });

  it('keeps en/en.json and en/messages.json in sync so the translation bot re-translates', () => {
    const entry = enMessages[LOGIN_KEY];
    expect(entry).toBeDefined();
    expect(entry!.message).toBe(note);
    expect(entry!.englishSource).toBe(note);
  });

  it('ships no en_GB note with the retired wording', () => {
    // en_GB ships through its messages.json; the flat bundle drops a stale key, so it alone would pass on a miss.
    const notes = shippedNotes('en_GB');
    expect(notes.length).toBeGreaterThan(0);
    for (const shipped of notes) expect(shipped).not.toBe(RETIRED_LOGIN_NOTE);
  });
});
