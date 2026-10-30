import { formatHoldDeadline } from 'lib/i18n/hold-deadline';

import { guardianHoldRetryMessage } from './constants';
import { GuardianHoldRetryError, isGuardianHoldRetryError, retryRefusalText } from './retry-refusal';

jest.mock('lib/i18n/core', () => ({ getCurrentLocale: () => 'de' }));

const t = (key: string, substitutions?: Record<string, string>): string =>
  substitutions === undefined ? key : `${key} ${JSON.stringify(substitutions)}`;

describe('GuardianHoldRetryError (#2060)', () => {
  it('carries when the hold clears, and keeps the English sentence for logs', () => {
    const error = new GuardianHoldRetryError(1_700_000_000);

    expect(error).toBeInstanceOf(Error);
    expect(error.clearsAtSec).toBe(1_700_000_000);
    expect(error.message).toBe(guardianHoldRetryMessage(1_700_000_000));
  });

  // The retry can be driven from another bundle, which shares no class identity.
  it('is matched by name, not by class', () => {
    const foreign = Object.assign(new Error('held'), { name: 'GuardianHoldRetryError', clearsAtSec: 5 });

    expect(isGuardianHoldRetryError(foreign)).toBe(true);
    expect(isGuardianHoldRetryError(new Error('held'))).toBe(false);
    expect(isGuardianHoldRetryError({ name: 'GuardianHoldRetryError' })).toBe(false);
  });
});

describe('retryRefusalText (#2060)', () => {
  it('shows a refusal`s own text, and the generic sentence for anything that is not an Error', () => {
    expect(retryRefusalText(new Error('a refusal'), t)).toBe('a refusal');
    expect(retryRefusalText('not an Error', t)).toBe('smthWentWrong');
  });

  // The refusal is localized here rather than in `message`, which the leaf writes for logs in English.
  it('renders the hold in the wallet`s language and locale', () => {
    const shown = retryRefusalText(new GuardianHoldRetryError(1_700_000_000), t);

    expect(shown).toBe(
      `guardianHoldRetryRefused ${JSON.stringify({ time: formatHoldDeadline(1_700_000_000, { locale: 'de' }) })}`
    );
    expect(shown).not.toContain('The Guardian is still holding');
  });

  it('shows the refusal`s own text when a hold arrives without its deadline', () => {
    const stripped = Object.assign(new Error('held'), { name: 'GuardianHoldRetryError' });

    expect(isGuardianHoldRetryError(stripped)).toBe(false);
    expect(retryRefusalText(stripped, t)).toBe('held');
  });

  it('renders a hold another bundle threw from what it carries', () => {
    const foreign = Object.assign(new Error('held'), { name: 'GuardianHoldRetryError', clearsAtSec: 1_700_000_000 });

    expect(retryRefusalText(foreign, t)).toContain('guardianHoldRetryRefused');
  });
});
