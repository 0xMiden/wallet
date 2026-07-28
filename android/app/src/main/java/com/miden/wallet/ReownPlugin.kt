package com.miden.wallet

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.fragment.app.FragmentActivity
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.reown.android.Core
import com.reown.android.CoreClient
import com.reown.appkit.client.AppKit
import com.reown.appkit.client.Modal
import com.reown.appkit.client.models.Session
import com.reown.appkit.client.models.request.Request
import com.reown.appkit.client.models.request.SentRequestResult
import com.reown.appkit.ui.AppKitSheet
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

@CapacitorPlugin(name = "Reown")
class ReownPlugin : Plugin(), AppKit.ModalDelegate, CoreClient.CoreDelegate {
    private data class PendingRequest(
        val call: PluginCall,
        val resolvesHash: Boolean,
    )

    companion object {
        private const val TAG = "ReownPlugin"
        private const val DEFAULT_PROJECT_ID = ""
        private const val DEFAULT_NATIVE_REDIRECT = "com.miden.wallet://"
        private const val DEFAULT_CHAIN_ID = 11155111
        private const val APPKIT_SHEET_TAG = "ReownAppKitSheet"
        private const val CHOOSE_NETWORK_KEY = "chooseNetwork"

        private var configured = false
        private val pendingDeepLinks = mutableListOf<String>()
    }

    private val pendingRequests = ConcurrentHashMap<Long, PendingRequest>()
    private var socketStatus: String? = null
    private var selectedSessionTopic: String? = null

    override fun load() {
        super.load()
        activity?.intent?.dataString?.let(::handleDeepLink)
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        intent.dataString?.let(::handleDeepLink)
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        if (configured) {
            notifyStateChanged()
            call.resolve()
            return
        }

        val projectId = call.getString("projectId") ?: DEFAULT_PROJECT_ID
        if (projectId.isBlank()) {
            call.reject("Missing WalletConnect projectId")
            return
        }

        val nativeRedirect = call.getString("nativeRedirect") ?: DEFAULT_NATIVE_REDIRECT
        val universalRedirect = call.getString("universalRedirect")
        val linkMode = (call.getBoolean("linkMode") ?: false) && !universalRedirect.isNullOrBlank()
        val methods = stringArray(call, "methods", listOf("eth_sendTransaction", "personal_sign", "eth_signTypedData"))
        val events = stringArray(call, "events", listOf("chainChanged", "accountsChanged"))
        val chainIds = intArray(call, "chainIds", listOf(DEFAULT_CHAIN_ID))

        val metadata = Core.Model.AppMetaData(
            name = call.getString("appName") ?: "Bread Wallet",
            description = call.getString("appDescription") ?: "Bread wallet",
            url = call.getString("appUrl") ?: "https://miden.io",
            icons = stringArray(call, "icons", emptyList()),
            redirect = nativeRedirect,
            appLink = universalRedirect,
            linkMode = linkMode,
            verifyUrl = call.getString("verifyUrl")
        )

        val application = context.applicationContext as? Application
        if (application == null) {
            call.reject("Android application context is unavailable")
            return
        }

        try {
            CoreClient.initialize(
                application = application,
                projectId = projectId,
                metaData = metadata,
                onError = { error ->
                    Log.e(TAG, "Core initialization error: ${error.throwable.message}", error.throwable)
                }
            )
            CoreClient.setDelegate(this)

            AppKit.initialize(
                init = Modal.Params.Init(core = CoreClient, coinbaseEnabled = false),
                onSuccess = {
                    finishConfigure(call, chainIds, methods, events)
                },
                onError = { error ->
                    if (error.throwable::class.java.simpleName.contains("AlreadyInitialized")) {
                        finishConfigure(call, chainIds, methods, events)
                    } else {
                        Log.e(TAG, "AppKit initialization error: ${error.throwable.message}", error.throwable)
                        call.reject(error.throwable.message ?: "Failed to initialize native WalletConnect")
                    }
                }
            )
        } catch (error: Throwable) {
            Log.e(TAG, "configure failed: ${error.message}", error)
            call.reject(error.message ?: "Failed to configure native WalletConnect")
        }
    }

    @PluginMethod
    fun present(call: PluginCall) {
        guardConfigured(call) {
            val fragmentActivity = activity as? FragmentActivity
            if (fragmentActivity == null) {
                call.reject("Reown AppKit requires a FragmentActivity")
                return@guardConfigured
            }

            activity.runOnUiThread {
                val existing = fragmentActivity.supportFragmentManager.findFragmentByTag(APPKIT_SHEET_TAG)
                if (existing != null) {
                    call.resolve()
                    return@runOnUiThread
                }

                AppKitSheet().apply {
                    arguments = Bundle().apply {
                        putBoolean(CHOOSE_NETWORK_KEY, false)
                    }
                }.show(fragmentActivity.supportFragmentManager, APPKIT_SHEET_TAG)
                call.resolve()
            }
        }
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        call.resolve(currentState())
    }

    @PluginMethod
    fun getSessions(call: PluginCall) {
        val result = JSObject()
        result.put("sessions", sessionPayloads())
        call.resolve(result)
    }

    @PluginMethod
    fun selectChain(call: PluginCall) {
        if (call.getInt("chainId") == null) {
            call.reject("Missing or invalid chainId")
            return
        }
        notifyStateChanged()
        call.resolve()
    }

    @PluginMethod
    fun request(call: PluginCall) {
        guardConfigured(call) {
            val method = call.getString("method")
            val chainId = call.getInt("chainId")
            if (method.isNullOrBlank() || chainId == null) {
                call.reject("Missing method or chainId")
                return@guardConfigured
            }

            val params = call.data.opt("params")
            if (params == null || params == JSONObject.NULL) {
                call.reject("Missing params")
                return@guardConfigured
            }

            publishRequest(
                call = call,
                method = method,
                params = paramsToJsonString(params),
                chainId = "eip155:$chainId",
                resolvesHash = false
            )
        }
    }

    @PluginMethod
    fun sendTransaction(call: PluginCall) {
        guardConfigured(call) {
            val chainId = call.getInt("chainId")
            val to = call.getString("to")
            if (chainId == null) {
                call.reject("Missing or invalid chainId")
                return@guardConfigured
            }
            if (to.isNullOrBlank()) {
                call.reject("Missing transaction recipient")
                return@guardConfigured
            }

            val tx = JSONObject()
            putIfPresent(tx, "from", call.getString("from") ?: firstAddress())
            tx.put("to", to)
            putIfPresent(tx, "value", call.getString("value"))
            putIfPresent(tx, "data", call.getString("data"))
            putIfPresent(tx, "gas", call.getString("gas"))
            putIfPresent(tx, "gasPrice", call.getString("gasPrice"))
            putIfPresent(tx, "maxFeePerGas", call.getString("maxFeePerGas"))
            putIfPresent(tx, "maxPriorityFeePerGas", call.getString("maxPriorityFeePerGas"))

            publishRequest(
                call = call,
                method = "eth_sendTransaction",
                params = JSONArray().put(tx).toString(),
                chainId = "eip155:$chainId",
                resolvesHash = true
            )
        }
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        guardConfigured(call) {
            if (safeSession() == null) {
                call.resolve()
                return@guardConfigured
            }

            AppKit.disconnect(
                onSuccess = {
                    selectedSessionTopic = null
                    notifyStateChanged()
                    call.resolve()
                },
                onError = { error ->
                    call.reject(error.message ?: "Failed to disconnect WalletConnect session")
                }
            )
        }
    }

    @PluginMethod
    fun launchWallet(call: PluginCall) {
        guardConfigured(call) {
            val redirect = (safeSession() as? Session.WalletConnectSession)?.redirect
            if (redirect.isNullOrBlank()) {
                call.reject("No wallet redirect is available")
                return@guardConfigured
            }
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(redirect))
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                call.resolve()
            } catch (error: Throwable) {
                call.reject(error.message ?: "Failed to launch wallet")
            }
        }
    }

    @PluginMethod
    fun cleanup(call: PluginCall) {
        disconnect(call)
    }

    override fun onSessionApproved(approvedSession: Modal.Model.ApprovedSession) {
        if (approvedSession is Modal.Model.ApprovedSession.WalletConnectSession) {
            selectedSessionTopic = approvedSession.topic
        }
        notifyStateChanged()
    }

    override fun onSessionRejected(rejectedSession: Modal.Model.RejectedSession) {
        notifyListeners("sessionResponse", JSObject().put("error", rejectedSession.reason))
        notifyStateChanged()
    }

    override fun onSessionUpdate(updatedSession: Modal.Model.UpdatedSession) {
        selectedSessionTopic = updatedSession.topic
        notifyStateChanged()
    }

    override fun onSessionEvent(sessionEvent: Modal.Model.SessionEvent) = Unit

    override fun onSessionExtend(session: Modal.Model.Session) {
        selectedSessionTopic = session.topic
        notifyStateChanged()
    }

    override fun onSessionDelete(deletedSession: Modal.Model.DeletedSession) {
        selectedSessionTopic = null
        pendingRequests.values.forEach {
            it.call.reject("WalletConnect session was deleted")
        }
        pendingRequests.clear()
        notifyStateChanged()
    }

    override fun onSessionRequestResponse(response: Modal.Model.SessionRequestResponse) {
        val payload = JSObject()
        payload.put("topic", response.topic)
        payload.put("method", response.method)

        when (val result = response.result) {
            is Modal.Model.JsonRpcResponse.JsonRpcResult -> {
                payload.put("id", result.id)
                payload.put("result", result.result?.toString())
                val pending = pendingRequests.remove(result.id)
                if (pending != null) {
                    val callResult = JSObject()
                    callResult.put(if (pending.resolvesHash) "hash" else "result", result.result?.toString() ?: "")
                    pending.call.resolve(callResult)
                }
            }

            is Modal.Model.JsonRpcResponse.JsonRpcError -> {
                payload.put("id", result.id)
                payload.put("error", result.message)
                pendingRequests.remove(result.id)?.call?.reject(result.message)
            }
        }

        notifyListeners("sessionResponse", payload)
    }

    override fun onSessionAuthenticateResponse(sessionAuthenticateResponse: Modal.Model.SessionAuthenticateResponse) = Unit

    override fun onSIWEAuthenticationResponse(response: Modal.Model.SIWEAuthenticateResponse) = Unit

    override fun onProposalExpired(proposal: Modal.Model.ExpiredProposal) {
        notifyStateChanged()
    }

    override fun onRequestExpired(request: Modal.Model.ExpiredRequest) {
        pendingRequests.remove(request.id)?.call?.reject("Request expired")
    }

    override fun onConnectionStateChange(state: Modal.Model.ConnectionState) {
        socketStatus = if (state.isAvailable) "connected" else "disconnected"
        notifyListeners("socketStatus", JSObject().put("status", socketStatus))
        notifyStateChanged()
    }

    override fun onError(error: Modal.Model.Error) {
        Log.e(TAG, "AppKit error: ${error.throwable.message}", error.throwable)
        notifyListeners("sessionResponse", JSObject().put("error", error.throwable.message))
    }

    override fun onPairingDelete(deletedPairing: Core.Model.DeletedPairing) = Unit

    override fun onPairingExpired(expiredPairing: Core.Model.ExpiredPairing) = Unit

    override fun onPairingState(pairingState: Core.Model.PairingState) {
        Log.d(TAG, "Pairing state: ${pairingState.isPairingState}")
    }

    private fun finishConfigure(call: PluginCall, chainIds: List<Int>, methods: List<String>, events: List<String>) {
        AppKit.setChains(chainIds.map { chainFor(it, methods, events) })
        AppKit.setDelegate(this)
        configured = true

        pendingDeepLinks.toList().forEach(::dispatchDeepLink)
        pendingDeepLinks.clear()

        notifyStateChanged()
        call.resolve()
    }

    private fun publishRequest(
        call: PluginCall,
        method: String,
        params: String,
        chainId: String,
        resolvesHash: Boolean,
    ) {
        try {
            val request = Request(
                method = method,
                params = params,
                chainId = chainId,
            )

            AppKit.request(
                request = request,
                onSuccess = { sentRequest ->
                    when (sentRequest) {
                        is SentRequestResult.WalletConnect -> {
                            pendingRequests[sentRequest.requestId] = PendingRequest(call, resolvesHash)
                            val payload = JSObject()
                            payload.put("id", sentRequest.requestId)
                            payload.put("topic", sentRequest.sessionTopic)
                            payload.put("method", sentRequest.method)
                            notifyListeners("sessionRequestSent", payload)
                        }

                        is SentRequestResult.Coinbase -> {
                            val value = sentRequest.results.firstOrNull()?.toString() ?: ""
                            val result = JSObject()
                            result.put(if (resolvesHash) "hash" else "result", value)
                            call.resolve(result)
                        }
                    }
                },
                onError = { error ->
                    call.reject(error.message ?: "Failed to send WalletConnect request")
                }
            )
        } catch (error: Throwable) {
            call.reject(error.message ?: "Failed to send WalletConnect request")
        }
    }

    private fun guardConfigured(call: PluginCall, run: () -> Unit) {
        if (!configured) {
            call.reject("Native Reown is not configured")
            return
        }
        run()
    }

    private fun handleDeepLink(url: String) {
        if (!configured) {
            pendingDeepLinks.add(url)
            return
        }
        dispatchDeepLink(url)
    }

    private fun dispatchDeepLink(url: String) {
        AppKit.handleDeepLink(url) { error ->
            Log.e(TAG, "Deep link handling failed: ${error.throwable.message}", error.throwable)
        }
    }

    private fun notifyStateChanged() {
        notifyListeners("stateChanged", currentState())
    }

    private fun currentState(): JSObject {
        val payload = JSObject()
        payload.put("configured", configured)

        val account = safeAccount()
        val session = safeSession()
        val accounts = sessionAccounts(session)

        payload.put("connected", account != null || accounts.length() > 0)
        payload.put("accounts", accounts)

        if (session is Session.WalletConnectSession) {
            payload.put("topic", session.topic)
            payload.put("walletName", session.metaData?.name)
            selectedSessionTopic = session.topic
        }

        val address = account?.address ?: firstAddress(session)
        if (!address.isNullOrBlank()) {
            payload.put("address", address)
        }

        val chainReference = account?.chain?.chainReference ?: firstChainReference(session)
        chainReference?.toIntOrNull()?.let { payload.put("chainId", it) }

        socketStatus?.let { payload.put("socketStatus", it) }
        return payload
    }

    private fun sessionPayloads(): JSArray {
        val sessions = JSArray()
        val session = safeSession()
        if (session is Session.WalletConnectSession) {
            val payload = JSObject()
            payload.put("topic", session.topic)
            payload.put("accounts", sessionAccounts(session))
            payload.put("address", firstAddress(session))
            firstChainReference(session)?.toIntOrNull()?.let { payload.put("chainId", it) }
            payload.put("walletName", session.metaData?.name)
            sessions.put(payload)
        }
        return sessions
    }

    private fun safeAccount() = try {
        if (configured) AppKit.getAccount() else null
    } catch (_: Throwable) {
        null
    }

    private fun safeSession() = try {
        if (configured) AppKit.getSession() else null
    } catch (_: Throwable) {
        null
    }

    private fun sessionAccounts(session: Session? = safeSession()): JSArray {
        val accounts = JSArray()
        if (session is Session.WalletConnectSession) {
            session.namespaces.values
                .flatMap { it.accounts }
                .distinct()
                .forEach { accounts.put(it) }
        }
        return accounts
    }

    private fun firstAddress(session: Session? = safeSession()): String? {
        if (session is Session.WalletConnectSession) {
            return session.namespaces.values
                .flatMap { it.accounts }
                .firstOrNull()
                ?.substringAfterLast(":")
        }
        return null
    }

    private fun firstChainReference(session: Session? = safeSession()): String? {
        if (session is Session.WalletConnectSession) {
            return session.namespaces.values
                .flatMap { it.accounts }
                .firstOrNull()
                ?.split(":")
                ?.getOrNull(1)
        }
        return null
    }

    private fun chainFor(chainId: Int, methods: List<String>, events: List<String>): Modal.Model.Chain {
        return Modal.Model.Chain(
            chainName = if (chainId == DEFAULT_CHAIN_ID) "Sepolia" else "EVM $chainId",
            chainNamespace = "eip155",
            chainReference = chainId.toString(),
            requiredMethods = methods,
            optionalMethods = methods,
            events = events,
            token = if (chainId == DEFAULT_CHAIN_ID) {
                Modal.Model.Token("Sepolia Ether", "SepoliaETH", 18)
            } else {
                Modal.Model.Token("Ether", "ETH", 18)
            },
            rpcUrl = null,
            blockExplorerUrl = if (chainId == DEFAULT_CHAIN_ID) "https://sepolia.etherscan.io" else null
        )
    }

    private fun stringArray(call: PluginCall, key: String, fallback: List<String>): List<String> {
        val array = call.data.optJSONArray(key) ?: return fallback
        return (0 until array.length())
            .mapNotNull { index -> array.optString(index).takeIf { it.isNotBlank() } }
            .ifEmpty { fallback }
    }

    private fun intArray(call: PluginCall, key: String, fallback: List<Int>): List<Int> {
        val array = call.data.optJSONArray(key) ?: return fallback
        return (0 until array.length())
            .mapNotNull { index ->
                when (val value = array.opt(index)) {
                    is Number -> value.toInt()
                    is String -> value.toIntOrNull()
                    else -> null
                }
            }
            .ifEmpty { fallback }
    }

    private fun paramsToJsonString(params: Any): String {
        return when (params) {
            is JSONArray -> params.toString()
            is JSONObject -> params.toString()
            is String -> params
            else -> JSONArray().put(params).toString()
        }
    }

    private fun putIfPresent(target: JSONObject, key: String, value: String?) {
        if (!value.isNullOrBlank()) {
            target.put(key, value)
        }
    }
}
