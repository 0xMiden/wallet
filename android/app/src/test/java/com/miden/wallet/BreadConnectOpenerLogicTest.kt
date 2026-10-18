package com.miden.wallet

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BreadConnectOpenerLogicTest {
    private val print = (0 until 32).joinToString(":") { "%02X".format(it * 7) }
    private val bytes = ByteArray(32) { (it * 7).toByte() }

    @Test
    fun `reads a fingerprint as assetlinks json writes it, in either case`() {
        assertArrayEquals(bytes, BreadConnectOpenerLogic.fingerprint(print))
        assertArrayEquals(bytes, BreadConnectOpenerLogic.fingerprint(print.lowercase()))
    }

    @Test
    fun `refuses a fingerprint of the wrong length or with a byte that is not two hex digits`() {
        assertNull(BreadConnectOpenerLogic.fingerprint(print.substringBeforeLast(':')))
        assertNull(BreadConnectOpenerLogic.fingerprint("$print:00"))
        assertNull(BreadConnectOpenerLogic.fingerprint(print.replaceFirst("00", "+0")))
        assertNull(BreadConnectOpenerLogic.fingerprint(print.replaceFirst("00", "0")))
        assertNull(BreadConnectOpenerLogic.fingerprint(print.replaceFirst("00", "0G")))
    }

    @Test
    fun `takes an android app that may handle all urls, keeping only its well-formed fingerprints`() {
        val target = BreadConnectOpenerLogic.target(
            listOf("delegate_permission/common.get_login_creds", BreadConnectOpenerLogic.HANDLE_ALL_URLS),
            "android_app",
            "com.example.game",
            listOf("not a fingerprint", print),
        )
        assertEquals("com.example.game", target?.packageName)
        assertEquals(1, target?.fingerprints?.size)
        assertArrayEquals(bytes, target?.fingerprints?.first())
    }

    @Test
    fun `ignores a statement that does not let an android app handle all urls`() {
        val all = listOf(BreadConnectOpenerLogic.HANDLE_ALL_URLS)
        assertNull(BreadConnectOpenerLogic.target(listOf("delegate_permission/common.get_login_creds"), "android_app", "com.example.game", listOf(print)))
        assertNull(BreadConnectOpenerLogic.target(all, "web", "com.example.game", listOf(print)))
        assertNull(BreadConnectOpenerLogic.target(all, "android_app", null, listOf(print)))
        assertNull(BreadConnectOpenerLogic.target(all, "android_app", "", listOf(print)))
        assertNull(BreadConnectOpenerLogic.target(all, "android_app", "com.example.game", listOf("AB:CD")))
    }
}
