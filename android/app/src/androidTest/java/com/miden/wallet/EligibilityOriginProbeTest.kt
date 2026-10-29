package com.miden.wallet

import android.os.SystemClock
import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EligibilityOriginProbeTest {
    @Test
    fun captureWebViewOriginCategory() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            fun evaluate(script: String): String {
                val result = AtomicReference<String>()
                val done = CountDownLatch(1)
                scenario.onActivity { activity ->
                    activity.bridge.webView.evaluateJavascript(script) { value ->
                        result.set(value)
                        done.countDown()
                    }
                }
                assertTrue("WebView evaluation timed out", done.await(10, TimeUnit.SECONDS))
                return result.get()
            }
            val deadline = SystemClock.elapsedRealtime() + 60_000
            val ready = "document.readyState === 'complete' && location.origin === 'http://localhost'"
            while (evaluate(ready) != "true" && SystemClock.elapsedRealtime() < deadline) {
                SystemClock.sleep(250)
            }
            assertTrue("Capacitor application did not become ready", evaluate(ready) == "true")
            evaluate("""
                window.__originCategory = 'pending';
                fetch('https://httpbin.org/anything', { credentials: 'omit', referrerPolicy: 'no-referrer' })
                    .then(response => { if (!response.ok) throw new Error('unavailable'); return response.json(); })
                    .then(data => {
                        const origin = data.headers?.Origin ?? data.headers?.origin;
                        window.__originCategory = !origin ? 'missing' : origin === 'http://localhost' ? 'http-localhost' : 'other';
                    }).catch(() => { window.__originCategory = 'request-failed'; });
                true;
            """.trimIndent())
            var category = "\"pending\""
            while (category == "\"pending\"" && SystemClock.elapsedRealtime() < deadline) {
                category = evaluate("window.__originCategory")
                SystemClock.sleep(250)
            }
            assertTrue("Unexpected or failed Origin probe: $category", category in setOf("\"missing\"", "\"http-localhost\"", "\"other\""))
            Log.i("EligibilityOriginProbe", "ELIGIBILITY_ORIGIN_CATEGORY=$category")
        }
    }
}
