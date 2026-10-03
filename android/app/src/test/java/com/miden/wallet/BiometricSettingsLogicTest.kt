package com.miden.wallet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/// Plain-JVM coverage for the Open-Settings fallback chain (BiometricSettingsLogic):
/// no Activity, no Android Settings intents - `launch` is a plain lambda the test
/// controls, raising `java.lang` exceptions in place of the real
/// ActivityNotFoundException / SecurityException a stub Settings activity throws.
class BiometricSettingsLogicTest {

    @Test
    fun launchFirst_returnsTheFirstActionWhenItStartsAndLaunchesNothingElse() {
        val launched = mutableListOf<String>()

        val result = BiometricSettingsLogic.launchFirst(listOf("a", "b", "c")) { action -> launched.add(action) }

        assertEquals("a", result)
        assertEquals(listOf("a"), launched)
    }

    @Test
    fun launchFirst_movesOnWhenAnActionThrowsIllegalStateException() {
        val launched = mutableListOf<String>()

        val result = BiometricSettingsLogic.launchFirst(listOf("a", "b", "c")) { action ->
            launched.add(action)
            if (action == "a") throw IllegalStateException("no activity handles a")
        }

        assertEquals(listOf("a", "b"), launched)
        assertEquals("b", result)
    }

    @Test
    fun launchFirst_movesOnWhenAnActionThrowsSecurityException() {
        val launched = mutableListOf<String>()

        val result = BiometricSettingsLogic.launchFirst(listOf("a", "b", "c")) { action ->
            launched.add(action)
            if (action == "a") throw SecurityException("permission denied for a")
        }

        assertEquals(listOf("a", "b"), launched)
        assertEquals("b", result)
    }

    @Test
    fun launchFirst_returnsNullAfterEveryActionThrows() {
        val launched = mutableListOf<String>()

        val result = BiometricSettingsLogic.launchFirst(listOf("a", "b", "c")) { action ->
            launched.add(action)
            throw IllegalStateException("no activity handles $action")
        }

        assertEquals(listOf("a", "b", "c"), launched)
        assertNull(result)
    }
}
