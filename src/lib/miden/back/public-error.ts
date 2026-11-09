/**
 * An error whose message the wallet can show or send as it is.
 *
 * A leaf module, so a module can extend it without the intercom setup in `defaults.ts`. `defaults.ts` exports the same
 * class.
 */
export class PublicError extends Error {}
