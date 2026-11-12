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

/**
 * A Guardian probe read with an absolute lifetime. HttpURLConnection's read timeout is idle, so a
 * trickle would keep the socket, and the permit in JS, until the body ended. The watchdog and
 * cancel both disconnect that socket once.
 */
@CapacitorPlugin(name = "GuardianProbeHttp")
class GuardianProbeHttpPlugin : Plugin() {
    private val lock = Any()
    private val executor = Executors.newCachedThreadPool()
    private val watchdog = Executors.newSingleThreadScheduledExecutor()
    private val connections = HashMap<String, HttpURLConnection>()
    private val cancelled = HashSet<String>()

    @PluginMethod
    fun request(call: PluginCall) {
        val url = call.getString("url")
        val requestId = call.getString("requestId")
        if (url.isNullOrEmpty() || requestId.isNullOrEmpty()) {
            call.reject("Guardian probe request needs a url and requestId")
            return
        }
        val timeoutMs = timeoutMs(call)
        val method = call.getString("method") ?: "GET"
        val body = call.getString("data")
        val headers = call.getObject("headers")
        val didSettle = AtomicBoolean(false)

        val watchdogTask = watchdog.schedule({
            markCancelled(requestId)
            disconnect(requestId)
        }, timeoutMs.toLong(), TimeUnit.MILLISECONDS)

        executor.execute {
            if (takeCancelled(requestId)) {
                watchdogTask.cancel(false)
                rejectOnce(didSettle, call, "The guardian probe request was cancelled")
                return@execute
            }
            val connection = try {
                URL(url).openConnection() as HttpURLConnection
            } catch (error: Exception) {
                watchdogTask.cancel(false)
                rejectOnce(didSettle, call, error.message ?: "Guardian probe request failed")
                return@execute
            }
            val started = synchronized(lock) {
                if (cancelled.remove(requestId)) {
                    false
                } else {
                    connections[requestId] = connection
                    true
                }
            }
            if (!started) {
                connection.disconnect()
                watchdogTask.cancel(false)
                rejectOnce(didSettle, call, "The guardian probe request was cancelled")
                return@execute
            }
            try {
                connection.requestMethod = method
                connection.connectTimeout = timeoutMs
                connection.readTimeout = timeoutMs
                if (headers != null) applyHeaders(connection, headers)
                if (body != null) {
                    connection.doOutput = true
                    connection.outputStream.use { stream -> stream.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
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
                disconnect(requestId)
                synchronized(lock) { cancelled.remove(requestId) }
            }
        }
    }

    /** Idempotent. A cancel that arrives before [request] stores a connection starts no new one. */
    @PluginMethod
    fun cancel(call: PluginCall) {
        val requestId = call.getString("requestId")
        if (!requestId.isNullOrEmpty()) {
            markCancelled(requestId)
            disconnect(requestId)
        }
        call.resolve()
    }

    private fun timeoutMs(call: PluginCall): Int {
        val raw = call.data.opt("timeoutMs")
        val timeout = if (raw is Number) raw.toLong() else 1L
        return timeout.coerceIn(1L, Int.MAX_VALUE.toLong()).toInt()
    }

    private fun markCancelled(requestId: String) {
        synchronized(lock) { cancelled.add(requestId) }
    }

    private fun takeCancelled(requestId: String): Boolean = synchronized(lock) { cancelled.remove(requestId) }

    private fun disconnect(requestId: String) {
        val connection = synchronized(lock) { connections.remove(requestId) } ?: return
        connection.disconnect()
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
