package ee.forgr.capacitor_inappbrowser;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;

final class BreadAuthState {
    static final String CALLBACK_SCHEME = "com.miden.wallet.auth";
    static final String CALLBACK_ADDRESS = "com.miden.wallet.auth://callback";
    static final int MAX_URL_LENGTH = 4096;
    static final String NOT_MAIN_FRAME = "AUTH_NOT_MAIN_FRAME", INSECURE_PAGE = "AUTH_INSECURE_PAGE",
        INVALID_URL = "AUTH_INVALID_URL", BUSY = "AUTH_BUSY", UNAVAILABLE = "AUTH_UNAVAILABLE",
        ORIGIN_MISMATCH = "AUTH_ORIGIN_MISMATCH", FAILED = "AUTH_FAILED";
    enum Phase { IDLE, LAUNCHING }
    enum Outcome { NONE, RESOLVED, CANCELLED, FAILED, MISMATCH }

    private Phase phase = Phase.IDLE;
    private long ticket;
    private boolean hostPaused;
    private String openerHost;
    private int openerPort;

    static String rejection(boolean mainFrame, String pageScheme, String pageHost, int pagePort, Object url) {
        if (!mainFrame) return NOT_MAIN_FRAME;
        if (!"https".equals(pageScheme) || pageHost == null || pageHost.isEmpty()) return INSECURE_PAGE;
        if (!(url instanceof String)) return INVALID_URL;
        String text = (String) url;
        if (text.isEmpty() || text.length() > MAX_URL_LENGTH) return INVALID_URL;
        for (int i = 0; i < text.length(); i++) if (!allowed(text.charAt(i))) return INVALID_URL;
        if (!authorityMatches(text, pageHost, pagePort < 0 ? 443 : pagePort)) return INVALID_URL;
        return restIsValid(text) ? null : INVALID_URL;
    }

    // The authority is compared as written: platform URL parsers decode some hosts and refuse others.
    private static boolean authorityMatches(String text, String host, int port) {
        String https = "https://";
        if (!text.startsWith(https)) return false;
        int end = https.length();
        while (end < text.length() && "/?#".indexOf(text.charAt(end)) < 0) end++;
        String authority = text.substring(https.length(), end);
        return equalsIgnoringAsciiCase(authority, host + ":" + port) || (port == 443 && equalsIgnoringAsciiCase(authority, host));
    }

    private static boolean equalsIgnoringAsciiCase(String text, String other) {
        return text.length() == other.length() && startsWithIgnoringAsciiCase(text, other);
    }

    // The sheet opens exactly the caller's string, so path, query and fragment must be valid RFC 3986, checked by hand.
    private static boolean restIsValid(String text) {
        int i = "https://".length();
        while (i < text.length() && "/?#".indexOf(text.charAt(i)) < 0) i++;
        int hexDigitsOwed = 0, fragments = 0;
        for (; i < text.length(); i++) {
            char c = text.charAt(i);
            if (hexDigitsOwed > 0) {
                if (!isAsciiHexDigit(c)) return false;
                hexDigitsOwed--;
            } else if (c == '%') {
                hexDigitsOwed = 2;
            } else if (c == '#') {
                if (++fragments > 1) return false;
            } else if (c == '[' || c == ']') {
                return false;
            }
        }
        return hexDigitsOwed == 0;
    }

    private static boolean isAsciiHexDigit(char c) {
        return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f');
    }

    static boolean isCallback(String url) {
        if (!startsWithIgnoringAsciiCase(url, CALLBACK_ADDRESS)) return false;
        if (url.length() == CALLBACK_ADDRESS.length()) return true;
        char next = url.charAt(CALLBACK_ADDRESS.length());
        return next == '?' || next == '#';
    }

    // Split by hand, as iOS does, so both decide every input alike.
    static boolean namesOrigin(String url, String pageHost, int pagePort) {
        int fragment = url.indexOf('#');
        String target = fragment < 0 ? url : url.substring(0, fragment);
        int query = target.indexOf('?');
        if (query < 0) return false;
        String value = null;
        int origins = 0;
        for (String field : target.substring(query + 1).split("&", -1)) {
            int equals = field.indexOf('=');
            if (!(equals < 0 ? field : field.substring(0, equals)).equals("origin")) continue;
            origins++;
            value = equals < 0 ? "" : field.substring(equals + 1);
        }
        String origin = origins == 1 ? percentDecoded(value) : null;
        if (origin == null) return false;
        for (int i = "https://".length(); i < origin.length(); i++) if ("/?#".indexOf(origin.charAt(i)) >= 0) return false;
        return authorityMatches(origin, pageHost, pagePort < 0 ? 443 : pagePort);
    }

    private static String percentDecoded(String text) {
        try {
            // URLDecoder uses form decoding and reads + as a space, unlike iOS's removingPercentEncoding.
            return URLDecoder.decode(text.replace("+", "%2B"), "UTF-8");
        } catch (IllegalArgumentException | UnsupportedEncodingException e) {
            return null;
        }
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
        return hostPaused ? UNAVAILABLE : null;
    }
    long begin(String pageHost, int pagePort) { phase = Phase.LAUNCHING; openerHost = pageHost; openerPort = pagePort; return ++ticket; }

    void paused() { hostPaused = true; }
    // The tab covers Bread until it closes, and Android resumes Bread without a stop when the tab closes before the stop
    // arrives, so any resume without a callback ends the sheet.
    Outcome resumed() {
        hostPaused = false;
        if (phase == Phase.IDLE) return Outcome.NONE;
        phase = Phase.IDLE;
        return Outcome.CANCELLED;
    }
    Outcome callback(String url) {
        if (phase == Phase.IDLE) return Outcome.NONE;
        phase = Phase.IDLE;
        if (!isCallback(url)) return Outcome.FAILED;
        return namesOrigin(url, openerHost, openerPort) ? Outcome.RESOLVED : Outcome.MISMATCH;
    }
    void release(long ticket) { if (ticket == this.ticket) phase = Phase.IDLE; }
    Phase phase() { return phase; }
}
