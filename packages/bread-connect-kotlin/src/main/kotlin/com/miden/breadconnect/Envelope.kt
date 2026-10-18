package com.miden.breadconnect

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Bread's error codes; each name is the code on the wire. */
enum class ProtocolErrorCode {
    NOT_GRANTED,
    NOT_FOUND,
    INVALID_PARAMS,
    NETWORK_NOT_GRANTED,
    UNSUPPORTED_METHOD,
    INVALID_REQUEST,
    DUPLICATE_REQUEST,
    REQUEST_EXPIRED,
    SESSION_NOT_FOUND,
    UNSUPPORTED_VERSION,
    TRANSACTION_FAILED,
    TRANSACTION_TIMEOUT,
    INTERNAL_ERROR,
}

data class ProtocolError(val code: ProtocolErrorCode, val message: String) {
    internal fun toJson(): JsonObject = buildJsonObject {
        put("code", code.name)
        put("message", message)
    }

    internal companion object {
        fun from(json: JsonElement?): ProtocolError? {
            val obj = json.obj ?: return null
            val code = ProtocolErrorCode.entries.firstOrNull { it.name == obj["code"].string } ?: return null
            val message = obj["message"].string ?: return null
            return ProtocolError(code, message)
        }
    }
}

sealed class Envelope {
    data class Connect(val id: String, val callback: String, val appPublicKey: String, val request: JsonObject) : Envelope()

    data class Connected(
        val id: String,
        val session: String,
        val walletPublicKey: String,
        val nonce: String,
        val sealed: String,
    ) : Envelope()

    data class Request(
        val id: String,
        val session: String,
        val callback: String,
        val nonce: String,
        val sealed: String,
    ) : Envelope()

    data class Response(val id: String, val session: String, val nonce: String, val sealed: String) : Envelope()

    data class Error(val id: String?, val error: ProtocolError) : Envelope()

    /** The envelope with its fields in the order every implementation writes them. */
    internal fun toJson(): JsonObject = when (this) {
        is Connect -> JsonObject(
            linkedMapOf(
                "type" to JsonPrimitive("connect"),
                "id" to JsonPrimitive(id),
                "callback" to JsonPrimitive(callback),
                "appPublicKey" to JsonPrimitive(appPublicKey),
                "request" to request,
            ),
        )
        is Connected -> strings(
            "type" to "connected", "id" to id, "session" to session, "walletPublicKey" to walletPublicKey,
            "nonce" to nonce, "sealed" to sealed,
        )
        is Request -> strings(
            "type" to "request", "id" to id, "session" to session, "callback" to callback, "nonce" to nonce,
            "sealed" to sealed,
        )
        is Response -> strings("type" to "response", "id" to id, "session" to session, "nonce" to nonce, "sealed" to sealed)
        is Error -> JsonObject(
            linkedMapOf<String, JsonElement>("type" to JsonPrimitive("error")).apply {
                if (id != null) put("id", JsonPrimitive(id))
                put("error", error.toJson())
            },
        )
    }

    internal companion object {
        private fun strings(vararg fields: Pair<String, String>) =
            JsonObject(fields.associateTo(linkedMapOf<String, JsonElement>()) { (key, value) -> key to JsonPrimitive(value) })

        fun from(json: JsonElement?): Envelope? {
            val value = json.obj ?: return null
            fun field(key: String) = value[key].string
            return when (field("type")) {
                "connect" -> {
                    val id = field("id")?.takeIf(::isId) ?: return null
                    val callback = field("callback")?.takeIf(::isCallback) ?: return null
                    val appPublicKey = field("appPublicKey")?.takeIf { isBytes(it, ProtocolCrypto.KEY_BYTES) } ?: return null
                    val request = value["request"].obj?.takeIf { it["type"].string == "PERMISSION_REQUEST" } ?: return null
                    Connect(id, callback, appPublicKey, request)
                }
                "connected" -> Connected(
                    id = field("id")?.takeIf(::isId) ?: return null,
                    session = field("session")?.takeIf(::isId) ?: return null,
                    walletPublicKey = field("walletPublicKey")?.takeIf { isBytes(it, ProtocolCrypto.KEY_BYTES) } ?: return null,
                    nonce = field("nonce")?.takeIf(::isNonce) ?: return null,
                    sealed = field("sealed")?.takeIf(::isSealed) ?: return null,
                )
                "request" -> Request(
                    id = field("id")?.takeIf(::isId) ?: return null,
                    session = field("session")?.takeIf(::isId) ?: return null,
                    callback = field("callback")?.takeIf(::isCallback) ?: return null,
                    nonce = field("nonce")?.takeIf(::isNonce) ?: return null,
                    sealed = field("sealed")?.takeIf(::isSealed) ?: return null,
                )
                "response" -> Response(
                    id = field("id")?.takeIf(::isId) ?: return null,
                    session = field("session")?.takeIf(::isId) ?: return null,
                    nonce = field("nonce")?.takeIf(::isNonce) ?: return null,
                    sealed = field("sealed")?.takeIf(::isSealed) ?: return null,
                )
                "error" -> {
                    val error = ProtocolError.from(value["error"]) ?: return null
                    if (!value.containsKey("id")) return Error(null, error)
                    Error(field("id")?.takeIf(::isId) ?: return null, error)
                }
                else -> null
            }
        }
    }
}

/**
 * What a link under a base says. [UnsupportedVersion] and [Invalid] carry the callback and request id when the
 * message names valid ones, so the receiver can answer there.
 */
sealed class ReadLink {
    data class Message(val envelope: Envelope) : ReadLink()

    data class UnsupportedVersion(val callback: String?, val id: String?) : ReadLink()

    data class Invalid(val callback: String?, val id: String?) : ReadLink()
}

object BreadConnectLinks {
    /** Bread's link for every app request; Android gives it only to Bread once bread.miden.xyz verifies Bread. */
    const val REQUEST_URL = "https://bread.miden.xyz/request"
    const val BREAD_PACKAGE = "com.miden.wallet"
    const val PLAY_STORE_MARKET_URL = "market://details?id=com.miden.wallet"
    const val PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.miden.wallet"

    /** The longest `m` a sender may send and a receiver reads, in base64url characters. */
    const val MAX_MESSAGE_LENGTH = 524_288
    const val MAX_CALLBACK_LENGTH = 512

    private val HOST_LABEL = Regex("[a-z0-9-]+")
    private val NUMERIC_LABEL = Regex("[0-9]+|0x[0-9a-f]*")
    private val PATH = Regex("(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*")

    /**
     * The origin of a callback that follows the protocol's rules, else null. A callback is a canonical https link on
     * a named host, with a path and no port, credentials, query or fragment.
     */
    fun callbackOrigin(callback: String): String? {
        if (callback.length > MAX_CALLBACK_LENGTH || !callback.startsWith("https://")) return null
        val rest = callback.removePrefix("https://")
        val slash = rest.indexOf('/')
        if (slash < 0) return null
        val host = rest.substring(0, slash)
        val labels = host.split('.')
        if (labels.size < 2 || !labels.all(HOST_LABEL::matches)) return null
        if (NUMERIC_LABEL.matches(labels.last()) || host.endsWith(".localhost")) return null
        val path = rest.substring(slash)
        if (!PATH.matches(path)) return null
        for (segment in path.split('/')) {
            val dots = segment.lowercase().replace("%2e", ".")
            if (dots == "." || dots == "..") return null
        }
        return "https://$host"
    }

    /** The link that carries the envelope to [base]. */
    fun writeLink(base: String, envelope: Envelope): String =
        "$base#v=1&m=${Base64Url.encode(envelope.toJson().serialized().toByteArray(Charsets.UTF_8))}"

    /** Null when the link is not [base] followed by a fragment, so it is not a message for this receiver. */
    fun readLink(link: String, base: String): ReadLink? {
        if (!link.startsWith("$base#")) return null
        val fields = mutableMapOf<String, String>()
        for (part in link.substring(base.length + 1).split('&')) {
            val at = part.indexOf('=')
            if (at < 0) return ReadLink.Invalid(null, null)
            val name = part.substring(0, at)
            if (name in fields) return ReadLink.Invalid(null, null)
            fields[name] = part.substring(at + 1)
        }
        val version = fields["v"]
        val message = fields["m"]
        if (version == null || message == null || message.length > MAX_MESSAGE_LENGTH) return ReadLink.Invalid(null, null)
        val json = Base64Url.decode(message)?.strictUtf8()?.let(::parseJson)
        val reply = json.obj
        val callback = reply?.get("callback").string?.takeIf(::isCallback)
        val id = reply?.get("id").string?.takeIf(::isId)
        if (version != "1") return ReadLink.UnsupportedVersion(callback, id)
        return Envelope.from(json)?.let(ReadLink::Message) ?: ReadLink.Invalid(callback, id)
    }
}

internal fun isId(text: String) = isBytes(text, ProtocolCrypto.ID_BYTES)

internal fun isNonce(text: String) = isBytes(text, ProtocolCrypto.NONCE_BYTES)

internal fun isBytes(text: String, size: Int) = Base64Url.decode(text, size) != null

internal fun isSealed(text: String) = (Base64Url.decode(text)?.size ?: -1) >= ProtocolCrypto.TAG_BYTES

internal fun isCallback(text: String) = BreadConnectLinks.callbackOrigin(text) != null
