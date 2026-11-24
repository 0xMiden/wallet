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

    @Test
    public void revokeBeforeDelayedWalletCommandPreventsNativeOpen() {
        IO io = new IO();
        String id = io.helper.prepare(LINK);
        assertNotNull(id);
        assertTrue(io.links.isEmpty());
        io.helper.revoke(id);
        io.helper.revoke(id);
        // Return from revoke is the acknowledgement boundary of the real plugin binding.
        NativeOpenAttempt.Result result = io.helper.openStep(id, "wallet");
        assertEquals(0, io.links.size());
        assertTrue(result.cancelled);
        assertFalse(result.opened);
        assertNull(result.next);
        assertEquals(1, io.cancelledExpiries);
    }

    @Test
    public void revokedMarketHandleCannotAdmitStore() {
        IO io = new IO();
        io.wallet = false;
        String id = io.helper.prepare(LINK);
        assertEquals("primaryStore", io.helper.openStep(id, "wallet").next);
        io.helper.revoke(id);
        NativeOpenAttempt.Result result = io.helper.openStep(id, "primaryStore");
        assertEquals(0, io.links.stream().filter(NativeOpenAttempt.MARKET_URL::equals).count());
        assertTrue(result.cancelled);
        assertNull(result.next);
        assertEquals(List.of(LINK), io.links);
    }

    @Test
    public void revokedHttpsHandleCannotAdmitStore() {
        IO io = new IO();
        io.wallet = false;
        io.market = false;
        String id = io.helper.prepare(LINK);
        io.helper.openStep(id, "wallet");
        assertEquals("secondaryStore", io.helper.openStep(id, "primaryStore").next);
        io.helper.revoke(id);
        NativeOpenAttempt.Result result = io.helper.openStep(id, "secondaryStore");
        assertEquals(0, io.links.stream().filter(NativeOpenAttempt.PLAY_URL::equals).count());
        assertTrue(result.cancelled);
        assertNull(result.next);
        assertEquals(List.of(LINK, NativeOpenAttempt.MARKET_URL), io.links);
    }

    @Test
    public void revokingOldHandleDoesNotRevokeReplacement() {
        IO io = new IO();
        String old = io.helper.prepare(LINK);
        String replacement = io.helper.prepare(LINK);
        io.helper.revoke(old);
        assertTrue(io.helper.openStep(replacement, "wallet").opened);
        assertEquals(1, io.links.size());
        NativeOpenAttempt.Result denied = io.helper.openStep(old, "wallet");
        assertEquals(1, io.links.size());
        assertTrue(denied.cancelled);
        io.helper.revoke(old);
        assertTrue(io.helper.openStep(replacement, "wallet").cancelled);
        assertEquals(2, io.cancelledExpiries);
    }

    @Test
    public void synchronousNativeIoCanReenterRevokeWithoutRetractingAdmittedIo() {
        List<String> launches = new ArrayList<>();
        NativeOpenAttempt[] helpers = new NativeOpenAttempt[1];
        String[] ids = new String[1];
        NativeOpenAttempt.IO nativeIo = new NativeOpenAttempt.IO() {
            public boolean isBread() { return true; }
            public boolean start(String link, String targetPackage) {
                launches.add(link);
                helpers[0].revoke(ids[0]);
                return false;
            }
        };
        helpers[0] = new NativeOpenAttempt(nativeIo, (delay, action) -> () -> {});
        ids[0] = helpers[0].prepare(LINK);
        NativeOpenAttempt.Result result = helpers[0].openStep(ids[0], "wallet");
        // This I/O was admitted before revoke. Only future admission must be forbidden.
        assertEquals(List.of(LINK), launches);
        assertTrue(result.cancelled);
        assertFalse(result.opened);
        assertNull(result.next);
        NativeOpenAttempt.Result replay = helpers[0].openStep(ids[0], "primaryStore");
        assertEquals(List.of(LINK), launches);
        assertTrue(replay.cancelled);
    }

    @Test
    public void expiryDuringAdmittedIoKeepsItsResultNeutralAndRetiresPermission() {
        List<String> launches = new ArrayList<>();
        List<Runnable> expiries = new ArrayList<>();
        int[] cancelled = { 0 };
        NativeOpenAttempt helper = new NativeOpenAttempt(new NativeOpenAttempt.IO() {
            public boolean isBread() { return true; }
            public boolean start(String link, String targetPackage) {
                launches.add(link);
                expiries.get(0).run();
                return false;
            }
        }, (delay, action) -> {
            expiries.add(action);
            return () -> cancelled[0]++;
        });
        String id = helper.prepare(LINK);
        NativeOpenAttempt.Result result = helper.openStep(id, "wallet");
        assertTrue(result.cancelled);
        assertNull(result.next);
        assertEquals(List.of(LINK), launches);
        assertTrue(helper.openStep(id, "primaryStore").cancelled);
        helper.revoke(id);
        helper.closeAll();
        assertEquals(1, cancelled[0]);
    }

    @Test
    public void lifecycleDuringAdmittedIoDoesNotCreateFallbackPermission() {
        List<String> launches = new ArrayList<>();
        NativeOpenAttempt[] helpers = new NativeOpenAttempt[1];
        helpers[0] = new NativeOpenAttempt(new NativeOpenAttempt.IO() {
            public boolean isBread() { return true; }
            public boolean start(String link, String targetPackage) {
                launches.add(link);
                helpers[0].closeAll();
                return false;
            }
        }, (delay, action) -> () -> {});
        String id = helpers[0].prepare(LINK);
        NativeOpenAttempt.Result result = helpers[0].openStep(id, "wallet");
        assertEquals(List.of(LINK), launches);
        assertTrue(result.cancelled);
        assertNull(result.next);
        assertTrue(helpers[0].openStep(id, "primaryStore").cancelled);
        assertNull(helpers[0].prepare(LINK));
    }

    @Test
    public void everyNormalTerminalPathRetiresHandleAndExpiryOnce() {
        for (String terminal : List.of("wallet", "primaryStore", "secondaryStore")) {
            IO io = new IO();
            io.wallet = "wallet".equals(terminal);
            io.market = !"secondaryStore".equals(terminal);
            String id = io.helper.prepare(LINK);
            NativeOpenAttempt.Result result = io.helper.openStep(id, "wallet");
            if (!"wallet".equals(terminal)) result = io.helper.openStep(id, "primaryStore");
            if ("secondaryStore".equals(terminal)) result = io.helper.openStep(id, "secondaryStore");
            assertFalse(result.cancelled);
            assertNull(result.next);
            int admitted = io.links.size();
            io.helper.revoke(id);
            io.expiries.get(0).run();
            io.helper.closeAll();
            for (String step : List.of("wallet", "primaryStore", "secondaryStore")) {
                assertTrue(io.helper.openStep(id, step).cancelled);
            }
            assertEquals(admitted, io.links.size());
            assertEquals(1, io.cancelledExpiries);
        }
    }
}
