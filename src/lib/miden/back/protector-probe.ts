import { Vault } from 'lib/miden/back/vault';

/**
 * Whether this wallet unlocks with its hardware protector (biometrics) rather than a password.
 *
 * A failed hardware read is resolved, never guessed. Each protector is its own storage key and
 * wallet setup stores exactly one of them, so a password key means the password gate is right and
 * its absence means hardware. Answering `false` on a rejection sent hardware-only wallets to a
 * password gate that cannot succeed (#1056). Off desktop and mobile the hardware read returns false
 * without touching storage, so the fallback never runs there.
 *
 * The complement holds because every wallet setup stores one of the two keys. A wallet from before
 * the vault-key model stores neither and is not supported; it could exist only on the extension,
 * where the hardware read above returns its early `false` without touching storage and so never
 * throws, since no desktop or mobile release predates the vault-key model. So the fallback, reached
 * only when the hardware read throws, never meets a wallet that could store neither key.
 *
 * Rejects only when both reads fail, which is storage being unavailable rather than a wallet with
 * no credential. The error carries both causes, in its message as well as its `cause`.
 */
export async function probeHardwareProtector(): Promise<boolean> {
  try {
    return await Vault.hasHardwareProtector();
  } catch (hardwareError) {
    try {
      return !(await Vault.hasPasswordProtector());
    } catch (passwordError) {
      // In the message too: callers log the message, the only record this state leaves.
      const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
      throw new Error(
        `both protector reads failed (hardware: ${describe(hardwareError)}; password: ${describe(passwordError)})`,
        { cause: { hardwareError, passwordError } }
      );
    }
  }
}
