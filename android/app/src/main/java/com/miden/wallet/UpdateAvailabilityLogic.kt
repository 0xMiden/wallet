package com.miden.wallet

import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability

enum class NativeUpdateAction {
    START_FLEXIBLE,
    COMPLETE,
    OPEN_LISTING,
}

data class PlayUpdateSnapshot(
    val playInstalled: Boolean,
    val availability: Int,
    val installStatus: Int,
    val installedVersion: String,
    val installedVersionCode: Int,
    val availableVersionCode: Int?,
    val flexibleAllowed: Boolean,
)

data class NativeUpdateResult(
    val status: String,
    val currentVersion: String,
    val availableVersionCode: Int? = null,
    val action: NativeUpdateAction? = null,
)

data class NativeUpdateProgress(val state: String, val percent: Int?)

object UpdateAvailabilityLogic {
    fun map(snapshot: PlayUpdateSnapshot): NativeUpdateResult {
        if (!snapshot.playInstalled) return unknown(snapshot)
        if (snapshot.availability == UpdateAvailability.UPDATE_NOT_AVAILABLE) {
            return NativeUpdateResult("none", snapshot.installedVersion)
        }
        if (
            snapshot.availability != UpdateAvailability.UPDATE_AVAILABLE &&
            snapshot.availability != UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS
        ) {
            return unknown(snapshot)
        }
        val availableCode = snapshot.availableVersionCode
        if (availableCode == null || availableCode <= snapshot.installedVersionCode) return unknown(snapshot)

        val action = when {
            snapshot.installStatus == InstallStatus.DOWNLOADED -> NativeUpdateAction.COMPLETE
            snapshot.availability == UpdateAvailability.UPDATE_AVAILABLE && snapshot.flexibleAllowed -> {
                NativeUpdateAction.START_FLEXIBLE
            }
            else -> NativeUpdateAction.OPEN_LISTING
        }
        return NativeUpdateResult("available", snapshot.installedVersion, availableCode, action)
    }

    fun progress(status: Int, downloadedBytes: Long, totalBytes: Long): NativeUpdateProgress = when (status) {
        InstallStatus.DOWNLOADING -> NativeUpdateProgress(
            "downloading",
            if (totalBytes > 0) ((downloadedBytes * 100) / totalBytes).coerceIn(0, 100).toInt() else null,
        )
        InstallStatus.DOWNLOADED -> NativeUpdateProgress("downloaded", 100)
        InstallStatus.CANCELED -> NativeUpdateProgress("canceled", null)
        InstallStatus.FAILED -> NativeUpdateProgress("failed", null)
        else -> NativeUpdateProgress("pending", null)
    }

    private fun unknown(snapshot: PlayUpdateSnapshot) = NativeUpdateResult("unknown", snapshot.installedVersion)
}
