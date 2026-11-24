package com.miden.breadconnect

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** What the app keeps while its connect request is out. */
data class AppConnection(val id: String, val callback: String, val appSecretKey: String, val appPublicKey: String)

/** What the app keeps for a connected session. */
data class AppSession(
    val session: String,
    val callback: String,
    val appSecretKey: String,
    val appPublicKey: String,
    val walletPublicKey: String,
)

sealed class ConnectAnswer {
    data class Response(val response: JsonObject) : ConnectAnswer()

    data class Error(val error: ProtocolError) : ConnectAnswer()
}

sealed class TransactionOutcome {
    data class Output(val output: JsonElement) : TransactionOutcome()

    data class Error(val error: ProtocolError) : TransactionOutcome()
}

sealed class RequestAnswer {
    data class Response(val response: JsonObject, val transaction: TransactionOutcome?) : RequestAnswer()

    data class Error(val error: ProtocolError) : RequestAnswer()
}

/** The app's side of Bread Connect: it starts connections, seals requests and reads Bread's answers. */
object BreadConnectProtocol {
    /** Starts a connection: the link opens Bread with the permission request. */
    fun startConnect(callback: String, request: JsonObject): Pair<String, AppConnection> = startConnect(
        callback,
        request,
        ProtocolCrypto.generateKeyPair(),
        Base64Url.encode(ProtocolCrypto.randomBytes(ProtocolCrypto.ID_BYTES)),
    )

    internal fun startConnect(
        callback: String,
        request: JsonObject,
        keyPair: ProtocolCrypto.KeyPair,
        id: String,
    ): Pair<String, AppConnection> {
        if (BreadConnectLinks.callbackOrigin(callback) == null) throw ProtocolException("The callback does not follow the rules")
        if (request["type"].string != "PERMISSION_REQUEST") throw ProtocolException("A connect carries a PERMISSION_REQUEST")
        val connection = AppConnection(id, callback, Base64Url.encode(keyPair.secretKey), Base64Url.encode(keyPair.publicKey))
        return checkedLink(Envelope.Connect(id, callback, connection.appPublicKey, request)) to connection
    }

    /** Reads Bread's answer to the connection; throws when it was not sealed for this connection. */
    fun finishConnect(envelope: Envelope.Connected, connection: AppConnection): Pair<AppSession, ConnectAnswer> {
        if (envelope.id != connection.id) throw ProtocolException("The answer is for another connection")
        val keys = appKeys(connection.appSecretKey, connection.appPublicKey, envelope.walletPublicKey)
        val payload = openPayload(keys.walletKey, "connected", envelope.session, envelope.id, envelope.nonce, envelope.sealed)
        val answer = connectAnswer(payload) ?: throw ProtocolException("The connect answer is malformed")
        val session = AppSession(
            envelope.session,
            connection.callback,
            connection.appSecretKey,
            connection.appPublicKey,
            envelope.walletPublicKey,
        )
        return session to answer
    }

    /** Seals a request for the session: the link opens Bread with it. [sentAt] is in milliseconds since 1970. */
    fun sendRequest(session: AppSession, request: JsonObject, sentAt: Long): Pair<String, String> = sendRequest(
        session,
        request,
        sentAt,
        Base64Url.encode(ProtocolCrypto.randomBytes(ProtocolCrypto.ID_BYTES)),
        ProtocolCrypto.randomBytes(ProtocolCrypto.NONCE_BYTES),
    )

    internal fun sendRequest(
        session: AppSession,
        request: JsonObject,
        sentAt: Long,
        id: String,
        nonce: ByteArray,
    ): Pair<String, String> {
        val keys = appKeys(session.appSecretKey, session.appPublicKey, session.walletPublicKey)
        val payload = JsonObject(linkedMapOf<String, JsonElement>("request" to request, "sentAt" to JsonPrimitive(sentAt)))
        val sealed = ProtocolCrypto.seal(
            keys.appKey,
            nonce,
            ProtocolCrypto.additionalData("request", session.session, id),
            payload.serialized(),
        )
        val envelope = Envelope.Request(id, session.session, session.callback, Base64Url.encode(nonce), Base64Url.encode(sealed))
        return checkedLink(envelope) to id
    }

    /** Reads Bread's answer to a request of the session; throws when it was not sealed for it. */
    fun readResponse(envelope: Envelope.Response, session: AppSession): RequestAnswer {
        if (envelope.session != session.session) throw ProtocolException("The answer is for another session")
        val keys = appKeys(session.appSecretKey, session.appPublicKey, session.walletPublicKey)
        val payload = openPayload(keys.walletKey, "response", envelope.session, envelope.id, envelope.nonce, envelope.sealed)
        return requestAnswer(payload) ?: throw ProtocolException("The answer is malformed")
    }

    internal fun appKeys(secretKey: String, appPublicKey: String, walletPublicKey: String): ProtocolCrypto.SessionKeys {
        val app = requireBytes(appPublicKey, ProtocolCrypto.KEY_BYTES)
        val wallet = requireBytes(walletPublicKey, ProtocolCrypto.KEY_BYTES)
        return ProtocolCrypto.deriveSessionKeys(requireBytes(secretKey, ProtocolCrypto.KEY_BYTES), wallet, app, wallet)
    }

    internal fun openPayload(
        key: ByteArray,
        type: String,
        session: String,
        id: String,
        nonce: String,
        sealed: String,
    ): JsonElement {
        val plaintext = ProtocolCrypto.open(
            key,
            requireBytes(nonce, ProtocolCrypto.NONCE_BYTES),
            ProtocolCrypto.additionalData(type, session, id),
            requireBytes(sealed, null),
        )
        return parseJson(plaintext) ?: throw ProtocolException("The sealed payload is not JSON")
    }

    internal fun connectAnswer(payload: JsonElement): ConnectAnswer? {
        val obj = payload.obj ?: return null
        val response = obj["response"].dAppMessage()
        if (response != null && !obj.containsKey("error")) return ConnectAnswer.Response(response)
        val error = ProtocolError.from(obj["error"])
        if (error != null && !obj.containsKey("response")) return ConnectAnswer.Error(error)
        return null
    }

    internal fun requestAnswer(payload: JsonElement): RequestAnswer? {
        val obj = payload.obj ?: return null
        val error = ProtocolError.from(obj["error"])
        if (error != null && !obj.containsKey("response") && !obj.containsKey("transaction")) return RequestAnswer.Error(error)
        val response = obj["response"].dAppMessage()
        if (response == null || obj.containsKey("error")) return null
        val transaction = obj["transaction"] ?: return RequestAnswer.Response(response, null)
        return transactionOutcome(transaction)?.let { RequestAnswer.Response(response, it) }
    }

    internal fun transactionOutcome(value: JsonElement): TransactionOutcome? {
        val obj = value.obj ?: return null
        val error = ProtocolError.from(obj["error"])
        if (error != null && !obj.containsKey("output")) return TransactionOutcome.Error(error)
        val output = obj["output"]
        if (output != null && !obj.containsKey("error")) return TransactionOutcome.Output(output)
        return null
    }

    internal fun requireBytes(text: String, size: Int?): ByteArray {
        val bytes = Base64Url.decode(text)
        if (bytes == null || (size != null && bytes.size != size)) throw ProtocolException("A byte field is malformed")
        return bytes
    }

    private fun checkedLink(envelope: Envelope): String {
        val link = BreadConnectLinks.writeLink(BreadConnectLinks.REQUEST_URL, envelope)
        if (link.length - link.indexOf("&m=") - 3 > BreadConnectLinks.MAX_MESSAGE_LENGTH) {
            throw ProtocolException("The message is longer than Bread reads")
        }
        return link
    }
}
