package com.miden.wallet

import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.security.InvalidAlgorithmParameterException
import java.security.ProviderException
import javax.crypto.BadPaddingException
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class HotKeyPluginUnwrapDiagnosticTest {
    private class RecordingCall : PluginCall(null, "HotKey", "fixture", "signWithHotKey", JSObject()) {
        var rejectedCode: String? = null
        var rejectedData: JSObject? = null

        override fun reject(message: String?, code: String?, exception: Exception?, data: JSObject?) {
            rejectedCode = code
            rejectedData = data
        }
    }

    @Test
    fun reportsParameterRefusalWithoutChangingTheRotationCode() {
        assertUnwrapDiagnostic(InvalidAlgorithmParameterException("synthetic provider detail"), "parameters_refused")
    }

    @Test
    fun reportsDecryptRejectionWithoutChangingTheRotationCode() {
        assertUnwrapDiagnostic(BadPaddingException("synthetic provider detail"), "decrypt_rejected")
    }

    @Test
    fun reportsAnUnclassifiedProviderFailureAsUnknown() {
        assertUnwrapDiagnostic(ProviderException("synthetic provider detail"), "unknown")
    }

    private fun assertUnwrapDiagnostic(cause: Exception, category: String) {
        val call = RecordingCall()
        val rejection = HotKeyPlugin::class.java.getDeclaredMethod(
            "rejectClassified",
            PluginCall::class.java,
            String::class.java,
            Exception::class.java
        ).apply { isAccessible = true }
        rejection.invoke(HotKeyPlugin(), call, "Hot-key sign failed", UnwrapFailedException("unwrap failed", cause))

        assertEquals("UNWRAP_FAILED", call.rejectedCode)
        val data = call.rejectedData
        assertEquals(category, data?.optString("unwrapFailure"))
        assertEquals(setOf("unwrapFailure"), data?.keys()?.asSequence()?.toSet())
    }
}
