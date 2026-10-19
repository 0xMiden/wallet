package com.miden.wallet

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/// An app a domain's assetlinks.json lets handle every link on that domain.
class AssetLinkTarget(val packageName: String, val fingerprints: List<ByteArray>)

/// The assetlinks.json rules BreadConnectOpenerPlugin applies before it opens a callback, split out so they are
/// coverable by plain JUnit - the HotKeyLogic pattern.
object BreadConnectOpenerLogic {
    const val HANDLE_ALL_URLS = "delegate_permission/common.handle_all_urls"

    private val HEX_BYTE = Regex("[0-9A-Fa-f]{2}")

    /// A SHA-256 certificate fingerprint as assetlinks.json writes it, 32 colon-separated hex bytes, else null.
    @JvmStatic
    fun fingerprint(text: String): ByteArray? {
        val parts = text.split(':')
        if (parts.size != 32 || !parts.all(HEX_BYTE::matches)) return null
        return ByteArray(parts.size) { parts[it].toInt(16).toByte() }
    }

    /// The app one statement names, or null unless it grants handle_all_urls to an Android app with at least one
    /// well-formed fingerprint.
    @JvmStatic
    fun target(
        relations: List<String>,
        namespace: String?,
        packageName: String?,
        fingerprints: List<String>,
    ): AssetLinkTarget? {
        if (HANDLE_ALL_URLS !in relations || namespace != "android_app" || packageName.isNullOrEmpty()) return null
        val parsed = fingerprints.mapNotNull(::fingerprint)
        return if (parsed.isEmpty()) null else AssetLinkTarget(packageName, parsed)
    }

    /// The first app the domain's statements name that is signed with one of the certificates its statement lists
    /// and handles the link, else null.
    @JvmStatic
    fun verifiedPackage(
        targets: List<AssetLinkTarget>,
        isSignedWith: (String, ByteArray) -> Boolean,
        handlesLink: (String) -> Boolean,
    ): String? = targets.firstOrNull { target ->
        target.fingerprints.any { isSignedWith(target.packageName, it) } && handlesLink(target.packageName)
    }?.packageName

    /// The body of a 200 answer on `connection`, at most `maxBytes` long, else null. `deadlineMs` bounds the whole
    /// read, status line and headers included: the read timeout bounds only each wait, so a server that sends a byte
    /// inside every one could otherwise hold the answer for as long as it likes.
    @JvmStatic
    fun readBody(
        connection: HttpURLConnection,
        maxBytes: Int,
        deadlineMs: Long,
        watchdog: ScheduledExecutorService,
    ): ByteArray? {
        val expired = AtomicBoolean(false)
        val cutOff = watchdog.schedule(
            Runnable {
                expired.set(true)
                connection.disconnect()
            },
            deadlineMs,
            TimeUnit.MILLISECONDS,
        )
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
            val body = ByteArrayOutputStream()
            val chunk = ByteArray(8192)
            connection.inputStream.use { stream ->
                while (true) {
                    val read = stream.read(chunk)
                    if (read < 0) break
                    body.write(chunk, 0, read)
                    if (body.size() > maxBytes) return null
                }
            }
            // A disconnect can end the stream early instead of failing the read, before its task has returned.
            return if (expired.get()) null else body.toByteArray()
        } catch (e: IOException) {
            return null
        } finally {
            cutOff.cancel(false)
            connection.disconnect()
        }
    }
}
