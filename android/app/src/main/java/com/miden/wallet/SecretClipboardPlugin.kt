package com.miden.wallet

import android.content.ClipboardManager
import android.view.ViewTreeObserver
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Copies a secret as a sensitive clip and clears it after a delay, but only while the clipboard still holds the clip
 * this write placed there. A clear that falls due while the window is unfocused waits for focus to return.
 */
@CapacitorPlugin(name = "SecretClipboard")
class SecretClipboardPlugin : Plugin() {
    private val focusListener = ViewTreeObserver.OnWindowFocusChangeListener { hasFocus ->
        slot.onWindowFocusChanged(this, hasFocus)
    }

    override fun load() {
        super.load()
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
        slot.attach(this, clipboard, activity?.hasWindowFocus() == true)
        activity?.window?.decorView?.viewTreeObserver?.addOnWindowFocusChangeListener(focusListener)
    }

    override fun handleOnDestroy() {
        val observer = activity?.window?.decorView?.viewTreeObserver
        if (observer != null && observer.isAlive) {
            observer.removeOnWindowFocusChangeListener(focusListener)
        }
        // Only this activity's attachment. The process-wide slot keeps the deadline for the next one.
        slot.detach(this)
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
        slot.write(
            clipboard,
            text,
            clearAfterMs,
            onWritten = { call.resolve() },
            onFailed = { call.reject("Clipboard write failed") }
        )
    }

    private companion object {
        val slot = SecretClipboardSlot()
    }
}
