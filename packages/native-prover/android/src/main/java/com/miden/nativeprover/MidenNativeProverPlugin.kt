package com.miden.nativeprover

import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors

/**
 * Capacitor plugin that proves a Miden transaction natively. Bridges JS
 * calls (Uint8Array → base64 → bytes → JNI → bytes → base64 → Uint8Array)
 * onto a background executor so the WebView main thread stays responsive
 * during the multi-second prove.
 *
 * Mirrors the iOS plugin's shape (`MidenNativeProverPlugin.swift`). The
 * native code is the same Rust crate built once per target ABI; differences
 * between platforms are only at the bridge layer (Swift FFI on iOS, JNI
 * here).
 */
@CapacitorPlugin(name = "MidenNativeProver")
class MidenNativeProverPlugin : Plugin() {

    companion object {
        private const val TAG = "MidenNativeProver"

        init {
            // `libmiden_native_prover_jni.so` is the cdylib produced by
            // packages/native-prover/android/rust-bridge. It statically
            // links in the Rust prover (rayon + miden-tx/concurrent +
            // miden-crypto, the works) and exports the JNI symbol that
            // `external fun proveNative` below resolves against.
            System.loadLibrary("miden_native_prover_jni")
        }

        @JvmStatic
        private external fun proveNative(input: ByteArray): ByteArray
    }

    /**
     * Single-flight prove executor. Concurrent calls would compete for the
     * rayon global pool inside libmiden_native_prover_jni.so, hurting
     * per-prove latency for both. A single-thread executor gives
     * predictable timings — same intent as the iOS side's serial
     * DispatchQueue.
     */
    private val proveExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "miden-native-prover").apply { isDaemon = true }
    }

    override fun load() {
        super.load()
        Log.i(TAG, "plugin loaded")
    }

    @PluginMethod
    fun prove(call: PluginCall) {
        Log.i(TAG, "prove() called, callbackId=${call.callbackId}")

        // Sync probe path mirroring the iOS plugin — resolves immediately
        // so a caller can confirm the bridge round-trip works without
        // running a real prove.
        val probe = call.getString("probe")
        if (probe != null) {
            Log.i(TAG, "prove() probe='$probe', resolving synchronously")
            val out = JSObject()
            out.put("probe", probe)
            out.put("echo", "ok")
            call.resolve(out)
            return
        }

        val inputBase64 = call.getString("input")
        if (inputBase64 == null) {
            Log.w(TAG, "prove() rejected: missing `input`")
            call.reject("MidenNativeProver.prove requires `input` as a base64-encoded Uint8Array")
            return
        }

        val inputBytes: ByteArray = try {
            Base64.decode(inputBase64, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "prove() rejected: input not valid base64", e)
            call.reject("MidenNativeProver: input is not valid base64")
            return
        }

        Log.i(TAG, "prove() dispatching native prove for ${inputBytes.size} input bytes")

        proveExecutor.submit {
            val t0 = System.nanoTime()
            try {
                val outputBytes = proveNative(inputBytes)
                val elapsedMs = (System.nanoTime() - t0) / 1_000_000.0
                Log.i(TAG, "prove() success, output=${outputBytes.size} bytes in ${"%.1f".format(elapsedMs)}ms")
                val out = JSObject()
                out.put("output", Base64.encodeToString(outputBytes, Base64.NO_WRAP))
                out.put("durationMs", elapsedMs)
                call.resolve(out)
            } catch (e: Throwable) {
                Log.e(TAG, "prove() failure", e)
                call.reject("MidenNativeProver: ${e.message ?: e.javaClass.simpleName}")
            }
        }
    }
}
