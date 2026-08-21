import { recordSdkProveStep } from 'lib/miden/sdk/prove-telemetry';

/**
 * The wallet's binding for the Miden SDK's observation sink.
 *
 * The SDK reports one observation per client operation, naming the *wrapped
 * client method* rather than the call the wallet made — one
 * `transactions.send()` reports `executeTransaction`, `proveTransaction`,
 * `submitProvenTransaction` and `applyTransaction`. The wallet has a use for
 * exactly one of them, so the rest are dropped here at the boundary.
 *
 * Two things this module deliberately does not do:
 *
 * 1. **It never reads `observation.sensitive`.** That field carries verbatim
 *    error text and account identifiers, and the SDK omits it entirely unless
 *    the client asked for it at construction — which the wallet never does.
 *    Destructuring the three safe fields by name rather than forwarding the
 *    object means a field added to the SDK's observation type in some later
 *    version cannot ride through here untouched either.
 *
 * 2. **It never forwards `op`.** `op` is the one free-form string on the
 *    observation, and a free-form string is the shape a leak takes. It is used
 *    to *decide*, never to *carry*: an operation the wallet recognises turns
 *    into a number filed under a field this codebase already had, and an
 *    operation it does not recognise is dropped. Nothing downstream of here
 *    has a field an operation name could occupy.
 */

/**
 * The safe fields, restated locally. The SDK's `MidenObservation` is a
 * superset; naming the subset the wallet reads is what makes "we never touch
 * the rest" a property of the type rather than of the implementation.
 */
interface SafeObservationFields {
  op: string;
  outcome: 'ok' | 'error';
  durationMs: number;
}

/** The SDK client method whose timing the wallet records (see #466). */
const PROVE_OP = 'proveTransaction';

export function createWalletSdkObserver(): (observation: SafeObservationFields) => void {
  return observation => {
    try {
      const { op, outcome, durationMs } = observation;
      if (op !== PROVE_OP) return;
      recordSdkProveStep({ durationMs, failed: outcome === 'error' });
    } catch {
      // An observer must never be able to fail a client operation. The SDK
      // swallows a throw too; not relying on that is the point.
    }
  };
}
