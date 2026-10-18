package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.browser.customtabs.CustomTabsService;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.mockito.MockedStatic;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowPackageManager;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class BreadAuthControllerTest {
    private static final String PAGE = "https://fixture.example";
    private static final String SIGN_IN = "https://fixture.example/auth?state=s";
    private static final String CALLBACK = "com.miden.wallet.auth://callback?origin=https%3A%2F%2Ffixture.example&login=a%2Fb&x=1";
    private Activity activity;
    private MockedStatic<WebViewFeature> features;
    private MockedStatic<WebViewCompat> webkit;
    private final List<String> installed = new ArrayList<>();
    private final Map<String, Set<String>> rules = new HashMap<>();
    private final Map<String, WebViewCompat.WebMessageListener> listeners = new HashMap<>();
    private final Map<WebViewDialog, WebViewCompat.WebMessageListener> authListeners = new HashMap<>();
    private final List<WebViewDialog> dialogs = new ArrayList<>();

    @Before public void setUp() {
        BreadAuthController.state = new BreadAuthState();
        activity = Robolectric.buildActivity(Activity.class).setup().visible().get();
        activity.setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar);
        features = mockStatic(WebViewFeature.class);
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.NAVIGATION_LISTENER_V1)).thenReturn(true);
        supports(true, true);
        webkit = mockStatic(WebViewCompat.class);
        webkit.when(() -> WebViewCompat.addWebMessageListener(any(), anyString(), anySet(), any()))
            .thenAnswer(call -> {
                assertNull(shadowOf((WebView) call.getArgument(0)).getLastLoadedUrl());
                installed.add("listener:" + call.getArgument(1));
                rules.put(call.getArgument(1), call.getArgument(2));
                listeners.put(call.getArgument(1), call.getArgument(3));
                return null;
            });
        webkit.when(() -> WebViewCompat.addDocumentStartJavaScript(any(), anyString(), anySet()))
            .thenAnswer(call -> {
                installed.add("script:" + call.getArgument(1));
                return mock(ScriptHandler.class);
            });
    }

    @After public void tearDown() {
        for (WebViewDialog dialog : dialogs) dialog.forceClose();
        webkit.close(); features.close();
        activity.finish();
    }

    private void supports(boolean documentStart, boolean listener) {
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)).thenReturn(documentStart);
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)).thenReturn(listener);
    }

    private WebViewDialog open() { return open(true); }

    private WebViewDialog open(boolean presentable) {
        Options options = new Options();
        options.setUrl("https://fixture.example/first");
        options.setToolbarType("default");
        options.setBackgroundColor("white");
        options.setWidth(390); options.setHeight(650); options.setX(0); options.setY(83);
        options.setPluginCall(mock(PluginCall.class));
        options.setCallbacks(mock(WebViewCallbacks.class));
        options.setBreadPresentation(new JSObject().put("script", "window.bread={version:1}")
            .put("logoSvg", "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='28'><rect width='48' height='28' fill='orange'/></svg>")
            .put("backLabel", "Back to Bread").put("retryLabel", "Retry")
            .put("hintLabel", "Tap Bread to return").put("errorLabel", "Loading failed"));
        WebViewDialog dialog = new WebViewDialog(activity, androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar, options, null, new WebView(activity));
        dialog.activity = activity;
        dialog.presentWebView();
        dialogs.add(dialog);
        BreadAuthController auth = ReflectionHelpers.getField(dialog, "auth");
        if (presentable) auth.presentable = () -> true;
        if (listeners.containsKey("breadAuth")) authListeners.put(dialog, listeners.remove("breadAuth"));
        return dialog;
    }

    private JavaScriptReplyProxy post(WebViewDialog dialog, String origin, boolean mainFrame, String body) {
        return post(dialog, origin, mainFrame, new WebMessageCompat(body));
    }

    private JavaScriptReplyProxy post(WebViewDialog dialog, String origin, boolean mainFrame, WebMessageCompat message) {
        JavaScriptReplyProxy proxy = mock(JavaScriptReplyProxy.class);
        WebView webView = ReflectionHelpers.getField(dialog, "_webView");
        authListeners.get(dialog).onPostMessage(webView, message, Uri.parse(origin), mainFrame, proxy);
        return proxy;
    }

    private void failLaunches(WebViewDialog dialog, RuntimeException failure) {
        Activity host = spy(activity);
        doThrow(failure).when(host).startActivity(any(Intent.class), nullable(Bundle.class));
        dialog.activity = host;
    }

    private static String request(String id, String url) {
        return "{\"id\":" + JSONObject.quote(id) + ",\"url\":" + JSONObject.quote(url) + "}";
    }

    private static void assertReply(JavaScriptReplyProxy proxy, String id, String key, Object value) throws Exception {
        ArgumentCaptor<String> sent = ArgumentCaptor.forClass(String.class);
        verify(proxy).postMessage(sent.capture());
        JSONObject reply = new JSONObject(sent.getValue());
        assertEquals(2, reply.length());
        assertEquals(id, reply.get("id"));
        assertEquals(value, reply.get(key));
    }

    private void registerChrome() throws Exception {
        ShadowPackageManager packages = shadowOf(activity.getPackageManager());
        ComponentName browser = new ComponentName("com.android.chrome", "com.android.chrome.Browser");
        packages.addActivityIfNotPresent(browser);
        IntentFilter view = new IntentFilter(Intent.ACTION_VIEW);
        view.addCategory(Intent.CATEGORY_DEFAULT);
        view.addCategory(Intent.CATEGORY_BROWSABLE);
        view.addDataScheme("http");
        view.addDataScheme("https");
        packages.addIntentFilterForActivity(browser, view);
        ComponentName tabs = new ComponentName("com.android.chrome", "com.android.chrome.CustomTabs");
        packages.addServiceIfNotPresent(tabs);
        packages.addIntentFilterForService(tabs, new IntentFilter(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION));
    }

    @Test public void installsBreadAuthBeforePresentationAndFirstNavigation() {
        WebViewDialog dialog = open();
        assertEquals("listener:breadAuth", installed.get(0));
        assertTrue(installed.indexOf("listener:breadAuth") < installed.indexOf("listener:breadPresentation"));
        assertEquals(Collections.singleton("*"), rules.get("breadAuth"));
        assertEquals("https://fixture.example/first", shadowOf((WebView) ReflectionHelpers.getField(dialog, "_webView")).getLastLoadedUrl());
    }

    @Test public void missingWebViewFeatureInstallsNoAuthListener() {
        for (boolean[] support : new boolean[][] {{false, true}, {true, false}, {false, false}}) {
            supports(support[0], support[1]);
            WebViewDialog dialog = open();
            assertFalse(installed.contains("listener:breadAuth"));
            assertFalse(authListeners.containsKey(dialog));
            dialog.forceClose();
        }
        webkit.verify(() -> WebViewCompat.removeWebMessageListener(any(WebView.class), eq("breadAuth")), never());
    }

    @Test public void childFrameRepliesNotMainFrame() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, false, request("a", SIGN_IN));
        assertReply(proxy, "a", "error", BreadAuthState.NOT_MAIN_FRAME);
        assertNull(shadowOf(activity).getNextStartedActivity());
    }

    @Test public void insecurePageRepliesInsecurePage() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), "http://fixture.example", true, request("a", SIGN_IN));
        assertReply(proxy, "a", "error", BreadAuthState.INSECURE_PAGE);
        assertNull(shadowOf(activity).getNextStartedActivity());
    }

    @Test public void crossOriginUrlRepliesInvalidUrl() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", "https://other.example/"));
        assertReply(proxy, "a", "error", BreadAuthState.INVALID_URL);
        assertNull(shadowOf(activity).getNextStartedActivity());
    }

    @Test public void binaryMessageIsIgnored() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, new WebMessageCompat(new byte[] {1}));
        verifyNoInteractions(proxy);
        assertNull(shadowOf(activity).getNextStartedActivity());
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
    }

    @Test public void idMustBeANonEmptyStringOfAtMost128Characters() throws Exception {
        registerChrome();
        WebViewDialog dialog = open();
        String longest = new String(new char[128]).replace('\0', 'i');
        for (String body : new String[] {
            "{\"id\":42,\"url\":" + JSONObject.quote(SIGN_IN) + "}", request("", SIGN_IN), request(longest + "i", SIGN_IN),
        }) verifyNoInteractions(post(dialog, PAGE, true, body));
        assertNull(shadowOf(activity).getNextStartedActivity());
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request(longest, SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        BreadAuthController.hostStopped();
        BreadAuthController.hostResumed();
        assertReply(proxy, longest, "cancelled", true);
    }

    @Test public void launchesSessionlessCustomTabInTheHostTask() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        Intent tab = shadowOf(activity).getNextStartedActivity();
        assertEquals(Intent.ACTION_VIEW, tab.getAction());
        assertEquals(SIGN_IN, tab.getDataString());
        assertEquals("com.android.chrome", tab.getPackage());
        assertEquals(0, tab.getFlags() & Intent.FLAG_ACTIVITY_NEW_TASK);
        assertEquals(0, tab.getFlags() & Intent.FLAG_ACTIVITY_NO_HISTORY);
        assertTrue(tab.hasExtra(CustomTabsIntent.EXTRA_SESSION));
        assertNull(tab.getExtras().getBinder(CustomTabsIntent.EXTRA_SESSION));
        verifyNoInteractions(proxy);
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
    }

    @Test public void acceptedUrlsLaunchExactlyAsWritten() throws Exception {
        registerChrome();
        for (String url : new String[] {"https://game.example/a%2Fb?x=%41&y=/?#z?/", "https://game.example/auth?x=1#"}) {
            WebViewDialog dialog = open();
            JavaScriptReplyProxy proxy = post(dialog, "https://game.example", true, request("a", url));
            Intent tab = shadowOf(activity).getNextStartedActivity();
            assertNotNull(url, tab);
            assertEquals(url, tab.getDataString());
            verifyNoInteractions(proxy);
            dialog.forceClose();
        }
    }

    @Test public void callbackIntentResolvesTheUrlUntouched() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        BreadAuthController.hostStopped();
        Intent callback = new Intent(Intent.ACTION_VIEW, Uri.parse(CALLBACK));
        Intent consumed = BreadAuthCallbacks.consume(callback);
        assertNotSame(callback, consumed);
        assertEquals(Intent.ACTION_VIEW, consumed.getAction());
        assertNull(consumed.getData());
        BreadAuthController.hostResumed();
        assertReply(proxy, "a", "url", CALLBACK);
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
    }

    @Test public void callbackWithAPathRepliesFailed() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        BreadAuthController.hostStopped();
        assertNull(BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse("com.miden.wallet.auth://callback/x"))).getData());
        BreadAuthController.hostResumed();
        assertReply(proxy, "a", "error", BreadAuthState.FAILED);
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
    }

    @Test public void theCallbackMustNameTheOpeningPage() throws Exception {
        registerChrome();
        WebViewDialog dialog = open();
        String page = "https://fixture.example:8443";
        JavaScriptReplyProxy other = post(dialog, page, true, request("a", page + "/auth"));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        BreadAuthController.hostStopped();
        BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse("com.miden.wallet.auth://callback?origin=https%3A%2F%2Ffixture.example&login=a")));
        BreadAuthController.hostResumed();
        assertReply(other, "a", "error", "AUTH_ORIGIN_MISMATCH");
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
        JavaScriptReplyProxy own = post(dialog, page, true, request("b", page + "/auth"));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        BreadAuthController.hostStopped();
        String callback = "com.miden.wallet.auth://callback?origin=https%3A%2F%2Ffixture.example%3A8443&login=a";
        BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse(callback)));
        BreadAuthController.hostResumed();
        assertReply(own, "b", "url", callback);
    }

    @Test public void consumeLeavesOtherIntentsAlone() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        BreadAuthController.hostStopped();
        for (Intent intent : new Intent[] {
            new Intent(Intent.ACTION_MAIN), new Intent(Intent.ACTION_MAIN, Uri.parse(CALLBACK)),
            new Intent(Intent.ACTION_VIEW, Uri.parse("com.miden.wallet://wc?uri=x")), new Intent(Intent.ACTION_VIEW),
        }) assertSame(intent, BreadAuthCallbacks.consume(intent));
        verifyNoInteractions(proxy);
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
    }

    @Test public void consumeStripsACallbackWithNoSheet() throws Exception {
        Intent coldStart = new Intent(Intent.ACTION_VIEW, Uri.parse(CALLBACK));
        Intent consumed = BreadAuthCallbacks.consume(coldStart);
        assertNotSame(coldStart, consumed);
        assertEquals(Intent.ACTION_VIEW, consumed.getAction());
        assertNull(consumed.getData());
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
        registerChrome();
        JavaScriptReplyProxy ended = post(open(), PAGE, true, request("a", SIGN_IN));
        BreadAuthController.hostStopped();
        BreadAuthController.hostResumed();
        assertNull(BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse(CALLBACK))).getData());
        assertReply(ended, "a", "cancelled", true);
    }

    @Test public void resumeAfterStopRepliesCancelled() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        BreadAuthController.hostStopped();
        BreadAuthController.hostResumed();
        BreadAuthController.hostResumed();
        assertReply(proxy, "a", "cancelled", true);
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
    }

    @Test public void aTabClosedBeforeTheStopRepliesCancelled() throws Exception {
        registerChrome();
        WebViewDialog dialog = open();
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request("a", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        BreadAuthController.hostResumed();
        BreadAuthController.hostResumed();
        assertReply(proxy, "a", "cancelled", true);
        post(dialog, PAGE, true, request("b", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
    }

    @Test public void pluginStopAndResumeReachTheSheet() throws Exception {
        registerChrome();
        WebViewDialog dialog = open();
        InAppBrowserPlugin plugin = spy(new InAppBrowserPlugin());
        doReturn(activity).when(plugin).getContext();
        plugin.handleOnStop();
        assertReply(post(dialog, PAGE, true, request("a", SIGN_IN)), "a", "error", BreadAuthState.UNAVAILABLE);
        assertNull(shadowOf(activity).getNextStartedActivity());
        plugin.handleOnResume();
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request("b", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        plugin.handleOnStop();
        verifyNoInteractions(proxy);
        plugin.handleOnResume();
        assertReply(proxy, "b", "cancelled", true);
    }

    @Test public void secondOpenRepliesBusy() throws Exception {
        registerChrome();
        WebViewDialog first = open();
        JavaScriptReplyProxy sheet = post(first, PAGE, true, request("a", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        JavaScriptReplyProxy same = post(first, PAGE, true, request("b", SIGN_IN));
        JavaScriptReplyProxy other = post(open(), PAGE, true, request("c", SIGN_IN));
        assertReply(same, "b", "error", BreadAuthState.BUSY);
        assertReply(other, "c", "error", BreadAuthState.BUSY);
        assertNull(shadowOf(activity).getNextStartedActivity());
        verifyNoInteractions(sheet);
        BreadAuthController.hostStopped();
        BreadAuthController.hostResumed();
        assertReply(sheet, "a", "cancelled", true);
    }

    @Test public void anOpenSheetStillRepliesInvalidUrlBeforeBusy() throws Exception {
        registerChrome();
        WebViewDialog dialog = open();
        JavaScriptReplyProxy sheet = post(dialog, PAGE, true, request("a", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request("b", "https://other.example/"));
        assertReply(proxy, "b", "error", BreadAuthState.INVALID_URL);
        verifyNoInteractions(sheet);
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
    }

    @Test public void anOpenSheetRepliesBusyBeforeAHiddenDialogIsUnavailable() throws Exception {
        registerChrome();
        JavaScriptReplyProxy sheet = post(open(), PAGE, true, request("a", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        WebViewDialog hidden = open(false);
        hidden.hide();
        assertFalse(hidden.isShowing());
        JavaScriptReplyProxy proxy = post(hidden, PAGE, true, request("b", SIGN_IN));
        assertReply(proxy, "b", "error", BreadAuthState.BUSY);
        verifyNoInteractions(sheet);
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
    }

    @Test public void noCustomTabsBrowserRepliesUnavailable() throws Exception {
        WebViewDialog dialog = open();
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request("a", SIGN_IN));
        assertReply(proxy, "a", "error", BreadAuthState.UNAVAILABLE);
        assertNull(shadowOf(activity).getNextStartedActivity());
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
        registerChrome();
        post(dialog, PAGE, true, request("b", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
    }

    @Test public void missingBrowserActivityRepliesUnavailableAndFreesTheSlot() throws Exception {
        registerChrome();
        WebViewDialog dialog = open();
        failLaunches(dialog, new ActivityNotFoundException());
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request("a", SIGN_IN));
        assertReply(proxy, "a", "error", BreadAuthState.UNAVAILABLE);
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
        assertNull(BreadAuthController.state.refusal());
    }

    @Test public void anyOtherLaunchFailureRepliesFailed() throws Exception {
        registerChrome();
        WebViewDialog dialog = open();
        failLaunches(dialog, new SecurityException());
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request("a", SIGN_IN));
        assertReply(proxy, "a", "error", BreadAuthState.FAILED);
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
        assertNull(BreadAuthController.state.refusal());
    }

    @Test public void hiddenDialogRepliesUnavailable() throws Exception {
        registerChrome();
        WebViewDialog dialog = open(false);
        dialog.hide();
        assertFalse(dialog.isShowing());
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request("a", SIGN_IN));
        assertReply(proxy, "a", "error", BreadAuthState.UNAVAILABLE);
        assertNull(shadowOf(activity).getNextStartedActivity());
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
    }

    @Test public void closingTheDialogFreesTheSheetAndIgnoresALateCallback() throws Exception {
        registerChrome();
        WebViewDialog dialog = open();
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request("a", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        BreadAuthController.hostStopped();
        dialog.forceClose();
        webkit.verify(() -> WebViewCompat.removeWebMessageListener(any(WebView.class), eq("breadAuth")));
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
        assertNull(BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse(CALLBACK))).getData());
        BreadAuthController.hostResumed();
        verifyNoInteractions(proxy);
        JavaScriptReplyProxy next = post(open(), PAGE, true, request("b", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        verifyNoInteractions(next);
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
    }

    @Test public void closingAnotherDialogKeepsTheSheet() throws Exception {
        registerChrome();
        JavaScriptReplyProxy sheet = post(open(), PAGE, true, request("a", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        open().forceClose();
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
        verifyNoInteractions(sheet);
        BreadAuthController.hostStopped();
        BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse(CALLBACK)));
        assertReply(sheet, "a", "url", CALLBACK);
    }
}
