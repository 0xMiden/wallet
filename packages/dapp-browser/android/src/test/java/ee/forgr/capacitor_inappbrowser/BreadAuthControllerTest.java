package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Bundle;
import android.os.Looper;
import android.webkit.WebView;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultRegistry;
import androidx.browser.auth.AuthTabIntent;
import androidx.browser.customtabs.CustomTabsClient;
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
import org.mockito.MockedConstruction;
import org.mockito.MockedStatic;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowActivity;
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
    private ActivityController<ComponentActivity> host;
    private MockedStatic<CustomTabsClient> authTabs;
    private MockedStatic<WebViewFeature> features;
    private MockedStatic<WebViewCompat> webkit;
    private final List<String> installed = new ArrayList<>();
    private final Map<String, Set<String>> rules = new HashMap<>();
    private final Map<String, WebViewCompat.WebMessageListener> listeners = new HashMap<>();
    private final Map<WebViewDialog, WebViewCompat.WebMessageListener> authListeners = new HashMap<>();
    private final List<WebViewDialog> dialogs = new ArrayList<>();

    @Before public void setUp() {
        BreadAuthController.state = new BreadAuthState();
        host = Robolectric.buildActivity(ComponentActivity.class).setup().visible();
        activity = host.get();
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
        WebViewRegistry.getShared().clear();
        if (authTabs != null) authTabs.close();
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
        registerBrowser("com.android.chrome");
    }

    private void registerBrowser(String browser) throws Exception {
        ShadowPackageManager packages = shadowOf(activity.getPackageManager());
        ComponentName browserActivity = new ComponentName(browser, browser + ".Browser");
        packages.addActivityIfNotPresent(browserActivity);
        IntentFilter view = new IntentFilter(Intent.ACTION_VIEW);
        view.addCategory(Intent.CATEGORY_DEFAULT);
        view.addCategory(Intent.CATEGORY_BROWSABLE);
        view.addDataScheme("http");
        view.addDataScheme("https");
        packages.addIntentFilterForActivity(browserActivity, view);
        ComponentName tabs = new ComponentName(browser, browser + ".CustomTabs");
        packages.addServiceIfNotPresent(tabs);
        packages.addIntentFilterForService(tabs, new IntentFilter(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION));
    }

    private void enableAuthTabs() { enableAuthTabs("com.android.chrome"); }

    private void enableAuthTabs(String browser) {
        if (authTabs == null) authTabs = mockStatic(CustomTabsClient.class, CALLS_REAL_METHODS);
        authTabs.when(() -> CustomTabsClient.isAuthTabSupported(activity, browser)).thenReturn(true);
    }

    private ShadowActivity.IntentForResult takeAuthLaunch() {
        ShadowActivity.IntentForResult launch = shadowOf(activity).getNextStartedActivityForResult();
        assertNotNull(launch);
        assertTrue(launch.intent.getBooleanExtra(AuthTabIntent.EXTRA_LAUNCH_AUTH_TAB, false));
        // Robolectric logs every start in both queues: take this launch from the plain one too, so a later
        // getNextStartedActivity() sees only what started after it.
        Intent started = shadowOf(activity).getNextStartedActivity();
        assertNotNull(started);
        assertTrue(started.getBooleanExtra(AuthTabIntent.EXTRA_LAUNCH_AUTH_TAB, false));
        return launch;
    }

    private void deliver(ShadowActivity.IntentForResult launch, int code, String callback) {
        Intent data = callback == null ? null : new Intent().setData(Uri.parse(callback));
        ((ComponentActivity) activity).getActivityResultRegistry().dispatchResult(launch.requestCode, code, data);
    }

    private ActivityResultCallback<AuthTabIntent.AuthResult> authTabCallback(WebViewDialog dialog) {
        BreadAuthController auth = ReflectionHelpers.getField(dialog, "auth");
        BreadAuthTabLauncher launcher = ReflectionHelpers.getField(auth, "authTabLauncher");
        // The registry and launcher each discard duplicates before the controller sees them.
        ActivityResultCallback<AuthTabIntent.AuthResult> callback = ReflectionHelpers.getField(launcher, "callback");
        assertNotNull(callback);
        return callback;
    }

    private AuthTabIntent.AuthResult authTabResult(int code, String callback) {
        // AndroidX keeps the result constructor package-private.
        return ReflectionHelpers.callConstructor(AuthTabIntent.AuthResult.class,
            ReflectionHelpers.ClassParameter.from(int.class, code),
            ReflectionHelpers.ClassParameter.from(Uri.class, callback == null ? null : Uri.parse(callback)));
    }

    private void assertReplyReleased(WebViewDialog dialog) {
        BreadAuthController auth = ReflectionHelpers.getField(dialog, "auth");
        assertNull(ReflectionHelpers.getField(auth, "reply"));
    }

    private void registerOwnedDialog(WebViewDialog dialog) {
        WebViewRegistry.getShared().register("auth-test", dialog);
    }

    private void destroyPluginAndRecreateHost() {
        new InAppBrowserPlugin().handleOnDestroy();
        WebViewRegistry.getShared().clear();
        host.recreate();
        activity = host.get();
        activity.setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar);
        BreadAuthTabLauncher.hostLoaded((ComponentActivity) activity);
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
        BreadAuthController.hostPaused();
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
        BreadAuthController.hostPaused();
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
        BreadAuthController.hostPaused();
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
        BreadAuthController.hostPaused();
        BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse("com.miden.wallet.auth://callback?origin=https%3A%2F%2Ffixture.example&login=a")));
        BreadAuthController.hostResumed();
        assertReply(other, "a", "error", "AUTH_ORIGIN_MISMATCH");
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
        JavaScriptReplyProxy own = post(dialog, page, true, request("b", page + "/auth"));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        BreadAuthController.hostPaused();
        String callback = "com.miden.wallet.auth://callback?origin=https%3A%2F%2Ffixture.example%3A8443&login=a";
        BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse(callback)));
        BreadAuthController.hostResumed();
        assertReply(own, "b", "url", callback);
    }

    @Test public void consumeLeavesOtherIntentsAlone() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        BreadAuthController.hostPaused();
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
        BreadAuthController.hostPaused();
        BreadAuthController.hostResumed();
        assertNull(BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse(CALLBACK))).getData());
        assertReply(ended, "a", "cancelled", true);
    }

    @Test public void resumeAfterStopRepliesCancelled() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        BreadAuthController.hostPaused();
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

    @Test public void pluginPauseAndResumeReachTheSheet() throws Exception {
        registerChrome();
        WebViewDialog dialog = open();
        InAppBrowserPlugin plugin = spy(new InAppBrowserPlugin());
        doReturn(activity).when(plugin).getContext();
        plugin.handleOnResume();
        plugin.handleOnPause();
        assertReply(post(dialog, PAGE, true, request("a", SIGN_IN)), "a", "error", BreadAuthState.UNAVAILABLE);
        assertNull(shadowOf(activity).getNextStartedActivity());
        plugin.handleOnResume();
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request("b", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        plugin.handleOnPause();
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
        BreadAuthController.hostPaused();
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
        BreadAuthController.hostPaused();
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
        BreadAuthController.hostPaused();
        BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse(CALLBACK)));
        assertReply(sheet, "a", "url", CALLBACK);
    }

    private void assertForwardsCallbackToHost() {
        Intent callback = new Intent(Intent.ACTION_VIEW, Uri.parse(CALLBACK))
            .putExtra("marker", "callback").putExtra("attempt", 7).addFlags(Intent.FLAG_ACTIVITY_BROUGHT_TO_FRONT);
        Intent forward = BreadAuthCallbacks.forwardIntent(activity, callback, ComponentActivity.class);
        assertNotNull(forward);
        assertNotSame(callback, forward);
        assertEquals(new ComponentName(activity, ComponentActivity.class), forward.getComponent());
        assertEquals(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_BROUGHT_TO_FRONT,
            forward.getFlags());
        assertEquals(Intent.ACTION_VIEW, forward.getAction());
        assertEquals(CALLBACK, forward.getDataString());
        assertEquals("callback", forward.getStringExtra("marker"));
        assertEquals(7, forward.getIntExtra("attempt", 0));
        assertNull(callback.getComponent());
        assertEquals(Intent.FLAG_ACTIVITY_BROUGHT_TO_FRONT, callback.getFlags());
    }

    @Test public void forwardsCallbacksToHostWhenIdle() {
        assertForwardsCallbackToHost();
    }

    @Test public void forwardsCallbacksToHostDuringCustomTab() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        assertNotNull(shadowOf(activity).getNextStartedActivity());
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
        assertForwardsCallbackToHost();
        verifyNoInteractions(proxy);
    }

    @Test public void doesNotForwardCallbacksToHostUntilAuthTabSettles() throws Exception {
        registerChrome(); enableAuthTabs();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        ShadowActivity.IntentForResult launch = takeAuthLaunch();
        assertNull(BreadAuthCallbacks.forwardIntent(activity, new Intent(Intent.ACTION_VIEW, Uri.parse(CALLBACK)),
            ComponentActivity.class));
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
        verifyNoInteractions(proxy);
        deliver(launch, AuthTabIntent.RESULT_OK, CALLBACK);
        assertReply(proxy, "a", "url", CALLBACK);
        assertForwardsCallbackToHost();
    }

    @Test public void forwardsCallbacksToHostAfterAuthTabCloses() throws Exception {
        registerChrome(); enableAuthTabs();
        WebViewDialog dialog = open();
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request("a", SIGN_IN));
        takeAuthLaunch();
        dialog.forceClose();
        assertForwardsCallbackToHost();
        verifyNoInteractions(proxy);
    }

    @Test public void supportedResolvedBrowserUsesAuthTab() throws Exception {
        registerChrome(); enableAuthTabs();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        ShadowActivity.IntentForResult launch = takeAuthLaunch();
        assertEquals("com.android.chrome", launch.intent.getPackage());
        assertEquals(SIGN_IN, launch.intent.getDataString());
        assertEquals("com.miden.wallet.auth", launch.intent.getStringExtra(AuthTabIntent.EXTRA_REDIRECT_SCHEME));
        verifyNoInteractions(proxy);
    }

    @Test public void unsupportedResolvedBrowserKeepsLegacyCustomTab() throws Exception {
        registerChrome();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        Intent launch = shadowOf(activity).getNextStartedActivity();
        assertFalse(launch.getBooleanExtra(AuthTabIntent.EXTRA_LAUNCH_AUTH_TAB, false));
        assertEquals("com.android.chrome", launch.getPackage());
        assertEquals(SIGN_IN, launch.getDataString());
        assertNull(launch.getExtras().getBinder(CustomTabsIntent.EXTRA_SESSION));
        verifyNoInteractions(proxy);
    }

    @Test public void schemeIntentCannotConsumeAuthTabAndResultSettlesOnlyOnce() throws Exception {
        registerChrome(); enableAuthTabs();
        WebViewDialog dialog = open();
        JavaScriptReplyProxy proxy = post(dialog, PAGE, true, request("a", SIGN_IN));
        ShadowActivity.IntentForResult launch = takeAuthLaunch();
        ActivityResultCallback<AuthTabIntent.AuthResult> callback = authTabCallback(dialog);
        Intent consumed = BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse(CALLBACK)));
        assertNull(consumed.getData());
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
        verifyNoInteractions(proxy);
        deliver(launch, AuthTabIntent.RESULT_OK, CALLBACK);
        callback.onActivityResult(authTabResult(AuthTabIntent.RESULT_CANCELED, null));
        BreadAuthCallbacks.consume(new Intent(Intent.ACTION_VIEW, Uri.parse(CALLBACK)));
        assertReply(proxy, "a", "url", CALLBACK);
        assertReplyReleased(dialog);
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
    }

    @Test public void authTabCancelledResolvesAndFreesSlotWithoutFallback() throws Exception {
        registerChrome(); enableAuthTabs();
        JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
        deliver(takeAuthLaunch(), AuthTabIntent.RESULT_CANCELED, null);
        assertReply(proxy, "a", "cancelled", true);
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
        assertNull(shadowOf(activity).getNextStartedActivity());
        assertNull(BreadAuthController.state.refusal());
    }

    @Test public void authTabVerificationNullOkAndUnknownResultsFailAndRelease() throws Exception {
        registerChrome(); enableAuthTabs();
        for (int code : new int[] {AuthTabIntent.RESULT_VERIFICATION_FAILED,
                AuthTabIntent.RESULT_VERIFICATION_TIMED_OUT, AuthTabIntent.RESULT_OK, 99}) {
            JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
            deliver(takeAuthLaunch(), code, null);
            assertReply(proxy, "a", "error", BreadAuthState.FAILED);
            assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
            assertNull(shadowOf(activity).getNextStartedActivity());
        }
    }

    @Test public void authTabUsesExistingCallbackParserAndPreservesBytes() throws Exception {
        registerChrome(); enableAuthTabs();
        String[] callbacks = {CALLBACK, "com.miden.wallet.auth://callback/x",
            "com.miden.wallet.auth://callback?origin=https%3A%2F%2Fother.example",
            "com.miden.wallet.auth://callback?origin=https%3A%2F%2Ffixture.example&origin=https%3A%2F%2Ffixture.example"};
        String[] values = {CALLBACK, BreadAuthState.FAILED, BreadAuthState.ORIGIN_MISMATCH, BreadAuthState.ORIGIN_MISMATCH};
        for (int i = 0; i < callbacks.length; i++) {
            JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
            deliver(takeAuthLaunch(), AuthTabIntent.RESULT_OK, callbacks[i]);
            assertReply(proxy, "a", i == 0 ? "url" : "error", values[i]);
        }
        for (String origin : new String[] {"https%3A%2F%2Fa+b.example", "https%3A%2F%2Fa%2Bb.example"}) {
            String callback = "com.miden.wallet.auth://callback?origin=" + origin + "&login=a%2Fb";
            JavaScriptReplyProxy proxy = post(open(), "https://a+b.example", true,
                request("plus", "https://a+b.example/auth"));
            deliver(takeAuthLaunch(), AuthTabIntent.RESULT_OK, callback);
            assertReply(proxy, "plus", "url", callback);
        }
    }

    @Test public void pausedAuthTabResultSurvivesEitherResumeOrder() throws Exception {
        registerChrome(); enableAuthTabs();
        for (boolean resumeFirst : new boolean[] {true, false}) {
            JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
            ShadowActivity.IntentForResult launch = takeAuthLaunch();
            BreadAuthController.hostPaused();
            if (resumeFirst) BreadAuthController.hostResumed();
            verifyNoInteractions(proxy);
            assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
            deliver(launch, AuthTabIntent.RESULT_OK, CALLBACK);
            if (!resumeFirst) BreadAuthController.hostResumed();
            assertReply(proxy, "a", "url", CALLBACK);
        }
    }

    @Test public void authTabKeepsPausedStartRefusalAndBusyPrecedence() throws Exception {
        registerChrome(); enableAuthTabs();
        WebViewDialog dialog = open();
        BreadAuthController.hostPaused();
        assertReply(post(dialog, PAGE, true, request("paused", SIGN_IN)), "paused", "error", BreadAuthState.UNAVAILABLE);
        assertNull(shadowOf(activity).getNextStartedActivityForResult());
        BreadAuthController.hostResumed();
        JavaScriptReplyProxy active = post(dialog, PAGE, true, request("a", SIGN_IN));
        ShadowActivity.IntentForResult launch = takeAuthLaunch();
        BreadAuthController.hostPaused();
        assertReply(post(dialog, PAGE, true, request("busy", SIGN_IN)), "busy", "error", BreadAuthState.BUSY);
        deliver(launch, AuthTabIntent.RESULT_CANCELED, null);
        assertReply(active, "a", "cancelled", true);
        BreadAuthController.hostResumed();
    }

    @Test public void supportedBrowserLaunchFailureDoesNotDowngrade() throws Exception {
        registerChrome(); enableAuthTabs();
        for (RuntimeException failure : new RuntimeException[] {new ActivityNotFoundException(), new SecurityException()}) {
            try (MockedConstruction<BreadAuthTabLauncher> launches = mockConstruction(BreadAuthTabLauncher.class,
                    (mock, context) -> doThrow(failure).when(mock).launch("com.android.chrome", SIGN_IN))) {
                JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
                assertReply(proxy, "a", "error", failure instanceof ActivityNotFoundException
                    ? BreadAuthState.UNAVAILABLE : BreadAuthState.FAILED);
                assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
                assertNull(BreadAuthController.state.refusal());
                assertNull(shadowOf(activity).getNextStartedActivity());
                verify(launches.constructed().get(0)).close();
            }
        }
    }

    @Test public void closedAuthTabResultCannotSettleTheNextRequest() throws Exception {
        registerChrome(); enableAuthTabs();
        WebViewDialog old = open();
        JavaScriptReplyProxy oldProxy = post(old, PAGE, true, request("a", SIGN_IN));
        ShadowActivity.IntentForResult oldLaunch = takeAuthLaunch();
        ActivityResultCallback<AuthTabIntent.AuthResult> oldCallback = authTabCallback(old);
        old.forceClose();
        WebViewDialog next = open();
        JavaScriptReplyProxy nextProxy = post(next, PAGE, true, request("b", SIGN_IN));
        ShadowActivity.IntentForResult nextLaunch = takeAuthLaunch();
        ActivityResultCallback<AuthTabIntent.AuthResult> nextCallback = authTabCallback(next);
        deliver(oldLaunch, AuthTabIntent.RESULT_OK, CALLBACK);
        oldCallback.onActivityResult(authTabResult(AuthTabIntent.RESULT_OK, CALLBACK));
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
        verifyNoInteractions(oldProxy, nextProxy);
        deliver(nextLaunch, AuthTabIntent.RESULT_OK, CALLBACK);
        nextCallback.onActivityResult(authTabResult(AuthTabIntent.RESULT_CANCELED, null));
        assertReply(nextProxy, "b", "url", CALLBACK);
        assertReplyReleased(next);
        verifyNoInteractions(oldProxy);
    }

    @Test public void recreatedActivityDropsOldAuthTabAndAllowsFreshRequest() throws Exception {
        registerChrome(); enableAuthTabs();
        WebViewDialog old = open(); registerOwnedDialog(old);
        JavaScriptReplyProxy oldProxy = post(old, PAGE, true, request("a", SIGN_IN));
        ShadowActivity.IntentForResult oldLaunch = takeAuthLaunch();
        ActivityResultCallback<AuthTabIntent.AuthResult> oldCallback = authTabCallback(old);
        Activity oldActivity = activity;
        ActivityResultRegistry oldRegistry = ((ComponentActivity) activity).getActivityResultRegistry();
        destroyPluginAndRecreateHost();
        assertNotSame(oldActivity, activity);
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
        registerChrome(); enableAuthTabs();
        WebViewDialog next = open();
        JavaScriptReplyProxy nextProxy = post(next, PAGE, true, request("b", SIGN_IN));
        ShadowActivity.IntentForResult nextLaunch = takeAuthLaunch();
        ActivityResultCallback<AuthTabIntent.AuthResult> nextCallback = authTabCallback(next);
        ActivityResultRegistry newRegistry = ((ComponentActivity) activity).getActivityResultRegistry();
        assertNotEquals(oldLaunch.requestCode, nextLaunch.requestCode);
        Intent data = new Intent().setData(Uri.parse(CALLBACK));
        oldRegistry.dispatchResult(oldLaunch.requestCode, AuthTabIntent.RESULT_OK, data);
        newRegistry.dispatchResult(oldLaunch.requestCode, AuthTabIntent.RESULT_OK, data);
        Bundle restoredState = new Bundle();
        newRegistry.onSaveInstanceState(restoredState);
        assertTrue("No abandoned auth result remains pending",
            restoredState.getBundle("KEY_COMPONENT_ACTIVITY_PENDING_RESULT").isEmpty());
        oldCallback.onActivityResult(authTabResult(AuthTabIntent.RESULT_OK, CALLBACK));
        verifyNoInteractions(oldProxy, nextProxy);
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
        deliver(nextLaunch, AuthTabIntent.RESULT_OK, CALLBACK);
        nextCallback.onActivityResult(authTabResult(AuthTabIntent.RESULT_CANCELED, null));
        assertReply(nextProxy, "b", "url", CALLBACK);
        assertReplyReleased(next);
        verifyNoInteractions(oldProxy);
    }

    @Test public void restoredAuthTabResultIsDiscardedBeforeAnotherPageOpens() throws Exception {
        registerChrome(); enableAuthTabs();
        WebViewDialog old = open(); registerOwnedDialog(old);
        JavaScriptReplyProxy oldProxy = post(old, PAGE, true, request("a", SIGN_IN));
        ShadowActivity.IntentForResult oldLaunch = takeAuthLaunch();
        new InAppBrowserPlugin().handleOnDestroy();
        WebViewRegistry.getShared().clear();
        Bundle saved = new Bundle();
        host.pause().saveInstanceState(saved).stop().destroy();
        host = Robolectric.buildActivity(ComponentActivity.class).create(saved).start().resume().visible();
        activity = host.get();
        activity.setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar);
        ActivityResultRegistry registry = ((ComponentActivity) activity).getActivityResultRegistry();
        registry.dispatchResult(oldLaunch.requestCode, AuthTabIntent.RESULT_OK, new Intent().setData(Uri.parse(CALLBACK)));
        Bundle beforeLoad = new Bundle();
        registry.onSaveInstanceState(beforeLoad);
        assertFalse(beforeLoad.getBundle("KEY_COMPONENT_ACTIVITY_PENDING_RESULT").isEmpty());

        BreadAuthTabLauncher.hostLoaded((ComponentActivity) activity);
        Bundle afterLoad = new Bundle();
        registry.onSaveInstanceState(afterLoad);
        assertTrue("Restored auth data must be consumed at host load",
            afterLoad.getBundle("KEY_COMPONENT_ACTIVITY_PENDING_RESULT").isEmpty());
        shadowOf(Looper.getMainLooper()).idle();
        Bundle afterCleanup = new Bundle();
        registry.onSaveInstanceState(afterCleanup);
        List<String> registered = afterCleanup.getStringArrayList("KEY_COMPONENT_ACTIVITY_REGISTERED_KEYS");
        assertEquals("Registration-time delivery must retain its discard callback", 1, registered.size());
        String oldKey = registered.get(0);
        assertEquals(Collections.singletonList(oldKey),
            afterCleanup.getStringArrayList("KEY_COMPONENT_ACTIVITY_LAUNCHED_KEYS"));
        verifyNoInteractions(oldProxy);
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());

        destroyPluginAndRecreateHost();
        registry = ((ComponentActivity) activity).getActivityResultRegistry();
        Bundle afterRecreation = new Bundle();
        registry.onSaveInstanceState(afterRecreation);
        assertEquals(Collections.singletonList(oldKey),
            afterRecreation.getStringArrayList("KEY_COMPONENT_ACTIVITY_REGISTERED_KEYS"));
        assertEquals(Collections.singletonList(oldKey),
            afterRecreation.getStringArrayList("KEY_COMPONENT_ACTIVITY_LAUNCHED_KEYS"));
        registerChrome(); enableAuthTabs();
        WebViewDialog next = open();
        JavaScriptReplyProxy nextProxy = post(next, PAGE, true, request("b", SIGN_IN));
        ShadowActivity.IntentForResult nextLaunch = takeAuthLaunch();
        assertNotEquals(oldLaunch.requestCode, nextLaunch.requestCode);
        deliver(oldLaunch, AuthTabIntent.RESULT_OK, CALLBACK);
        shadowOf(Looper.getMainLooper()).idle();
        Bundle afterLateResult = new Bundle();
        registry.onSaveInstanceState(afterLateResult);
        assertTrue(afterLateResult.getBundle("KEY_COMPONENT_ACTIVITY_PENDING_RESULT").isEmpty());
        assertFalse(afterLateResult.getStringArrayList("KEY_COMPONENT_ACTIVITY_REGISTERED_KEYS").contains(oldKey));
        assertFalse(afterLateResult.getStringArrayList("KEY_COMPONENT_ACTIVITY_LAUNCHED_KEYS").contains(oldKey));
        verifyNoInteractions(oldProxy, nextProxy);
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
        deliver(nextLaunch, AuthTabIntent.RESULT_OK, CALLBACK);
        assertReply(nextProxy, "b", "url", CALLBACK);
        verifyNoInteractions(oldProxy);
        shadowOf(Looper.getMainLooper()).idle();
        Bundle completed = new Bundle();
        registry.onSaveInstanceState(completed);
        assertTrue(completed.getStringArrayList("KEY_COMPONENT_ACTIVITY_REGISTERED_KEYS").isEmpty());
        assertTrue(completed.getStringArrayList("KEY_COMPONENT_ACTIVITY_LAUNCHED_KEYS").isEmpty());
    }

    @Test public void abandonedAuthTabKeySurvivesAnotherRecreationUntilItsResultArrives() throws Exception {
        registerChrome(); enableAuthTabs();
        WebViewDialog old = open(); registerOwnedDialog(old);
        JavaScriptReplyProxy oldProxy = post(old, PAGE, true, request("a", SIGN_IN));
        ShadowActivity.IntentForResult oldLaunch = takeAuthLaunch();
        destroyPluginAndRecreateHost();
        destroyPluginAndRecreateHost();
        registerChrome(); enableAuthTabs();
        WebViewDialog next = open();
        JavaScriptReplyProxy nextProxy = post(next, PAGE, true, request("b", SIGN_IN));
        ShadowActivity.IntentForResult nextLaunch = takeAuthLaunch();
        assertNotEquals(oldLaunch.requestCode, nextLaunch.requestCode);
        deliver(oldLaunch, AuthTabIntent.RESULT_OK, CALLBACK);
        Bundle saved = new Bundle();
        ((ComponentActivity) activity).getActivityResultRegistry().onSaveInstanceState(saved);
        assertTrue(saved.getBundle("KEY_COMPONENT_ACTIVITY_PENDING_RESULT").isEmpty());
        verifyNoInteractions(oldProxy, nextProxy);
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
        deliver(nextLaunch, AuthTabIntent.RESULT_OK, CALLBACK);
        assertReply(nextProxy, "b", "url", CALLBACK);
        verifyNoInteractions(oldProxy);
    }

    @Test public void oldAuthTabCallbackCannotSettleNextRequestOnTheSameDialog() throws Exception {
        registerChrome(); enableAuthTabs();
        WebViewDialog dialog = open();
        JavaScriptReplyProxy firstProxy = post(dialog, PAGE, true, request("a", SIGN_IN));
        ShadowActivity.IntentForResult firstLaunch = takeAuthLaunch();
        ActivityResultCallback<AuthTabIntent.AuthResult> firstCallback = authTabCallback(dialog);
        deliver(firstLaunch, AuthTabIntent.RESULT_OK, CALLBACK);
        assertReply(firstProxy, "a", "url", CALLBACK);
        assertReplyReleased(dialog);

        JavaScriptReplyProxy nextProxy = post(dialog, PAGE, true, request("b", SIGN_IN));
        ShadowActivity.IntentForResult nextLaunch = takeAuthLaunch();
        ActivityResultCallback<AuthTabIntent.AuthResult> nextCallback = authTabCallback(dialog);
        firstCallback.onActivityResult(authTabResult(AuthTabIntent.RESULT_OK, CALLBACK));
        verifyNoInteractions(nextProxy);
        assertEquals(BreadAuthState.Phase.LAUNCHING, BreadAuthController.state.phase());
        deliver(nextLaunch, AuthTabIntent.RESULT_OK, CALLBACK);
        nextCallback.onActivityResult(authTabResult(AuthTabIntent.RESULT_CANCELED, null));
        assertReply(firstProxy, "a", "url", CALLBACK);
        assertReply(nextProxy, "b", "url", CALLBACK);
        assertReplyReleased(dialog);
        assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
    }

    @Test public void probesAndPinsTheResolvedProviderRatherThanChrome() throws Exception {
        String browser = "org.example.browser";
        registerBrowser(browser); enableAuthTabs(browser);
        post(open(), PAGE, true, request("a", SIGN_IN));
        assertEquals(browser, takeAuthLaunch().intent.getPackage());
        authTabs.verify(() -> CustomTabsClient.isAuthTabSupported(activity, browser));
    }

    @Test public void authTabAcceptedUrlsLaunchExactlyAsWritten() throws Exception {
        registerChrome(); enableAuthTabs();
        for (String url : new String[] {"https://game.example/a%2Fb?x=%41&y=/?#z?/", "https://game.example/auth?x=1#"}) {
            WebViewDialog dialog = open();
            post(dialog, "https://game.example", true, request("a", url));
            assertEquals(url, takeAuthLaunch().intent.getDataString());
            dialog.forceClose();
        }
    }

    @Test public void supportedBrowserWithoutRegistryRepliesUnavailable() throws Exception {
        Activity registryHost = activity;
        ActivityController<Activity> plainHost = Robolectric.buildActivity(Activity.class).setup().visible();
        activity = plainHost.get();
        activity.setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar);
        try {
            registerChrome(); enableAuthTabs();
            JavaScriptReplyProxy proxy = post(open(), PAGE, true, request("a", SIGN_IN));
            assertReply(proxy, "a", "error", BreadAuthState.UNAVAILABLE);
            assertEquals(BreadAuthState.Phase.IDLE, BreadAuthController.state.phase());
            assertNull(BreadAuthController.state.refusal());
            assertNull(shadowOf(activity).getNextStartedActivity());
        } finally {
            plainHost.pause().stop().destroy();
            activity = registryHost;
        }
    }
}
