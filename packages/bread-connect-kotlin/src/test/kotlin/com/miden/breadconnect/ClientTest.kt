package com.miden.breadconnect

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
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

    private fun BreadConnect.answerLoginBytes(encoded: String) {
        answering { link ->
            val request = bread.openRequest(link).second
            val key = request["type"].string == "LOGIN_KEY_REQUEST"
            val response = buildJsonObject {
                put("type", if (key) "LOGIN_KEY_RESPONSE" else "LOGIN_SIGN_RESPONSE")
                put(if (key) "loginKey" else "signature", encoded)
            }
            bread.answerRequest(link, buildJsonObject { put("response", response) })
        }
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
    fun aSessionOpenedForAnotherCallbackIsNotRestored() = runTest {
        connected()

        val moved = BreadConnect("https://wherelegendsgrow.com/bread2", storage, opener) { now }

        assertNull(moved.session)
        assertFails(BreadConnectException.Code.Bread(ProtocolErrorCode.NOT_GRANTED)) {
            moved.request(json("""{"type":"SIGN_REQUEST"}"""))
        }
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
    fun requestLoginKeyAndSignLoginBytesUseTheSessionAccount() = runTest {
        val client = connected()
        var seen: JsonObject? = null
        client.answering { link ->
            val opened = bread.openRequest(link)
            seen = opened.second
            val type = if (opened.second["type"].string == "LOGIN_KEY_REQUEST") "LOGIN_KEY_RESPONSE" else "LOGIN_SIGN_RESPONSE"
            val field = if (type == "LOGIN_KEY_RESPONSE") "loginKey" else "signature"
            bread.answerRequest(link, json("""{"response":{"type":"$type","$field":"++//AA=="}}"""))
        }

        assertArrayEquals(byteArrayOf(-5, -17, -1, 0), client.requestLoginKey())
        assertEquals(
            json("""{"type":"LOGIN_KEY_REQUEST","sourceAccountId":"mtst1qy35q7ar3h0cgyqqqx2gs3nzxrgu7hz5xz3"}"""),
            seen,
        )

        assertArrayEquals(byteArrayOf(-5, -17, -1, 0), client.signLoginBytes(byteArrayOf(-5, -17, -1, 0)))
        assertEquals(
            json("""{"type":"LOGIN_SIGN_REQUEST","sourceAccountId":"mtst1qy35q7ar3h0cgyqqqx2gs3nzxrgu7hz5xz3","payload":"++//AA==","kind":"word"}"""),
            seen,
        )
    }

    @Test
    fun loginHelpersMapMalformedBase64ToInternalError() = runTest {
        val client = connected()
        client.answering { link ->
            val request = bread.openRequest(link).second
            val key = request["type"].string == "LOGIN_KEY_REQUEST"
            val type = if (key) "LOGIN_KEY_RESPONSE" else "LOGIN_SIGN_RESPONSE"
            val field = if (key) "loginKey" else "signature"
            bread.answerRequest(link, json("""{"response":{"type":"$type","$field":"%%%"}}"""))
        }

        assertFails(BreadConnectException.Code.Bread(ProtocolErrorCode.INTERNAL_ERROR)) { client.requestLoginKey() }
        assertFails(BreadConnectException.Code.Bread(ProtocolErrorCode.INTERNAL_ERROR)) {
            client.signLoginBytes(byteArrayOf(0))
        }
    }

    @Test
    fun loginHelpersAcceptBasicBase64PaddingAndEmptyData() = runTest {
        val client = connected()
        val answers = listOf(
            "" to byteArrayOf(),
            "AQ==" to byteArrayOf(1),
            "AQ" to byteArrayOf(1),
            "AQI=" to byteArrayOf(1, 2),
            "AQI" to byteArrayOf(1, 2),
            "AQID" to byteArrayOf(1, 2, 3),
            "++//AA" to byteArrayOf(-5, -17, -1, 0),
            "AB==" to byteArrayOf(0),
        )
        for ((encoded, bytes) in answers) {
            client.answerLoginBytes(encoded)
            assertArrayEquals("login key for $encoded", bytes, client.requestLoginKey())
            assertArrayEquals("login signature for $encoded", bytes, client.signLoginBytes(byteArrayOf(0)))
        }
    }

    @Test
    fun loginHelpersRejectWhitespaceInBase64Replies() = runTest {
        val client = connected()
        for (encoded in listOf(" ", "\t\r\n", " AQ==", "AQ== ", "A Q==", "A\tQ==", "AQ==\r\n")) {
            client.answerLoginBytes(encoded)
            assertFails(BreadConnectException.Code.Bread(ProtocolErrorCode.INTERNAL_ERROR)) { client.requestLoginKey() }
            assertFails(BreadConnectException.Code.Bread(ProtocolErrorCode.INTERNAL_ERROR)) {
                client.signLoginBytes(byteArrayOf(0))
            }
        }
    }

    @Test
    fun loginHelpersRejectMalformedBase64Padding() = runTest {
        val client = connected()
        for (encoded in listOf("A", "AQ=", "AQ===", "A===", "=AQ=", "AQ==AA==", "AQI==")) {
            client.answerLoginBytes(encoded)
            assertFails(BreadConnectException.Code.Bread(ProtocolErrorCode.INTERNAL_ERROR)) { client.requestLoginKey() }
            assertFails(BreadConnectException.Code.Bread(ProtocolErrorCode.INTERNAL_ERROR)) {
                client.signLoginBytes(byteArrayOf(0))
            }
        }
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
    fun aRequestWhoseOpenerHasNotReturnedStillEndsOnACancelOrANewerRequest() = runTest {
        val opening = object : ManagedBreadOpener {
            override suspend fun open(link: String, attempt: OpenAttempt): Boolean = awaitCancellation()
        }
        val client = BreadConnect(callback, storage, opening) { now }

        val cancelled = async { runCatching { client.connect("Where Legends Grow") } }
        runCurrent()
        client.cancelPending()
        assertEquals(BreadConnectException.Code.Cancelled, (cancelled.await().exceptionOrNull() as BreadConnectException).code)

        val first = async { runCatching { client.connect("Where Legends Grow") } }
        runCurrent()
        val second = async { runCatching { client.connect("Where Legends Grow") } }
        runCurrent()
        assertEquals(BreadConnectException.Code.Superseded, (first.await().exceptionOrNull() as BreadConnectException).code)
        client.cancelPending()
        assertEquals(BreadConnectException.Code.Cancelled, (second.await().exceptionOrNull() as BreadConnectException).code)
        assertEquals(0L, currentTime)
    }

    @Test
    fun twoRequestsInOneTurnOpenBreadOnlyForTheNewer() = runTest {
        val client = client()

        val first = async { runCatching { client.connect("Where Legends Grow") } }
        val second = async { runCatching { client.connect("Where Legends Grow") } }
        runCurrent()

        assertEquals(BreadConnectException.Code.Superseded, (first.await().exceptionOrNull() as BreadConnectException).code)
        assertEquals(1, opener.opened.size)
        client.cancelPending()
        assertEquals(BreadConnectException.Code.Cancelled, (second.await().exceptionOrNull() as BreadConnectException).code)
    }

    @Test
    fun aRequestCancelledBeforeItsOpenerRunsNeverOpensBread() = runTest {
        val client = client()

        val cancelled = async { runCatching { client.connect("Where Legends Grow") } }
        launch { client.cancelPending() }
        runCurrent()

        assertEquals(BreadConnectException.Code.Cancelled, (cancelled.await().exceptionOrNull() as BreadConnectException).code)
        assertEquals(0, opener.opened.size)
    }

    @Test
    fun aCancelFromAnotherThreadBetweenTheCheckAndTheOpenNeverOpensBread() = runBlocking {
        val opened = AtomicBoolean(false)
        lateinit var client: BreadConnect
        val opener = object : ManagedBreadOpener {
            override suspend fun open(link: String, attempt: OpenAttempt): Boolean {
                val cancelling = Thread { client.cancelPending() }
                cancelling.start()
                cancelling.join()
                return attempt.run { opened.set(true); true } ?: true
            }
        }
        client = BreadConnect(callback, MemoryStorage(), opener) { now }

        val error = withTimeout(5_000) { runCatching { client.connect("Where Legends Grow") } }.exceptionOrNull()
        assertEquals(BreadConnectException.Code.Cancelled, (error as? BreadConnectException)?.code)
        assertFalse(opened.get())
    }

    @Test
    fun anOpenerAlreadyInProgressNeverOpensAfterAnotherThreadCancels() = runBlocking {
        val inside = CountDownLatch(1)
        val release = CountDownLatch(1)
        val opened = AtomicBoolean(false)
        val opener = object : ManagedBreadOpener {
            override suspend fun open(link: String, attempt: OpenAttempt): Boolean {
                inside.countDown()
                release.await()
                if (!isActive) return true
                return attempt.run { opened.set(true); true } ?: true
            }
        }
        val client = BreadConnect(callback, MemoryStorage(), opener) { now }
        // One thread, so the waiting call cannot cancel the opener until the opener leaves this function.
        val serial = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val connect = async(serial) { runCatching { client.connect("Where Legends Grow") } }
        try {
            assertTrue(inside.await(5, TimeUnit.SECONDS))

            client.cancelPending()
            release.countDown()

            val error = withTimeout(5_000) { connect.await() }.exceptionOrNull()
            assertEquals(BreadConnectException.Code.Cancelled, (error as? BreadConnectException)?.code)
            assertFalse(opened.get())
        } finally {
            connect.cancel()
            release.countDown()
            serial.close()
        }
    }

    @Test
    fun callerJobCancellationRevokesAnOpenerWaitingOutsideAttempt() = runBlocking {
        val opening = HeldAttemptOpener()
        val client = BreadConnect(callback, storage, opening) { now }
        val serial = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val outcome = CompletableDeferred<Result<JsonObject>>()
        val connecting = launch(serial) {
            outcome.complete(runCatching { client.connect("Where Legends Grow") })
        }
        try {
            val call = withTimeout(5_000) { opening.firstEntered.await() }
            assertNotNull(storage.items[BreadConnect.PENDING_KEY])

            connecting.cancel()
            assertFalse(connecting.isCompleted)
            call.release()
            withTimeout(5_000) { call.passedAttempt.await() }
            val result = withTimeout(5_000) { outcome.await() }
            withTimeout(5_000) { connecting.join() }

            assertTrue(result.exceptionOrNull() is CancellationException)
            assertTrue(connecting.isCancelled)
            assertNull(storage.items[BreadConnect.PENDING_KEY])
            assertEquals(0, call.launches.get())
        } finally {
            opening.releaseAll()
            connecting.cancel()
            try {
                withContext(NonCancellable) { withTimeout(5_000) { connecting.join() } }
            } finally {
                serial.close()
            }
        }
    }

    @Test
    fun sdkDeadlineRevokesAnOpenerWaitingOutsideAttempt() = runTest {
        val opening = HeldAttemptOpener()
        val client = BreadConnect(callback, storage, opening) { now }
        val connecting = async { runCatching { client.connect("Where Legends Grow") } }
        try {
            runCurrent()
            assertEquals(1, opening.calls.size)
            val call = opening.calls.single()
            assertTrue(opening.firstEntered.isCompleted)

            advanceTimeBy(BreadConnect.ANSWER_WAIT_MS + 1)
            runCurrent()
            assertFalse(connecting.isCompleted)
            assertNotNull(storage.items[BreadConnect.PENDING_KEY])
            call.release()
            runCurrent()
            assertTrue(call.passedAttempt.isCompleted)
            val error = connecting.await().exceptionOrNull()

            assertEquals(BreadConnectException.Code.Timeout, (error as? BreadConnectException)?.code)
            assertNull(storage.items[BreadConnect.PENDING_KEY])
            assertEquals(0, call.launches.get())
        } finally {
            opening.releaseAll()
            connecting.cancel()
            runCurrent()
            connecting.join()
        }
    }

    @Test
    fun normalAnswerDisposesTheCancellationWatcher() = runTest {
        val opening = HeldAttemptOpener()
        val client = BreadConnect(callback, storage, opening) { now }
        val connecting = async { client.connect("Where Legends Grow") }
        try {
            runCurrent()
            assertEquals(1, opening.calls.size)
            val call = opening.calls.single()
            call.release()
            runCurrent()
            assertTrue(call.passedAttempt.isCompleted)
            assertEquals(1, call.launches.get())

            assertTrue(client.handle(bread.answerConnect(call.link, json("""{"response":$permission}"""))))
            runCurrent()

            assertTrue("A normal answer must join all request children", connecting.isCompleted)
            assertEquals(permission, connecting.await())
            assertNull(storage.items[BreadConnect.PENDING_KEY])
            assertEquals(0L, currentTime)
        } finally {
            opening.releaseAll()
            connecting.cancel()
            runCurrent()
            connecting.join()
        }
    }

    @Test
    fun supersessionRevokesOnlyTheOlderAttempt() = runTest {
        val opening = HeldAttemptOpener()
        val client = BreadConnect(callback, storage, opening) { now }
        val first = async { runCatching { client.connect("Where Legends Grow") } }
        val second = async(start = CoroutineStart.LAZY) { runCatching { client.connect("New request") } }
        try {
            runCurrent()
            assertEquals(1, opening.calls.size)
            val oldCall = opening.calls[0]
            second.start()
            runCurrent()
            assertEquals(2, opening.calls.size)
            val newCall = opening.calls[1]
            assertFalse(first.isCompleted)

            oldCall.release()
            runCurrent()
            assertTrue(oldCall.passedAttempt.isCompleted)
            assertEquals(BreadConnectException.Code.Superseded, (first.await().exceptionOrNull() as? BreadConnectException)?.code)
            assertEquals(0, oldCall.launches.get())
            assertNotNull(storage.items[BreadConnect.PENDING_KEY])
            newCall.release()
            runCurrent()
            assertTrue(newCall.passedAttempt.isCompleted)
            assertEquals(1, newCall.launches.get())
            assertTrue(client.handle(bread.answerConnect(newCall.link, json("""{"response":$permission}"""))))
            runCurrent()

            assertTrue(second.isCompleted)
            assertEquals(permission, second.await().getOrThrow())
            assertNull(storage.items[BreadConnect.PENDING_KEY])
            assertEquals(0L, currentTime)
        } finally {
            opening.releaseAll()
            first.cancel()
            second.cancel()
            runCurrent()
            first.join()
            second.join()
        }
    }

    @Test
    fun nativeAttemptAndCancellationHaveOrderedHandoffs() = runBlocking {
        val inside = CountDownLatch(1)
        val release = CountDownLatch(1)
        val passedAttempt = CountDownLatch(1)
        val cancelling = CountDownLatch(1)
        val cancelReturned = CountDownLatch(1)
        val admittedLaunches = AtomicInteger()
        val laterLaunches = AtomicInteger()
        val opening = object : ManagedBreadOpener {
            override suspend fun open(link: String, attempt: OpenAttempt): Boolean {
                attempt.run {
                    inside.countDown()
                    release.await()
                    admittedLaunches.incrementAndGet()
                }
                attempt.run { laterLaunches.incrementAndGet() }
                passedAttempt.countDown()
                return true
            }
        }
        val client = BreadConnect(callback, storage, opening) { now }
        val serial = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val outcome = CompletableDeferred<Result<JsonObject>>()
        val connecting = launch(serial) {
            outcome.complete(runCatching { client.connect("Where Legends Grow") })
        }
        val cancellation = Thread {
            cancelling.countDown()
            try {
                connecting.cancel()
            } finally {
                cancelReturned.countDown()
            }
        }
        try {
            assertTrue(inside.await(5, TimeUnit.SECONDS))
            cancellation.start()
            assertTrue(cancelling.await(5, TimeUnit.SECONDS))
            withTimeout(5_000) {
                while (!connecting.isCancelled) delay(1)
            }
            val returnedDuringHandoff = cancelReturned.await(250, TimeUnit.MILLISECONDS)
            release.countDown()
            assertTrue(passedAttempt.await(5, TimeUnit.SECONDS))
            cancellation.join(5_000)
            assertFalse(cancellation.isAlive)
            val result = withTimeout(5_000) { outcome.await() }
            withTimeout(5_000) { connecting.join() }

            assertTrue(result.exceptionOrNull() is CancellationException)
            assertEquals(1, admittedLaunches.get())
            assertFalse("Cancellation returned before the admitted native handoff left", returnedDuringHandoff)
            assertEquals(0, laterLaunches.get())
            assertNull(storage.items[BreadConnect.PENDING_KEY])
        } finally {
            release.countDown()
            connecting.cancel()
            cancellation.join(5_000)
            try {
                withContext(NonCancellable) { withTimeout(5_000) { connecting.join() } }
            } finally {
                serial.close()
            }
        }
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
        client.answering { bread.error(Base64Url.encode(counting(9, 16)), ProtocolErrorCode.SESSION_NOT_FOUND, "No") }
        val request = async { runCatching { client.request(json("""{"type":"SIGN_REQUEST"}""")) } }
        runCurrent()
        assertTrue(request.isActive)

        client.cancelPending()

        assertEquals(BreadConnectException.Code.Cancelled, (request.await().exceptionOrNull() as BreadConnectException).code)
        assertNotNull(client.session)
    }

    @Test
    fun breadNotAnsweringInThirtyMinutesEndsTheRequest() = runTest {
        val client = client()
        val connecting = async { runCatching { client.connect("Where Legends Grow") } }
        runCurrent()
        assertNotNull(storage.items[BreadConnect.PENDING_KEY])

        advanceTimeBy(BreadConnect.ANSWER_WAIT_MS + 1)

        assertEquals(BreadConnectException.Code.Timeout, (connecting.await().exceptionOrNull() as BreadConnectException).code)
        assertNull(storage.items[BreadConnect.PENDING_KEY])
    }

    @Test
    fun breadAnsweringAfterTheTenMinutesItAcceptsTheRequestForStillCompletesIt() = runTest {
        val client = client()
        val connecting = async { client.connect("Where Legends Grow") }
        runCurrent()

        advanceTimeBy(10 * 60 * 1000L + 1)
        assertTrue(client.handle(bread.answerConnect(opener.opened[0], json("""{"response":$permission}"""))))

        assertEquals(permission, connecting.await())
    }

    @Test
    fun anOpenerThatNeverReturnsStillEndsTheRequestInThirtyMinutes() = runTest {
        val client = BreadConnect(
            callback,
            storage,
            object : ManagedBreadOpener {
                override suspend fun open(link: String, attempt: OpenAttempt): Boolean = awaitCancellation()
            },
        ) { now }
        val connecting = async { runCatching { client.connect("Where Legends Grow") } }
        runCurrent()

        advanceTimeBy(BreadConnect.ANSWER_WAIT_MS + 1)

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
    fun aCallersOwnTimeoutEndsTheRequestAsTheCallersCancellation() = runTest {
        val client = client()

        assertNull(withTimeoutOrNull(1_000) { client.connect("Where Legends Grow") })

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
    fun aRelaunchAfterTheTenMinutesBreadAcceptsTheRequestForStillCompletesTheConnection() = runTest {
        val first = client()
        val connecting = async { runCatching { first.connect("Where Legends Grow") } }
        runCurrent()
        val late = bread.answerConnect(opener.opened[0], json("""{"response":$permission}"""))

        now += 10 * 60 * 1000L + 1
        val relaunched = client()
        assertTrue(relaunched.handle(late))

        assertEquals(permission, relaunched.session?.permission)
        first.cancelPending()
        assertEquals(BreadConnectException.Code.Cancelled, (connecting.await().exceptionOrNull() as BreadConnectException).code)
    }

    @Test
    fun aStoredRequestOlderThanTheClientWaitsIsDropped() = runTest {
        val first = client()
        val connecting = async { runCatching { first.connect("Where Legends Grow") } }
        runCurrent()
        val late = bread.answerConnect(opener.opened[0], json("""{"response":$permission}"""))

        now += BreadConnect.ANSWER_WAIT_MS + 1
        val relaunched = client()
        assertTrue(relaunched.handle(late))

        assertNull(relaunched.session)
        first.cancelPending()
        assertEquals(BreadConnectException.Code.Cancelled, (connecting.await().exceptionOrNull() as BreadConnectException).code)
    }

    /** A store that throws for one key, as a full disk or an unavailable keystore does. */
    private class FailingStorage : BreadConnectStorage {
        val items = mutableMapOf<String, String>()
        var failingRead: String? = null
        var failingWrite: String? = null
        var failingRemoval: String? = null

        override fun read(key: String): String? {
            if (key == failingRead) throw IllegalStateException("storage unavailable")
            return items[key]
        }

        override fun write(key: String, value: String?) {
            if (key == (if (value == null) failingRemoval else failingWrite)) throw IllegalStateException("keystore unavailable")
            if (value == null) items.remove(key) else items[key] = value
        }
    }

    private suspend fun connectedWith(failing: FailingStorage): BreadConnect {
        val client = BreadConnect(callback, failing, opener) { now }
        client.answering { bread.answerConnect(it, json("""{"response":$permission}""")) }
        client.connect("Where Legends Grow")
        opener.onOpen = null
        return client
    }

    @Test
    fun aSessionThatCannotBeKeptEndsTheConnectAtOnce() = runTest {
        val failing = FailingStorage().apply { failingWrite = BreadConnect.SESSION_KEY }
        val client = BreadConnect(callback, failing, opener) { now }
        val connecting = async { runCatching { client.connect("Where Legends Grow") } }
        runCurrent()

        assertTrue(client.handle(bread.answerConnect(opener.opened[0], json("""{"response":$permission}"""))))

        val error = connecting.await().exceptionOrNull() as BreadConnectException
        assertEquals(BreadConnectException.Code.Bread(ProtocolErrorCode.INTERNAL_ERROR), error.code)
        assertNull(client.session)
    }

    @Test
    fun aLinkThatCannotBeAuthenticatedWhileTheSessionCannotBeReadIsDropped() = runTest {
        val failing = FailingStorage()
        val client = connectedWith(failing)
        val signing = async { runCatching { client.request(json("""{"type":"SIGN_REQUEST"}""")) } }
        runCurrent()
        val (request) = bread.openRequest(opener.opened[1])
        val forged = BreadConnectLinks.writeLink(
            callback,
            Envelope.Response(request.id, bread.session, Base64Url.encode(ByteArray(12)), Base64Url.encode(ByteArray(16))),
        )
        failing.failingRead = BreadConnect.SESSION_KEY

        assertTrue(client.handle(forged))
        runCurrent()
        assertTrue(signing.isActive)

        failing.failingRead = null
        val answer = bread.answerRequest(opener.opened[1], json("""{"response":{"type":"SIGN_RESPONSE","signature":"c2ln"}}"""))
        assertTrue(client.handle(answer))
        assertEquals("SIGN_RESPONSE", signing.await().getOrThrow()["type"].string)
    }

    @Test
    fun anOutcomeThatCannotBeKeptStillAnswersTheRequest() = runTest {
        val failing = FailingStorage().apply { failingWrite = BreadConnect.OUTCOMES_KEY }
        val client = connectedWith(failing)
        val sending = async { client.request(json("""{"type":"SEND_TRANSACTION_REQUEST"}""")) }
        runCurrent()

        val answer = bread.answerRequest(
            opener.opened[1],
            json("""{"response":{"type":"SEND_TRANSACTION_RESPONSE","transactionId":"tx-1"},"transaction":{"output":{"txHash":"0xabc"}}}"""),
        )
        assertTrue(client.handle(answer))

        assertEquals("tx-1", sending.await()["transactionId"].string)
        assertNull(client.transactionOutcome("tx-1"))
    }

    @Test
    fun aPendingRecordThatCannotBeClearedStillSettlesTheAnswer() = runTest {
        val failing = FailingStorage()
        val client = connectedWith(failing)
        val signing = async { client.request(json("""{"type":"SIGN_REQUEST"}""")) }
        runCurrent()
        failing.failingRemoval = BreadConnect.PENDING_KEY

        val answer = bread.answerRequest(opener.opened[1], json("""{"response":{"type":"SIGN_RESPONSE","signature":"c2ln"}}"""))
        assertTrue(client.handle(answer))

        assertEquals("SIGN_RESPONSE", signing.await()["type"].string)
    }

    @Test
    fun aCancelledConnectWhosePendingRecordCannotBeRemovedTakesNoLateAnswer() = runTest {
        val failing = FailingStorage().apply { failingRemoval = BreadConnect.PENDING_KEY }
        val client = BreadConnect(callback, failing, opener) { now }
        val connecting = async { runCatching { client.connect("Where Legends Grow") } }
        runCurrent()
        client.cancelPending()
        assertEquals(BreadConnectException.Code.Cancelled, (connecting.await().exceptionOrNull() as BreadConnectException).code)
        assertNotNull(failing.items[BreadConnect.PENDING_KEY])

        assertTrue(client.handle(bread.answerConnect(opener.opened[0], json("""{"response":$permission}"""))))

        assertNull(client.session)
    }

    @Test
    fun aSessionThatCannotBeForgottenStillSettlesBreadsSessionNotFound() = runTest {
        val failing = FailingStorage()
        val client = connectedWith(failing)
        val signing = async { runCatching { client.request(json("""{"type":"SIGN_REQUEST"}""")) } }
        runCurrent()
        failing.failingRemoval = BreadConnect.SESSION_KEY
        val (request) = bread.openRequest(opener.opened[1])

        assertTrue(client.handle(bread.error(request.id, ProtocolErrorCode.SESSION_NOT_FOUND, "gone")))

        val error = signing.await().exceptionOrNull() as BreadConnectException
        assertEquals(BreadConnectException.Code.Bread(ProtocolErrorCode.SESSION_NOT_FOUND), error.code)
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
