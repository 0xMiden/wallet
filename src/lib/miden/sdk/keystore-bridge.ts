/**
 * Late-binding bridge between the long-lived MidenClient (which receives
 * permanent keystore callbacks at create time) and the wallet-side state
 * those callbacks need (the unlocked vault, the per-tx sign callback).
 *
 * The SDK requires keystore callbacks at create time and they're immutable
 * after that. To support the wallet's lifecycle (vault locks/unlocks, per-tx
 * sign sessions), we wire the SDK with permanent callbacks here that
 * delegate to mutable slots. The wiring layer in keystore-wiring.ts updates
 * those slots based on Effector store events.
 *
 * Note on bundles:
 * - Backend (extension SW, mobile process, desktop process):
 *   wireKeystoreBridge() runs at boot, hooking unlocked/locked watchers.
 *   From there, callInsertKey/callSign delegate to the active vault.
 * - Frontend (popup/tab/page): wireKeystoreBridge does NOT run.
 *   callInsertKey/callSign throw if invoked. Front-end SDK usage is
 *   read-only by design; throw is a safety net.
 *
 * Bridge state across SW restarts: in-memory only. Restart wipes the
 * slots; user must re-unlock to re-wire (matches today's behavior since
 * the in-memory vault key is also lost).
 */

type SdkSignCallback = (publicKey: Uint8Array, signingInputs: Uint8Array) => Promise<Uint8Array>;
type InsertKeyCallback = (key: Uint8Array, secretKey: Uint8Array) => Promise<void>;
type GetKeyCallback = (pubKey: Uint8Array) => Promise<Uint8Array | null>;

let activeInsertKey: InsertKeyCallback | null = null;
let activeSignCallback: SdkSignCallback | null = null;

/**
 * Set or clear the active insert-key callback.
 *
 * No concurrent-set guard (intentionally asymmetric vs setActiveSignCallback):
 * insertKey lifecycle is bound to vault unlock state, not per-tx. Multiple
 * legitimate setters exist:
 *   - unlocked.watch sets it to point at the active vault's encryptKeystoreEntry.
 *   - Vault.spawn sets it to a closure over a not-yet-constructed vault's KEK.
 *   - locked.watch clears it.
 * Last-wins is the intended behavior.
 */
export function setActiveInsertKey(cb: InsertKeyCallback | null): void {
  activeInsertKey = cb;
}

/**
 * Set or clear the active sign callback. Per-tx slot — guarded against
 * concurrent set because two simultaneous sign sessions in the same
 * process means a real bug (the TransactionProcessor enforces serial
 * tx execution; a violation surfaces here).
 *
 * Truth table:
 *   (cb, current=null)    → sets, OK
 *   (null, current=cb)    → clears, OK
 *   (null, current=null)  → no-op, OK
 *   (cb1, current=cb2)    → THROWS (concurrent sign session)
 */
export function setActiveSignCallback(cb: SdkSignCallback | null): void {
  if (cb !== null && activeSignCallback !== null) {
    throw new Error('concurrent sign session detected');
  }
  activeSignCallback = cb;
}

/**
 * Test-only escape hatch. Production must not call this.
 * Allows tests to wipe bridge state between cases without resetModules().
 */
export function resetBridgeStateForTests(): void {
  activeInsertKey = null;
  activeSignCallback = null;
}

// SDK-facing entries — passed to MidenClient.create as keystore callbacks.

export const callInsertKey: InsertKeyCallback = async (key, secretKey) => {
  if (activeInsertKey === null) {
    throw new Error('insert-key callback not wired (vault locked?)');
  }
  return activeInsertKey(key, secretKey);
};

export const callSign: SdkSignCallback = async (publicKey, signingInputs) => {
  if (activeSignCallback === null) {
    throw new Error('no active sign session');
  }
  return activeSignCallback(publicKey, signingInputs);
};

/**
 * The wallet doesn't use the SDK's external getKey lookup — keys are
 * stored in the wallet's own encrypted storage and retrieved via
 * Vault.getAuthSecretKey at sign time. Returning null tells the SDK
 * "no key in external store; fall through to internal lookup if any".
 */
export const callGetKey: GetKeyCallback = async () => null;
