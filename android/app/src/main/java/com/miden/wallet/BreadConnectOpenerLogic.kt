package com.miden.wallet

/// An app a domain's assetlinks.json lets handle every link on that domain.
class AssetLinkTarget(val packageName: String, val fingerprints: List<ByteArray>)

/// The assetlinks.json rules BreadConnectOpenerPlugin applies on Android 9 and 10, split out so they are
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
}
