package com.miden.wallet

/// The rules SecretClipboardPlugin applies to a copied secret, split out so they are coverable by plain JUnit - the
/// HotKeyLogic pattern.
object SecretClipboardLogic {
    /// ClipDescription.EXTRA_IS_SENSITIVE, spelled out so it is usable below API 33, where it is ignored.
    const val EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"
    const val EXTRA_SECRET_MARKER = "com.miden.wallet.extra.SECRET_CLIP"

    enum class Decision { CLEAR, DROP, WAIT }

    /// What a due clear does with the clip now on the clipboard: an unfocused app cannot read it (Android 10+), so it
    /// waits; a focused one clears only its own clip, recognised by the marker its write carried.
    @JvmStatic
    fun decide(focused: Boolean, currentMarker: String?, ownMarker: String): Decision = when {
        !focused -> Decision.WAIT
        currentMarker == ownMarker -> Decision.CLEAR
        else -> Decision.DROP
    }

    /// The delay itself when it is positive, else null.
    @JvmStatic
    fun validClearAfterMs(raw: Long?): Long? = raw?.takeIf { it > 0 }
}
