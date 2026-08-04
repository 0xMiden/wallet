package com.miden.wallet

import android.view.WindowManager
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Blocks screenshots / screen recordings while enabled by toggling
 * FLAG_SECURE on the activity window (also hides content in Recents).
 */
@CapacitorPlugin(name = "ScreenshotGuard")
class ScreenshotGuardPlugin : Plugin() {

    @PluginMethod
    fun enable(call: PluginCall) {
        val act = activity ?: return call.reject("No activity available")
        act.runOnUiThread {
            act.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            call.resolve()
        }
    }

    @PluginMethod
    fun disable(call: PluginCall) {
        val act = activity ?: return call.reject("No activity available")
        act.runOnUiThread {
            act.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            call.resolve()
        }
    }
}
