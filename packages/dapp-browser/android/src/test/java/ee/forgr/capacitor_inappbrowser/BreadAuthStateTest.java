package ee.forgr.capacitor_inappbrowser;

import org.junit.Test;
import static org.junit.Assert.*;

public class BreadAuthStateTest {
    private static final String CALLBACK = "com.miden.wallet.auth://callback?login=a%2Fb&x=1";

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
            null, 42, "", "/auth", "//game.example/auth", "http://game.example/auth", "https://other.example/auth",
            "https://game.example:444/auth", "https://user@game.example/auth", "https://game.example\\@other.example/auth",
            "https://game.example/a b", "https://g\u00e4me.example/auth", url(4097),
            "HTTPS://game.example/auth", "https://g%61me.example/auth",
        };
        for (Object url : invalid) assertEquals(String.valueOf(url), BreadAuthState.INVALID_URL, rejection(url));
        assertNull(rejection("https://GAME.example:443/a?b#c"));
        assertEquals(4096, url(4096).length());
        assertNull(rejection(url(4096)));
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

    @Test public void resumeAfterStopWithoutCallbackCancels() {
        BreadAuthState state = new BreadAuthState();
        state.begin();
        state.stopped();
        assertEquals(BreadAuthState.Phase.AWAY, state.phase());
        assertEquals(BreadAuthState.Outcome.CANCELLED, state.resumed());
        assertEquals(BreadAuthState.Phase.IDLE, state.phase());
        assertEquals(BreadAuthState.Outcome.NONE, state.callback(CALLBACK));
    }

    @Test public void aPauseAloneKeepsTheSheet() {
        BreadAuthState state = new BreadAuthState();
        state.begin();
        assertEquals(BreadAuthState.Outcome.NONE, state.resumed());
        assertEquals(BreadAuthState.Phase.LAUNCHING, state.phase());
        assertEquals(BreadAuthState.Outcome.RESOLVED, state.callback(CALLBACK));
        assertEquals(BreadAuthState.Phase.IDLE, state.phase());
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

    @Test public void callbackWithoutSheetIsIgnored() {
        BreadAuthState state = new BreadAuthState();
        assertEquals(BreadAuthState.Outcome.NONE, state.callback(CALLBACK));
        assertEquals(BreadAuthState.Phase.IDLE, state.phase());
    }
}
