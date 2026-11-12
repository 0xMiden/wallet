package com.miden.wallet

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Opens payment links only in the selected wallet package. */
@CapacitorPlugin(name = "WalletPayments")
class WalletPaymentsPlugin : Plugin() {
    private val packages = mapOf(
        "trust" to "com.wallet.crypto.trustapp",
        "metamask" to "io.metamask",
        "rainbow" to "me.rainbow",
        "phantom" to "app.phantom"
    )

    @PluginMethod
    fun available(call: PluginCall) {
        val wallets = JSArray()
        packages.forEach { (wallet, packageName) ->
            if (context.packageManager.getLaunchIntentForPackage(packageName) != null) wallets.put(wallet)
        }
        call.resolve(JSObject().put("wallets", wallets))
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val wallet = call.getString("wallet")
        val packageName = packages[wallet]
        val text = call.getString("url")
        val deadline = call.getDouble("deadline")
        if (packageName == null || text == null || deadline == null || !deadline.isFinite() ||
            deadline <= System.currentTimeMillis()) {
            call.resolve(JSObject().put("opened", false))
            return
        }
        val uri = Uri.parse(text)
        val scheme = when (wallet) {
            "trust" -> "trust"
            "metamask" -> "metamask"
            "rainbow" -> "ethereum"
            "phantom" -> "solana"
            else -> null
        }
        if (uri.scheme != scheme) {
            call.resolve(JSObject().put("opened", false))
            return
        }
        val intent = Intent(Intent.ACTION_VIEW, uri)
            .setPackage(packageName)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val opened = try {
            context.startActivity(intent)
            true
        } catch (error: ActivityNotFoundException) {
            false
        } catch (error: SecurityException) {
            false
        }
        call.resolve(JSObject().put("opened", opened))
    }
}
