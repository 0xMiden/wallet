package com.miden.wallet

import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import org.junit.Assert.assertEquals
import org.junit.Test

class UpdateAvailabilityLogicTest {
    private fun snapshot(
        availability: Int = UpdateAvailability.UPDATE_AVAILABLE,
        availableVersionCode: Int? = 11700001,
        flexibleAllowed: Boolean = true,
        installStatus: Int = InstallStatus.UNKNOWN,
        playInstalled: Boolean = true,
    ) = PlayUpdateSnapshot(
        playInstalled = playInstalled,
        availability = availability,
        installStatus = installStatus,
        installedVersion = "1.16.0",
        installedVersionCode = 11600001,
        availableVersionCode = availableVersionCode,
        flexibleAllowed = flexibleAllowed,
    )

    @Test
    fun `maps no update without inventing availability`() {
        assertEquals(
            NativeUpdateResult("none", "1.16.0"),
            UpdateAvailabilityLogic.map(snapshot(availability = UpdateAvailability.UPDATE_NOT_AVAILABLE)),
        )
    }

    @Test
    fun `maps a flexible update to a user-started flow`() {
        assertEquals(
            NativeUpdateResult("available", "1.16.0", 11700001, NativeUpdateAction.START_FLEXIBLE),
            UpdateAvailabilityLogic.map(snapshot()),
        )
    }

    @Test
    fun `falls back to the compiled listing when flexible mode is unavailable`() {
        assertEquals(
            NativeUpdateAction.OPEN_LISTING,
            UpdateAvailabilityLogic.map(snapshot(flexibleAllowed = false)).action,
        )
    }

    @Test
    fun `marks a downloaded in-progress update ready for explicit completion`() {
        val result = UpdateAvailabilityLogic.map(
            snapshot(
                availability = UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS,
                installStatus = InstallStatus.DOWNLOADED,
            ),
        )

        assertEquals(NativeUpdateAction.COMPLETE, result.action)
    }

    @Test
    fun `keeps a developer-triggered download visible without restarting it`() {
        val result = UpdateAvailabilityLogic.map(
            snapshot(
                availability = UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS,
                installStatus = InstallStatus.DOWNLOADING,
            ),
        )

        assertEquals(NativeUpdateAction.OPEN_LISTING, result.action)
    }

    @Test
    fun `allows a canceled or failed flexible flow to be retried after a fresh check`() {
        for (status in listOf(InstallStatus.CANCELED, InstallStatus.FAILED)) {
            assertEquals(NativeUpdateAction.START_FLEXIBLE, UpdateAvailabilityLogic.map(snapshot(installStatus = status)).action)
        }
    }

    @Test
    fun `treats unknown stale and sideloaded signals as unknown`() {
        val cases = listOf(
            snapshot(availability = UpdateAvailability.UNKNOWN),
            snapshot(availableVersionCode = 11600001),
            snapshot(playInstalled = false),
            snapshot(availableVersionCode = null),
        )

        for (case in cases) assertEquals("unknown", UpdateAvailabilityLogic.map(case).status)
    }
}
