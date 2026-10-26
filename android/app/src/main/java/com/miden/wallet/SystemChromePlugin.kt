package com.miden.wallet

import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.view.View
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Paints the app theme's page colour under the status bar: on the decor view
 * (shown under the transparent bar on API 35+), on the WebView's parent (shown
 * where SystemBars pads it) and, below API 35, as the status bar colour.
 */
@CapacitorPlugin(name = "SystemChrome")
class SystemChromePlugin : Plugin() {
    private companion object {
        val HEX_COLOR = Regex("#[0-9a-fA-F]{6}")
    }

    @Volatile
    private var color: Int? = null

    @PluginMethod
    fun setBackground(call: PluginCall) {
        val hex = call.getString("color")
        if (hex == null || !HEX_COLOR.matches(hex)) return call.reject("color must be #rrggbb")
        color = Color.parseColor(hex)
        val act = activity ?: return call.reject("No activity available")
        act.runOnUiThread {
            applyStoredColor()
            call.resolve()
        }
    }

    override fun handleOnConfigurationChanged(newConfig: Configuration) {
        super.handleOnConfigurationChanged(newConfig)
        // SystemBars resets the decor view background in its own synchronous
        // handler, so re-apply once the plugins' handlers have all run.
        activity?.window?.decorView?.post { applyStoredColor() }
    }

    private fun applyStoredColor() {
        val stored = color ?: return
        val window = activity?.window ?: return
        window.decorView.setBackgroundColor(stored)
        (bridge?.webView?.parent as? View)?.setBackgroundColor(stored)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            @Suppress("DEPRECATION")
            window.statusBarColor = stored
        }
    }
}
