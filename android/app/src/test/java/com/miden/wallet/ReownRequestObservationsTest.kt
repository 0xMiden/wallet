package com.miden.wallet

import org.junit.Assert.assertEquals
import org.junit.Test

class ReownRequestObservationsTest {
    @Test
    fun categorizesWalletRejectionBeforePluginWiring() {
        val helper = Class.forName("com.miden.wallet.ReownRequestObservationsKt")
        val category = requireNotNull(helper.getMethod("walletResponseCategory", Int::class.javaObjectType).invoke(null, 4001))
        assertEquals("user_rejected", category.javaClass.getMethod("getWire").invoke(category))
    }
}
