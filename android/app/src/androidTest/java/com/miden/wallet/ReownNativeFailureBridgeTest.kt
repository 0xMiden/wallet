package com.miden.wallet

import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ReownNativeFailureBridgeTest {
    private lateinit var scenario: ActivityScenario<MainActivity>

    private val configured = ReownPlugin::class.java.getDeclaredField("configured").apply { isAccessible = true }

    @Before
    fun openUnconfiguredOnboarding() {
        configured.setBoolean(null, false)
        scenario = ActivityScenario.launch(MainActivity::class.java)
        awaitJavaScriptValue(
            "document.readyState === 'complete' && " +
                "typeof window.Capacitor?.nativePromise === 'function' && " +
                "Boolean(document.querySelector('[data-onboarding-root=\"true\"]'))"
        ) { it == "true" }
        assertEquals(Lifecycle.State.RESUMED, scenario.state)
        assertFalse("Onboarding must not configure Reown", configured.getBoolean(null))
        assertEquals("true", evaluateJavaScript("location.hash === '' || location.hash === '#/'"))
        withPlugin { assertFalse(configured.getBoolean(null)) }
    }

    @After
    fun closeActivity() {
        if (::scenario.isInitialized) scenario.close()
        configured.setBoolean(null, false)
    }

    @Test
    fun rejectCodeCrossesRealCapacitorBridge() {
        val expectedCode = "REOWN_NATIVE_REQUEST_FAILURE:{\"nativeOrigin\":\"unconfigured\",\"requestAge\":\"unknown\",\"published\":\"unobserved\"}"
        assertEquals("Native Reown is not configured" to expectedCode, awaitNativeRejection("request"))
        assertEquals("Native Reown is not configured" to expectedCode, awaitNativeRejection("sendTransaction"))
        assertFalse(awaitNativeRejection("present").second?.startsWith("REOWN_NATIVE_REQUEST_FAILURE:") == true)
    }

    @Test
    fun activityLifecycleReachesThePluginObservationRegistry() {
        lateinit var registry: ReownRequestObservations
        lateinit var pausedContext: ReownRequestObservations.Context
        withPlugin { plugin ->
            registry = observationRegistry(plugin)
            pausedContext = registry.create()
            registry.start(pausedContext)
        }
        scenario.moveToState(Lifecycle.State.CREATED)
        scenario.moveToState(Lifecycle.State.RESUMED)
        withPlugin { assertTrue(registry === observationRegistry(it)) }
        val pausedSnapshot = requireNotNull(registry.fail(pausedContext, ReownNativeOrigin.OTHER))
        assertEquals("yes", pausedSnapshot.backgrounded?.wire)

        val recreatedContext = registry.create()
        registry.start(recreatedContext)
        scenario.recreate()
        withPlugin { assertNotSame(registry, observationRegistry(it)) }
        val recreatedSnapshot = requireNotNull(registry.fail(recreatedContext, ReownNativeOrigin.OTHER))
        assertNull(recreatedSnapshot.backgrounded)
    }

    private fun awaitNativeRejection(method: String): Pair<String, String?> {
        assertFalse("Fixture must remain unconfigured", configured.getBoolean(null))
        evaluateJavaScript(
            """
            window.__reownNativeFailureBridge = null;
            window.Capacitor.nativePromise('Reown', ${JSONObject.quote(method)}, {
                method: 'eth_chainId', chainId: 1, params: [],
                to: '0x0000000000000000000000000000000000000001'
            }).then(
                () => { window.__reownNativeFailureBridge = { resolved: true }; },
                error => {
                    window.__reownNativeFailureBridge = {
                        message: error.message,
                        code: typeof error.code === 'string' ? error.code : null
                    };
                }
            );
            true;
            """.trimIndent()
        )
        val encoded = awaitJavaScriptValue("JSON.stringify(window.__reownNativeFailureBridge)") {
            it != "null" && it != "\"null\""
        }
        val rejection = JSONObject(JSONArray("[$encoded]").getString(0))
        assertFalse("$method must reject through the native bridge", rejection.optBoolean("resolved"))
        return rejection.getString("message") to if (rejection.isNull("code")) null else rejection.getString("code")
    }

    private fun withPlugin(action: (ReownPlugin) -> Unit) {
        scenario.onActivity { activity ->
            val plugin = requireNotNull(activity.bridge.getPlugin("Reown")).instance
            require(plugin is ReownPlugin)
            action(plugin)
        }
    }

    private fun observationRegistry(plugin: ReownPlugin): ReownRequestObservations {
        val registry = ReownPlugin::class.java.getDeclaredField("observations").apply {
            isAccessible = true
        }.get(plugin)
        require(registry is ReownRequestObservations)
        return registry
    }

    private fun evaluateJavaScript(script: String): String {
        val completed = CountDownLatch(1)
        val result = AtomicReference<String>()
        scenario.onActivity { activity ->
            activity.bridge.webView.evaluateJavascript(script) {
                result.set(it)
                completed.countDown()
            }
        }
        assertTrue("WebView did not evaluate the test expression", completed.await(10, TimeUnit.SECONDS))
        return requireNotNull(result.get())
    }

    private fun awaitJavaScriptValue(script: String, ready: (String) -> Boolean): String {
        val deadline = SystemClock.elapsedRealtime() + 30000L
        do {
            val value = evaluateJavaScript(script)
            if (ready(value)) return value
            Thread.sleep(50)
        } while (SystemClock.elapsedRealtime() < deadline)
        error("WebView did not reach the expected test state")
    }
}
