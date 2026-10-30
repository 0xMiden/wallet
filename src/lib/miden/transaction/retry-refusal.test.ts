import { guardianHoldRetryMessage } from './constants';
import { GuardianHoldRetryError, isGuardianHoldRetryError, retryRefusalText } from './retry-refusal';

const t = (key: string): string => key;

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

  it('shows the hold as a hold', () => {
    const error = new GuardianHoldRetryError(1_700_000_000);

    expect(retryRefusalText(error, t)).toBe(error.message);
  });
});
