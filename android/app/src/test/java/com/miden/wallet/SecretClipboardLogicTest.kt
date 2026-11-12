package com.miden.wallet

import android.content.ClipDescription
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/// Plain-JVM coverage for SecretClipboardLogic: when a due clear may empty the clipboard, and which delays the plugin
/// accepts.
class SecretClipboardLogicTest {

    @Test
    fun decide_clearsOurOwnClipWhileFocused() {
        assertEquals(SecretClipboardLogic.Decision.CLEAR, SecretClipboardLogic.decide(true, "m1", "m1"))
    }

    @Test
    fun decide_dropsWhenSomethingElseWasCopied() {
        assertEquals(SecretClipboardLogic.Decision.DROP, SecretClipboardLogic.decide(true, "other", "m1"))
        assertEquals(SecretClipboardLogic.Decision.DROP, SecretClipboardLogic.decide(true, null, "m1"))
    }

    // Android 10+ hides the clipboard from an unfocused app, so a marker read then proves nothing either way.
    @Test
    fun decide_waitsWhileTheClipboardCannotBeRead() {
        assertEquals(SecretClipboardLogic.Decision.WAIT, SecretClipboardLogic.decide(false, null, "m1"))
        assertEquals(SecretClipboardLogic.Decision.WAIT, SecretClipboardLogic.decide(false, "m1", "m1"))
    }

    // A second copy of the same text carries a fresh marker, so the first copy's deadline must leave it alone.
    @Test
    fun decide_dropsAnEarlierCopyOfTheSamePhrase() {
        assertEquals(SecretClipboardLogic.Decision.DROP, SecretClipboardLogic.decide(true, "m2", "m1"))
    }

    @Test
    fun validClearAfterMs_acceptsOnlyTheSupportedRange() {
        for (raw in listOf(null, 0L, -1L, 999L, 600_001L)) {
            assertNull("$raw", SecretClipboardLogic.validClearAfterMs(raw))
        }
        for (raw in listOf(1_000L, 60_000L, 600_000L)) {
            assertEquals(raw, SecretClipboardLogic.validClearAfterMs(raw))
        }
    }

    @Test
    fun sensitiveExtraIsThePlatformKey() {
        assertEquals(ClipDescription.EXTRA_IS_SENSITIVE, SecretClipboardLogic.EXTRA_IS_SENSITIVE)
    }

    @Test
    fun mainActivityRegistersThePluginBeforeSuperOnCreate() {
        val source = File("src/main/java/com/miden/wallet/MainActivity.java").readText()
        val registration = source.indexOf("registerPlugin(SecretClipboardPlugin.class)")
        val superOnCreate = source.indexOf("super.onCreate(")
        // indexOf is -1 for a missing marker, which would pass the ordering check on its own.
        assertTrue("Missing registerPlugin(SecretClipboardPlugin.class)", registration >= 0)
        assertTrue("Missing super.onCreate(", superOnCreate >= 0)
        assertTrue("SecretClipboardPlugin must be registered before super.onCreate", registration < superOnCreate)
    }
}
