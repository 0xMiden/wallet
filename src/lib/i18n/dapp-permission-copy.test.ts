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

  it('names the sign-in message as what Bread signs, never a transaction', () => {
    expect(note).toBeDefined();
    expect(note).toContain('sign-in message');
    expect(note).not.toMatch(/transaction/i);
  });

  it('keeps the site placeholder', () => {
    expect(note).toContain('$domain$');
  });

  it('keeps en/en.json and en/messages.json in sync so the translation bot re-translates', () => {
    const entry = enMessages[LOGIN_KEY];
    expect(entry).toBeDefined();
    expect(entry!.message).toBe(note);
    expect(entry!.englishSource).toBe(note);
  });

  it('leaves no English bundle with the retired note', () => {
    for (const locale of ['en', 'en_GB']) {
      const flat: Record<string, string> = JSON.parse(
        fs.readFileSync(path.join(LOCALES_DIR, locale, `${locale}.json`), 'utf8')
      );
      expect(flat[LOGIN_KEY]).not.toBe(RETIRED_LOGIN_NOTE);
    }
  });
});
