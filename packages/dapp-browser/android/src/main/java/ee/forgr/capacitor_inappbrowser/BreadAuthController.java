package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.webkit.WebView;
import androidx.activity.ComponentActivity;
import androidx.browser.auth.AuthTabIntent;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.BooleanSupplier;
import org.json.JSONException;
import org.json.JSONObject;

final class BreadAuthController {
    private enum LaunchPath { CUSTOM_TAB, AUTH_TAB }
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
    private LaunchPath launchPath;
    private BreadAuthTabLauncher authTabLauncher;

    BreadAuthController(WebViewDialog owner, WebView webView) {
        this.owner = owner;
        this.webView = webView;
        presentable = () -> owner.isShowing() && !owner.unseenWarmPresentation()
            && !owner.managedClosing() && owner.activity != null;
    }

    void install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        installed = true;
        WebViewCompat.addWebMessageListener(webView, "breadAuth", Collections.singleton("*"), (view, message, origin, mainFrame, reply) -> {
            // getData() throws for an ArrayBuffer, and a binary message has no id to reply to.
            if (message.getType() == WebMessageCompat.TYPE_STRING) receive(message.getData(), origin, mainFrame, reply);
        });
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
        ticket = state.begin(origin.getHost(), origin.getPort()); reply = proxy; requestId = id; active = this;
        try {
            if (CustomTabsClient.isAuthTabSupported(owner.activity, browser)) {
                launchPath = LaunchPath.AUTH_TAB;
                if (!(owner.activity instanceof ComponentActivity)) { finish("error", BreadAuthState.UNAVAILABLE); return; }
                BreadAuthTabLauncher.hostLoaded((ComponentActivity) owner.activity);
                final long expectedTicket = ticket;
                authTabLauncher = new BreadAuthTabLauncher(((ComponentActivity) owner.activity).getActivityResultRegistry(),
                    result -> authTabResult(expectedTicket, result.resultCode, result.resultUri));
                authTabLauncher.launch(browser, (String) url);
            } else {
                launchPath = LaunchPath.CUSTOM_TAB;
                // No session: the plugin's shared session reports page loads to the wallet's JavaScript.
                CustomTabsIntent tab = new CustomTabsIntent.Builder().build();
                tab.intent.setPackage(browser);
                tab.launchUrl(owner.activity, Uri.parse((String) url));
            }
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
        BreadAuthTabLauncher launcher = authTabLauncher;
        authTabLauncher = null; launchPath = null;
        if (launcher != null) launcher.close();
    }

    static boolean authTabInFlight() {
        return active != null && active.launchPath == LaunchPath.AUTH_TAB && active.reply != null;
    }

    static void hostPaused() { state.paused(); }

    static void hostResumed() {
        boolean cancelLaunching = active == null || active.launchPath != LaunchPath.AUTH_TAB;
        if (state.resumed(cancelLaunching) == BreadAuthState.Outcome.CANCELLED && active != null) active.finish("cancelled", true);
    }

    static void hostCallback(String url) {
        if (active == null || active.launchPath != LaunchPath.CUSTOM_TAB) return;
        active.completeCallback(url);
    }

    private void authTabResult(long expectedTicket, int resultCode, Uri resultUri) {
        if (active != this || ticket != expectedTicket || launchPath != LaunchPath.AUTH_TAB || reply == null
            || state.phase() != BreadAuthState.Phase.LAUNCHING) return;
        if (resultCode == AuthTabIntent.RESULT_OK && resultUri != null) completeCallback(resultUri.toString());
        else if (resultCode == AuthTabIntent.RESULT_CANCELED) finish("cancelled", true);
        else finish("error", BreadAuthState.FAILED);
    }

    private void completeCallback(String url) {
        BreadAuthState.Outcome outcome = state.callback(url);
        if (outcome == BreadAuthState.Outcome.RESOLVED) finish("url", url);
        else if (outcome == BreadAuthState.Outcome.MISMATCH) finish("error", BreadAuthState.ORIGIN_MISMATCH);
        else if (outcome == BreadAuthState.Outcome.FAILED) finish("error", BreadAuthState.FAILED);
    }

    private void finish(String key, Object value) {
        JavaScriptReplyProxy proxy = reply;
        String id = requestId;
        reply = null; requestId = null;
        if (active == this) active = null;
        state.release(ticket);
        BreadAuthTabLauncher launcher = authTabLauncher;
        authTabLauncher = null; launchPath = null;
        if (launcher != null) launcher.close();
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
