package com.miden.wallet

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import androidx.activity.result.ActivityResult
import cl.kgames.capacitorbarcodescanner.BarcodeScannerPlugin
import cl.kgames.capacitorbarcodescanner.ScannerActivity
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class BarcodeScannerOutcomeTest {
    private class ScanCall : PluginCall(null, "BarcodeScanner", "fixture", "scan", JSObject()) {
        val rejections = mutableListOf<String?>()
        val resolutions = mutableListOf<JSObject>()

        override fun reject(message: String?) {
            rejections.add(message)
        }

        override fun resolve(result: JSObject) {
            resolutions.add(result)
        }
    }

    @Test
    fun backBeforeADecodeRejectsAsCancellation() {
        val scanner = scanner()
        // Start where Android hands off Back so Robolectric cannot bypass ScannerActivity.finish().
        scanner.finishAfterTransition()

        val call = deliver(resultOf(scanner))
        assertEquals(listOf("Scan cancelled"), call.rejections)
        assertTrue(call.resolutions.isEmpty())
    }

    @Test
    fun activityCameraDenialRejectsAsPermissionDenied() {
        val scanner = scanner()
        shadowOf(scanner).denyPermissions(Manifest.permission.CAMERA)
        scanner.onRequestPermissionsResult(
            1,
            arrayOf(Manifest.permission.CAMERA),
            intArrayOf(PackageManager.PERMISSION_DENIED)
        )

        val call = deliver(resultOf(scanner))
        assertEquals(listOf("User denied access to camera"), call.rejections)
        assertTrue(call.resolutions.isEmpty())
    }

    @Test
    fun decodedSingleScanResolvesWithTheBarcode() {
        val scanner = scanner()
        val code = "mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph"
        ReflectionHelpers.callInstanceMethod<Unit>(
            scanner,
            "closeActivity",
            ClassParameter.from(String::class.java, code)
        )

        val call = deliver(resultOf(scanner))
        assertTrue(call.rejections.isEmpty())
        val result = call.resolutions.single()
        assertTrue(result.getBoolean("result"))
        assertEquals(code, result.getString("code"))
    }

    @Test
    fun unclassifiedEmptyResultStillResolvesAsAnUnreadBarcode() {
        val call = deliver(ActivityResult(Activity.RESULT_OK, Intent()))

        assertTrue(call.rejections.isEmpty())
        assertEquals(false, call.resolutions.single().getBoolean("result"))
    }

    @Test
    fun finishingMultiScanPreservesTheCollectedCodesAndEmptyResult() {
        for (codes in listOf(arrayOf("synthetic-first", "synthetic-second"), emptyArray<String>())) {
            val scanner = scanner()
            ReflectionHelpers.setField(scanner, "multiScan", true)
            ReflectionHelpers.setField(scanner, "resultCodes", codes)
            scanner.finish()

            val call = deliver(resultOf(scanner))
            assertTrue(call.rejections.isEmpty())
            val result = call.resolutions.single()
            assertEquals(codes.isNotEmpty(), result.getBoolean("result"))
            assertEquals(codes.size, result.getInt("count"))
            val actual = result.getJSONArray("codes")
            assertEquals(codes.toList(), (0 until actual.length()).map { actual.getString(it) })
        }
    }

    // Attach the activity without starting CameraX or requiring a physical camera.
    private fun scanner(): ScannerActivity = Robolectric.buildActivity(ScannerActivity::class.java).get()

    private fun resultOf(scanner: ScannerActivity): ActivityResult {
        assertTrue("Scanner should finish after settling the scan", scanner.isFinishing)
        val activity = shadowOf(scanner)
        return ActivityResult(activity.resultCode, activity.resultIntent)
    }

    private fun deliver(result: ActivityResult): ScanCall = ScanCall().also { call ->
        ReflectionHelpers.callInstanceMethod<Unit>(
            BarcodeScannerPlugin(),
            "onScan",
            ClassParameter.from(PluginCall::class.java, call),
            ClassParameter.from(ActivityResult::class.java, result)
        )
    }
}
