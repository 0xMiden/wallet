package com.miden.wallet

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReownPluginWiringTest {
    private val source = File("src/main/java/com/miden/wallet/ReownPlugin.kt").readText()

    private fun blockAfter(text: String, marker: String): String {
        val markerIndex = text.indexOf(marker)
        assertTrue("Missing $marker", markerIndex >= 0)
        val start = text.indexOf('{', markerIndex + marker.length)
        assertTrue("Missing body for $marker", start >= 0)
        var depth = 0
        for (index in start until text.length) {
            when (text[index]) {
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) return text.substring(start + 1, index)
                }
            }
        }
        error("Unbalanced body for $marker")
    }

    // indexOf is -1 for a missing marker, which would pass any "before" comparison.
    private fun assertOrder(text: String, vararg markers: String) {
        val positions = markers.map { marker -> text.indexOf(marker).also { assertTrue("Missing $marker", it >= 0) } }
        assertEquals(positions.sorted(), positions)
    }

    private fun section(name: String): String {
        val declaration = Regex("\\bfun\\s+${Regex.escape(name)}\\s*\\(").find(source)
        assertTrue("Missing function $name", declaration != null)
        return blockAfter(source.substring(requireNotNull(declaration).range.first), "fun $name(")
    }

    @Test
    fun observesBeforeAppKitInvocation() {
        assertTrue(source.contains("private val observations: ReownRequestObservations = ReownRequestObservations(SystemClock::elapsedRealtime)"))
        val publisher = section("publishRequest")
        assertTrue(publisher.indexOf("observations.start(observation)") >= 0)
        assertOrder(publisher, "observations.start(observation)", "AppKit.request(")
        assertOrder(publisher, "val request = Request(", "observations.start(observation)")
        val enrollment = blockAfter(publisher, "synchronized(requestLock)")
        assertTrue(enrollment.contains("requestOwners[observation] = PendingRequest(call, resolvesHash, observation)"))
        assertOrder(enrollment, "requestOwners[observation]", "observations.start(observation)")
        assertFalse(enrollment.contains("AppKit.request("))

        val publication = blockAfter(publisher, "is SentRequestResult.WalletConnect ->")
        val pendingInsertion = blockAfter(publication, "observations.published(observation)")
        assertTrue(pendingInsertion.contains("pendingRequests[sentRequest.requestId] = pending"))
        assertEquals(1, Regex("pendingRequests\\[sentRequest.requestId] =").findAll(publication).count())
        assertOrder(publication, "synchronized(requestLock)", "requestOwners[observation]", "observations.published(observation)")
        assertOrder(publication, "observations.published(observation)", "pendingRequests[")
        assertTrue(source.contains("val observation: ReownRequestObservations.Context"))

        val walletSuccess = blockAfter(section("onSessionRequestResponse"), "is Modal.Model.JsonRpcResponse.JsonRpcResult ->")
        assertTrue(walletSuccess.contains("resolveNativeRequest(pending.observation, result.result?.toString() ?: \"\")"))
        val coinbaseSuccess = blockAfter(publisher, "is SentRequestResult.Coinbase ->")
        assertTrue(coinbaseSuccess.contains("resolveNativeRequest(observation, value)"))
        val success = section("resolveNativeRequest")
        val successClaim = blockAfter(success, "synchronized(requestLock)")
        assertOrder(successClaim, "requestOwners.remove(observation) ?: return", "observations.succeed(observation)", "pendingRequests.entries.removeIf")
        assertTrue(success.contains("result.put(if (pending.resolvesHash) \"hash\" else \"result\", value)"))
        assertOrder(success, "observations.succeed(observation)", "result.put(", "pending.call.resolve(")
        assertFalse(successClaim.contains(".resolve("))
        assertFalse(walletSuccess.contains("rejectNativeRequest("))
        assertFalse(coinbaseSuccess.contains("rejectNativeRequest("))

        for ((hook, helper) in listOf(
            "handleOnResume" to "onResume",
            "handleOnPause" to "onPause",
            "handleOnDestroy" to "invalidateLifecycle"
        )) {
            val body = section(hook)
            assertTrue(body.contains("observations.$helper()"))
            assertTrue(body.contains("super.$hook()"))
            assertFalse(body.contains("rejectNativeRequest("))
            assertFalse(body.contains(".reject("))
        }
    }

    @Test
    fun instrumentsOnlyRequestGuards() {
        for (name in listOf("request", "sendTransaction")) {
            val body = section(name)
            val create = body.indexOf("val observation = observations.create()")
            assertTrue(create >= 0)
            assertTrue(body.indexOf("guardConfigured(call, observation)") > create)
            assertTrue(body.contains("observation = observation"))
            assertFalse(body.contains("observations.start("))
            assertFalse(body.contains("call.reject("))
        }
        val request = section("request")
        for (message in listOf("Missing method or chainId", "Missing params")) {
            assertTrue(request.contains("rejectNativeRequest(call, observation, ReownNativeOrigin.ARGUMENT_VALIDATION, \"$message\")"))
        }
        val transaction = section("sendTransaction")
        for (message in listOf("Missing or invalid chainId", "Missing transaction recipient")) {
            assertTrue(transaction.contains("rejectNativeRequest(call, observation, ReownNativeOrigin.ARGUMENT_VALIDATION, \"$message\")"))
        }
        assertEquals(2, Regex("guardConfigured\\(call, observation\\)").findAll(source).count())
        for (name in listOf("present", "disconnect", "launchWallet")) {
            val body = section(name)
            assertTrue(body.contains("guardConfigured(call)"))
            assertFalse(body.contains("observations."))
            assertFalse(body.contains("ReownNativeOrigin"))
        }
        val guard = section("guardConfigured")
        assertTrue(guard.contains("if (observation != null)"))
        assertTrue(guard.contains("rejectNativeRequest(call, observation, ReownNativeOrigin.UNCONFIGURED, \"Native Reown is not configured\")"))
        assertTrue(guard.contains("call.reject(\"Native Reown is not configured\")"))
    }

    @Test
    fun mapsEveryExistingRequestSettlement() {
        val publisher = section("publishRequest")
        val publishError = "rejectNativeRequest(call, observation, ReownNativeOrigin.PUBLISH_ERROR, error.message ?: \"Failed to send WalletConnect request\")"
        assertTrue(blockAfter(publisher, "onError =").contains(publishError))
        assertTrue(blockAfter(publisher, "catch (error: Throwable)").contains(publishError))
        assertEquals(2, Regex("ReownNativeOrigin.PUBLISH_ERROR").findAll(publisher).count())
        assertFalse(publisher.contains("call.reject("))

        val walletError = blockAfter(section("onSessionRequestResponse"), "is Modal.Model.JsonRpcResponse.JsonRpcError ->")
        assertTrue(walletError.contains("synchronized(requestLock) { pendingRequests[result.id] }"))
        assertTrue(walletError.contains("pending.call, pending.observation, ReownNativeOrigin.WALLET_ERROR, result.message, result.code"))
        assertTrue(section("onSessionRequestResponse").contains("result.code"))
        assertEquals(1, Regex("result.code").findAll(source).count())
        assertFalse(walletError.contains(".reject("))

        val expired = section("onRequestExpired")
        assertTrue(expired.contains("synchronized(requestLock) { pendingRequests[request.id] }"))
        assertTrue(expired.contains("ReownNativeOrigin.REQUEST_EXPIRED"))
        assertTrue(expired.contains("pending.call, pending.observation, ReownNativeOrigin.REQUEST_EXPIRED, \"Request expired\""))
        val deleted = section("onSessionDelete")
        val deletionClaim = blockAfter(deleted, "synchronized(requestLock)")
        assertTrue(deletionClaim.contains("requestOwners.values.mapNotNull"))
        assertTrue(deletionClaim.contains("observations.fail(pending.observation, ReownNativeOrigin.SESSION_DELETED)"))
        assertTrue(deleted.contains("pending.call.reject(\"WalletConnect session was deleted\", failure.toErrorCode())"))
        assertOrder(deletionClaim, "observations.fail(", "requestOwners.clear()", "pendingRequests.clear()")
        assertOrder(deleted, "pendingRequests.clear()", "deleted.forEach", "pending.call.reject(")
        assertFalse(deletionClaim.contains(".reject("))
        assertFalse(deleted.contains("deletedSession.topic"))

        val rejection = section("rejectNativeRequest")
        val failureClaim = blockAfter(rejection, "synchronized(requestLock)")
        assertTrue(failureClaim.contains("observations.fail(observation, origin, walletCode) ?: return"))
        assertTrue(failureClaim.contains("requestOwners.remove(observation)"))
        assertTrue(rejection.contains("pendingRequests.entries.removeIf { it.value.observation === observation }"))
        assertTrue(rejection.contains("call.reject(message, failure.toErrorCode())"))
        assertOrder(rejection, "observations.fail(", "pendingRequests.entries.removeIf")
        assertOrder(rejection, "pendingRequests.entries.removeIf", "call.reject(")
        assertFalse(failureClaim.contains(".reject("))
    }

    @Test
    fun doesNotInventGenericEventSettlements() {
        assertFalse(section("onError").contains("rejectNativeRequest("))
        assertFalse(section("onProposalExpired").contains("rejectNativeRequest("))
        for (name in listOf(
            "configure", "present", "getState", "getSessions", "selectChain", "disconnect", "cleanup", "launchWallet",
            "onSessionApproved", "onSessionRejected", "onSessionUpdate", "onSessionExtend", "onConnectionStateChange",
            "onError", "onProposalExpired", "onPairingState", "dispatchDeepLink", "handleDeepLink", "finishConfigure"
        )) {
            val body = section(name)
            assertFalse("No native request origin in $name", body.contains("ReownNativeOrigin"))
            assertFalse("No request observations in $name", body.contains("observations."))
            assertFalse("No new request rejection in $name", body.contains("rejectNativeRequest("))
            assertFalse("No pending-call settlement in $name", body.contains("pendingRequests"))
        }
        assertFalse(section("onError").contains(".reject("))
        assertFalse(section("onSessionRejected").contains(".reject("))
        assertFalse(section("onProposalExpired").contains(".reject("))
        assertFalse(section("dispatchDeepLink").contains(".reject("))
        assertTrue(section("onSessionRejected").contains("notifyListeners(\"sessionResponse\", JSObject().put(\"error\", rejectedSession.reason))"))
        assertTrue(section("onError").contains("notifyListeners(\"sessionResponse\", JSObject().put(\"error\", error.throwable.message))"))
        assertFalse(source.contains("ReownNativeOrigin.OTHER"))
    }
}
