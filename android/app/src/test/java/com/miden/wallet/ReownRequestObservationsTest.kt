package com.miden.wallet

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReownRequestObservationsTest {
    @Test
    fun categorizesWalletRejectionBeforePluginWiring() {
        assertEquals("user_rejected", walletResponseCategory(4001).wire)
    }

    @Test
    fun categorizesKnownProviderAndRpcErrorsWithoutExposingRawValues() {
        val cases = listOf(
            4100 to "provider_unauthorized", 4200 to "method_unsupported",
            -32601 to "method_unsupported", -32004 to "method_unsupported",
            4900 to "provider_disconnected", 4901 to "chain_disconnected",
            4902 to "chain_switch_failed", -32700 to "request_invalid",
            -32600 to "request_invalid", -32001 to "rpc_unavailable",
            -32002 to "rpc_unavailable", -32003 to "transaction_rejected",
            -32005 to "rpc_limited"
        )
        for ((code, expected) in cases) {
            assertEquals(expected, walletResponseCategory(code).wire)
            val observations = ReownRequestObservations { 0L }
            val failure = requireNotNull(observations.fail(observations.create(), ReownNativeOrigin.WALLET_ERROR, code))
            assertTrue(failure.toErrorCode().contains("\"walletResponseCode\":\"$expected\""))
            assertFalse(failure.toErrorCode().contains(code.toString()))
        }
        assertEquals("other", walletResponseCategory(-32000).wire)
        assertEquals("other", walletResponseCategory(12345).wire)
    }

    @Test
    fun mapsOnlyNumericWalletCodes() {
        assertEquals(ReownWalletResponseCode.USER_REJECTED, walletResponseCategory(4001))
        assertEquals(ReownWalletResponseCode.INVALID_PARAMS, walletResponseCategory(-32602))
        assertEquals(ReownWalletResponseCode.INTERNAL_ERROR, walletResponseCategory(-32603))
        assertEquals(ReownWalletResponseCode.OTHER, walletResponseCategory(null))
        assertEquals(ReownWalletResponseCode.OTHER, walletResponseCategory(12345))
        assertEquals(ReownWalletResponseCode.OTHER, walletResponseCategory(Int.MIN_VALUE))
        assertEquals(ReownWalletResponseCode.OTHER, walletResponseCategory(Int.MAX_VALUE))

        for (origin in ReownNativeOrigin.entries) {
            val observations = ReownRequestObservations { error("No request was started") }
            val failure = requireNotNull(observations.fail(observations.create(), origin, 4001))
            if (origin == ReownNativeOrigin.WALLET_ERROR) {
                assertEquals(ReownWalletResponseCode.USER_REJECTED, failure.walletResponseCode)
            } else {
                assertNull(failure.walletResponseCode)
                assertFalse(failure.toErrorCode().contains("\"walletResponseCode\""))
            }
        }

        val observations = ReownRequestObservations { 0L }
        val missingCode = requireNotNull(observations.fail(observations.create(), ReownNativeOrigin.WALLET_ERROR))
        assertEquals(ReownWalletResponseCode.OTHER, missingCode.walletResponseCode)
    }

    @Test
    fun bucketsExactMonotonicBoundaries() {
        val boundaries = listOf(
            0L to "under_30s",
            29999L to "under_30s",
            30000L to "30_to_120s",
            119999L to "30_to_120s",
            120000L to "120_to_300s",
            300000L to "120_to_300s",
            300001L to "over_300s"
        )
        for ((elapsed, expected) in boundaries) {
            var now = 7000L
            var reads = 0
            val observations = ReownRequestObservations { reads++; now }
            val context = observations.create()
            assertEquals(0, reads)
            assertEquals(0, observations.observingCount)
            observations.start(context)
            observations.start(context)
            assertEquals(1, reads)
            assertEquals(1, observations.observingCount)
            now += elapsed
            val failure = requireNotNull(observations.fail(context, ReownNativeOrigin.REQUEST_EXPIRED))
            assertEquals(expected, failure.requestAge.wire)
            assertEquals(2, reads)
            assertEquals(0, observations.observingCount)
        }

        val observations = ReownRequestObservations { error("No request was started") }
        observations.onResume()
        val context = observations.create()
        observations.onPause()
        val neverStarted = requireNotNull(observations.fail(context, ReownNativeOrigin.ARGUMENT_VALIDATION))
        assertEquals("unknown", neverStarted.requestAge.wire)
        assertEquals("unobserved", neverStarted.published.wire)
        assertNull(neverStarted.backgrounded)
        assertEquals(0, observations.observingCount)
    }

    @Test
    fun keepsPauseStickyBeforeAndAfterPublication() {
        for (pauseBeforePublication in listOf(true, false)) {
            var now = 0L
            val observations = ReownRequestObservations { now }
            observations.onResume()
            val context = observations.create()
            observations.start(context)
            if (pauseBeforePublication) observations.onPause()
            var stored = false
            assertTrue(observations.published(context) { stored = true })
            assertTrue(stored)
            assertFalse(observations.published(context) { error("Duplicate pending entry") })
            if (!pauseBeforePublication) observations.onPause()
            observations.onResume()
            now = 120000L
            observations.start(context)
            val failure = requireNotNull(observations.fail(context, ReownNativeOrigin.WALLET_ERROR, -32603))
            assertEquals("120_to_300s", failure.requestAge.wire)
            assertEquals("confirmed", failure.published.wire)
            assertEquals("yes", failure.backgrounded?.wire)
            assertNull(observations.fail(context, ReownNativeOrigin.REQUEST_EXPIRED))
            var resurrected = false
            assertFalse(observations.published(context) { resurrected = true })
            assertFalse(resurrected)
            observations.succeed(context)
            observations.start(context)
            assertEquals(0, observations.observingCount)
        }

        val observations = ReownRequestObservations { 0L }
        observations.onResume()
        observations.onPause()
        val context = observations.create()
        observations.start(context)
        observations.onResume()
        val failure = requireNotNull(observations.fail(context, ReownNativeOrigin.PUBLISH_ERROR))
        assertEquals("yes", failure.backgrounded?.wire)
    }

    @Test
    fun omitsBackgroundWithoutContinuousCoverage() {
        for (resumeAfterStart in listOf(false, true)) {
            val observations = ReownRequestObservations { 0L }
            observations.onPause()
            val context = observations.create()
            observations.start(context)
            if (resumeAfterStart) observations.onResume()
            observations.onPause()
            val failure = requireNotNull(observations.fail(context, ReownNativeOrigin.PUBLISH_ERROR))
            assertNull(failure.backgrounded)
            assertFalse(failure.toErrorCode().contains("\"backgrounded\""))
            assertEquals(0, observations.observingCount)
        }

        for (publishBeforeInvalidation in listOf(false, true)) {
            var now = 1000L
            val observations = ReownRequestObservations { now }
            observations.onResume()
            val context = observations.create()
            observations.start(context)
            observations.onPause()
            if (publishBeforeInvalidation) assertTrue(observations.published(context) {})
            observations.invalidateLifecycle()
            assertEquals(0, observations.observingCount)
            observations.onResume()
            observations.start(context)
            assertEquals(0, observations.observingCount)
            if (!publishBeforeInvalidation) assertTrue(observations.published(context) {})
            assertEquals(0, observations.observingCount)
            now = 31000L
            val failure = requireNotNull(observations.fail(context, ReownNativeOrigin.SESSION_DELETED))
            assertEquals("30_to_120s", failure.requestAge.wire)
            assertEquals("confirmed", failure.published.wire)
            assertNull(failure.backgrounded)
            assertEquals(0, observations.observingCount)
            assertNull(observations.fail(context, ReownNativeOrigin.SESSION_DELETED))
            assertFalse(observations.published(context) { error("Completed context was restored") })
        }

        val observations = ReownRequestObservations { 0L }
        observations.onResume()
        observations.invalidateLifecycle()
        val context = observations.create()
        observations.start(context)
        observations.onResume()
        assertNull(requireNotNull(observations.fail(context, ReownNativeOrigin.OTHER)).backgrounded)

        val recreated = ReownRequestObservations { 0L }
        val recreatedContext = recreated.create()
        recreated.start(recreatedContext)
        recreated.onResume()
        assertNull(requireNotNull(recreated.fail(recreatedContext, ReownNativeOrigin.OTHER)).backgrounded)
    }

    @Test
    fun isolatesConcurrentInvocations() {
        var now = 1000L
        val observations = ReownRequestObservations { now }
        observations.onResume()
        val first = observations.create()
        observations.start(first)
        now = 10000L
        val second = observations.create()
        observations.start(second)
        assertTrue(observations.published(second) {})
        assertEquals(2, observations.observingCount)
        now = 20000L
        val firstFailure = requireNotNull(observations.fail(first, ReownNativeOrigin.PUBLISH_ERROR))
        assertEquals("under_30s", firstFailure.requestAge.wire)
        assertEquals("unobserved", firstFailure.published.wire)
        assertEquals("no", firstFailure.backgrounded?.wire)
        val firstCode = firstFailure.toErrorCode()
        assertEquals(1, observations.observingCount)
        observations.onPause()
        observations.onResume()
        now = 40000L
        val secondFailure = requireNotNull(observations.fail(second, ReownNativeOrigin.WALLET_ERROR, 4001))
        assertEquals("30_to_120s", secondFailure.requestAge.wire)
        assertEquals("confirmed", secondFailure.published.wire)
        assertEquals("yes", secondFailure.backgrounded?.wire)
        assertEquals("under_30s", firstFailure.requestAge.wire)
        assertEquals("unobserved", firstFailure.published.wire)
        assertEquals("no", firstFailure.backgrounded?.wire)
        assertEquals(firstCode, firstFailure.toErrorCode())
        assertEquals(0, observations.observingCount)

        val older = observations.create()
        observations.start(older)
        now = 50000L
        val younger = observations.create()
        observations.start(younger)
        now = 70000L
        val olderFailure = requireNotNull(observations.fail(older, ReownNativeOrigin.REQUEST_EXPIRED))
        val youngerFailure = requireNotNull(observations.fail(younger, ReownNativeOrigin.REQUEST_EXPIRED))
        assertEquals("30_to_120s", olderFailure.requestAge.wire)
        assertEquals("under_30s", youngerFailure.requestAge.wire)
        assertEquals(0, observations.observingCount)
    }

    @Test
    fun completionIsIdempotentUnderRacingCallbacks() {
        val observations = ReownRequestObservations { 0L }
        observations.onResume()
        val context = observations.create()
        observations.start(context)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val barrier = CyclicBarrier(3)
            val failures = listOf(ReownNativeOrigin.REQUEST_EXPIRED, ReownNativeOrigin.SESSION_DELETED).map { origin ->
                executor.submit<ReownNativeFailure?> {
                    barrier.await(5, TimeUnit.SECONDS)
                    observations.fail(context, origin)
                }
            }
            barrier.await(5, TimeUnit.SECONDS)
            val snapshots = failures.mapNotNull { it.get(5, TimeUnit.SECONDS) }
            assertEquals(1, snapshots.size)
            assertEquals("no", snapshots.single().backgrounded?.wire)
            assertEquals(0, observations.observingCount)
            observations.succeed(context)
            observations.start(context)
            assertNull(observations.fail(context, ReownNativeOrigin.OTHER))
            assertFalse(observations.published(context) { error("Late publication after failure") })
            assertEquals(0, observations.observingCount)

            for (stage in 0..2) {
                val succeeded = observations.create()
                if (stage >= 1) observations.start(succeeded)
                if (stage == 2) assertTrue(observations.published(succeeded) {})
                observations.succeed(succeeded)
                assertEquals(0, observations.observingCount)
                observations.succeed(succeeded)
                observations.start(succeeded)
                assertNull(observations.fail(succeeded, ReownNativeOrigin.OTHER))
                assertFalse(observations.published(succeeded) { error("Late publication after success") })
                assertEquals(0, observations.observingCount)
            }

            val publishing = observations.create()
            observations.start(publishing)
            val storing = CountDownLatch(1)
            val releaseStore = CountDownLatch(1)
            val attemptingFailure = CountDownLatch(1)
            val failureReturned = CountDownLatch(1)
            val pending = mutableListOf<ReownRequestObservations.Context>()
            val publication = executor.submit<Boolean> {
                observations.published(publishing) {
                    storing.countDown()
                    check(releaseStore.await(5, TimeUnit.SECONDS))
                    pending.add(publishing)
                }
            }
            try {
                assertTrue(storing.await(5, TimeUnit.SECONDS))
                val failure = executor.submit<ReownNativeFailure?> {
                    attemptingFailure.countDown()
                    try {
                        observations.fail(publishing, ReownNativeOrigin.REQUEST_EXPIRED)
                    } finally {
                        failureReturned.countDown()
                    }
                }
                assertTrue(attemptingFailure.await(5, TimeUnit.SECONDS))
                assertFalse(failureReturned.await(100, TimeUnit.MILLISECONDS))
                releaseStore.countDown()
                assertTrue(publication.get(5, TimeUnit.SECONDS))
                assertEquals("confirmed", requireNotNull(failure.get(5, TimeUnit.SECONDS)).published.wire)
                assertEquals(listOf(publishing), pending)
                assertEquals(0, observations.observingCount)
            } finally {
                releaseStore.countDown()
            }

            val next = observations.create()
            observations.start(next)
            observations.onPause()
            assertEquals(1, observations.observingCount)
            val nextFailure = requireNotNull(observations.fail(next, ReownNativeOrigin.PUBLISH_ERROR))
            assertEquals("yes", nextFailure.backgrounded?.wire)
            assertEquals("no", snapshots.single().backgrounded?.wire)
            assertEquals(0, observations.observingCount)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun matchesJavaScriptEnvelopeFixture() {
        assertEquals(
            listOf(
                "argument_validation", "unconfigured", "publish_error", "wallet_error",
                "request_expired", "session_deleted", "other"
            ),
            ReownNativeOrigin.entries.map { it.wire }
        )
        assertEquals(
            listOf("user_rejected", "invalid_params", "internal_error", "other"),
            ReownWalletResponseCode.entries.map { it.wire }
        )
        assertEquals(
            listOf("under_30s", "30_to_120s", "120_to_300s", "over_300s", "unknown"),
            ReownRequestAge.entries.map { it.wire }
        )
        assertEquals(listOf("confirmed", "unobserved"), ReownPublication.entries.map { it.wire })
        assertEquals(listOf("yes", "no"), ReownBackgroundAnswer.entries.map { it.wire })

        var now = 0L
        val observations = ReownRequestObservations { now }
        observations.onResume()
        val context = observations.create()
        observations.start(context)
        assertTrue(observations.published(context) {})
        observations.onPause()
        now = 120000L
        val goldenFailure = requireNotNull(observations.fail(context, ReownNativeOrigin.WALLET_ERROR, -32603))
        assertEquals(
            File("../../src/lib/walletconnect/testing/native-request-failure-envelope.txt").readText().trim(),
            goldenFailure.toErrorCode()
        )

        val minimal = requireNotNull(observations.fail(observations.create(), ReownNativeOrigin.UNCONFIGURED, 4001))
        assertEquals(
            "REOWN_NATIVE_REQUEST_FAILURE:{\"nativeOrigin\":\"unconfigured\"," +
                "\"requestAge\":\"unknown\",\"published\":\"unobserved\"}",
            minimal.toErrorCode()
        )
        assertEquals(
            minimal.toErrorCode(),
            minimal.copy(walletResponseCode = ReownWalletResponseCode.INTERNAL_ERROR).toErrorCode()
        )
        val missingWalletCode = requireNotNull(observations.fail(observations.create(), ReownNativeOrigin.WALLET_ERROR))
        assertEquals(
            "REOWN_NATIVE_REQUEST_FAILURE:{\"nativeOrigin\":\"wallet_error\",\"walletResponseCode\":\"other\"," +
                "\"requestAge\":\"unknown\",\"published\":\"unobserved\"}",
            missingWalletCode.toErrorCode()
        )
        assertEquals(missingWalletCode.toErrorCode(), missingWalletCode.copy(walletResponseCode = null).toErrorCode())
    }
}
