package com.miden.wallet

enum class ReownNativeOrigin(val wire: String) {
    ARGUMENT_VALIDATION("argument_validation"),
    UNCONFIGURED("unconfigured"),
    PUBLISH_ERROR("publish_error"),
    WALLET_ERROR("wallet_error"),
    REQUEST_EXPIRED("request_expired"),
    SESSION_DELETED("session_deleted"),
    OTHER("other")
}

enum class ReownWalletResponseCode(val wire: String) {
    USER_REJECTED("user_rejected"),
    INVALID_PARAMS("invalid_params"),
    INTERNAL_ERROR("internal_error"),
    PROVIDER_UNAUTHORIZED("provider_unauthorized"),
    METHOD_UNSUPPORTED("method_unsupported"),
    PROVIDER_DISCONNECTED("provider_disconnected"),
    CHAIN_DISCONNECTED("chain_disconnected"),
    CHAIN_SWITCH_FAILED("chain_switch_failed"),
    REQUEST_INVALID("request_invalid"),
    RPC_UNAVAILABLE("rpc_unavailable"),
    TRANSACTION_REJECTED("transaction_rejected"),
    RPC_LIMITED("rpc_limited"),
    OTHER("other")
}

enum class ReownRequestAge(val wire: String) {
    UNDER_30S("under_30s"),
    FROM_30_TO_120S("30_to_120s"),
    FROM_120_TO_300S("120_to_300s"),
    OVER_300S("over_300s"),
    UNKNOWN("unknown")
}

enum class ReownPublication(val wire: String) {
    CONFIRMED("confirmed"),
    UNOBSERVED("unobserved")
}

enum class ReownBackgroundAnswer(val wire: String) {
    YES("yes"),
    NO("no")
}

fun walletResponseCategory(code: Int?): ReownWalletResponseCode = when (code) {
    4001 -> ReownWalletResponseCode.USER_REJECTED
    -32602 -> ReownWalletResponseCode.INVALID_PARAMS
    -32603 -> ReownWalletResponseCode.INTERNAL_ERROR
    4100 -> ReownWalletResponseCode.PROVIDER_UNAUTHORIZED
    4200, -32601, -32004 -> ReownWalletResponseCode.METHOD_UNSUPPORTED
    4900 -> ReownWalletResponseCode.PROVIDER_DISCONNECTED
    4901 -> ReownWalletResponseCode.CHAIN_DISCONNECTED
    4902 -> ReownWalletResponseCode.CHAIN_SWITCH_FAILED
    -32700, -32600 -> ReownWalletResponseCode.REQUEST_INVALID
    -32001, -32002 -> ReownWalletResponseCode.RPC_UNAVAILABLE
    -32003 -> ReownWalletResponseCode.TRANSACTION_REJECTED
    -32005 -> ReownWalletResponseCode.RPC_LIMITED
    else -> ReownWalletResponseCode.OTHER
}

data class ReownNativeFailure(
    val nativeOrigin: ReownNativeOrigin,
    val walletResponseCode: ReownWalletResponseCode?,
    val requestAge: ReownRequestAge,
    val published: ReownPublication,
    val backgrounded: ReownBackgroundAnswer?
) {
    fun toErrorCode(): String = buildString {
        append("REOWN_NATIVE_REQUEST_FAILURE:{\"nativeOrigin\":\"")
        append(nativeOrigin.wire)
        if (nativeOrigin == ReownNativeOrigin.WALLET_ERROR) {
            append("\",\"walletResponseCode\":\"")
            append((walletResponseCode ?: ReownWalletResponseCode.OTHER).wire)
        }
        append("\",\"requestAge\":\"")
        append(requestAge.wire)
        append("\",\"published\":\"")
        append(published.wire)
        if (backgrounded != null) {
            append("\",\"backgrounded\":\"")
            append(backgrounded.wire)
        }
        append("\"}")
    }
}

class ReownRequestObservations(private val clock: () -> Long) {
    sealed class Context

    private class Observation : Context() {
        var startedAt: Long? = null
        var published = false
        var continuousCoverage = false
        var paused = false
        var completed = false
    }

    private val observing = mutableSetOf<Observation>()
    private var lifecycleKnown = false
    private var resumed = false

    internal val observingCount: Int
        @Synchronized get() = observing.size

    @Synchronized
    fun create(): Context = Observation()

    @Synchronized
    fun start(context: Context) {
        val observation = context.observation()
        if (observation.completed || observation.startedAt != null) return
        observation.startedAt = clock()
        observation.continuousCoverage = lifecycleKnown
        observation.paused = lifecycleKnown && !resumed
        observing.add(observation)
    }

    @Synchronized
    fun onResume() {
        lifecycleKnown = true
        resumed = true
    }

    @Synchronized
    fun onPause() {
        resumed = false
        for (observation in observing) observation.paused = true
    }

    @Synchronized
    fun invalidateLifecycle() {
        lifecycleKnown = false
        resumed = false
        // Closures may still settle these calls, but a later resume cannot repair the gap.
        for (observation in observing) observation.continuousCoverage = false
        observing.clear()
    }

    @Synchronized
    fun published(context: Context, storePending: () -> Unit): Boolean {
        val observation = context.observation()
        if (observation.completed || observation.published) return false
        observation.published = true
        // Keep insertion inside completion's monitor so a late callback cannot restore a pending entry.
        storePending()
        return true
    }

    @Synchronized
    fun succeed(context: Context) {
        val observation = context.observation()
        observation.completed = true
        observing.remove(observation)
    }

    @Synchronized
    fun fail(
        context: Context,
        origin: ReownNativeOrigin,
        walletCode: Int? = null
    ): ReownNativeFailure? {
        val observation = context.observation()
        if (observation.completed) return null
        val requestAge = observation.startedAt?.let { startedAt ->
            val elapsed = clock() - startedAt
            when {
                elapsed < 30000L -> ReownRequestAge.UNDER_30S
                elapsed < 120000L -> ReownRequestAge.FROM_30_TO_120S
                elapsed <= 300000L -> ReownRequestAge.FROM_120_TO_300S
                else -> ReownRequestAge.OVER_300S
            }
        } ?: ReownRequestAge.UNKNOWN
        val backgrounded = if (observation.continuousCoverage) {
            if (observation.paused) ReownBackgroundAnswer.YES else ReownBackgroundAnswer.NO
        } else {
            null
        }
        val failure = ReownNativeFailure(
            nativeOrigin = origin,
            walletResponseCode = if (origin == ReownNativeOrigin.WALLET_ERROR) walletResponseCategory(walletCode) else null,
            requestAge = requestAge,
            published = if (observation.published) ReownPublication.CONFIRMED else ReownPublication.UNOBSERVED,
            backgrounded = backgrounded
        )
        observation.completed = true
        observing.remove(observation)
        return failure
    }

    private fun Context.observation(): Observation = when (this) {
        is Observation -> this
    }
}
