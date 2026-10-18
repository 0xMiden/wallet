package ee.forgr.capacitor_inappbrowser;

import org.junit.Test;
import static org.junit.Assert.*;

public class BreadAuthStateTest {
    private static final String CALLBACK = "com.miden.wallet.auth://callback?origin=https%3A%2F%2Fgame.example&login=a%2Fb&x=1";

    private static String rejection(Object url) {
        return BreadAuthState.rejection(true, "https", "game.example", -1, url);
    }

    private static String url(int length) {
        StringBuilder url = new StringBuilder("https://game.example/");
        while (url.length() < length) url.append('a');
        return url.toString();
    }

    @Test public void mainFrameIsCheckedFirst() {
        assertEquals(BreadAuthState.NOT_MAIN_FRAME, BreadAuthState.rejection(false, "http", "game.example", -1, "not a url"));
    }

    @Test public void nonHttpsOrOpaquePagesAreInsecure() {
        String url = "https://game.example/auth";
        assertEquals(BreadAuthState.INSECURE_PAGE, BreadAuthState.rejection(true, "http", "game.example", -1, url));
        assertEquals(BreadAuthState.INSECURE_PAGE, BreadAuthState.rejection(true, null, null, -1, url));
        assertEquals(BreadAuthState.INSECURE_PAGE, BreadAuthState.rejection(true, "https", "", -1, url));
    }

    @Test public void urlMustBeAbsoluteSameOriginHttps() {
        Object[] invalid = {
            null, 42, "", "/auth", "//game.example/auth", "http://game.example/auth",
            "HTTPS://game.example/auth", "https:game.example/auth", "https:/game.example/auth",
            "https:///game.example/auth", "https://other.example/auth", "https://game.example./auth",
            "https://game.example:444/auth", "https://game.example:8443/auth", "https://game.example:/auth",
            "https://game.example:0443/auth", "https://user@game.example/auth",
            "https://other.example\\@game.example/auth", "https://game.example/a b",
            "https://g\u00e4me.example/auth", url(4097), "https://game.example/auth#a#b",
            "https://game.example/%zz", "https://game.example/a%4", "https://game.example/auth?x=[1]",
            "https://game.example/[x]", "https://game.example/auth#[x]", "https://game.example/a]", "https://game.example/a%",
        };
        for (Object url : invalid) assertEquals(String.valueOf(url), BreadAuthState.INVALID_URL, rejection(url));
        assertEquals(4096, url(4096).length());
        for (String url : new String[] {
            "https://GAME.example:443/a?b#c", "https://GAME.example:443/auth?x=1#y", "https://GAME.example/auth",
            "https://game.example:443/auth", "https://game.example", "https://game.example?x=1", "https://game.example#x", url(4096),
            "https://game.example/a%2Fb?x=%41&y=/?#z?/", "https://game.example/auth?x=1#",
        }) assertNull(url, rejection(url));
    }

    @Test public void aNonDefaultPagePortMustBeWritten() {
        assertNull(BreadAuthState.rejection(true, "https", "game.example", 8443, "https://game.example:8443/auth"));
        for (String url : new String[] {"https://game.example/auth", "https://game.example:443/auth"}) {
            assertEquals(url, BreadAuthState.INVALID_URL, BreadAuthState.rejection(true, "https", "game.example", 8443, url));
        }
    }

    @Test public void theHostIsComparedAsWritten() {
        for (String host : new String[] {"xn--gme-sna.example", "my_game.example"}) {
            assertNull(host, BreadAuthState.rejection(true, "https", host, -1, "https://" + host + "/auth"));
        }
        assertEquals(BreadAuthState.INVALID_URL, rejection("https://g%61me.example/auth"));
    }

    @Test public void callbackAddressIsExactWithAnyQuery() {
        for (String url : new String[] {
            "com.miden.wallet.auth://callback", "com.miden.wallet.auth://callback?login=a%2Fb",
            "com.miden.wallet.auth://callback#f", "COM.MIDEN.WALLET.AUTH://callback",
        }) assertTrue(url, BreadAuthState.isCallback(url));
        for (String url : new String[] {
            "com.miden.wallet.auth://callbacks", "com.miden.wallet.auth://callback/", "com.miden.wallet.auth://callback/x",
            "com.miden.wallet.auth://other", "com.miden.wallet://callback", "com.m\u0131den.wallet.auth://callback",
        }) assertFalse(url, BreadAuthState.isCallback(url));
    }

    @Test public void oneSheetAtATime() {
        BreadAuthState state = new BreadAuthState();
        long stale = state.begin();
        state.release(stale);
        assertNull(state.refusal());
        long current = state.begin();
        assertEquals(BreadAuthState.BUSY, state.refusal());
        state.release(stale);
        assertEquals(BreadAuthState.BUSY, state.refusal());
        assertEquals(BreadAuthState.Phase.LAUNCHING, state.phase());
        state.release(current);
        assertNull(state.refusal());
        assertEquals(BreadAuthState.Phase.IDLE, state.phase());
    }

    @Test public void stoppedHostRefusesUnavailable() {
        BreadAuthState state = new BreadAuthState();
        state.stopped();
        assertEquals(BreadAuthState.UNAVAILABLE, state.refusal());
        assertEquals(BreadAuthState.Phase.IDLE, state.phase());
        assertEquals(BreadAuthState.Outcome.NONE, state.resumed());
        assertNull(state.refusal());
    }

    @Test public void anOpenSheetIsBusyBeforeTheStoppedHostIsUnavailable() {
        BreadAuthState state = new BreadAuthState();
        state.begin();
        state.stopped();
        assertEquals(BreadAuthState.BUSY, state.refusal());
    }

    @Test public void resumeAfterStopWithoutCallbackCancels() {
        BreadAuthState state = new BreadAuthState();
        state.begin();
        state.stopped();
        assertEquals(BreadAuthState.Phase.LAUNCHING, state.phase());
        assertEquals(BreadAuthState.Outcome.CANCELLED, state.resumed());
        assertEquals(BreadAuthState.Phase.IDLE, state.phase());
        assertEquals(BreadAuthState.Outcome.NONE, state.callback(CALLBACK));
    }

    @Test public void aResumeWithoutAStopCancels() {
        BreadAuthState state = new BreadAuthState();
        state.begin();
        assertEquals(BreadAuthState.Outcome.CANCELLED, state.resumed());
        assertEquals(BreadAuthState.Phase.IDLE, state.phase());
        assertEquals(BreadAuthState.Outcome.NONE, state.callback(CALLBACK));
        assertNull(state.refusal());
    }

    @Test public void callbackBeforeResumeResolvesAndResumeIsQuiet() {
        BreadAuthState state = new BreadAuthState();
        state.begin();
        state.stopped();
        assertEquals(BreadAuthState.Outcome.RESOLVED, state.callback(CALLBACK));
        assertEquals(BreadAuthState.Outcome.NONE, state.resumed());
        assertEquals(BreadAuthState.Phase.IDLE, state.phase());
    }

    @Test public void foreignCallbackWhileOpenFails() {
        BreadAuthState state = new BreadAuthState();
        state.begin();
        assertEquals(BreadAuthState.Outcome.FAILED, state.callback("com.miden.wallet.auth://callback/x"));
        assertEquals(BreadAuthState.Phase.IDLE, state.phase());
        assertNull(state.refusal());
    }

    @Test public void aCallbackMustNameTheOpeningPageOnce() {
        String address = "com.miden.wallet.auth://callback";
        for (String rest : new String[] {
            "?login=a", "?origin=https%3A%2F%2Fgame.example&origin=https%3A%2F%2Fgame.example", "?origin=https%3A%2F%2Fother.example",
            "?origin=https%3A%2F%2Fgame.example%3A8443", "?origin=https%3A%2F%2Fgame.example%2F", "?origin=http%3A%2F%2Fgame.example",
            "?origin=HTTPS%3A%2F%2Fgame.example", "?origin=https%3A%2F%2Fgame.example.", "?origin=https%3A%2F%2Fuser%40game.example",
            "?origin=https%3A%2F%2Fgame.example%zz", "?origin=", "?origin", "?Origin=https%3A%2F%2Fgame.example",
            "?%6Frigin=https%3A%2F%2Fgame.example", "?origin&origin=https%3A%2F%2Fgame.example",
            "#origin=https%3A%2F%2Fgame.example", "?x=1#&origin=https%3A%2F%2Fgame.example", "#?origin=https%3A%2F%2Fgame.example",
        }) {
            BreadAuthState state = new BreadAuthState();
            state.begin();
            assertNotEquals(rest, BreadAuthState.Outcome.RESOLVED, state.callback(address + rest));
            assertEquals(rest, BreadAuthState.Phase.IDLE, state.phase());
        }
        for (String callback : new String[] {
            address + "?login=a&origin=https%3A%2F%2FGAME.Example", address + "?origin=https://game.example",
            address + "?origin=https%3A%2F%2Fgame.example%3A443#f", "COM.MIDEN.WALLET.AUTH://callback?origin=https%3A%2F%2Fgame.example",
        }) {
            BreadAuthState state = new BreadAuthState();
            state.begin();
            assertEquals(callback, BreadAuthState.Outcome.RESOLVED, state.callback(callback));
        }
    }

    @Test public void callbackWithoutSheetIsIgnored() {
        BreadAuthState state = new BreadAuthState();
        assertEquals(BreadAuthState.Outcome.NONE, state.callback(CALLBACK));
        assertEquals(BreadAuthState.Phase.IDLE, state.phase());
    }
}
