package com.miden.wallet

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
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
/// in a browser: by package, in an installed app that handles the link and is signed with a certificate the domain's
/// assetlinks.json names, on every Android version. The system's default handler is not enough, because from
/// Android 11 it is also an app the user picked for the domain.
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
        return BreadConnectOpenerLogic.verifiedPackage(
            assetLinkTargets(host),
            { packageName, fingerprint ->
                packages.hasSigningCertificate(packageName, fingerprint, PackageManager.CERT_INPUT_SHA256)
            },
            { packageName -> packages.queryIntentActivities(view(uri).setPackage(packageName), 0).isNotEmpty() },
        )
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
