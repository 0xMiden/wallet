package com.miden.wallet

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.Executors
import kotlin.concurrent.thread

class BreadConnectOpenerLogicTest {
    private val print = (0 until 32).joinToString(":") { "%02X".format(it * 7) }
    private val bytes = ByteArray(32) { (it * 7).toByte() }

    @Test
    fun `reads a fingerprint as assetlinks json writes it, in either case`() {
        assertArrayEquals(bytes, BreadConnectOpenerLogic.fingerprint(print))
        assertArrayEquals(bytes, BreadConnectOpenerLogic.fingerprint(print.lowercase()))
    }

    @Test
    fun `refuses a fingerprint of the wrong length or with a byte that is not two hex digits`() {
        assertNull(BreadConnectOpenerLogic.fingerprint(print.substringBeforeLast(':')))
        assertNull(BreadConnectOpenerLogic.fingerprint("$print:00"))
        assertNull(BreadConnectOpenerLogic.fingerprint(print.replaceFirst("00", "+0")))
        assertNull(BreadConnectOpenerLogic.fingerprint(print.replaceFirst("00", "0")))
        assertNull(BreadConnectOpenerLogic.fingerprint(print.replaceFirst("00", "0G")))
    }

    @Test
    fun `takes an android app that may handle all urls, keeping only its well-formed fingerprints`() {
        val target = BreadConnectOpenerLogic.target(
            listOf("delegate_permission/common.get_login_creds", BreadConnectOpenerLogic.HANDLE_ALL_URLS),
            "android_app",
            "com.example.game",
            listOf("not a fingerprint", print),
        )
        assertEquals("com.example.game", target?.packageName)
        assertEquals(1, target?.fingerprints?.size)
        assertArrayEquals(bytes, target?.fingerprints?.first())
    }

    @Test
    fun `ignores a statement that does not let an android app handle all urls`() {
        val all = listOf(BreadConnectOpenerLogic.HANDLE_ALL_URLS)
        assertNull(BreadConnectOpenerLogic.target(listOf("delegate_permission/common.get_login_creds"), "android_app", "com.example.game", listOf(print)))
        assertNull(BreadConnectOpenerLogic.target(all, "web", "com.example.game", listOf(print)))
        assertNull(BreadConnectOpenerLogic.target(all, "android_app", null, listOf(print)))
        assertNull(BreadConnectOpenerLogic.target(all, "android_app", "", listOf(print)))
        assertNull(BreadConnectOpenerLogic.target(all, "android_app", "com.example.game", listOf("AB:CD")))
    }

    private val other = ByteArray(32) { 1.toByte() }
    private val signedWith =
        mapOf("com.example.lacks" to bytes, "com.example.game" to bytes, "com.example.later" to bytes)
    private val handlers = setOf("com.example.other", "com.example.game", "com.example.later")

    private fun verified(vararg targets: AssetLinkTarget) = BreadConnectOpenerLogic.verifiedPackage(
        targets.toList(),
        { name, fingerprint -> signedWith[name]?.contentEquals(fingerprint) == true },
        { name -> name in handlers },
    )

    @Test
    fun `hands the link to the first named app signed with a certificate its statement lists that handles it`() {
        assertEquals(
            "com.example.game",
            verified(
                AssetLinkTarget("com.example.other", listOf(bytes)),
                AssetLinkTarget("com.example.lacks", listOf(bytes)),
                AssetLinkTarget("com.example.game", listOf(other, bytes)),
                AssetLinkTarget("com.example.later", listOf(bytes)),
            ),
        )
    }

    @Test
    fun `hands the link to no app signed with another certificate or not handling it`() {
        assertNull(verified(AssetLinkTarget("com.example.game", listOf(other))))
        assertNull(verified(AssetLinkTarget("com.example.other", listOf(bytes))))
        assertNull(verified(AssetLinkTarget("com.example.lacks", listOf(bytes))))
        assertNull(verified())
    }

    private val watchdog = Executors.newSingleThreadScheduledExecutor { task -> Thread(task).apply { isDaemon = true } }

    /// A one-request HTTP server on the loopback address that answers with `respond`.
    private fun serve(respond: (OutputStream) -> Unit): URL {
        val server = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        thread(isDaemon = true) {
            server.use {
                it.accept().use { socket ->
                    val request = socket.getInputStream().bufferedReader()
                    while (request.readLine()?.isNotEmpty() == true) continue
                    try {
                        respond(socket.getOutputStream())
                    } catch (e: IOException) {
                        // The reader hung up.
                    }
                }
            }
        }
        return URL("http://127.0.0.1:${server.localPort}/.well-known/assetlinks.json")
    }

    private fun read(url: URL, maxBytes: Int = 64): ByteArray? {
        val connection = url.openConnection() as HttpURLConnection
        connection.connectTimeout = 500
        connection.readTimeout = 500
        return BreadConnectOpenerLogic.readBody(connection, maxBytes, 1_000, watchdog)
    }

    private fun drip(out: OutputStream, text: String) {
        for (byte in text.toByteArray()) {
            out.write(byte.toInt())
            out.flush()
            Thread.sleep(100)
        }
    }

    @Test
    fun `reads a whole answer and refuses one over the cap`() {
        val ok = "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n"
        val answer = "[{\"relation\":[]}]"
        assertEquals(answer, read(serve { it.write("$ok$answer".toByteArray()) })?.let { String(it) })
        assertNull(read(serve { it.write("$ok${"[".repeat(65)}".toByteArray()) }))
        assertNull(read(serve { it.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n[]".toByteArray()) }))
    }

    @Test(timeout = 10_000)
    fun `gives up at the deadline on a body sent a byte inside every read timeout`() {
        val url = serve {
            it.write("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".toByteArray())
            while (true) drip(it, "[")
        }
        val started = System.nanoTime()
        assertNull(read(url, maxBytes = 1_000_000))
        assertTrue(System.nanoTime() - started < 3_000_000_000L)
    }

    @Test(timeout = 10_000)
    fun `gives up at the deadline on headers sent a byte inside every read timeout`() {
        val url = serve { drip(it, "HTTP/1.1 200 OK\r\nX-Slow: ${"a".repeat(1000)}\r\n\r\n[]") }
        val started = System.nanoTime()
        assertNull(read(url))
        assertTrue(System.nanoTime() - started < 3_000_000_000L)
    }
}
