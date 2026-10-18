package com.miden.breadconnect

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** Where the client keeps the session, the waiting request and transaction outcomes across launches. */
interface BreadConnectStorage {
    fun read(key: String): String?

    fun write(key: String, value: String?)
}

/** Opens Bread's link in Bread only; false when Bread is not installed and its store page opened instead. */
interface BreadOpener {
    suspend fun open(link: String): Boolean
}

class BreadConnectException(val code: Code, message: String) : Exception(message) {
    sealed class Code {
        /** Bread's own answer. */
        data class Bread(val code: ProtocolErrorCode) : Code()

        data object NotInstalled : Code()

        data object Superseded : Code()

        data object Cancelled : Code()

        data object Timeout : Code()
    }
}

/** A connected session, with the permission request it answered and Bread's answer. */
data class StoredSession(val session: AppSession, val request: JsonObject, val permission: JsonObject)

/**
 * Carries requests to Bread and its answers back through app switches, one request at a time: a new request
 * replaces the one still waiting. The session and the waiting request are stored, so an answer that relaunches the
 * app after the system stopped it still completes a connection and records a transaction's outcome.
 *
 * @param callback the app's https link for Bread's answers, which the app's `assetlinks.json` gives to the app.
 */
class BreadConnect(
    val callback: String,
    private val storage: BreadConnectStorage,
    private val opener: BreadOpener,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val lock = Any()
    private var waiter: Waiter? = null

    private class Waiter(val pending: Pending, val answer: CompletableDeferred<JsonObject>)

    private sealed class Pending {
        abstract val id: String
        abstract val sentAt: Long

        data class Connect(val connection: AppConnection, val request: JsonObject, override val sentAt: Long) : Pending() {
            override val id get() = connection.id
        }

        data class Request(override val id: String, val session: String, override val sentAt: Long) : Pending()
    }

    init {
        require(BreadConnectLinks.callbackOrigin(callback) != null) {
            "The callback must be a canonical https link with no query or fragment"
        }
    }

    val session: StoredSession? get() = storage.read(SESSION_KEY)?.let(::decodeSession)

    fun forgetSession() = storage.write(SESSION_KEY, null)

    /** The outcome Bread reported with a transaction's answer, when this app sent it. */
    fun transactionOutcome(transactionId: String): TransactionOutcome? = storedOutcomes()
        .firstOrNull { it["transactionId"].string == transactionId }
        ?.get("outcome")
        ?.let(BreadConnectProtocol::transactionOutcome)

    /** Asks Bread for a permission; returns Bread's PERMISSION_RESPONSE and keeps the session. */
    suspend fun connect(request: JsonObject): JsonObject {
        val (link, connection) = BreadConnectProtocol.startConnect(callback, request)
        return exchange(Pending.Connect(connection, request, clock()), link)
    }

    /** Asks Bread to connect the app, named [appName], on [network]. */
    suspend fun connect(
        appName: String,
        network: String = "testnet",
        privateDataPermission: String = "UPON_REQUEST",
    ): JsonObject = connect(
        buildJsonObject {
            put("type", "PERMISSION_REQUEST")
            put("appMeta", buildJsonObject { put("name", appName) })
            put("network", network)
            put("force", false)
            put("privateDataPermission", privateDataPermission)
        },
    )

    /** Sends a request in the connected session; returns Bread's response. */
    suspend fun request(request: JsonObject): JsonObject {
        val session = session ?: throw BreadConnectException(
            BreadConnectException.Code.Bread(ProtocolErrorCode.NOT_GRANTED),
            "The app is not connected to Bread",
        )
        val sentAt = clock()
        val (link, id) = BreadConnectProtocol.sendRequest(session.session, request, sentAt)
        return exchange(Pending.Request(id, session.session.session, sentAt), link)
    }

    /** Stops waiting for the answer to the request in flight. */
    fun cancelPending() {
        settle(null, failure(BreadConnectException.Code.Cancelled, "The request to Bread was cancelled"))
    }

    /**
     * Reads a link the app was opened with. True when the link is under the callback, so it is Bread's and the app
     * should not route it further; anything but an answer to the waiting request is dropped.
     */
    fun handle(link: String): Boolean {
        val read = BreadConnectLinks.readLink(link, callback) ?: return false
        val envelope = (read as? ReadLink.Message)?.envelope ?: return true
        synchronized(lock) {
            val pending = waiter?.pending ?: storedPending() ?: return true
            when {
                envelope is Envelope.Connected && pending is Pending.Connect && envelope.id == pending.id -> {
                    val (session, answer) = try {
                        BreadConnectProtocol.finishConnect(envelope, pending.connection)
                    } catch (e: ProtocolException) {
                        return true
                    }
                    when (answer) {
                        is ConnectAnswer.Response -> {
                            storage.write(SESSION_KEY, encodeSession(StoredSession(session, pending.request, answer.response)))
                            settle(null, Result.success(answer.response))
                        }
                        is ConnectAnswer.Error -> settle(null, failure(answer.error))
                    }
                }
                envelope is Envelope.Response && pending is Pending.Request && envelope.id == pending.id -> {
                    val stored = session?.takeIf { it.session.session == pending.session } ?: return true
                    val answer = try {
                        BreadConnectProtocol.readResponse(envelope, stored.session)
                    } catch (e: ProtocolException) {
                        return true
                    }
                    when (answer) {
                        is RequestAnswer.Response -> {
                            val transactionId = answer.response["transactionId"].string
                            if (answer.transaction != null && transactionId != null) {
                                recordOutcome(transactionId, answer.transaction)
                            }
                            settle(null, Result.success(answer.response))
                        }
                        is RequestAnswer.Error -> settle(null, failure(answer.error))
                    }
                }
                envelope is Envelope.Error && envelope.id != null && envelope.id == pending.id -> {
                    if (envelope.error.code == ProtocolErrorCode.SESSION_NOT_FOUND) forgetSession()
                    settle(null, failure(envelope.error))
                }
            }
        }
        return true
    }

    private suspend fun exchange(pending: Pending, link: String): JsonObject {
        val waiter = Waiter(pending, CompletableDeferred())
        synchronized(lock) {
            settle(null, failure(BreadConnectException.Code.Superseded, "A newer request to Bread replaced this one"))
            storage.write(PENDING_KEY, encodePending(pending))
            this.waiter = waiter
        }
        try {
            return withTimeout(REQUEST_MAX_AGE_MS) {
                val opened = try {
                    opener.open(link)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    settle(waiter, failure(ProtocolError(ProtocolErrorCode.INTERNAL_ERROR, "Bread could not be opened: $e")))
                    true
                }
                if (!opened) settle(waiter, failure(BreadConnectException.Code.NotInstalled, "Bread is not installed; its store page is open"))
                waiter.answer.await()
            }
        } catch (e: TimeoutCancellationException) {
            settle(waiter, failure(BreadConnectException.Code.Timeout, "Bread did not answer in time"))
            throw BreadConnectException(BreadConnectException.Code.Timeout, "Bread did not answer in time")
        } catch (e: CancellationException) {
            settle(waiter, failure(BreadConnectException.Code.Cancelled, "The request to Bread was cancelled"))
            throw e
        }
    }

    /** Ends the waiting request, if any, and forgets it; with [only], just when that request is still waiting. */
    private fun settle(only: Waiter?, result: Result<JsonObject>) {
        synchronized(lock) {
            if (only != null && waiter !== only) return
            storage.write(PENDING_KEY, null)
            val current = waiter ?: return
            waiter = null
            result.fold({ current.answer.complete(it) }, { current.answer.completeExceptionally(it) })
        }
    }

    private fun storedPending(): Pending? =
        storage.read(PENDING_KEY)?.let(::decodePending)?.takeIf { clock() - it.sentAt <= REQUEST_MAX_AGE_MS }

    private fun storedOutcomes(): List<JsonObject> =
        (storage.read(OUTCOMES_KEY)?.let(::parseJson) as? JsonArray)?.mapNotNull { it.obj }.orEmpty()

    private fun recordOutcome(transactionId: String, outcome: TransactionOutcome) {
        val outcomeJson = when (outcome) {
            is TransactionOutcome.Output -> JsonObject(mapOf("output" to outcome.output))
            is TransactionOutcome.Error -> JsonObject(mapOf("error" to outcome.error.toJson()))
        }
        val entry = JsonObject(
            linkedMapOf<String, JsonElement>("transactionId" to JsonPrimitive(transactionId), "outcome" to outcomeJson),
        )
        val kept = storedOutcomes().filter { it["transactionId"].string != transactionId }
        storage.write(OUTCOMES_KEY, JsonArray((kept + entry).takeLast(OUTCOME_LIMIT)).serialized())
    }

    private fun failure(error: ProtocolError) = failure(BreadConnectException.Code.Bread(error.code), error.message)

    private fun failure(code: BreadConnectException.Code, message: String): Result<JsonObject> =
        Result.failure(BreadConnectException(code, message))

    private fun encodeSession(stored: StoredSession): String = JsonObject(
        linkedMapOf<String, JsonElement>(
            "session" to JsonPrimitive(stored.session.session),
            "callback" to JsonPrimitive(stored.session.callback),
            "appSecretKey" to JsonPrimitive(stored.session.appSecretKey),
            "appPublicKey" to JsonPrimitive(stored.session.appPublicKey),
            "walletPublicKey" to JsonPrimitive(stored.session.walletPublicKey),
            "request" to stored.request,
            "permission" to stored.permission,
        ),
    ).serialized()

    private fun decodeSession(text: String): StoredSession? {
        val obj = parseJson(text).obj ?: return null
        return StoredSession(
            AppSession(
                obj["session"].string ?: return null,
                obj["callback"].string ?: return null,
                obj["appSecretKey"].string ?: return null,
                obj["appPublicKey"].string ?: return null,
                obj["walletPublicKey"].string ?: return null,
            ),
            obj["request"].dAppMessage() ?: return null,
            obj["permission"].dAppMessage() ?: return null,
        )
    }

    private fun encodePending(pending: Pending): String = when (pending) {
        is Pending.Connect -> buildJsonObject {
            put("kind", "connect")
            put(
                "connection",
                buildJsonObject {
                    put("id", pending.connection.id)
                    put("callback", pending.connection.callback)
                    put("appSecretKey", pending.connection.appSecretKey)
                    put("appPublicKey", pending.connection.appPublicKey)
                },
            )
            put("request", pending.request)
            put("sentAt", pending.sentAt)
        }
        is Pending.Request -> buildJsonObject {
            put("kind", "request")
            put("id", pending.id)
            put("session", pending.session)
            put("sentAt", pending.sentAt)
        }
    }.serialized()

    private fun decodePending(text: String): Pending? {
        val obj = parseJson(text).obj ?: return null
        val sentAt = (obj["sentAt"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: return null
        return when (obj["kind"].string) {
            "request" -> Pending.Request(obj["id"].string ?: return null, obj["session"].string ?: return null, sentAt)
            "connect" -> {
                val connection = obj["connection"].obj ?: return null
                Pending.Connect(
                    AppConnection(
                        connection["id"].string ?: return null,
                        connection["callback"].string ?: return null,
                        connection["appSecretKey"].string ?: return null,
                        connection["appPublicKey"].string ?: return null,
                    ),
                    obj["request"].dAppMessage() ?: return null,
                    sentAt,
                )
            }
            else -> null
        }
    }

    companion object {
        /** Bread refuses a request sent longer ago than this. */
        const val REQUEST_MAX_AGE_MS = 10 * 60 * 1000L
        internal const val SESSION_KEY = "bread-connect:session"
        internal const val PENDING_KEY = "bread-connect:pending"
        internal const val OUTCOMES_KEY = "bread-connect:outcomes"
        private const val OUTCOME_LIMIT = 20
    }
}
