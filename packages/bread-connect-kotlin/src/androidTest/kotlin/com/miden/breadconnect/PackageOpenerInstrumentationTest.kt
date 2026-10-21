package com.miden.breadconnect

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.test.InstrumentationTestCase
import android.test.mock.MockPackageManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

@Suppress("DEPRECATION")
class PackageOpenerInstrumentationTest : InstrumentationTestCase() {
    fun testStoppedAttemptDoesNotReadCertificatesOrStartActivities() = runBlocking {
        val context = RecordingContext(instrumentation.targetContext)
        val opener = PackageOpener(context, listOf("00".repeat(32)))

        assertTrue(opener.open("https://example.com/request", OpenAttempt(Any()) { false }))

        assertEquals(0, context.certificateChecks)
        assertTrue(context.activities.isEmpty())
    }

    fun testCancelledWalletHandoffDoesNotAdmitMarket() = runBlocking {
        withTimeout(5_000) {
            val context = RecordingContext(instrumentation.targetContext)
            val storage = TestStorage()
            val client = BreadConnect("https://example.com/callback", storage, PackageOpener(context, listOf("00".repeat(32))))
            val owner = async(start = CoroutineStart.LAZY) { client.connect("Synthetic app") }
            context.onStart = {
                owner.cancel()
                throw ActivityNotFoundException()
            }

            owner.start()
            owner.join()

            assertTrue(owner.isCancelled)
            assertEquals(1, context.certificateChecks)
            assertNull(storage.read(BreadConnect.PENDING_KEY))
            assertEquals(listOf("com.miden.wallet"), context.destinations())
        }
    }

    fun testCancelledMarketHandoffDoesNotAdmitHttpsStore() = runBlocking {
        withTimeout(5_000) {
            val context = RecordingContext(instrumentation.targetContext)
            val storage = TestStorage()
            val client = BreadConnect("https://example.com/callback", storage, PackageOpener(context, listOf("00".repeat(32))))
            val owner = async(start = CoroutineStart.LAZY) { client.connect("Synthetic app") }
            context.onStart = { intent ->
                if (intent.data?.scheme == "market") owner.cancel()
                throw ActivityNotFoundException()
            }

            owner.start()
            owner.join()

            assertTrue(owner.isCancelled)
            assertEquals(1, context.certificateChecks)
            assertNull(storage.read(BreadConnect.PENDING_KEY))
            assertEquals(
                listOf("com.miden.wallet", "market://details?id=com.miden.wallet"),
                context.destinations(),
            )
        }
    }

    fun testFreshOwnedRequestCanOpenAfterAnEarlierCancellation() = runBlocking {
        withTimeout(5_000) {
            val context = RecordingContext(instrumentation.targetContext)
            val storage = TestStorage()
            val client = BreadConnect("https://example.com/callback", storage, PackageOpener(context, listOf("00".repeat(32))))
            val first = async(start = CoroutineStart.LAZY) { client.connect("First synthetic app") }
            context.onStart = {
                first.cancel()
                throw ActivityNotFoundException()
            }
            first.start()
            first.join()
            assertTrue(first.isCancelled)

            val launched = CompletableDeferred<Unit>()
            context.onStart = { launched.complete(Unit) }
            val next = async(start = CoroutineStart.LAZY) { client.connect("Next synthetic app") }
            try {
                next.start()
                launched.await()

                assertTrue(next.isActive)
                assertEquals(2, context.certificateChecks)
                assertEquals(listOf("com.miden.wallet", "com.miden.wallet"), context.destinations())
                assertNotNull(storage.read(BreadConnect.PENDING_KEY))
            } finally {
                next.cancelAndJoin()
            }
            assertNull(storage.read(BreadConnect.PENDING_KEY))
        }
    }

    fun testLiveGuardedDirectOpenerKeepsBothStoreFallbacks() = runBlocking {
        val context = RecordingContext(instrumentation.targetContext)
        context.onStart = { intent ->
            if (intent.`package` != null || intent.data?.scheme == "market") throw ActivityNotFoundException()
        }
        val opener = PackageOpener(context, listOf("00".repeat(32)))

        assertFalse(opener.open("https://example.com/request", OpenAttempt(Any()) { true }))

        assertEquals(1, context.certificateChecks)
        assertEquals(
            listOf(
                "com.miden.wallet",
                "market://details?id=com.miden.wallet",
                "https://play.google.com/store/apps/details?id=com.miden.wallet",
            ),
            context.destinations(),
        )
        for (intent in context.activities) {
            assertEquals("android.intent.action.VIEW", intent.action)
            assertTrue(intent.hasCategory("android.intent.category.BROWSABLE"))
            assertTrue(intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        }
    }

    private class TestStorage : BreadConnectStorage {
        private val values = mutableMapOf<String, String>()

        override fun read(key: String): String? = values[key]

        override fun write(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    private class RecordingContext(base: Context) : ContextWrapper(base) {
        val activities = mutableListOf<Intent>()
        var certificateChecks = 0
        var onStart: (Intent) -> Unit = {}
        private val manager = object : MockPackageManager() {
            override fun hasSigningCertificate(packageName: String, certificate: ByteArray, type: Int): Boolean {
                require(packageName == "com.miden.wallet")
                require(certificate.contentEquals(ByteArray(32)))
                require(type == PackageManager.CERT_INPUT_SHA256)
                certificateChecks++
                return true
            }
        }

        override fun getPackageManager(): PackageManager = manager

        override fun startActivity(intent: Intent) {
            activities += Intent(intent)
            onStart(intent)
        }

        fun destinations(): List<String?> = activities.map { it.`package` ?: it.dataString }
    }
}
