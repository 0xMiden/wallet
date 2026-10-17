package com.miden.wallet

import android.content.Intent

/// The launch-intent rule MainActivity applies before the bridge reads the launch URL, split out so it is
/// coverable by plain JUnit - the HotKeyLogic pattern.
object LaunchIntentLogic {
    /// An activity restored after its process died, or reopened from Recents, gets back the launch intent
    /// whose link an earlier instance already received.
    @JvmStatic
    fun alreadyDelivered(restored: Boolean, flags: Int): Boolean =
        restored || (flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0
}
