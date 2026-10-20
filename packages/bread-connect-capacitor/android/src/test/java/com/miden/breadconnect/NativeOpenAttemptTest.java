package com.miden.breadconnect;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class NativeOpenAttemptTest {

    private static final String LINK = "https://bread.miden.xyz/request#v=1&m=request";

    private static final class IO implements NativeOpenAttempt.IO, NativeOpenAttempt.Scheduler {
        final List<String> links = new ArrayList<>();
        final List<String> packages = new ArrayList<>();
        final List<Runnable> expiries = new ArrayList<>();
        boolean trusted = true;
        boolean wallet = true;
        boolean market = true;
        boolean web = true;
        int cancelledExpiries;
        final NativeOpenAttempt helper = new NativeOpenAttempt(this, this);

        public boolean isBread() { return trusted; }
        public boolean start(String link, String targetPackage) {
            links.add(link);
            packages.add(targetPackage);
            if (LINK.equals(link)) return wallet;
            if (NativeOpenAttempt.MARKET_URL.equals(link)) return market;
            return web;
        }
        public Runnable after(long delay, Runnable action) {
            assertEquals(30 * 60 * 1000L, delay);
            expiries.add(action);
            return () -> cancelledExpiries++;
        }
    }

    @Test
    public void prepareValidatesWithoutOpeningAndAllocatesUniqueHandles() {
        IO io = new IO();
        assertNull(io.helper.prepare(null));
        assertNull(io.helper.prepare("https://other.example/request#x"));
        String first = io.helper.prepare(LINK);
        String second = io.helper.prepare(LINK);
        assertNotNull(first);
        assertNotEquals(first, second);
        assertTrue(io.links.isEmpty());
    }

    @Test
    public void walletSuccessUsesOnlyBreadPackageAndRetiresHandle() {
        IO io = new IO();
        String id = io.helper.prepare(LINK);
        NativeOpenAttempt.Result result = io.helper.openStep(id, "wallet");
        assertTrue(result.opened);
        assertFalse(result.cancelled);
        assertNull(result.next);
        assertEquals(List.of(LINK), io.links);
        assertEquals(List.of(NativeOpenAttempt.BREAD_PACKAGE), io.packages);
        assertTrue(io.helper.openStep(id, "wallet").cancelled);
        assertEquals(1, io.cancelledExpiries);
    }

    @Test
    public void missingWalletDoesNotAutonomouslyOpenAnyStore() {
        IO io = new IO();
        io.wallet = false;
        NativeOpenAttempt.Result result = io.helper.openStep(io.helper.prepare(LINK), "wallet");
        assertFalse(result.opened);
        assertEquals("primaryStore", result.next);
        assertEquals(List.of(LINK), io.links);
    }

    @Test
    public void untrustedPackageNeverReceivesRequestAndMarketIsASeparateStep() {
        IO io = new IO();
        io.trusted = false;
        String id = io.helper.prepare(LINK);
        assertEquals("primaryStore", io.helper.openStep(id, "wallet").next);
        assertTrue(io.links.isEmpty());
        NativeOpenAttempt.Result result = io.helper.openStep(id, "primaryStore");
        assertFalse(result.opened);
        assertNull(result.next);
        assertEquals(List.of(NativeOpenAttempt.MARKET_URL), io.links);
        assertNull(io.packages.get(0));
    }

    @Test
    public void marketFailureRequiresASeparateHttpsStepEvenIfItAlsoFails() {
        IO io = new IO();
        io.wallet = false;
        io.market = false;
        io.web = false;
        String id = io.helper.prepare(LINK);
        io.helper.openStep(id, "wallet");
        assertEquals("secondaryStore", io.helper.openStep(id, "primaryStore").next);
        assertEquals(List.of(LINK, NativeOpenAttempt.MARKET_URL), io.links);
        NativeOpenAttempt.Result result = io.helper.openStep(id, "secondaryStore");
        assertFalse(result.opened);
        assertFalse(result.cancelled);
        assertNull(result.next);
        assertEquals(List.of(LINK, NativeOpenAttempt.MARKET_URL, NativeOpenAttempt.PLAY_URL), io.links);
        assertNull(io.packages.get(1));
        assertNull(io.packages.get(2));
    }

    @Test
    public void wrongUnknownAndRepeatedStepsDoNotCreatePermission() {
        IO io = new IO();
        String id = io.helper.prepare(LINK);
        assertTrue(io.helper.openStep("missing", "wallet").cancelled);
        assertTrue(io.helper.openStep(id, "primaryStore").cancelled);
        assertTrue(io.helper.openStep(id, "secondaryStore").cancelled);
        assertTrue(io.links.isEmpty());
        assertTrue(io.helper.openStep(id, "wallet").opened);
        assertTrue(io.helper.openStep(id, "wallet").cancelled);
        assertEquals(1, io.links.size());
    }

    @Test
    public void standaloneAggregatePreservesWalletMarketAndWebOrder() {
        IO io = new IO();
        assertTrue(io.helper.openWallet(LINK));
        assertEquals(List.of(LINK), io.links);
        io.links.clear();
        io.wallet = false;
        assertFalse(io.helper.openWallet(LINK));
        assertEquals(List.of(LINK, NativeOpenAttempt.MARKET_URL), io.links);
        io.links.clear();
        io.market = false;
        assertFalse(io.helper.openWallet(LINK));
        assertEquals(List.of(LINK, NativeOpenAttempt.MARKET_URL, NativeOpenAttempt.PLAY_URL), io.links);
    }

    @Test
    public void expiryAndLifecycleCleanupRetireIdleHandles() {
        IO io = new IO();
        String first = io.helper.prepare(LINK);
        String second = io.helper.prepare(LINK);
        io.expiries.get(0).run();
        assertTrue(io.helper.openStep(first, "wallet").cancelled);
        assertTrue(io.helper.openStep(second, "wallet").opened);
        String third = io.helper.prepare(LINK);
        io.helper.closeAll();
        io.helper.closeAll();
        assertNull(io.helper.prepare(LINK));
        assertTrue(io.helper.openStep(third, "wallet").cancelled);
        assertEquals(3, io.cancelledExpiries);
        assertEquals(List.of(LINK), io.links);
    }
}
