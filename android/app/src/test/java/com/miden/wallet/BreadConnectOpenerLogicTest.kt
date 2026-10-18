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

    private val other = ByteArray(32) { 1.toByte() }
    private val signedWith = mapOf("com.example.lacks" to bytes, "com.example.game" to bytes, "com.example.later" to bytes)
    private val handlers = setOf("com.example.other", "com.example.game", "com.example.later")

    private fun verified(vararg targets: AssetLinkTarget) = BreadConnectOpenerLogic.verifiedPackage(
        targets.toList(),
        { name, fingerprint -> signedWith[name]?.contentEquals(fingerprint) == true },
        { name -> name in handlers },
    )

    @Test
    fun `hands the link to the first named app signed with a certificate its statement lists that handles it`() {
        assertEquals(
            "com.example.game",
            verified(
                AssetLinkTarget("com.example.other", listOf(bytes)),
                AssetLinkTarget("com.example.lacks", listOf(bytes)),
                AssetLinkTarget("com.example.game", listOf(other, bytes)),
                AssetLinkTarget("com.example.later", listOf(bytes)),
            ),
        )
    }

    @Test
    fun `hands the link to no app signed with another certificate or not handling it`() {
        assertNull(verified(AssetLinkTarget("com.example.game", listOf(other))))
        assertNull(verified(AssetLinkTarget("com.example.other", listOf(bytes))))
        assertNull(verified(AssetLinkTarget("com.example.lacks", listOf(bytes))))
        assertNull(verified())
    }
}
