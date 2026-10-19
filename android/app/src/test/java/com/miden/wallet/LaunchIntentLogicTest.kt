package com.miden.wallet

import android.content.Intent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LaunchIntentLogicTest {
    @Test
    fun `an activity restored after its process died already delivered its launch link`() {
        assertTrue(LaunchIntentLogic.alreadyDelivered(true, 0))
    }

    @Test
    fun `an activity reopened from Recents already delivered its launch link`() {
        assertTrue(LaunchIntentLogic.alreadyDelivered(false, Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY))
    }

    @Test
    fun `a fresh launch delivers its link`() {
        assertFalse(LaunchIntentLogic.alreadyDelivered(false, Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
