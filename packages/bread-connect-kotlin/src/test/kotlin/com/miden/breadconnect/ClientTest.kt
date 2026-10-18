package com.miden.breadconnect

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ClientTest {
    private val callback = "https://wherelegendsgrow.com/bread"
    private val permission =
        json("""{"type":"PERMISSION_RESPONSE","accountId":"mtst1qy35q7ar3h0cgyqqqx2gs3nzxrgu7hz5xz3","network":"testnet"}""")
    private val storage = MemoryStorage()
    private val opener = FakeOpener()
    private val bread = FakeBread()
    private var now = 1_792_000_000_000L

    private fun client() = BreadConnect(callback, storage, opener) { now }

    /** Answers each link the client opens with [answer], as Bread does once the user decides. */
    private fun BreadConnect.answering(answer: (String) -> String) {
        opener.onOpen = { link -> handle(answer(link)) }
    }

    private suspend fun connected(): BreadConnect {
        val client = client()
        client.answering { bread.answerConnect(it, json("""{"response":$permission}""")) }
        client.connect("Where Legends Grow")
        return client
    }

    private suspend fun assertFails(code: BreadConnectException.Code, block: suspend () -> Unit) {
        try {
            block()
            fail("Expected $code")
        } catch (e: BreadConnectException) {
            assertEquals(code, e.code)
        }
    }

    @Test
    fun connectOpensBreadAndKeepsTheSessionItApproves() = runTest {
        val client = client()
        client.answering { bread.answerConnect(it, json("""{"response":$permission}""")) }

        assertEquals(permission, client.connect("Where Legends Grow"))

        assertEquals(1, opener.opened.size)
        val connect = (BreadConnectLinks.readLink(opener.opened[0], BreadConnectLinks.REQUEST_URL) as ReadLink.Message)
            .envelope as Envelope.Connect
        assertEquals(callback, connect.callback)
        assertEquals(
            """{"type":"PERMISSION_REQUEST","appMeta":{"name":"Where Legends Grow"},"network":"testnet","force":false,"privateDataPermission":"UPON_REQUEST"}""",
            connect.request.serialized(),
        )
        assertEquals(permission, client.session?.permission)
        assertEquals(bread.session, client.session?.session?.session)
        assertNull(storage.items[BreadConnect.PENDING_KEY])
    }

    @Test
    fun aRefusedConnectThrowsBreadsErrorAndKeepsNoSession() = runTest {
        val client = client()
        client.answering {
            bread.answerConnect(it, json("""{"error":{"code":"NOT_GRANTED","message":"The user declined"}}"""))
        }

        assertFails(BreadConnectException.Code.Bread(ProtocolErrorCode.NOT_GRANTED)) { client.connect("Where Legends Grow") }
        assertNull(client.session)
    }

    @Test
    fun aRequestReturnsBreadsResponse() = runTest {
        val client = connected()
        var seen: Triple<Envelope.Request, JsonObject, Long>? = null
        client.answering { link ->
            seen = bread.openRequest(link)
            bread.answerRequest(link, json("""{"response":{"type":"SIGN_RESPONSE","signature":"c2ln"}}"""))
        }

        val response = client.request(json("""{"type":"SIGN_REQUEST","payload":"aGVsbG8="}"""))

        assertEquals(json("""{"type":"SIGN_RESPONSE","signature":"c2ln"}"""), response)
        assertEquals(json("""{"type":"SIGN_REQUEST","payload":"aGVsbG8="}"""), seen?.second)
        assertEquals(now, seen?.third)
    }

    @Test
    fun aTransactionsOutcomeIsKept() = runTest {
        val client = connected()
        client.answering {
            bread.answerRequest(
                it,
                json(
                    """{"response":{"type":"SEND_TRANSACTION_RESPONSE","transactionId":"tx-1"},"transaction":{"output":{"txHash":"0x5f"}}}""",
                ),
            )
        }

        client.request(json("""{"type":"SEND_TRANSACTION_REQUEST"}"""))

        assertEquals(TransactionOutcome.Output(json("""{"txHash":"0x5f"}""")), client.transactionOutcome("tx-1"))
        assertNull(client.transactionOutcome("tx-2"))
    }

    @Test
    fun aRequestWithoutASessionIsRefused() = runTest {
        val client = client()
        assertFails(BreadConnectException.Code.Bread(ProtocolErrorCode.NOT_GRANTED)) {
            client.request(json("""{"type":"SIGN_REQUEST"}"""))
        }
        assertTrue(opener.opened.isEmpty())
    }

    @Test
    fun whenBreadIsNotInstalledTheStorePageOpensAndTheRequestEnds() = runTest {
        val client = client()
        opener.installed = false

        assertFails(BreadConnectException.Code.NotInstalled) { client.connect("Where Legends Grow") }
        assertNull(storage.items[BreadConnect.PENDING_KEY])
    }

    @Test
    fun aNewRequestReplacesTheOneStillWaiting() = runTest {
        val client = connected()
        opener.onOpen = null
        val first = async { runCatching { client.request(json("""{"type":"SIGN_REQUEST"}""")) } }
        runCurrent()
        val second = async { runCatching { client.request(json("""{"type":"SIGN_REQUEST"}""")) } }
        runCurrent()

        assertEquals(BreadConnectException.Code.Superseded, (first.await().exceptionOrNull() as BreadConnectException).code)
        client.cancelPending()
        assertEquals(BreadConnectException.Code.Cancelled, (second.await().exceptionOrNull() as BreadConnectException).code)
    }

    @Test
    fun aLostSessionIsForgotten() = runTest {
        val client = connected()
        client.answering { link ->
            val (envelope) = bread.openRequest(link)
            bread.error(envelope.id, ProtocolErrorCode.SESSION_NOT_FOUND, "Bread has no such session")
        }

        assertFails(BreadConnectException.Code.Bread(ProtocolErrorCode.SESSION_NOT_FOUND)) {
            client.request(json("""{"type":"SIGN_REQUEST"}"""))
        }
        assertNull(client.session)
    }

    @Test
    fun anAnswerToAnotherRequestIsIgnored() = runTest {
        val client = connected()
        client.answering { bread.error(Base64Url.encode(counting(9, 16)), ProtocolErrorCode.NOT_FOUND, "No") }
        val request = async { runCatching { client.request(json("""{"type":"SIGN_REQUEST"}""")) } }
        runCurrent()
        assertTrue(request.isActive)

        client.cancelPending()

        assertEquals(BreadConnectException.Code.Cancelled, (request.await().exceptionOrNull() as BreadConnectException).code)
        assertNotNull(client.session)
    }

    @Test
    fun breadNotAnsweringInTenMinutesEndsTheRequest() = runTest {
        val client = client()
        val connecting = async { runCatching { client.connect("Where Legends Grow") } }
        runCurrent()
        assertNotNull(storage.items[BreadConnect.PENDING_KEY])

        advanceTimeBy(BreadConnect.REQUEST_MAX_AGE_MS + 1)

        assertEquals(BreadConnectException.Code.Timeout, (connecting.await().exceptionOrNull() as BreadConnectException).code)
        assertNull(storage.items[BreadConnect.PENDING_KEY])
    }

    @Test
    fun anOpenerThatNeverReturnsStillEndsTheRequestInTenMinutes() = runTest {
        val client = BreadConnect(
            callback,
            storage,
            object : BreadOpener {
                override suspend fun open(link: String): Boolean = awaitCancellation()
            },
        ) { now }
        val connecting = async { runCatching { client.connect("Where Legends Grow") } }
        runCurrent()

        advanceTimeBy(BreadConnect.REQUEST_MAX_AGE_MS + 1)

        assertEquals(BreadConnectException.Code.Timeout, (connecting.await().exceptionOrNull() as BreadConnectException).code)
        assertNull(storage.items[BreadConnect.PENDING_KEY])
    }

    @Test
    fun cancellingTheCallerEndsTheRequest() = runTest {
        val client = client()
        val connecting = launch { client.connect("Where Legends Grow") }
        runCurrent()
        assertNotNull(storage.items[BreadConnect.PENDING_KEY])

        connecting.cancel()
        runCurrent()

        assertNull(storage.items[BreadConnect.PENDING_KEY])
    }

    @Test
    fun anAnswerThatRelaunchesTheAppStillCompletesTheConnection() = runTest {
        val first = client()
        val connecting = async { runCatching { first.connect("Where Legends Grow") } }
        runCurrent()
        val answer = bread.answerConnect(opener.opened[0], json("""{"response":$permission}"""))

        val relaunched = client()
        assertTrue(relaunched.handle(answer))

        assertEquals(permission, relaunched.session?.permission)
        assertNull(storage.items[BreadConnect.PENDING_KEY])
        first.cancelPending()
        assertEquals(BreadConnectException.Code.Cancelled, (connecting.await().exceptionOrNull() as BreadConnectException).code)
    }

    @Test
    fun aStoredRequestOlderThanBreadAcceptsIsDropped() = runTest {
        val first = client()
        val connecting = async { runCatching { first.connect("Where Legends Grow") } }
        runCurrent()
        val late = bread.answerConnect(opener.opened[0], json("""{"response":$permission}"""))

        now += BreadConnect.REQUEST_MAX_AGE_MS + 1
        val relaunched = client()
        assertTrue(relaunched.handle(late))

        assertNull(relaunched.session)
        first.cancelPending()
        assertEquals(BreadConnectException.Code.Cancelled, (connecting.await().exceptionOrNull() as BreadConnectException).code)
    }

    @Test
    fun onlyLinksUnderTheCallbackAreBreads() {
        val client = client()
        assertFalse(client.handle("https://wherelegendsgrow.com/other#v=1&m=e30"))
        assertFalse(client.handle("https://wherelegendsgrow.com/bread"))
        assertTrue(client.handle("https://wherelegendsgrow.com/bread#v=1&m=e30"))
        assertTrue(client.handle("https://wherelegendsgrow.com/bread#garbage"))
    }

    @Test
    fun theClientRefusesACallbackThatBreaksTheRules() {
        assertThrows(IllegalArgumentException::class.java) {
            BreadConnect("https://wherelegendsgrow.com/bread?from=game", storage, opener)
        }
    }
}
