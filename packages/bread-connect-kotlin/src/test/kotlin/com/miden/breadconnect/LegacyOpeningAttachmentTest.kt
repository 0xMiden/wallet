package com.miden.breadconnect

import kotlinx.coroutines.CopyableThreadContextElement
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.Closeable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class, DelicateCoroutinesApi::class)
class LegacyOpeningAttachmentTest {
    private val callback = "https://wherelegendsgrow.com/bread"
    private val permission = json(
        """{
            "type":"PERMISSION_RESPONSE",
            "accountId":"mtst1qy35q7ar3h0cgyqqqx2gs3nzxrgu7hz5xz3",
            "network":"testnet"
        }""",
    )

    @Test
    fun cancellationBeforeAttachmentDoesNotInvokeALegacyOpener() = runBlocking {
        ImmediateThreadDispatcher().use { dispatcher ->
            val pause = ChildCopyPause()
            val storage = MemoryStorage()
            val calls = AtomicInteger()
            val opener = object : BreadOpener {
                override suspend fun open(link: String): Boolean {
                    calls.incrementAndGet()
                    return true
                }
            }
            val client = BreadConnect(callback, storage, opener)
            val owner = async(dispatcher + CopyProbe(pause)) {
                pause.arm()
                runCatching { client.connect("Cancelled legacy request") }
            }
            try {
                assertTrue("Opening context copy was not reached", pause.entered.await(WAIT_MS, TimeUnit.MILLISECONDS))
                assertEquals(2, pause.copies.get())
                assertNotNull(storage.read(BreadConnect.PENDING_KEY))
                assertEquals(0, calls.get())

                client.cancelPending()
                assertNull(storage.read(BreadConnect.PENDING_KEY))
                pause.release()
                val error = withTimeout(RESULT_WAIT_MS) { owner.await() }.exceptionOrNull()

                assertFalse("Opening context copy timed out", pause.timedOut.get())
                assertTrue(error is BreadConnectException)
                assertEquals(
                    BreadConnectException.Code.Cancelled,
                    if (error is BreadConnectException) error.code else null,
                )
                assertNull(storage.read(BreadConnect.PENDING_KEY))
                assertEquals(0, calls.get())
            } finally {
                finishRequests(client, pause, listOf(owner))
            }
        }
    }

    @Test
    fun supersessionBeforeAttachmentDoesNotInvokeTheObsoleteLegacyOpener() = runBlocking {
        ImmediateThreadDispatcher().use { dispatcher ->
            val pause = ChildCopyPause()
            val storage = MemoryStorage()
            val obsoleteCalls = AtomicInteger()
            val freshCalls = AtomicInteger()
            val bread = FakeBread()
            lateinit var client: BreadConnect
            val opener = object : BreadOpener {
                override suspend fun open(link: String): Boolean {
                    when (applicationName(link)) {
                        "Obsolete legacy request" -> obsoleteCalls.incrementAndGet()
                        "Fresh legacy request" -> {
                            freshCalls.incrementAndGet()
                            client.handle(bread.answerConnect(link, json("""{"response":$permission}""")))
                        }
                        else -> error("Unexpected legacy request")
                    }
                    return true
                }
            }
            client = BreadConnect(callback, storage, opener)
            val owner = async(dispatcher + CopyProbe(pause)) {
                pause.arm()
                runCatching { client.connect("Obsolete legacy request") }
            }
            var replacement: Deferred<Result<JsonObject>>? = null
            try {
                assertTrue("Opening context copy was not reached", pause.entered.await(WAIT_MS, TimeUnit.MILLISECONDS))
                assertEquals(2, pause.copies.get())
                val obsoletePending = storage.read(BreadConnect.PENDING_KEY)
                assertNotNull(obsoletePending)
                assertEquals(0, obsoleteCalls.get())

                val fresh = async(start = CoroutineStart.UNDISPATCHED) {
                    runCatching { client.connect("Fresh legacy request") }
                }
                replacement = fresh
                val freshPending = storage.read(BreadConnect.PENDING_KEY)
                assertNotNull(freshPending)
                assertNotEquals(obsoletePending, freshPending)
                assertEquals(0, freshCalls.get())
                pause.release()
                val error = withTimeout(RESULT_WAIT_MS) { owner.await() }.exceptionOrNull()
                val response = withTimeout(RESULT_WAIT_MS) { fresh.await() }.getOrThrow()

                assertFalse("Opening context copy timed out", pause.timedOut.get())
                assertTrue(error is BreadConnectException)
                assertEquals(
                    BreadConnectException.Code.Superseded,
                    if (error is BreadConnectException) error.code else null,
                )
                assertEquals(permission, response)
                assertEquals(1, freshCalls.get())
                assertNotNull(client.session)
                assertEquals(permission, client.session?.permission)
                assertNull(storage.read(BreadConnect.PENDING_KEY))
                assertEquals(0, obsoleteCalls.get())
            } finally {
                finishRequests(client, pause, listOfNotNull(owner, replacement))
            }
        }
    }

    @Test
    fun aLiveLegacyOpenerStillCompletesAfterTheSameAttachmentPause() = runBlocking {
        ImmediateThreadDispatcher().use { dispatcher ->
            val pause = ChildCopyPause()
            val storage = MemoryStorage()
            val calls = AtomicInteger()
            val handled = AtomicBoolean()
            val bread = FakeBread()
            lateinit var client: BreadConnect
            val opener = object : BreadOpener {
                override suspend fun open(link: String): Boolean {
                    calls.incrementAndGet()
                    handled.set(client.handle(bread.answerConnect(link, json("""{"response":$permission}"""))))
                    return true
                }
            }
            client = BreadConnect(callback, storage, opener)
            val owner = async(dispatcher + CopyProbe(pause)) {
                pause.arm()
                runCatching { client.connect("Live legacy request") }
            }
            try {
                assertTrue("Opening context copy was not reached", pause.entered.await(WAIT_MS, TimeUnit.MILLISECONDS))
                assertEquals(2, pause.copies.get())
                assertNotNull(storage.read(BreadConnect.PENDING_KEY))
                assertEquals(0, calls.get())
                pause.release()
                val response = withTimeout(RESULT_WAIT_MS) { owner.await() }.getOrThrow()

                assertFalse("Opening context copy timed out", pause.timedOut.get())
                assertEquals(permission, response)
                assertTrue(handled.get())
                assertEquals(1, calls.get())
                assertNull(storage.read(BreadConnect.PENDING_KEY))
                assertEquals(permission, client.session?.permission)
            } finally {
                finishRequests(client, pause, listOf(owner))
            }
        }
    }

    @Test
    fun aLegacyCallbackDoesNotHoldTheClientLockDuringCrossThreadCancellation() = runBlocking {
        ImmediateThreadDispatcher().use { dispatcher ->
            val pause = ChildCopyPause()
            val storage = MemoryStorage()
            val calls = AtomicInteger()
            val cancelled = CountDownLatch(1)
            val cancelledInsideCallback = AtomicBoolean()
            val cancellingThread = AtomicReference<Thread?>()
            lateinit var client: BreadConnect
            val opener = object : BreadOpener {
                override suspend fun open(link: String): Boolean {
                    calls.incrementAndGet()
                    val thread = Thread {
                        client.cancelPending()
                        cancelled.countDown()
                    }
                    cancellingThread.set(thread)
                    thread.start()
                    cancelledInsideCallback.set(cancelled.await(WAIT_MS, TimeUnit.MILLISECONDS))
                    return true
                }
            }
            client = BreadConnect(callback, storage, opener)
            val owner = async(dispatcher + CopyProbe(pause)) {
                pause.arm()
                runCatching { client.connect("Cross-thread legacy request") }
            }
            try {
                assertTrue("Opening context copy was not reached", pause.entered.await(WAIT_MS, TimeUnit.MILLISECONDS))
                assertEquals(2, pause.copies.get())
                assertNotNull(storage.read(BreadConnect.PENDING_KEY))
                assertEquals(0, calls.get())
                pause.release()
                val error = withTimeout(RESULT_WAIT_MS) { owner.await() }.exceptionOrNull()

                assertFalse("Opening context copy timed out", pause.timedOut.get())
                assertTrue(error is BreadConnectException)
                assertEquals(
                    BreadConnectException.Code.Cancelled,
                    if (error is BreadConnectException) error.code else null,
                )
                assertNull(storage.read(BreadConnect.PENDING_KEY))
                assertEquals(1, calls.get())
                assertTrue("Cancellation did not finish inside the legacy callback", cancelledInsideCallback.get())
            } finally {
                try {
                    finishRequests(client, pause, listOf(owner))
                } finally {
                    cancellingThread.get()?.let { thread ->
                        thread.join(WAIT_MS)
                        check(!thread.isAlive) { "Legacy cancellation thread did not stop" }
                    }
                }
            }
        }
    }

    private fun applicationName(link: String): String? {
        val read = BreadConnectLinks.readLink(link, BreadConnectLinks.REQUEST_URL)
        if (read !is ReadLink.Message) return null
        val envelope = read.envelope
        if (envelope !is Envelope.Connect) return null
        return envelope.request["appMeta"].obj?.get("name").string
    }

    private suspend fun finishRequests(client: BreadConnect, pause: ChildCopyPause, requests: List<Job>) {
        pause.release()
        client.cancelPending()
        withContext(NonCancellable) {
            withTimeout(RESULT_WAIT_MS) {
                requests.forEach { it.cancelAndJoin() }
            }
        }
    }

    private class ChildCopyPause {
        private val armed = AtomicBoolean()
        private val released = CountDownLatch(1)
        val copies = AtomicInteger()
        val entered = CountDownLatch(1)
        val timedOut = AtomicBoolean()

        fun arm() {
            armed.set(true)
        }

        fun copyForChild() {
            // The first armed child is the cancellation watcher; the second is the not-yet-attached opener.
            if (armed.get() && copies.incrementAndGet() == 2) {
                entered.countDown()
                if (!released.await(WAIT_MS, TimeUnit.MILLISECONDS)) timedOut.set(true)
            }
        }

        fun release() {
            released.countDown()
        }
    }

    private class CopyProbe(private val pause: ChildCopyPause) :
        AbstractCoroutineContextElement(Key), CopyableThreadContextElement<Unit> {
        companion object Key : CoroutineContext.Key<CopyProbe>

        override fun copyForChild(): CopyableThreadContextElement<Unit> {
            pause.copyForChild()
            return CopyProbe(pause)
        }

        override fun mergeForChild(overwritingElement: CoroutineContext.Element): CoroutineContext = overwritingElement

        override fun updateThreadContext(context: CoroutineContext) = Unit

        override fun restoreThreadContext(context: CoroutineContext, oldState: Unit) = Unit
    }

    private class ImmediateThreadDispatcher : CoroutineDispatcher(), Closeable {
        private val executor = Executors.newSingleThreadExecutor { task ->
            Thread(task, "bread-connect-attachment").apply { isDaemon = true }
        }
        @Volatile private var worker: Thread? = null

        override fun isDispatchNeeded(context: CoroutineContext): Boolean = Thread.currentThread() !== worker

        override fun dispatch(context: CoroutineContext, block: Runnable) {
            executor.execute {
                worker = Thread.currentThread()
                block.run()
            }
        }

        override fun close() {
            executor.shutdownNow()
            check(executor.awaitTermination(WAIT_MS, TimeUnit.MILLISECONDS)) {
                "Immediate test dispatcher did not stop"
            }
        }
    }

    private companion object {
        const val WAIT_MS = 5_000L
        const val RESULT_WAIT_MS = 15_000L
    }
}
