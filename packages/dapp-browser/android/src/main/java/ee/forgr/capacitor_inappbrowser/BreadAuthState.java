package ee.forgr.capacitor_inappbrowser;

import java.net.URI;
import java.net.URISyntaxException;

final class BreadAuthState {
    static final String CALLBACK_SCHEME = "com.miden.wallet.auth";
    static final String CALLBACK_ADDRESS = "com.miden.wallet.auth://callback";
    static final int MAX_URL_LENGTH = 4096;
    static final String NOT_MAIN_FRAME = "AUTH_NOT_MAIN_FRAME", INSECURE_PAGE = "AUTH_INSECURE_PAGE",
        INVALID_URL = "AUTH_INVALID_URL", BUSY = "AUTH_BUSY", UNAVAILABLE = "AUTH_UNAVAILABLE", FAILED = "AUTH_FAILED";
    enum Phase { IDLE, LAUNCHING, AWAY }
    enum Outcome { NONE, RESOLVED, CANCELLED, FAILED }

    private Phase phase = Phase.IDLE;
    private long ticket;
    private boolean hostStopped;

    static String rejection(boolean mainFrame, String pageScheme, String pageHost, int pagePort, Object url) {
        if (!mainFrame) return NOT_MAIN_FRAME;
        if (!"https".equals(pageScheme) || pageHost == null || pageHost.isEmpty()) return INSECURE_PAGE;
        if (!(url instanceof String)) return INVALID_URL;
        String text = (String) url;
        if (text.isEmpty() || text.length() > MAX_URL_LENGTH) return INVALID_URL;
        for (int i = 0; i < text.length(); i++) if (!allowed(text.charAt(i))) return INVALID_URL;
        URI uri;
        try { uri = new URI(text); } catch (URISyntaxException e) { return INVALID_URL; }
        String host = uri.getHost();
        if (!"https".equals(uri.getScheme()) || host == null || host.isEmpty() || uri.getRawUserInfo() != null) return INVALID_URL;
        if (host.length() != pageHost.length() || !startsWithIgnoringAsciiCase(host, pageHost)) return INVALID_URL;
        int port = uri.getPort();
        return (port < 0 ? 443 : port) == (pagePort < 0 ? 443 : pagePort) ? null : INVALID_URL;
    }

    static boolean isCallback(String url) {
        if (!startsWithIgnoringAsciiCase(url, CALLBACK_ADDRESS)) return false;
        if (url.length() == CALLBACK_ADDRESS.length()) return true;
        char next = url.charAt(CALLBACK_ADDRESS.length());
        return next == '?' || next == '#';
    }

    // ASCII only: equalsIgnoreCase would also fold U+0131 onto 'i' and U+212A onto 'k'.
    static boolean startsWithIgnoringAsciiCase(String text, String prefix) {
        if (text.length() < prefix.length()) return false;
        for (int i = 0; i < prefix.length(); i++) {
            if (asciiLower(text.charAt(i)) != asciiLower(prefix.charAt(i))) return false;
        }
        return true;
    }

    private static char asciiLower(char c) { return c >= 'A' && c <= 'Z' ? (char) (c + ('a' - 'A')) : c; }

    private static boolean allowed(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
            || "-._~:/?#[]@!$&'()*+,;=%".indexOf(c) >= 0;
    }

    String refusal() {
        if (phase != Phase.IDLE) return BUSY;
        return hostStopped ? UNAVAILABLE : null;
    }
    long begin() { phase = Phase.LAUNCHING; return ++ticket; }

    // Only a stop moves a launch away: a pause alone (a system dialog, a permission prompt) keeps it.
    void stopped() {
        hostStopped = true;
        if (phase == Phase.LAUNCHING) phase = Phase.AWAY;
    }
    Outcome resumed() {
        hostStopped = false;
        if (phase != Phase.AWAY) return Outcome.NONE;
        phase = Phase.IDLE;
        return Outcome.CANCELLED;
    }
    Outcome callback(String url) {
        if (phase == Phase.IDLE) return Outcome.NONE;
        phase = Phase.IDLE;
        return isCallback(url) ? Outcome.RESOLVED : Outcome.FAILED;
    }
    void release(long ticket) { if (ticket == this.ticket) phase = Phase.IDLE; }
    Phase phase() { return phase; }
}
