package ee.forgr.capacitor_inappbrowser;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Singleton registry of all open dApp browser instances on Android, keyed
 * by id. Mirrors the iOS WebViewRegistry.
 *
 * Each instance is a {@link WebViewDialog}. Unlike iOS (which needs the
 * UIWindow Architecture A refactor in chunk 3 to host multiple webviews
 * simultaneously), Android Dialog already supports multiple concurrent
 * instances natively — each Dialog has its own Window and can be shown
 * or hidden independently. The plugin therefore just needs to track
 * which dialog corresponds to which id.
 *
 * The default single-instance code path registers under
 * {@link #DEFAULT_INSTANCE_ID} so legacy callers (faucet-webview,
 * native-notifications, the wallet's PR-3 dApp browser) keep working.
 */
public class WebViewRegistry {
    public static final String DEFAULT_INSTANCE_ID = "default";

    private static final WebViewRegistry INSTANCE = new WebViewRegistry();

    public static WebViewRegistry getShared() {
        return INSTANCE;
    }

    // LinkedHashMap so iteration / allIds() preserves registration order.
    private final Map<String, WebViewDialog> instances = new LinkedHashMap<>();

    private WebViewRegistry() {
    }

    public synchronized void register(String id, WebViewDialog dialog) {
        instances.put(id, dialog);
    }

    public synchronized WebViewDialog get(String id) {
        return instances.get(id);
    }

    public synchronized void remove(String id) {
        instances.remove(id);
    }

    public synchronized List<String> allIds() {
        return new ArrayList<>(instances.keySet());
    }

    public synchronized int count() {
        return instances.size();
    }

    /** Snapshot of every (id, dialog) pair so the caller can iterate without
     *  holding the lock. */
    public synchronized List<Map.Entry<String, WebViewDialog>> snapshot() {
        return new ArrayList<>(instances.entrySet());
    }

    public synchronized void clear() {
        instances.clear();
    }
}
