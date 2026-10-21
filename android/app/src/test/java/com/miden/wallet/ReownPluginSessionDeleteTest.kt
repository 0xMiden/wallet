package com.miden.wallet

import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import com.reown.appkit.client.AppKit
import com.reown.appkit.client.Modal
import com.reown.appkit.client.models.request.Request
import com.reown.appkit.client.models.request.SentRequestResult
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Answers
import org.mockito.Mockito
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ReownPluginSessionDeleteTest {
    private data class Rejection(val message: String?, val code: String?)

    private class RecordingCall(val stopAtRejection: (() -> Unit)? = null) :
        PluginCall(null, "Reown", "fixture", "request", JSObject()) {
        val rejections = CopyOnWriteArrayList<Rejection>()
        val resolutions = CopyOnWriteArrayList<JSObject>()

        override fun reject(message: String?, code: String?) {
            rejections.add(Rejection(message, code))
            stopAtRejection?.invoke()
        }

        override fun resolve(result: JSObject) {
            resolutions.add(result)
        }
    }

    private data class Publication(
        val request: Request,
        val success: (SentRequestResult) -> Unit,
        val error: (Throwable) -> Unit
    )

    private lateinit var plugin: ReownPlugin
    private lateinit var observations: ReownRequestObservations
    private val publications = CopyOnWriteArrayList<Publication>()
    private val engineField = AppKit::class.java.getDeclaredField("appKitEngine").apply { isAccessible = true }
    private val configuredField = ReownPlugin::class.java.getDeclaredField("configured").apply { isAccessible = true }
    private var originalEngine: Any? = null
    private var originallyConfigured = false

    @Before
    @Suppress("UNCHECKED_CAST")
    fun captureOnlyTheSdkPublisher() {
        originalEngine = engineField.get(null)
        originallyConfigured = configuredField.getBoolean(null)
        val engineType = Class.forName("com.reown.appkit.engine.AppKitEngine")
        val engine = Mockito.mock(engineType) { invocation ->
            if (invocation.method.name == "request") {
                require(invocation.arguments.size == 3)
                publications.add(
                    Publication(
                        invocation.arguments[0] as Request,
                        invocation.arguments[1] as (SentRequestResult) -> Unit,
                        invocation.arguments[2] as (Throwable) -> Unit
                    )
                )
            }
            Answers.RETURNS_DEFAULTS.answer(invocation)
        }
        engineField.set(null, engine)
        configuredField.setBoolean(null, true)
        plugin = ReownPlugin()
        observations = ReownPlugin::class.java.getDeclaredField("observations").apply {
            isAccessible = true
        }.get(plugin) as ReownRequestObservations
    }

    @After
    fun restoreSdkPublisher() {
        engineField.set(null, originalEngine)
        configuredField.setBoolean(null, originallyConfigured)
    }

    @Test
    fun deletionBeforePublicationSettlesRequest() {
        assertDeletionBeforePublication(resolvesHash = false)
    }

    @Test
    fun deletionBeforePublicationSettlesSendTransaction() {
        assertDeletionBeforePublication(resolvesHash = true)
    }

    @Test
    fun publicationDuringDeletionSettlesRequest() {
        assertPublicationDuringDeletion(resolvesHash = false)
    }

    @Test
    fun publicationDuringDeletionSettlesSendTransaction() {
        assertPublicationDuringDeletion(resolvesHash = true)
    }

    @Test
    fun deletionRejectsPublishedCallsAcrossTopics() {
        val request = RecordingCall()
        val transaction = RecordingCall()
        val first = begin(request, resolvesHash = false)
        val second = begin(transaction, resolvesHash = true)
        publish(first, id = 1L, topic = "topic-one")
        publish(second, id = 2L, topic = "topic-two")

        delete()
        assertDeletedOnce(request, published = "confirmed")
        assertDeletedOnce(transaction, published = "confirmed")
        assertEquals(0, pendingCount())
        assertEquals(0, observations.observingCount)
    }

    @Test
    fun completedCallIsNotRejectedByDeletion() {
        val call = RecordingCall()
        val publication = begin(call, resolvesHash = false)
        publish(publication, id = 1L)
        respond(id = 1L)
        delete()

        assertEquals(1, call.resolutions.size)
        assertEquals("fixture-result", call.resolutions.single().getString("result"))
        assertTrue(call.rejections.isEmpty())
        assertEquals(0, pendingCount())
        assertEquals(0, observations.observingCount)
    }

    @Test
    fun newInvocationAfterDeletionCanResolveItsHash() {
        delete()
        val call = RecordingCall()
        val publication = begin(call, resolvesHash = true)
        publish(publication, id = 1L)
        respond(id = 1L)

        assertEquals(1, call.resolutions.size)
        assertEquals("fixture-result", call.resolutions.single().getString("hash"))
        assertTrue(call.rejections.isEmpty())
        assertEquals(0, pendingCount())
        assertEquals(0, observations.observingCount)
    }

    @Test
    fun ordinaryExpiryStillSettlesOnce() {
        val call = RecordingCall()
        val publication = begin(call, resolvesHash = false)
        publish(publication, id = 1L)
        plugin.onRequestExpired(Modal.Model.ExpiredRequest("live-topic", 1L))
        plugin.onRequestExpired(Modal.Model.ExpiredRequest("live-topic", 1L))
        publish(publication, id = 1L)
        respond(id = 1L)

        assertEquals(1, call.rejections.size)
        assertEquals("Request expired", call.rejections.single().message)
        assertEquals("request_expired", failure(call).getString("nativeOrigin"))
        assertEquals("confirmed", failure(call).getString("published"))
        assertTrue(call.resolutions.isEmpty())
        assertEquals(0, pendingCount())
        assertEquals(0, observations.observingCount)
    }

    private fun assertDeletionBeforePublication(resolvesHash: Boolean) {
        val call = RecordingCall()
        val publication = begin(call, resolvesHash)
        assertEquals(1, observations.observingCount)
        assertEquals(0, pendingCount())
        delete()
        publish(publication, id = 1L)

        assertDeletedOnce(call, published = "unobserved")
        assertEquals(0, pendingCount())
        assertEquals(0, observations.observingCount)
        plugin.onRequestExpired(Modal.Model.ExpiredRequest("live-topic", 1L))
        respond(id = 1L)
        assertDeletedOnce(call, published = "unobserved")
    }

    private fun assertPublicationDuringDeletion(resolvesHash: Boolean) {
        val firstRejected = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val seed = RecordingCall {
            firstRejected.countDown()
            assertTrue("Release the first settlement", releaseFirst.await(5, TimeUnit.SECONDS))
        }
        val seedPublication = begin(seed, resolvesHash = false)
        // The second insertion lands in a bucket the default map traversal has already passed.
        publish(seedPublication, id = 15L, topic = "deleted-topic")
        val call = RecordingCall()
        val publication = begin(call, resolvesHash)
        assertEquals(2, publications.size)
        assertEquals(2, observations.observingCount)
        assertEquals(1, pendingCount())
        val executor = Executors.newSingleThreadExecutor()
        try {
            val deletion = executor.submit { delete() }
            try {
                assertTrue("Deletion must reach the first real call rejection", firstRejected.await(5, TimeUnit.SECONDS))
                publish(publication, id = 1L, topic = "still-live-topic")
            } finally {
                releaseFirst.countDown()
            }
            deletion.get(5, TimeUnit.SECONDS)
            assertDeletedOnce(seed, published = "confirmed")
            assertDeletedOnce(call, published = "unobserved")
            assertEquals(0, pendingCount())
            assertEquals(0, observations.observingCount)
            plugin.onRequestExpired(Modal.Model.ExpiredRequest("still-live-topic", 1L))
            respond(id = 1L, topic = "still-live-topic")
            assertDeletedOnce(call, published = "unobserved")
        } finally {
            releaseFirst.countDown()
            executor.shutdownNow()
            assertTrue("Deletion worker must terminate", executor.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

    private fun begin(call: RecordingCall, resolvesHash: Boolean): Publication {
        val before = publications.size
        val context = observations.create()
        val publisher = ReownPlugin::class.java.getDeclaredMethod(
            "publishRequest",
            PluginCall::class.java,
            String::class.java,
            String::class.java,
            String::class.java,
            Boolean::class.javaPrimitiveType,
            ReownRequestObservations.Context::class.java
        ).apply { isAccessible = true }
        publisher.invoke(plugin, call, if (resolvesHash) "eth_sendTransaction" else "eth_chainId", "[]", "eip155:1", resolvesHash, context)
        assertEquals("Reach the SDK request once", before + 1, publications.size)
        val publication = publications.last()
        assertEquals(if (resolvesHash) "eth_sendTransaction" else "eth_chainId", publication.request.method)
        assertEquals("[]", publication.request.params)
        assertEquals("eip155:1", publication.request.chainId)
        assertTrue(call.rejections.isEmpty())
        assertTrue(call.resolutions.isEmpty())
        return publication
    }

    private fun publish(publication: Publication, id: Long, topic: String = "live-topic") {
        publication.success(
            SentRequestResult.WalletConnect(
                publication.request.method, publication.request.params, publication.request.chainId ?: "eip155:1", id, topic
            )
        )
    }

    private fun delete() {
        plugin.onSessionDelete(Modal.Model.DeletedSession.Success("deleted-topic", "fixture deletion"))
    }

    private fun respond(id: Long, topic: String = "live-topic") {
        plugin.onSessionRequestResponse(
            Modal.Model.SessionRequestResponse(topic, "eip155:1", "eth_chainId", Modal.Model.JsonRpcResponse.JsonRpcResult(id, "fixture-result"))
        )
    }

    private fun pendingCount(): Int {
        val pending = ReownPlugin::class.java.getDeclaredField("pendingRequests").apply {
            isAccessible = true
        }.get(plugin) as Map<*, *>
        return pending.size
    }

    private fun assertDeletedOnce(call: RecordingCall, published: String) {
        assertEquals("Every started call must be settled once by deletion", 1, call.rejections.size)
        assertEquals("WalletConnect session was deleted", call.rejections.single().message)
        assertEquals("session_deleted", failure(call).getString("nativeOrigin"))
        assertEquals(published, failure(call).getString("published"))
        assertFalse(failure(call).has("walletResponseCode"))
        assertTrue(call.resolutions.isEmpty())
    }

    private fun failure(call: RecordingCall): JSONObject {
        val code = requireNotNull(call.rejections.single().code)
        assertTrue(code.startsWith("REOWN_NATIVE_REQUEST_FAILURE:"))
        return JSONObject(code.removePrefix("REOWN_NATIVE_REQUEST_FAILURE:"))
    }
}
