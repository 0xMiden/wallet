package com.miden.wallet

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "SecretClipboard")
class SecretClipboardPlugin : Plugin() {

    @PluginMethod
    fun write(call: PluginCall) {
        call.reject("Not implemented")
    }
}
