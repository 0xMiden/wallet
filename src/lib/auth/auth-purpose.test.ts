import en from '../../../public/_locales/en/en.json';
import { type AuthPurpose, authPromptReason } from './auth-purpose';

jest.mock('lib/i18n', () => ({ getMessage: (key: string) => key }));

const PURPOSES: AuthPurpose[] = [
  'unlock',
  'view-recovery-phrase',
  'reveal-private-key',
  'reveal-everyday-key',
  'export-account-file',
  'export-wallet-file',
  'change-spending-limit',
  'over-limit-transaction',
  'remove-device',
  'switch-guardian',
  'set-up'
];

describe('authPromptReason', () => {
  const messages: Record<string, string> = en;
  const text = (purpose: AuthPurpose) => messages[authPromptReason(purpose)!]!;

  it('gives every action its own text, short enough for the native prompt', () => {
    const texts = PURPOSES.map(text);
    expect(new Set(texts).size).toBe(PURPOSES.length);
    for (const value of texts) expect(value.length).toBeLessThanOrEqual(120);
  });

  it('says "Unlock your wallet" only for an unlock', () => {
    expect(PURPOSES.filter(purpose => /unlock/i.test(text(purpose)))).toEqual(['unlock']);
  });

  it('matches the text the native plugin shows for an everyday key reveal', () => {
    const swift = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../../ios/App/App/LocalBiometricPlugin.swift'),
      'utf8'
    );
    expect(swift).toContain(`let kRevealHotKeyReason = "${text('reveal-everyday-key')}"`);
  });

  it('gives no text for a value that is not an action', () => {
    expect(authPromptReason('constructor' as AuthPurpose)).toBeUndefined();
  });
});
