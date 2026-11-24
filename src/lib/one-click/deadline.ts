export const ONE_CLICK_EXPIRED_ERROR = 'The 1Click quote has expired. Request a new quote before depositing.';
export const ONE_CLICK_INVALID_DEADLINE_ERROR =
  'The 1Click quote deadline is invalid. Request a new quote before depositing.';

export class OneClickDeadlineError extends Error {
  readonly errorBeforeSubmit = true;

  constructor(message: string) {
    super(message);
    this.name = 'OneClickDeadlineError';
  }
}

export function isOneClickDeadlineError(error: unknown): boolean {
  if (error instanceof OneClickDeadlineError) return true;
  if (typeof error === 'string') {
    return error.includes(ONE_CLICK_EXPIRED_ERROR) || error.includes(ONE_CLICK_INVALID_DEADLINE_ERROR);
  }
  if (typeof error !== 'object' || error === null) return false;
  const name: unknown = Reflect.get(error, 'name');
  const message: unknown = Reflect.get(error, 'message');
  return (
    name === 'OneClickDeadlineError' ||
    (typeof message === 'string' &&
      (message.includes(ONE_CLICK_EXPIRED_ERROR) || message.includes(ONE_CLICK_INVALID_DEADLINE_ERROR)))
  );
}

export function assertOneClickDeadline(deadline: string | undefined, now = Date.now()): void {
  if (typeof deadline !== 'string' || !Number.isFinite(Date.parse(deadline))) {
    throw new OneClickDeadlineError(ONE_CLICK_INVALID_DEADLINE_ERROR);
  }
  if (Date.parse(deadline) <= now) throw new OneClickDeadlineError(ONE_CLICK_EXPIRED_ERROR);
}

export function effectiveOneClickFundingDeadline(
  requestDeadline: string | undefined,
  providerDeadline: string | undefined
): string {
  if (
    typeof requestDeadline !== 'string' ||
    !Number.isFinite(Date.parse(requestDeadline)) ||
    typeof providerDeadline !== 'string' ||
    !Number.isFinite(Date.parse(providerDeadline))
  ) {
    throw new OneClickDeadlineError(ONE_CLICK_INVALID_DEADLINE_ERROR);
  }
  return Date.parse(requestDeadline) <= Date.parse(providerDeadline) ? requestDeadline : providerDeadline;
}

export function assertOneClickFundingDeadline(
  requestDeadline: string | undefined,
  providerDeadline: string | undefined,
  now = Date.now()
): string {
  const fundingDeadline = effectiveOneClickFundingDeadline(requestDeadline, providerDeadline);
  assertOneClickDeadline(requestDeadline, now);
  assertOneClickDeadline(providerDeadline, now);
  return fundingDeadline;
}

export function assertOneClickFundingDeadlineMatches(
  storedDeadline: string | undefined,
  requestDeadline: string | undefined,
  providerDeadline: string | undefined,
  now = Date.now()
): string {
  const fundingDeadline = assertOneClickFundingDeadline(requestDeadline, providerDeadline, now);
  if (storedDeadline !== undefined && storedDeadline !== fundingDeadline) {
    throw new OneClickDeadlineError(ONE_CLICK_INVALID_DEADLINE_ERROR);
  }
  return fundingDeadline;
}
