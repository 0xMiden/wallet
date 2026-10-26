package com.miden.wallet

/// Pure fallback-chain logic for the Open Settings tap, split out of
/// HardwareSecurityPlugin so it is coverable by plain JUnit (no Activity, no
/// Android Settings intents, no Robolectric) - the HotKeyLogic pattern.
object BiometricSettingsLogic {
    /// Tries `actions` in order via `launch`, stopping at the first one that
    /// does not throw (ActivityNotFoundException, SecurityException, or
    /// anything else a given OEM's Settings app throws). Returns the action
    /// that launched, or null once every action has thrown.
    fun launchFirst(actions: List<String>, launch: (String) -> Unit): String? {
        for (action in actions) {
            try {
                launch(action)
                return action
            } catch (e: Exception) {
                // Fall through to the next action in the chain.
            }
        }
        return null
    }
}
