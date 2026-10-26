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

    private fun unknown(snapshot: PlayUpdateSnapshot) = NativeUpdateResult("unknown", snapshot.installedVersion)
}
