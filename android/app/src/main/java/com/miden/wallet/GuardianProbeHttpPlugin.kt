package com.miden.wallet

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val DISCONNECT_RETRY_MS = 50L

/**
 * A Guardian probe read with an absolute lifetime. HttpURLConnection's read timeout is idle, so a
 * trickle would keep the socket, and the permit in JS, until the body ended. disconnect() before
 * the engine exists does not stick, so an abandoned socket is disconnected again until the worker
 * finishes.
 */
@CapacitorPlugin(name = "GuardianProbeHttp")
class GuardianProbeHttpPlugin : Plugin() {
    private val executor = Executors.newCachedThreadPool()
    private val watchdog = Executors.newSingleThreadScheduledExecutor()
    private val book = GuardianProbeHttpBook<HttpURLConnection>()

    /** Installed by [request]. [cancel] and the deadline claim one retry, then run this. */
    @Volatile
    private var startDisconnectRetry: ((String) -> Unit)? = null

    @PluginMethod
    fun request(call: PluginCall) {
        val url = call.getString("url")
        val requestId = call.getString("requestId")
        if (url.isNullOrEmpty() || requestId.isNullOrEmpty()) {
            call.reject("Guardian probe request needs a url and requestId")
            return
        }
        when (book.begin(requestId)) {
            GuardianProbeBegin.alreadyCancelled -> {
                call.reject("The guardian probe request was cancelled")
                return
            }
            GuardianProbeBegin.duplicate -> {
                call.reject("Guardian probe request is already active")
                return
            }
            GuardianProbeBegin.started -> Unit
        }
        val timeoutMs = timeoutMs(call)
        val method = call.getString("method") ?: "GET"
        val body = call.getString("data")
        val headers = call.getObject("headers")
        val didSettle = AtomicBoolean(false)

        startDisconnectRetry =
            fun(id: String) {
                fun retry() {
                    book.abandonedSocket(id)?.disconnect() ?: return
                    watchdog.schedule({ retry() }, DISCONNECT_RETRY_MS, TimeUnit.MILLISECONDS)
                }
                watchdog.schedule({ retry() }, DISCONNECT_RETRY_MS, TimeUnit.MILLISECONDS)
            }

        val watchdogTask = watchdog.schedule({
            book.abandon(requestId)?.disconnect()
            val retry = startDisconnectRetry
            if (retry != null && book.claimRetry(requestId)) retry(requestId)
        }, timeoutMs.toLong(), TimeUnit.MILLISECONDS)

        executor.execute {
            val connection = try {
                URL(url).openConnection() as HttpURLConnection
            } catch (error: Exception) {
                watchdogTask.cancel(false)
                book.finish(requestId)
                rejectOnce(didSettle, call, error.message ?: "Guardian probe request failed")
                return@execute
            }
            if (!book.publish(requestId, connection)) {
                connection.disconnect()
                watchdogTask.cancel(false)
                book.finish(requestId)
                rejectOnce(didSettle, call, "The guardian probe request was cancelled")
                return@execute
            }
            fun rejectCancelled() {
                connection.disconnect()
                watchdogTask.cancel(false)
                book.finish(requestId)
                rejectOnce(didSettle, call, "The guardian probe request was cancelled")
            }
            try {
                connection.requestMethod = method
                connection.connectTimeout = timeoutMs
                connection.readTimeout = timeoutMs
                if (headers != null) applyHeaders(connection, headers)
                if (body != null) {
                    connection.doOutput = true
                    if (!book.admitIo(requestId)) {
                        rejectCancelled()
                        return@execute
                    }
                    connection.outputStream.use { stream -> stream.write(body.toByteArray(Charsets.UTF_8)) }
                } else if (!book.admitIo(requestId)) {
                    rejectCancelled()
                    return@execute
                }
                val status = connection.responseCode
                if (book.abandonedSocket(requestId) != null) {
                    rejectCancelled()
                    return@execute
                }
                val result = JSObject()
                result.put("status", status)
                result.put("data", readBody(connection))
                result.put("url", connection.url?.toString() ?: url)
                result.put("headers", responseHeaders(connection))
                resolveOnce(didSettle, call, result)
            } catch (error: Exception) {
                rejectOnce(didSettle, call, error.message ?: "Guardian probe request failed")
            } finally {
                watchdogTask.cancel(false)
                connection.disconnect()
                book.finish(requestId)
            }
        }
    }

    /** Idempotent. A cancel before the socket is published starts no transfer. */
    @PluginMethod
    fun cancel(call: PluginCall) {
        val requestId = call.getString("requestId")
        if (!requestId.isNullOrEmpty()) {
            val retry = startDisconnectRetry
            book.abandon(requestId)?.disconnect()
            if (retry != null && book.claimRetry(requestId)) retry(requestId)
        }
        call.resolve()
    }

    private fun timeoutMs(call: PluginCall): Int {
        val raw = call.data.opt("timeoutMs")
        val timeout = if (raw is Number) raw.toLong() else 1L
        return timeout.coerceIn(1L, Int.MAX_VALUE.toLong()).toInt()
    }

    private fun resolveOnce(didSettle: AtomicBoolean, call: PluginCall, result: JSObject) {
        if (!didSettle.compareAndSet(false, true)) return
        call.resolve(result)
    }

    private fun rejectOnce(didSettle: AtomicBoolean, call: PluginCall, message: String) {
        if (!didSettle.compareAndSet(false, true)) return
        call.reject(message)
    }

    private fun applyHeaders(connection: HttpURLConnection, headers: JSObject) {
        val keys = headers.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = headers.opt(key)
            if (value is String) connection.setRequestProperty(key, value)
        }
    }

    private fun readBody(connection: HttpURLConnection): String {
        val stream = try {
            connection.inputStream
        } catch (_: Exception) {
            connection.errorStream
        } ?: return ""
        return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    private fun responseHeaders(connection: HttpURLConnection): JSObject {
        val headers = JSObject()
        val fields = connection.headerFields ?: return headers
        for ((key, values) in fields) {
            if (key != null && values.isNotEmpty()) headers.put(key, values.joinToString(", "))
        }
        return headers
    }
}

internal enum class GuardianProbeBegin {
    alreadyCancelled,
    duplicate,
    started
}

/**
 * Cancellation memory for one plugin. Pending pre-begin cancels and finished ids stay inside
 * capped rings. An active socket stays installed through [abandon] until [finish].
 */
internal class GuardianProbeHttpBook<Socket> {
    private class Slot<S> {
        var abandoned: Boolean = false
        var socket: S? = null
        var ioArmed: Boolean = false
        var retryClaimed: Boolean = false
    }

    private val lock = Any()
    private val pending = ArrayDeque<String>()
    private val active = HashMap<String, Slot<Socket>>()
    private val finished = ArrayDeque<String>()

    fun begin(id: String): GuardianProbeBegin {
        synchronized(lock) {
            if (consumePending(id)) return GuardianProbeBegin.alreadyCancelled
            if (active.containsKey(id)) return GuardianProbeBegin.duplicate
            dropFinished(id)
            active[id] = Slot<Socket>()
            return GuardianProbeBegin.started
        }
    }

    /** Stores [socket] only while [id] is active and has not been abandoned. */
    fun publish(id: String, socket: Socket): Boolean {
        synchronized(lock) {
            val slot = active[id] ?: return false
            if (slot.abandoned) return false
            slot.socket = socket
            return true
        }
    }

    /** True only while [id] is active, published, and not abandoned, and then arms I/O. */
    fun admitIo(id: String): Boolean {
        synchronized(lock) {
            val slot = active[id] ?: return false
            if (slot.abandoned || slot.socket == null) return false
            if (slot.ioArmed) return true
            slot.ioArmed = true
            return true
        }
    }

    /**
     * An active id is marked abandoned and its socket stays installed for another disconnect.
     * A finished id is ignored. Any other id is a pre-begin cancel, evicting the oldest past [PENDING_CAP].
     */
    fun abandon(id: String): Socket? {
        synchronized(lock) {
            val slot = active[id]
            if (slot != null) {
                slot.abandoned = true
                return slot.socket
            }
            if (finished.contains(id)) return null
            rememberPending(id)
            return null
        }
    }

    /** Published socket of an abandoned id, until [finish] drops it. */
    fun abandonedSocket(id: String): Socket? {
        synchronized(lock) {
            val slot = active[id] ?: return null
            if (!slot.abandoned) return null
            return slot.socket
        }
    }

    /** True once, only while a socket is still published. */
    fun claimRetry(id: String): Boolean {
        synchronized(lock) {
            val slot = active[id] ?: return false
            if (slot.socket == null || slot.retryClaimed) return false
            slot.retryClaimed = true
            return true
        }
    }

    /** Drops the active id and its socket. A second call is a no-op. */
    fun finish(id: String) {
        synchronized(lock) {
            if (active.remove(id) == null) return
            rememberFinished(id)
        }
    }

    fun pendingCount(): Int = synchronized(lock) { pending.size }

    fun activeCount(): Int = synchronized(lock) { active.size }

    fun finishedCount(): Int = synchronized(lock) { finished.size }

    private fun consumePending(id: String): Boolean = pending.remove(id)

    private fun dropFinished(id: String) {
        finished.remove(id)
    }

    private fun rememberPending(id: String) {
        if (pending.contains(id)) return
        pending.addLast(id)
        while (pending.size > PENDING_CAP) pending.removeFirst()
    }

    private fun rememberFinished(id: String) {
        if (finished.contains(id)) return
        finished.addLast(id)
        while (finished.size > FINISHED_CAP) finished.removeFirst()
    }

    companion object {
        // Above the six in-flight permits and the one bridge turn between finish and a late cancel.
        const val PENDING_CAP = 64
        const val FINISHED_CAP = 64
    }
}
