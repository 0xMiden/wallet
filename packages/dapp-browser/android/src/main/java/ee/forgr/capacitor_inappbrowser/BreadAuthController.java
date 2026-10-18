package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.webkit.WebView;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.BooleanSupplier;
import org.json.JSONException;
import org.json.JSONObject;

final class BreadAuthController {
    static BreadAuthState state = new BreadAuthState();
    // The one controller whose page waits for the open sheet's reply.
    private static BreadAuthController active;
    private final WebViewDialog owner;
    private final WebView webView;
    BooleanSupplier presentable;
    private boolean installed;
    private long ticket;
    private JavaScriptReplyProxy reply;
    private String requestId;

    BreadAuthController(WebViewDialog owner, WebView webView) {
        this.owner = owner;
        this.webView = webView;
        presentable = () -> owner.isShowing() && !owner.managedClosing() && owner.activity != null;
    }

    void install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        installed = true;
        WebViewCompat.addWebMessageListener(webView, "breadAuth", Collections.singleton("*"),
            (view, message, origin, mainFrame, reply) -> receive(message.getData(), origin, mainFrame, reply));
    }

    private void receive(String raw, Uri origin, boolean mainFrame, JavaScriptReplyProxy proxy) {
        String id; Object url;
        try {
            JSONObject message = new JSONObject(raw);
            // getString would turn a number or an object into an id the page script never sent.
            Object value = message.opt("id");
            if (!(value instanceof String)) return;
            id = (String) value; url = message.opt("url");
        } catch (JSONException | NullPointerException e) { return; }
        if (id.isEmpty() || id.length() > 128) return;
        String code = BreadAuthState.rejection(mainFrame, origin.getScheme(), origin.getHost(), origin.getPort(), url);
        if (code == null) code = state.refusal();
        if (code == null && !presentable.getAsBoolean()) code = BreadAuthState.UNAVAILABLE;
        String browser = code == null ? customTabsPackage(owner.activity) : null;
        if (code == null && browser == null) code = BreadAuthState.UNAVAILABLE;
        if (code != null) { send(proxy, id, "error", code); return; }
        ticket = state.begin(); reply = proxy; requestId = id; active = this;
        try {
            // No session: the plugin's shared session reports page loads to the wallet's JavaScript.
            CustomTabsIntent tab = new CustomTabsIntent.Builder().build();
            tab.intent.setPackage(browser);
            tab.launchUrl(owner.activity, Uri.parse((String) url));
        } catch (ActivityNotFoundException e) { finish("error", BreadAuthState.UNAVAILABLE); }
        catch (RuntimeException e) { finish("error", BreadAuthState.FAILED); }
    }

    private static String customTabsPackage(Activity activity) {
        List<String> browsers = new ArrayList<>();
        for (ResolveInfo browser : activity.getPackageManager().queryIntentActivities(
                new Intent(Intent.ACTION_VIEW, Uri.parse("http://")), PackageManager.MATCH_ALL)) {
            browsers.add(browser.activityInfo.packageName);
        }
        return CustomTabsClient.getPackageName(activity, browsers);
    }

    void close() {
        if (installed) WebViewCompat.removeWebMessageListener(webView, "breadAuth");
        installed = false;
        if (active == this) { active = null; state.release(ticket); }
        reply = null; requestId = null;
    }

    static void hostStopped() { state.stopped(); }

    static void hostResumed() {
        if (state.resumed() == BreadAuthState.Outcome.CANCELLED && active != null) active.finish("cancelled", true);
    }

    static void hostCallback(String url) {
        BreadAuthState.Outcome outcome = state.callback(url);
        if (active == null) return;
        if (outcome == BreadAuthState.Outcome.RESOLVED) active.finish("url", url);
        else if (outcome == BreadAuthState.Outcome.FAILED) active.finish("error", BreadAuthState.FAILED);
    }

    private void finish(String key, Object value) {
        JavaScriptReplyProxy proxy = reply;
        String id = requestId;
        reply = null; requestId = null;
        if (active == this) active = null;
        state.release(ticket);
        if (proxy != null) send(proxy, id, key, value);
    }

    private static void send(JavaScriptReplyProxy proxy, String id, String key, Object value) {
        try {
            proxy.postMessage(new JSONObject().put("id", id).put(key, value).toString());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }
}
