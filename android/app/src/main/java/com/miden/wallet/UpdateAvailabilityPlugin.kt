package com.miden.wallet

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.UpdateAvailability

@CapacitorPlugin(name = "UpdateAvailability")
class UpdateAvailabilityPlugin : Plugin() {
    companion object {
        private const val PLAY_PACKAGE = "com.android.vending"
        private const val UPDATE_REQUEST_CODE = 821
        private const val PLAY_URI = "market://details?id=com.miden.wallet"
        private const val PLAY_WEB_URI = "https://play.google.com/store/apps/details?id=com.miden.wallet"
    }

    private val updateManager: AppUpdateManager by lazy { AppUpdateManagerFactory.create(context) }

    @PluginMethod
    fun check(call: PluginCall) {
        if (!isPlayInstall()) {
            call.resolve(resultToJs(UpdateAvailabilityLogic.map(snapshot(playInstalled = false))))
            return
        }
        updateManager.appUpdateInfo
            .addOnSuccessListener { info ->
                val result = UpdateAvailabilityLogic.map(snapshot(info))
                call.resolve(resultToJs(result))
            }
            .addOnFailureListener {
                call.resolve(resultToJs(UpdateAvailabilityLogic.map(snapshot())))
            }
    }

    @PluginMethod
    fun performUpdate(call: PluginCall) {
        if (!isPlayInstall()) return call.reject("Google Play update is unavailable")
        updateManager.appUpdateInfo
            .addOnSuccessListener { info ->
                val result = UpdateAvailabilityLogic.map(snapshot(info))
                when (result.action) {
                    NativeUpdateAction.COMPLETE -> completeUpdate(call)
                    NativeUpdateAction.START_FLEXIBLE -> startFlexibleUpdate(info, call)
                    NativeUpdateAction.OPEN_LISTING -> openPlayListing(call)
                    null -> call.reject("No Google Play update is available")
                }
            }
            .addOnFailureListener { call.reject("Google Play update check failed", it) }
    }

    // Play downloads a flexible update in the background. The card does not follow
    // that download: a later check reports the downloaded state, and its action
    // completes the install.
    private fun startFlexibleUpdate(info: AppUpdateInfo, call: PluginCall) {
        val currentActivity = activity ?: return call.reject("No activity is available")
        val started = updateManager.startUpdateFlowForResult(
            info,
            currentActivity,
            AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build(),
            UPDATE_REQUEST_CODE,
        )
        if (started) call.resolve(JSObject().put("started", true)) else call.reject("Google Play update did not start")
    }

    private fun completeUpdate(call: PluginCall) {
        updateManager.completeUpdate()
            .addOnSuccessListener { call.resolve(JSObject().put("started", true)) }
            .addOnFailureListener { call.reject("Google Play update installation failed", it) }
    }

    // Every arm settles the call: an unsettled one leaves the card's button
    // disabled on "Starting update" with no error and no retry.
    private fun openPlayListing(call: PluginCall) {
        val currentActivity = activity ?: return call.reject("No activity is available")
        try {
            currentActivity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PLAY_URI)))
        } catch (_: ActivityNotFoundException) {
            try {
                currentActivity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PLAY_WEB_URI)))
            } catch (error: Exception) {
                return call.reject("Google Play listing could not be opened", error)
            }
        }
        call.resolve(JSObject().put("started", true))
    }

    private fun snapshot(
        playInstalled: Boolean = true,
        availability: Int = com.google.android.play.core.install.model.UpdateAvailability.UNKNOWN,
        installStatus: Int = com.google.android.play.core.install.model.InstallStatus.UNKNOWN,
        availableVersionCode: Int? = null,
        flexibleAllowed: Boolean = false,
    ): PlayUpdateSnapshot {
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            packageInfo.longVersionCode.toInt()
        } else {
            @Suppress("DEPRECATION")
            packageInfo.versionCode
        }
        return PlayUpdateSnapshot(
            playInstalled = playInstalled,
            availability = availability,
            installStatus = installStatus,
            installedVersion = packageInfo.versionName ?: "",
            installedVersionCode = versionCode,
            availableVersionCode = availableVersionCode,
            flexibleAllowed = flexibleAllowed,
        )
    }

    private fun snapshot(info: AppUpdateInfo): PlayUpdateSnapshot {
        val availability = info.updateAvailability()
        val hasAvailableVersion = availability == UpdateAvailability.UPDATE_AVAILABLE ||
            availability == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS
        return snapshot(
            availability = availability,
            installStatus = info.installStatus(),
            availableVersionCode = if (hasAvailableVersion) info.availableVersionCode() else null,
            flexibleAllowed = availability == UpdateAvailability.UPDATE_AVAILABLE &&
                info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE),
        )
    }

    private fun isPlayInstall(): Boolean = try {
        val installer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.getInstallerPackageName(context.packageName)
        }
        installer == PLAY_PACKAGE
    } catch (_: Exception) {
        false
    }

    private fun resultToJs(result: NativeUpdateResult) = JSObject().apply {
        put("status", result.status)
        put("currentVersion", result.currentVersion)
        result.availableVersionCode?.let { put("availableVersionCode", it) }
    }
}
