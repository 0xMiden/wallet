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

    // A recreated activity attaches unfocused from onCreate; the clear keeps the time it had left.
    @Test
    fun aRecreatedActivityKeepsTheRemainingDeadline() {
        val slot = SecretClipboardSlot()
        val first = Any()
        val second = Any()
        slot.attach(first, clipboard, focused = true)
        slot.write(clipboard, "alpha beta", 1_000)
        flushWrites()
        advance(400)
        slot.detach(first)
        slot.attach(second, clipboard, focused = false)
        flushWrites()
        slot.onWindowFocusChanged(second, true)
        flushWrites()
        assertEquals("alpha beta", clipText())
        advance(599)
        assertEquals("alpha beta", clipText())
        advance(1)
        assertNull(clipText())
    }

    @Test
    fun aReplacedOwnerCannotCancelTheDeadline() {
        val slot = SecretClipboardSlot()
        val first = Any()
        val second = Any()
        slot.attach(first, clipboard, focused = true)
        slot.write(clipboard, "alpha beta", 1_000)
        flushWrites()
        slot.attach(second, clipboard, focused = true)
        slot.detach(first)
        advance(1_000)
        assertNull(clipText())
    }

    @Test
    fun aReplacedOwnerCannotClearOnFocus() {
        val slot = SecretClipboardSlot()
        val first = Any()
        val second = Any()
        slot.attach(first, clipboard, focused = false)
        slot.write(clipboard, "secret", 1_000)
        flushWrites()
        advance(1_000)
        slot.attach(second, clipboard, focused = false)
        flushWrites()
        slot.onWindowFocusChanged(first, true)
        flushWrites()
        assertEquals("secret", clipText())
    }

    // Destroyed before the deadline, which then passes with nothing attached: the recreated activity attaches
    // unfocused and the clear runs once it has focus.
    @Test
    fun aDeadlinePassedWhileDetachedClearsWhenFocusReturns() {
        val slot = SecretClipboardSlot()
        val first = Any()
        val second = Any()
        slot.attach(first, clipboard, focused = true)
        slot.write(clipboard, "overdue", 1_000)
        flushWrites()
        advance(400)
        slot.detach(first)
        advance(700)
        slot.attach(second, clipboard, focused = false)
        flushWrites()
        assertEquals("overdue", clipText())
        slot.onWindowFocusChanged(second, true)
        flushWrites()
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
