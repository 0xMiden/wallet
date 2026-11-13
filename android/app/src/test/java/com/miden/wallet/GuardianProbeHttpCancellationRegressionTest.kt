package com.miden.wallet

import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLConnection
import java.net.URLStreamHandler
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class GuardianProbeHttpCancellationRegressionTest {
    private val plugin = GuardianProbeHttpPlugin()

    private class RecordingCall(
        callbackId: String,
        method: String,
        data: JSObject
    ) : PluginCall(null, "GuardianProbeHttp", callbackId, method, data) {
        val settled = CountDownLatch(1)
        @Volatile var resolved = false
        @Volatile var rejection: String? = null

        override fun resolve() {
            resolved = true
            settled.countDown()
        }

        override fun resolve(result: JSObject) {
            resolved = true
            settled.countDown()
        }

        override fun reject(message: String?) {
            rejection = message
            settled.countDown()
        }

        override fun reject(message: String?, code: String?) {
            rejection = message
            settled.countDown()
        }
    }

    private class BlockingConnection(url: URL) : HttpURLConnection(url) {
        val requestMethodEntered = CountDownLatch(1)
        val allowRequestMethod = CountDownLatch(1)
        val responseCodeCalls = AtomicInteger()

        override fun setRequestMethod(method: String) {
            requestMethodEntered.countDown()
            allowRequestMethod.await()
            super.setRequestMethod(method)
        }

        override fun getResponseCode(): Int {
            responseCodeCalls.incrementAndGet()
            return 200
        }

        override fun getInputStream() = ByteArrayInputStream(ByteArray(0))

        override fun connect() {
            connected = true
        }

        override fun disconnect() {
            connected = false
        }

        override fun usingProxy() = false
    }

    @Before
    fun clearConnection() {
        nextConnection.set(null)
    }

    @After
    fun stopExecutors() {
        nextConnection.getAndSet(null)?.allowRequestMethod?.countDown()
        for (name in listOf("executor", "watchdog")) {
            val field = GuardianProbeHttpPlugin::class.java.getDeclaredField(name).apply { isAccessible = true }
            (field.get(plugin) as ExecutorService).shutdownNow()
        }
    }

    @Test
    fun cancelBetweenConnectionPublishAndResponseCodePreventsHttpIo() {
        val id = "cancel-before-response-code"
        val connection = BlockingConnection(URL("guardianprobe-c01://fixture/request"))
        nextConnection.set(connection)
        val request = call(
            "request",
            id,
            mapOf("url" to "guardianprobe-c01://fixture/request", "requestId" to id, "timeoutMs" to 10000)
        )

        plugin.request(request)
        try {
            assertTrue(connection.requestMethodEntered.await(5, TimeUnit.SECONDS))
            plugin.cancel(call("cancel", "cancel-$id", mapOf("requestId" to id)))
        } finally {
            connection.allowRequestMethod.countDown()
        }

        assertTrue(request.settled.await(5, TimeUnit.SECONDS))
        assertEquals("An abandoned socket must not enter responseCode", 0, connection.responseCodeCalls.get())
        assertEquals("The guardian probe request was cancelled", request.rejection)
    }

    @Test
    fun evictedPreBeginCancellationDoesNotRejectTheNextRequest() {
        repeat(65) { index ->
            plugin.cancel(call("cancel-$index", "cancel-$index", mapOf("requestId" to "pre-$index")))
        }
        val request = call(
            "request",
            "retry-evicted-cancel",
            mapOf(
                "url" to "guardianprobe-unhandled://fixture/request",
                "requestId" to "pre-0",
                "timeoutMs" to 10000
            )
        )

        plugin.request(request)

        assertTrue(request.settled.await(5, TimeUnit.SECONDS))
        assertNotNull("The unsupported protocol should fail only after cancel-state eviction", request.rejection)
        assertNotEquals("The oldest pre-begin cancellation should have been evicted", CANCELLED, request.rejection)
    }

    private fun call(method: String, callbackId: String, values: Map<String, Any>): RecordingCall {
        val data = JSObject()
        values.forEach { (key, value) -> data.put(key, value) }
        return RecordingCall(callbackId, method, data)
    }

    companion object {
        private const val CANCELLED = "The guardian probe request was cancelled"
        private val nextConnection = AtomicReference<BlockingConnection?>()

        @BeforeClass
        @JvmStatic
        fun installProtocolHandler() {
            URL.setURLStreamHandlerFactory { protocol ->
                if (protocol != "guardianprobe-c01") {
                    null
                } else {
                    object : URLStreamHandler() {
                        override fun openConnection(url: URL): URLConnection =
                            nextConnection.getAndSet(null) ?: error("No guarded fake connection was configured")
                    }
                }
            }
        }
    }
}
