package com.miden.wallet

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/// Opens an app's Bread Connect callback with Bread's answer only in the app the callback's domain verified, never
/// in a browser. Android 11 and later route it to the link's verified default handler alone; Android 9 and 10, which
/// lack those flags, only to an installed app that handles the link and is signed with a certificate the domain's
/// assetlinks.json names.
@CapacitorPlugin(name = "BreadConnectOpener")
class BreadConnectOpenerPlugin : Plugin() {
    companion object {
        private const val ASSET_LINKS_MAX_BYTES = 256 * 1024
        private const val TIMEOUT_MS = 5_000
    }

    private val executor = Executors.newSingleThreadExecutor()

    @PluginMethod
    fun openCallback(call: PluginCall) {
        val uri = call.getString("url")?.let(Uri::parse)
        val host = uri?.host
        if (uri == null || uri.scheme != "https" || host.isNullOrEmpty()) {
            return call.reject("The callback must be an https link")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val flags = Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER or Intent.FLAG_ACTIVITY_REQUIRE_DEFAULT
            call.resolve(opened(start(view(uri).addFlags(flags))))
            return
        }
        executor.execute {
            val target = runCatching { verifiedPackage(uri, host) }.getOrNull()
            call.resolve(opened(target != null && start(view(uri).setPackage(target))))
        }
    }

    private fun view(uri: Uri): Intent =
        Intent(Intent.ACTION_VIEW, uri)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun start(intent: Intent): Boolean =
        try {
            context.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        }

    private fun opened(value: Boolean): JSObject = JSObject().put("opened", value)

    private fun verifiedPackage(uri: Uri, host: String): String? {
        val packages = context.packageManager
        return assetLinkTargets(host).firstOrNull { target ->
            target.fingerprints.any {
                packages.hasSigningCertificate(target.packageName, it, PackageManager.CERT_INPUT_SHA256)
            } && packages.queryIntentActivities(view(uri).setPackage(target.packageName), 0).isNotEmpty()
        }?.packageName
    }

    private fun assetLinkTargets(host: String): List<AssetLinkTarget> {
        val connection = URL("https://$host/.well-known/assetlinks.json").openConnection() as HttpURLConnection
        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = TIMEOUT_MS
        connection.instanceFollowRedirects = false
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) return emptyList()
            val body = ByteArrayOutputStream()
            val chunk = ByteArray(8192)
            connection.inputStream.use { stream ->
                while (true) {
                    val read = stream.read(chunk)
                    if (read < 0) break
                    body.write(chunk, 0, read)
                    if (body.size() > ASSET_LINKS_MAX_BYTES) return emptyList()
                }
            }
            val statements = JSONArray(body.toString(Charsets.UTF_8.name()))
            return (0 until statements.length()).mapNotNull { index ->
                val statement = statements.optJSONObject(index) ?: return@mapNotNull null
                val target = statement.optJSONObject("target") ?: return@mapNotNull null
                BreadConnectOpenerLogic.target(
                    strings(statement.optJSONArray("relation")),
                    target.optString("namespace").ifEmpty { null },
                    target.optString("package_name").ifEmpty { null },
                    strings(target.optJSONArray("sha256_cert_fingerprints")),
                )
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun strings(array: JSONArray?): List<String> =
        if (array == null) emptyList() else (0 until array.length()).mapNotNull { array.opt(it) as? String }
}
