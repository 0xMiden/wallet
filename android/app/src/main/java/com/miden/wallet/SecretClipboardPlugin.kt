package com.miden.wallet

import android.content.ClipData
import android.content.ClipboardManager
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.miden.wallet.SecretClipboardLogic.Decision
import java.util.UUID

/**
 * Copies a secret as a sensitive clip and clears it after a delay, but only while the clipboard still holds the clip
 * this write placed there. A clear that falls due while the window is unfocused waits for focus to return.
 */
@CapacitorPlugin(name = "SecretClipboard")
class SecretClipboardPlugin : Plugin() {
    private class Pending(val marker: String) {
        var waiting = false
    }

    // Touched only on the main looper, where the write, the check and the focus listener all run.
    private val main = Handler(Looper.getMainLooper())
    private var pending: Pending? = null
    private val check = Runnable { runCheck() }

    override fun load() {
        super.load()
        activity?.window?.decorView?.viewTreeObserver?.addOnWindowFocusChangeListener { hasFocus ->
            if (hasFocus && pending?.waiting == true) {
                main.removeCallbacks(check)
                main.post(check)
            }
        }
    }

    override fun handleOnDestroy() {
        // A destroyed activity never regains focus, so its pending clear could never run; release it.
        main.removeCallbacks(check)
        pending = null
        super.handleOnDestroy()
    }

    @PluginMethod
    fun write(call: PluginCall) {
        // Rejections stay static strings so they can never carry the secret.
        val text = call.getString("string") ?: return call.reject("Missing string")
        // The bridge parses a whole JSON number that fits an int as Integer, which getLong reads as null.
        val clearAfterMs = SecretClipboardLogic.validClearAfterMs(call.getInt("clearAfterMs")?.toLong())
            ?: return call.reject("Invalid clearAfterMs")
        val clipboard = context.getSystemService(ClipboardManager::class.java)
            ?: return call.reject("Clipboard unavailable")
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
                call.reject("Clipboard write failed")
                return@post
            }
            // One slot: a newer copy replaces the earlier one's deadline, whose clip is no longer on the clipboard.
            main.removeCallbacks(check)
            pending = Pending(marker)
            main.postDelayed(check, clearAfterMs)
            call.resolve()
        }
    }

    private fun runCheck() {
        val slot = pending ?: return
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
        val currentMarker = clipboard.primaryClipDescription?.extras?.getString(SecretClipboardLogic.EXTRA_SECRET_MARKER)
        when (SecretClipboardLogic.decide(activity?.hasWindowFocus() == true, currentMarker, slot.marker)) {
            Decision.CLEAR -> {
                clipboard.clearPrimaryClip()
                pending = null
            }
            Decision.DROP -> pending = null
            Decision.WAIT -> slot.waiting = true
        }
    }
}
