/**
 * The "a rotation to another operator is already running" rejection, in its own
 * dependency-free module.
 *
 * It lives here rather than beside its thrower (`initiateSwitchGuardianTransaction`
 * in `lib/miden/transaction/initiate`) because both ends of the contract need it
 * and only one of them can afford that module: the review screen imports the
 * transaction barrel for the initiator, and every test of that screen mocks the
 * barrel wholesale. An identity or name constant reached through a mocked module
 * is `undefined`, which turns the check below into a comparison that is always
 * false — the mapping silently stops happening and no test can see it. A leaf
 * module with no imports is not worth mocking, so both sides get the real value.
 */

/**
 * `Error.name` for {@link GuardianRotationInProgressError}.
 *
 * Callers match on this rather than `instanceof`: the error crosses module
 * boundaries that the intercom adapters may serialize, which drops the prototype
 * and leaves a plain object carrying `name`.
 */
export const GUARDIAN_ROTATION_IN_PROGRESS = 'GuardianRotationInProgressError';

/**
 * Is this thrown value the rotation-in-progress rejection?
 *
 * Shape, not prototype, and deliberately not `err instanceof Error` either: the
 * whole point of matching on the name is that this error crosses boundaries the
 * intercom adapters may serialize, and what survives that is a plain object
 * carrying `name` — which an `instanceof Error` gate rejects just as surely as
 * an `instanceof GuardianRotationInProgressError` would. A caller writing the
 * gate itself re-imposes the check the constant exists to avoid, and then falls
 * through to `String(err)` on the one input this mechanism was built for.
 *
 * Lives beside the constant so there is one definition to be right rather than
 * one per caller.
 */
export const isGuardianRotationInProgress = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'name' in err && err.name === GUARDIAN_ROTATION_IN_PROGRESS;

/**
 * A guardian rotation to a DIFFERENT operator is already in flight for this
 * account, so this request cannot be answered with the running rotation's id.
 *
 * A distinct type rather than a plain `Error` because the UI renders this one:
 * `RotateGuardianReview` puts its catch's `err.message` straight into the error
 * slot, so a bare English sentence would ship untranslated user-facing copy —
 * and `yarn lint:i18n` cannot catch it, since it is a runtime string rather than
 * a literal in a component. Callers match the name and supply their own
 * localized copy; the message is a developer-facing fallback, and `endpoint` is
 * carried separately so a caller can name the operator without parsing prose.
 */
export class GuardianRotationInProgressError extends Error {
  constructor(readonly endpoint: string | undefined) {
    super(
      `A guardian rotation${endpoint ? ` to ${endpoint}` : ''} is already in progress for this account; ` +
        'wait for it to finish before switching to a different guardian.'
    );
    this.name = GUARDIAN_ROTATION_IN_PROGRESS;
  }
}
