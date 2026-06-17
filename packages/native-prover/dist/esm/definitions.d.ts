/**
 * Native Miden transaction prover plugin interface.
 *
 * Bridges JS calls onto a native prover built from `web-sdk/crates/mobile-prover`.
 * The wire format matches the web-sdk's `TransactionProver.newCallbackProver`
 * callback contract: serialized `TransactionInputs` in, serialized
 * `ProvenTransaction` out (encoded as base64 strings across the Capacitor
 * bridge because the bridge serializes through JSON).
 */
export interface MidenNativeProverPlugin {
    /**
     * Prove a transaction natively.
     *
     * @param options.input base64-encoded serialized `TransactionInputs`.
     * @returns base64-encoded serialized `ProvenTransaction` and the
     *          wall-clock duration of the prove call in milliseconds (native
     *          side only — does not include the base64 round-trip).
     * @throws  on bad input bytes, prove failures (malformed/invalid tx),
     *          or unknown native errors.
     */
    prove(options: {
        input: string;
    }): Promise<{
        output: string;
        durationMs: number;
    }>;
}
