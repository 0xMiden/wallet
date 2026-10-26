/**
 * Capacitor reports a dismissed share sheet as a plain rejection with this message on
 * both platforms - there is no code or typed error to key off, so the message is the
 * only available signal. Matched loosely (the platforms spell it "canceled") and
 * deliberately fail-safe: an unrecognised error stays a hard failure.
 */
export const isShareCancellation = (error: unknown): boolean =>
  error instanceof Error && /cancell?ed/i.test(error.message);
