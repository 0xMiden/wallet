package com.miden.breadconnect

import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** The shared vectors in packages/bread-connect/vectors, which every implementation checks itself against. */
internal object Vectors {
    val all: JsonObject by lazy { parseJson(File("../bread-connect/vectors/v1.json").readText()).obj!! }

    fun string(key: String) = all[key].string!!

    fun obj(key: String) = all[key].obj!!

    fun list(key: String) = (all[key] as JsonArray).map { it.obj!! }

    fun message(name: String) = list("messages").first { it["name"].string == name }

    val app get() = ProtocolCrypto.KeyPair(bytes(obj("app")["secretKey"]), bytes(obj("app")["publicKey"]))

    val connection get() =
        AppConnection(string("id"), string("callback"), obj("app")["secretKey"].string!!, obj("app")["publicKey"].string!!)

    val session get() = AppSession(
        string("session"),
        string("callback"),
        obj("app")["secretKey"].string!!,
        obj("app")["publicKey"].string!!,
        obj("wallet")["publicKey"].string!!,
    )
}

fun bytes(value: JsonElement?) = Base64Url.decode(value.string!!)!!

/** [size] bytes counting up from [from], as the vector generator makes ids and nonces. */
fun counting(from: Int, size: Int) = ByteArray(size) { ((from + it) and 255).toByte() }

fun json(text: String) = parseJson(text).obj!!

class MemoryStorage : BreadConnectStorage {
    val items = mutableMapOf<String, String>()

    override fun read(key: String) = items[key]

    override fun write(key: String, value: String?) {
        if (value == null) items.remove(key) else items[key] = value
    }
}

internal class FakeOpener : ManagedBreadOpener {
    var installed = true
    val opened = mutableListOf<String>()
    var onOpen: ((String) -> Unit)? = null

    override suspend fun open(link: String, attempt: OpenAttempt): Boolean {
        val installedNow = attempt.run {
            opened += link
            installed
        } ?: return true
        onOpen?.invoke(link)
        return installedNow
    }
}

internal class HeldAttemptOpener : ManagedBreadOpener {
    class Call(val link: String) {
        val launches = AtomicInteger()
        val passedAttempt = CompletableDeferred<Unit>()
        private var continuation: Continuation<Unit>? = null
        private var released = false

        suspend fun awaitRelease(entered: () -> Unit) = suspendCoroutine<Unit> { waiting ->
            val resumeNow = synchronized(this) {
                if (released) true else {
                    continuation = waiting
                    false
                }
            }
            entered()
            if (resumeNow) waiting.resume(Unit)
        }

        fun release() {
            val waiting = synchronized(this) {
                released = true
                continuation.also { continuation = null }
            }
            waiting?.resume(Unit)
        }
    }

    private val lock = Any()
    private val recorded = mutableListOf<Call>()
    private var releasing = false
    val firstEntered = CompletableDeferred<Call>()
    val calls: List<Call> get() = synchronized(lock) { recorded.toList() }

    override suspend fun open(link: String, attempt: OpenAttempt): Boolean {
        val call = Call(link)
        val releaseNow = synchronized(lock) {
            recorded += call
            releasing
        }
        if (releaseNow) call.release()
        // Raw suspension leaves the opening child incomplete while its caller or SDK deadline cancels.
        call.awaitRelease { firstEntered.complete(call) }
        val opened = attempt.run {
            call.launches.incrementAndGet()
            true
        } ?: true
        call.passedAttempt.complete(Unit)
        return opened
    }

    fun releaseAll() {
        val pending = synchronized(lock) {
            releasing = true
            recorded.toList()
        }
        pending.forEach { it.release() }
    }
}

/** Bread's side of the protocol, for answering the client's links in tests. */
class FakeBread {
    var session = ""
        private set
    var callback = ""
        private set
    private var keys: ProtocolCrypto.SessionKeys? = null

    /** Bread's answer to a connect link: [answer] is `{"response": …}` or `{"error": …}`. */
    fun answerConnect(link: String, answer: JsonObject): String {
        val connect = (BreadConnectLinks.readLink(link, BreadConnectLinks.REQUEST_URL) as ReadLink.Message).envelope as Envelope.Connect
        val wallet = ProtocolCrypto.generateKeyPair()
        val appPublicKey = Base64Url.decode(connect.appPublicKey)!!
        val keys = ProtocolCrypto.deriveSessionKeys(wallet.secretKey, appPublicKey, appPublicKey, wallet.publicKey)
        this.keys = keys
        session = Base64Url.encode(ProtocolCrypto.randomBytes(16))
        callback = connect.callback
        val nonce = ProtocolCrypto.randomBytes(12)
        val sealed = ProtocolCrypto.seal(
            keys.walletKey,
            nonce,
            ProtocolCrypto.additionalData("connected", session, connect.id),
            answer.serialized(),
        )
        val envelope = Envelope.Connected(
            connect.id,
            session,
            Base64Url.encode(wallet.publicKey),
            Base64Url.encode(nonce),
            Base64Url.encode(sealed),
        )
        return BreadConnectLinks.writeLink(callback, envelope)
    }

    /** The request a link carries, opened with the session's app key. */
    fun openRequest(link: String): Triple<Envelope.Request, JsonObject, Long> {
        val envelope = (BreadConnectLinks.readLink(link, BreadConnectLinks.REQUEST_URL) as ReadLink.Message).envelope as Envelope.Request
        val payload = BreadConnectProtocol.openPayload(
            keys!!.appKey,
            "request",
            envelope.session,
            envelope.id,
            envelope.nonce,
            envelope.sealed,
        ).obj!!
        return Triple(envelope, payload["request"].obj!!, payload["sentAt"].toString().toLong())
    }

    /** Bread's sealed answer to a request link: `{"response": …}`, with a `transaction` outcome or not, or `{"error": …}`. */
    fun answerRequest(link: String, answer: JsonObject): String {
        val (envelope) = openRequest(link)
        val nonce = ProtocolCrypto.randomBytes(12)
        val sealed = ProtocolCrypto.seal(
            keys!!.walletKey,
            nonce,
            ProtocolCrypto.additionalData("response", session, envelope.id),
            answer.serialized(),
        )
        return BreadConnectLinks.writeLink(
            callback,
            Envelope.Response(envelope.id, session, Base64Url.encode(nonce), Base64Url.encode(sealed)),
        )
    }

    /** An unsealed error for a request id, as Bread sends when it holds no keys for the message. */
    fun error(id: String?, code: ProtocolErrorCode, message: String): String =
        BreadConnectLinks.writeLink(callback, Envelope.Error(id, ProtocolError(code, message)))
}
