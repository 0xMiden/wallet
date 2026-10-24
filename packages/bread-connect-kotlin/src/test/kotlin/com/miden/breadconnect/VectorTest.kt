package com.miden.breadconnect

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class VectorTest {
    private val appKey = bytes(Vectors.obj("keys")["appKey"])
    private val walletKey = bytes(Vectors.obj("keys")["walletKey"])

    @Test
    fun keysAgreeWithRfc7748AndTheDerivedKeys() {
        val app = Vectors.obj("app")
        val wallet = Vectors.obj("wallet")
        assertArrayEquals(bytes(app["publicKey"]), ProtocolCrypto.publicKeyOf(bytes(app["secretKey"])))
        assertArrayEquals(bytes(wallet["publicKey"]), ProtocolCrypto.publicKeyOf(bytes(wallet["secretKey"])))

        val appPublicKey = bytes(app["publicKey"])
        val walletPublicKey = bytes(wallet["publicKey"])
        val fromApp = ProtocolCrypto.deriveSessionKeys(bytes(app["secretKey"]), walletPublicKey, appPublicKey, walletPublicKey)
        val fromWallet = ProtocolCrypto.deriveSessionKeys(bytes(wallet["secretKey"]), appPublicKey, appPublicKey, walletPublicKey)
        for (keys in listOf(fromApp, fromWallet)) {
            assertArrayEquals(appKey, keys.appKey)
            assertArrayEquals(walletKey, keys.walletKey)
        }
    }

    @Test
    fun everyMessageReadsAndWritesBackToItsLink() {
        for (message in Vectors.list("messages")) {
            val name = message["name"].string
            val base = message["base"].string!!
            val link = message["link"].string!!
            val envelope = (BreadConnectLinks.readLink(link, base) as? ReadLink.Message)?.envelope
                ?: throw AssertionError("$name does not read")
            assertEquals(name, message["envelope"], envelope.toJson())
            assertEquals(name, link, BreadConnectLinks.writeLink(base, envelope))
        }
    }

    @Test
    fun sealedPayloadsOpenToTheirPlaintextAndSealBack() {
        for (message in Vectors.list("messages").filter { it.containsKey("plaintext") }) {
            val name = message["name"].string
            val envelope = message["envelope"].obj!!
            val type = envelope["type"].string!!
            val key = if (type == "request") appKey else walletKey
            val additionalData = ProtocolCrypto.additionalData(type, envelope["session"].string!!, envelope["id"].string!!)
            assertEquals(name, message["additionalData"].string, additionalData.toString(Charsets.UTF_8))

            val nonce = bytes(envelope["nonce"])
            val sealed = bytes(envelope["sealed"])
            val plaintext = ProtocolCrypto.open(key, nonce, additionalData, sealed)
            assertEquals(name, message["plaintext"].string, plaintext)
            assertEquals(name, plaintext, parseJson(plaintext)!!.serialized())
            assertArrayEquals(name, sealed, ProtocolCrypto.seal(key, nonce, additionalData, plaintext))
        }
    }

    @Test
    fun startConnectWritesTheConnectLink() {
        val message = Vectors.message("connect")
        val request = message["envelope"].obj!!["request"].obj!!
        val (link, connection) =
            BreadConnectProtocol.startConnect(Vectors.string("callback"), request, Vectors.app, Vectors.string("id"))
        assertEquals(message["link"].string, link)
        assertEquals(Vectors.connection, connection)
    }

    @Test
    fun finishConnectReadsTheApprovalAndTheRefusal() {
        val (session, answer) = BreadConnectProtocol.finishConnect(connected("connected"), Vectors.connection)
        assertEquals(Vectors.session, session)
        val plaintext = json(Vectors.message("connected")["plaintext"].string!!)
        assertEquals(ConnectAnswer.Response(plaintext["response"].obj!!), answer)

        val (_, refused) = BreadConnectProtocol.finishConnect(connected("connected, refused"), Vectors.connection)
        assertEquals(ConnectAnswer.Error(ProtocolError(ProtocolErrorCode.NOT_GRANTED, "The user declined")), refused)
    }

    @Test
    fun sendRequestWritesTheRequestLinks() {
        for ((name, id, nonceFrom) in listOf(
            Triple("sign request", Vectors.string("id"), 96),
            Triple("send request", Vectors.string("secondId"), 128),
        )) {
            val message = Vectors.message(name)
            val plaintext = json(message["plaintext"].string!!)
            val (link, sentId) = BreadConnectProtocol.sendRequest(
                Vectors.session,
                plaintext["request"].obj!!,
                plaintext["sentAt"].toString().toLong(),
                id,
                counting(nonceFrom, 12),
            )
            assertEquals(name, message["link"].string, link)
            assertEquals(name, id, sentId)
        }
    }

    @Test
    fun readResponseReadsAnswersAndTransactionOutcomes() {
        assertEquals(
            RequestAnswer.Response(json("""{"type":"SIGN_RESPONSE","signature":"c2lnbmF0dXJlIGJ5dGVz"}"""), null),
            BreadConnectProtocol.readResponse(response("sign response"), Vectors.session),
        )
        assertEquals(
            RequestAnswer.Response(
                json("""{"type":"SEND_TRANSACTION_RESPONSE","transactionId":"tx-7f3e"}"""),
                TransactionOutcome.Output(json("""{"txHash":"0x5f1c9e","outputNotes":[]}""")),
            ),
            BreadConnectProtocol.readResponse(response("send response with its outcome"), Vectors.session),
        )
    }

    @Test
    fun theUnsealedErrorReads() {
        val message = Vectors.message("unsealed error")
        assertEquals(
            ReadLink.Message(
                Envelope.Error(
                    Vectors.string("id"),
                    ProtocolError(ProtocolErrorCode.SESSION_NOT_FOUND, "Bread has no such session"),
                ),
            ),
            BreadConnectLinks.readLink(message["link"].string!!, message["base"].string!!),
        )
    }

    @Test
    fun invalidLinksReadAsTheVectorsSay() {
        for (vector in Vectors.list("invalid")) {
            val read = vector["read"].obj!!
            val callback = read["callback"].string
            val id = read["id"].string
            val expected = if (read["kind"].string == "unsupported-version") {
                ReadLink.UnsupportedVersion(callback, id)
            } else {
                ReadLink.Invalid(callback, id)
            }
            assertEquals(
                vector["name"].string,
                expected,
                BreadConnectLinks.readLink(vector["link"].string!!, vector["base"].string!!),
            )
        }
    }

    @Test
    fun callbacksReadAsTheVectorsSay() {
        for (vector in Vectors.list("callbacks")) {
            val callback = vector["callback"].string!!
            assertEquals(callback, vector["origin"].string, BreadConnectLinks.callbackOrigin(callback))
        }
    }

    @Test
    fun theAppRefusesEnvelopesThatDoNotOpen() {
        for (vector in Vectors.list("unopenable").filter { it["role"].string == "app" }) {
            when (val envelope = Envelope.from(vector["envelope"])) {
                is Envelope.Connected -> assertThrows(vector["name"].string, ProtocolException::class.java) {
                    BreadConnectProtocol.finishConnect(envelope, Vectors.connection)
                }
                is Envelope.Response -> assertThrows(vector["name"].string, ProtocolException::class.java) {
                    BreadConnectProtocol.readResponse(envelope, Vectors.session)
                }
                else -> throw AssertionError("${vector["name"].string} does not read as an answer")
            }
        }
    }

    private fun connected(name: String) = Envelope.from(Vectors.message(name)["envelope"]) as Envelope.Connected

    private fun response(name: String) = Envelope.from(Vectors.message(name)["envelope"]) as Envelope.Response
}
