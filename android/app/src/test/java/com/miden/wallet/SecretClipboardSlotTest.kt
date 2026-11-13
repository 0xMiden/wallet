package com.miden.wallet

import android.content.ClipData
import android.content.ClipboardManager
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowLooper

/// The process-wide pending clear, on the main looper and the Robolectric clipboard.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class SecretClipboardSlotTest {
    private lateinit var clipboard: ClipboardManager

    @Before
    fun setUp() {
        clipboard = RuntimeEnvironment.getApplication().getSystemService(ClipboardManager::class.java)
        clipboard.clearPrimaryClip()
    }

    @After
    fun drainDeadlines() {
        ShadowLooper.runUiThreadTasksIncludingDelayedTasks()
    }

    @Test
    fun clearsAtTheDeadline() {
        val slot = SecretClipboardSlot()
        val owner = Any()
        slot.attach(owner, clipboard, focused = true)
        slot.write(clipboard, "phrase", 1_000)
        flushWrites()
        assertEquals(true, clipboard.primaryClipDescription?.extras?.getBoolean(SecretClipboardLogic.EXTRA_IS_SENSITIVE))
        advance(999)
        assertEquals("phrase", clipText())
        advance(1)
        assertNull(clipText())
    }

    @Test
    fun aSecondCopyOutlivesTheFirstDeadline() {
        val slot = SecretClipboardSlot()
        val owner = Any()
        slot.attach(owner, clipboard, focused = true)
        slot.write(clipboard, "first", 1_000)
        slot.write(clipboard, "second", 2_000)
        flushWrites()
        advance(1_000)
        assertEquals("second", clipText())
        advance(1_000)
        assertNull(clipText())
    }

    @Test
    fun focusBeforeTheDeadlineDoesNotClearEarly() {
        val slot = SecretClipboardSlot()
        val owner = Any()
        slot.attach(owner, clipboard, focused = false)
        slot.write(clipboard, "second", 1_000)
        flushWrites()
        slot.onWindowFocusChanged(owner, true)
        flushWrites()
        assertEquals("second", clipText())
        advance(1_000)
        assertNull(clipText())
    }

    @Test
    fun aDueClearWaitsForFocus() {
        val slot = SecretClipboardSlot()
        val owner = Any()
        slot.attach(owner, clipboard, focused = false)
        slot.write(clipboard, "secret", 1_000)
        flushWrites()
        advance(1_000)
        assertEquals("secret", clipText())
        slot.onWindowFocusChanged(owner, true)
        flushWrites()
        assertNull(clipText())
    }

    @Test
    fun anotherAppsCopyIsLeftAlone() {
        val slot = SecretClipboardSlot()
        val owner = Any()
        slot.attach(owner, clipboard, focused = true)
        slot.write(clipboard, "ours", 1_000)
        flushWrites()
        clipboard.setPrimaryClip(ClipData.newPlainText("", "theirs"))
        advance(1_000)
        assertEquals("theirs", clipText())
    }

    @Test
    fun aRecreatedActivityTakesOverAPendingClear() {
        val slot = SecretClipboardSlot()
        val first = Any()
        val second = Any()
        slot.attach(first, clipboard, focused = true)
        slot.write(clipboard, "alpha beta", 1_000)
        flushWrites()
        slot.detach(first)
        assertEquals("alpha beta", clipText())
        slot.attach(second, clipboard, focused = true)
        advance(1_000)
        assertNull(clipText())
    }

    private fun clipText(): String? = clipboard.primaryClip?.getItemAt(0)?.text?.toString()

    private fun flushWrites() {
        ShadowLooper.idleMainLooper()
    }

    private fun advance(ms: Long) {
        ShadowLooper.idleMainLooper(ms, TimeUnit.MILLISECONDS)
    }
}
