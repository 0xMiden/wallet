package com.miden.wallet

import android.app.Activity
import android.content.Intent
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope

/**
 * Native Google OAuth bridge for cloud backup on Android.
 *
 * Uses the Google Identity Services `AuthorizationClient` (Google Play Services)
 * to obtain an OAuth access token for the requested scopes — native UI, no
 * browser redirect or custom URI scheme. The OAuth client is picked up
 * implicitly from the app's package name + signing SHA-1 (registered as an
 * Android-type OAuth client in Google Cloud Console), so no client ID needs
 * to be passed in from JS.
 *
 * Access tokens returned by this API live ~1 hour; Google manages silent
 * refresh internally on subsequent `signInSilently` calls — we don't persist
 * a refresh token on device (matches chrome.identity behavior on the
 * extension path).
 */
@CapacitorPlugin(name = "GoogleAuthAndroid")
class GoogleAuthPlugin : Plugin() {

    companion object {
        private const val TAG = "GoogleAuthAndroid"
        private const val REQUEST_AUTHORIZE = 9001
        // Google access tokens live ~1h; use a slightly conservative expiry so the
        // JS layer eagerly re-requests via signInSilently (which returns cached).
        private const val TOKEN_LIFETIME_SECONDS = 55 * 60
    }

    private var pendingCall: PluginCall? = null

    @PluginMethod
    fun signIn(call: PluginCall) {
        authorize(call, interactive = true)
    }

    @PluginMethod
    fun signInSilently(call: PluginCall) {
        authorize(call, interactive = false)
    }

    private fun authorize(call: PluginCall, interactive: Boolean) {
        val scopesArray: JSArray = call.getArray("scopes") ?: run {
            call.reject("scopes array is required")
            return
        }

        val scopes = try {
            (0 until scopesArray.length()).map { Scope(scopesArray.getString(it)) }
        } catch (e: Exception) {
            call.reject("scopes must be an array of strings", e)
            return
        }

        val request = AuthorizationRequest.Builder()
            .setRequestedScopes(scopes)
            .build()

        Identity.getAuthorizationClient(activity)
            .authorize(request)
            .addOnSuccessListener { result ->
                if (result.hasResolution()) {
                    // User consent required.
                    if (!interactive) {
                        // Silent mode — signal that interactive auth is needed
                        // without triggering any UI.
                        val ret = JSObject()
                        ret.put("needsConsent", true)
                        call.resolve(ret)
                        return@addOnSuccessListener
                    }
                    val pendingIntent = result.pendingIntent ?: run {
                        call.reject("Authorization requires consent but no pending intent was returned")
                        return@addOnSuccessListener
                    }
                    try {
                        pendingCall = call
                        activity.startIntentSenderForResult(
                            pendingIntent.intentSender,
                            REQUEST_AUTHORIZE,
                            null,
                            0,
                            0,
                            0,
                            null
                        )
                    } catch (e: Exception) {
                        pendingCall = null
                        call.reject("Failed to launch authorization consent: ${e.message}", e)
                    }
                } else {
                    resolveWithResult(call, result)
                }
            }
            .addOnFailureListener { e ->
                Log.w(TAG, "authorize failed", e)
                call.reject("Authorization failed: ${e.message}", e)
            }
    }

    override fun handleOnActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.handleOnActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_AUTHORIZE) return

        val call = pendingCall ?: return
        pendingCall = null

        if (resultCode != Activity.RESULT_OK) {
            call.reject("User cancelled Google authorization")
            return
        }

        try {
            val result = Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(data)
            resolveWithResult(call, result)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse authorization result", e)
            call.reject("Failed to parse authorization result: ${e.message}", e)
        }
    }

    private fun resolveWithResult(call: PluginCall, result: AuthorizationResult) {
        val accessToken = result.accessToken
        if (accessToken == null) {
            call.reject("Authorization succeeded but no access token was returned")
            return
        }
        val ret = JSObject()
        ret.put("accessToken", accessToken)
        ret.put("grantedScopes", JSArray(result.grantedScopes))
        ret.put("expiresIn", TOKEN_LIFETIME_SECONDS)
        call.resolve(ret)
    }
}
