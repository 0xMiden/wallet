package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.util.Log;
import android.webkit.GeolocationPermissions;
import android.webkit.HttpAuthHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import androidx.activity.ComponentActivity;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedConstruction;
import org.mockito.MockedStatic;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class BridgeLogPrivacyTest {
    private static final String MARKER = "bread-log-marker-1582";
    private static final String INSTANCE_ID = "bridge-log-fixture";
    private Activity activity;
    private ComponentActivity resultHost;
    private RecordingPlugin plugin;
    private WebViewDialog dialog;
    private WebViewCallbacks callbacks;
    private MockedConstruction<WebViewDialog> dialogs;
    private WebViewDialog realDialog;
    private MockedStatic<WebViewFeature> features;
    private MockedStatic<WebViewCompat> webkit;
    private ApplicationInfo applicationInfo;
    private int originalFlags;

    @Before public void setUp() {
        activity = Robolectric.buildActivity(Activity.class).setup().visible().get();
        activity.setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar);
        applicationInfo = activity.getApplication().getApplicationInfo();
        originalFlags = applicationInfo.flags;
        plugin = spy(new RecordingPlugin());
        AppCompatActivity pluginActivity = mock(AppCompatActivity.class);
        resultHost = Robolectric.buildActivity(ComponentActivity.class).setup().get();
        doReturn(resultHost.getActivityResultRegistry()).when(pluginActivity).getActivityResultRegistry();
        doReturn(resultHost.getSavedStateRegistry()).when(pluginActivity).getSavedStateRegistry();
        doAnswer(call -> { ((Runnable) call.getArgument(0)).run(); return null; }).when(pluginActivity).runOnUiThread(any());
        doReturn(pluginActivity).when(plugin).getActivity();
        doReturn(activity.getApplication()).when(plugin).getContext();
        Bridge bridge = mock(Bridge.class);
        doReturn(bridge).when(plugin).getBridge();
        when(bridge.getWebView()).thenReturn(new WebView(activity));
        dialogs = mockConstruction(WebViewDialog.class, (created, context) -> {
            Options options = (Options) context.arguments().get(2);
            callbacks = options.getCallbacks();
        });
        PluginCall call = mock(PluginCall.class);
        when(call.getString("url")).thenReturn("https://fixture.example");
        when(call.getString("id")).thenReturn(INSTANCE_ID);
        when(call.getString("id", WebViewRegistry.DEFAULT_INSTANCE_ID)).thenReturn(INSTANCE_ID);
        when(call.getData()).thenReturn(new JSObject());
        plugin.openWebView(call);
        verify(call).resolve();
        assertEquals(1, dialogs.constructed().size());
        dialog = dialogs.constructed().get(0);
        assertNotNull(callbacks);
        ShadowLog.clear();
    }

    @After public void tearDown() {
        WebViewRegistry.getShared().remove(INSTANCE_ID);
        if (dialogs != null) dialogs.close();
        if (realDialog != null) realDialog.forceClose();
        if (webkit != null) webkit.close();
        if (features != null) features.close();
        shadowOf(activity.getApplication()).checkActivities(false);
        applicationInfo.flags = originalFlags;
        plugin.load();
        resultHost.finish();
        activity.finish();
        ShadowLog.clear();
    }

    @Test public void pageMessageContentStaysOutOfLogs() {
        callbacks.javascriptCallback(new JSObject().put("word", MARKER).toString());
        JSObject event = receivedMessage();
        assertEquals(MARKER, event.getString("word"));
        assertEquals(INSTANCE_ID, event.getString("id"));
        assertFalse(event.has("rawMessage"));
        assertNoMarkerInLogs();
    }

    @Test public void malformedPageMessageContentStaysOutOfLogs() {
        callbacks.javascriptCallback(MARKER);
        JSObject event = receivedMessage();
        assertEquals(MARKER, event.getString("rawMessage"));
        assertEquals(INSTANCE_ID, event.getString("id"));
        assertNoMarkerInLogs();
    }

    @Test public void walletMessageContentStaysOutOfLogs() {
        JSObject detail = new JSObject().put("word", MARKER);
        PluginCall call = mock(PluginCall.class);
        when(call.getString("id")).thenReturn(INSTANCE_ID);
        when(call.getObject("detail")).thenReturn(detail);
        plugin.postMessage(call);
        verify(dialog).postMessageToJS(detail);
        verify(call).resolve();
        verify(call, never()).reject(anyString());
        assertNoMarkerInLogs();
    }

    @Test public void walletMessageWithoutDetailStillRejects() {
        PluginCall call = mock(PluginCall.class);
        when(call.getString("id")).thenReturn(INSTANCE_ID);
        plugin.postMessage(call);
        verify(call).reject("No event data provided");
        verify(call, never()).resolve();
        verify(dialog, never()).postMessageToJS(any());
    }

    @Test public void releaseNavigationContentStaysOutOfLogsAfterDebugLoad() {
        loadLogging(true);
        loadLogging(false);
        WebView webView = openRealDialog(new Options());
        ShadowLog.clear();
        assertFalse(navigate(webView, "https://fixture.example/" + MARKER + "?token=" + MARKER));
        assertNoMarkerInLogs();
    }

    @Test public void malformedIntentContentStaysOutOfReleaseLogs() {
        loadLogging(false);
        WebView webView = openRealDialog(new Options());
        ShadowLog.clear();
        assertTrue(navigate(webView, "intent://fixture.example/" + MARKER + "?token=" + MARKER
            + "#Intent;scheme=https;X.token=" + MARKER + ";end"));
        assertNoHandlerWarning("URISyntaxException");
        assertNoMarkerInLogs();
    }

    @Test public void missingCustomSchemeHandlerContentStaysOutOfReleaseLogs() {
        loadLogging(false);
        WebView webView = openRealDialog(new Options());
        shadowOf(activity.getApplication()).checkActivities(true);
        ShadowLog.clear();
        assertTrue(navigate(webView, "bread-no-handler://fixture.example/" + MARKER + "?token=" + MARKER));
        assertNoHandlerWarning("ActivityNotFoundException");
        assertNoMarkerInLogs();
    }

    @Test public void geolocationOriginStaysOutOfReleaseLogs() {
        loadLogging(false);
        WebView webView = openRealDialog(new Options());
        String origin = "https://" + MARKER + ".example";
        GeolocationPermissions.Callback callback = mock(GeolocationPermissions.Callback.class);
        ShadowLog.clear();
        shadowOf(webView).getWebChromeClient().onGeolocationPermissionsShowPrompt(origin, callback);
        verify(callback).invoke(origin, true, false);
        assertNoMarkerInLogs();
    }

    @Test public void fileChooserAcceptTypeStaysOutOfReleaseLogs() {
        loadLogging(false);
        WebView webView = openRealDialog(new Options());
        WebChromeClient.FileChooserParams params = mock(WebChromeClient.FileChooserParams.class);
        when(params.getAcceptTypes()).thenReturn(new String[] { "application/" + MARKER });
        when(params.getMode()).thenReturn(WebChromeClient.FileChooserParams.MODE_OPEN);
        ShadowLog.clear();
        assertTrue(shadowOf(webView).getWebChromeClient().onShowFileChooser(webView, ignored -> {}, params));
        assertNoMarkerInLogs();
    }

    @Test public void httpAuthPageUrlStaysOutOfReleaseLogsAndSystemErr() {
        loadLogging(false);
        Options options = new Options();
        options.setCredentials(new JSObject().put("username", "fixture-user").put("password", "fixture-password"));
        WebView webView = openRealDialog(options);
        String pageUrl = "https://fixture.example/page?token={" + MARKER + "}";
        webView.loadUrl(pageUrl);
        assertEquals(pageUrl, webView.getUrl());
        HttpAuthHandler handler = mock(HttpAuthHandler.class);
        ByteArrayOutputStream errors = new ByteArrayOutputStream();
        PrintStream originalErr = System.err;
        ShadowLog.clear();
        try (PrintStream capturedErr = new PrintStream(errors, true, StandardCharsets.UTF_8)) {
            System.setErr(capturedErr);
            shadowOf(webView).getWebViewClient().onReceivedHttpAuthRequest(webView, handler, "fixture.example", "fixture");
        } finally {
            System.setErr(originalErr);
        }
        verify(handler, never()).proceed(anyString(), anyString());
        assertFalse("Page URL in System.err", errors.toString(StandardCharsets.UTF_8).contains(MARKER));
        assertNoMarkerInLogs();
        assertTrue("Invalid page URI must emit a sanitized warning", ShadowLog.getLogs().stream()
            .anyMatch(log -> log.type == Log.WARN && "InAppBrowser".equals(log.tag)
                && "Invalid HTTP auth page URI: URISyntaxException".equals(log.msg) && log.throwable == null));
    }

    @Test public void debugNavigationStillLogsPageContent() {
        loadLogging(false);
        loadLogging(true);
        WebView webView = openRealDialog(new Options());
        ShadowLog.clear();
        assertFalse(navigate(webView, "https://fixture.example/" + MARKER + "?token=" + MARKER));
        assertTrue("Debug navigation must retain diagnostics", ShadowLog.getLogs().stream()
            .anyMatch(log -> log.type == Log.DEBUG && log.msg != null && log.msg.contains(MARKER)));
    }

    private void loadLogging(boolean debuggable) {
        if (debuggable) applicationInfo.flags |= ApplicationInfo.FLAG_DEBUGGABLE;
        else applicationInfo.flags &= ~ApplicationInfo.FLAG_DEBUGGABLE;
        plugin.load();
    }

    private WebView openRealDialog(Options options) {
        dialogs.close();
        dialogs = null;
        features = mockStatic(WebViewFeature.class);
        webkit = mockStatic(WebViewCompat.class);
        if (options.getUrl() == null) options.setUrl("https://fixture.example/first");
        options.setToolbarType("default");
        options.setBackgroundColor("white");
        options.setPluginCall(mock(PluginCall.class));
        options.setCallbacks(mock(WebViewCallbacks.class));
        realDialog = new WebViewDialog(activity, androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar,
            options, null, new WebView(activity));
        realDialog.activity = activity;
        realDialog.presentWebView();
        return ReflectionHelpers.getField(realDialog, "_webView");
    }

    private static boolean navigate(WebView webView, String url) {
        WebResourceRequest request = mock(WebResourceRequest.class);
        when(request.getUrl()).thenReturn(Uri.parse(url));
        when(request.isForMainFrame()).thenReturn(true);
        return shadowOf(webView).getWebViewClient().shouldOverrideUrlLoading(webView, request);
    }

    private static void assertNoHandlerWarning(String exceptionClass) {
        ShadowLog.LogItem warning = null;
        for (ShadowLog.LogItem log : ShadowLog.getLogs()) {
            if (log.type != Log.WARN || !"InAppBrowser".equals(log.tag)
                || log.msg == null || !log.msg.startsWith("No handler for external URL")) continue;
            assertNull("One no-handler warning", warning);
            warning = log;
        }
        assertNotNull("No-handler path must emit a warning", warning);
        assertNull("No-handler warning must not carry a throwable", warning.throwable);
        assertEquals("No handler for external URL: " + exceptionClass, warning.msg);
    }

    private JSObject receivedMessage() {
        JSObject received = null;
        for (RecordingPlugin.Event event : plugin.events) {
            if (!"messageFromWebview".equals(event.name)) continue;
            assertNull("one page message, one event", received);
            received = event.data;
        }
        assertNotNull(received);
        return received;
    }

    // Plugin.notifyListeners is protected in another package, so the test records events by overriding it.
    public static class RecordingPlugin extends InAppBrowserPlugin {
        static final class Event {
            final String name;
            final JSObject data;

            Event(String name, JSObject data) {
                this.name = name;
                this.data = data;
            }
        }

        final java.util.List<Event> events = new java.util.ArrayList<>();

        @Override
        protected void notifyListeners(String eventName, JSObject data) {
            events.add(new Event(eventName, data));
        }
    }

    private static void assertNoMarkerInLogs() {
        for (ShadowLog.LogItem log : ShadowLog.getLogs()) {
            assertFalse("Bridge content in log message", log.msg != null && log.msg.contains(MARKER));
            for (Throwable failure = log.throwable; failure != null; failure = failure.getCause()) {
                assertFalse("Bridge content in logged throwable", failure.getMessage() != null && failure.getMessage().contains(MARKER));
            }
        }
    }
}
