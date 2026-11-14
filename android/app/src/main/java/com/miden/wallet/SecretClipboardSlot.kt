package com.miden.wallet

import android.content.ClipData
import android.content.ClipboardManager
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import com.miden.wallet.SecretClipboardLogic.Decision
import java.util.UUID

/**
 * The one pending clear for this process. A plugin attaches the clipboard and window focus it has; when that activity
 * is destroyed only its attachment drops, and the next activity re-arms the same deadline.
 */
class SecretClipboardSlot {
    private class Pending(val marker: String, val deadlineAt: Long) {
        var waiting = false
    }

    private class Attachment(val owner: Any, val clipboard: ClipboardManager, var focused: Boolean)

    // Touched only on the main looper, where the write, the check and the focus listener all run.
    private val main = Handler(Looper.getMainLooper())
    private var pending: Pending? = null
    private var attachment: Attachment? = null
    private val check = Runnable { runCheck() }

    fun attach(owner: Any, clipboard: ClipboardManager, focused: Boolean) {
        attachment = Attachment(owner, clipboard, focused)
        rearm()
    }

    fun detach(owner: Any) {
        val attached = attachment ?: return
        if (attached.owner !== owner) return
        // The destroyed activity must not run the check. The next attach re-arms this deadline.
        main.removeCallbacks(check)
        attachment = null
    }

    fun onWindowFocusChanged(owner: Any, hasFocus: Boolean) {
        val attached = attachment ?: return
        if (attached.owner !== owner) return
        attached.focused = hasFocus
        if (hasFocus && pending?.waiting == true) {
            main.removeCallbacks(check)
            main.post(check)
        }
    }

    fun write(
        clipboard: ClipboardManager,
        text: String,
        clearAfterMs: Long,
        onWritten: () -> Unit = {},
        onFailed: () -> Unit = {}
    ) {
        val marker = UUID.randomUUID().toString()
        val clip = ClipData.newPlainText("", text)
        clip.description.setExtras(PersistableBundle().apply {
            putBoolean(SecretClipboardLogic.EXTRA_IS_SENSITIVE, true)
            putString(SecretClipboardLogic.EXTRA_SECRET_MARKER, marker)
        })
        main.post {
            try {
                clipboard.setPrimaryClip(clip)
            } catch (e: RuntimeException) {
                onFailed()
                return@post
            }
            // One deadline: a newer copy cancels the earlier one, whose clip is no longer on the clipboard.
            main.removeCallbacks(check)
            val deadlineAt = SystemClock.uptimeMillis() + clearAfterMs
            pending = Pending(marker, deadlineAt)
            main.postDelayed(check, clearAfterMs)
            onWritten()
        }
    }

    private fun rearm() {
        val current = pending ?: return
        main.removeCallbacks(check)
        val delay = (current.deadlineAt - SystemClock.uptimeMillis()).coerceAtLeast(0L)
        main.postDelayed(check, delay)
    }

    private fun runCheck() {
        val current = pending ?: return
        val attached = attachment ?: return
        val currentMarker =
            attached.clipboard.primaryClipDescription?.extras?.getString(SecretClipboardLogic.EXTRA_SECRET_MARKER)
        when (SecretClipboardLogic.decide(attached.focused, currentMarker, current.marker)) {
            Decision.CLEAR -> {
                attached.clipboard.clearPrimaryClip()
                pending = null
            }
            Decision.DROP -> pending = null
            Decision.WAIT -> current.waiting = true
        }
    }
}
