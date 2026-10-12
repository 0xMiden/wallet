package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.net.Uri;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowWebView;
import org.robolectric.shadow.api.Shadow;
import android.webkit.ValueCallback;
import androidx.webkit.WebMessageCompat;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.TextView;
import androidx.core.view.WindowCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class BreadPresentationControllerTest {
    private Activity activity;
    private WebViewDialog dialog;
    private Options options;
    private BreadPresentationController controller;
    private WebView webView;
    private WebViewCallbacks callbacks;
    private WebViewCompat.WebMessageListener messageListener;
    private MockedStatic<WebViewFeature> features;
    private MockedStatic<WebViewCompat> webkit;
    private final List<String> installed = new ArrayList<>();

    @Before public void setUp() {
        activity = Robolectric.buildActivity(Activity.class).setup().get();
        activity.setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar);
        features = mockStatic(WebViewFeature.class);
        webkit = mockStatic(WebViewCompat.class);
        webkit.when(() -> WebViewCompat.addWebMessageListener(any(), anyString(), anySet(), any()))
            .thenAnswer(call -> {
                assertNull(shadowOf((WebView) call.getArgument(0)).getLastLoadedUrl());
                installed.add("listener:" + call.getArgument(1));
                messageListener = call.getArgument(3);
                return null;
            });
        webkit.when(() -> WebViewCompat.addDocumentStartJavaScript(any(), anyString(), anySet()))
            .thenAnswer(call -> {
                assertNull(shadowOf((WebView) call.getArgument(0)).getLastLoadedUrl());
                installed.add("script:" + call.getArgument(1));
                return mock(ScriptHandler.class);
            });
    }

    private void open(boolean documentStart, boolean listener, String toolbar) {
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)).thenReturn(documentStart);
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)).thenReturn(listener);
        options = new Options();
        options.setUrl("https://fixture.example/first");
        options.setToolbarType(toolbar);
        options.setBackgroundColor("white");
        options.setWidth(390); options.setHeight(650); options.setX(0); options.setY(83);
        options.setPluginCall(mock(PluginCall.class));
        callbacks = mock(WebViewCallbacks.class);
        options.setCallbacks(callbacks);
        options.setBreadPresentation(new JSObject().put("script", "window.bread={version:1}")
            .put("logoSvg", "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='28'><rect width='48' height='28' fill='orange'/></svg>")
            .put("backLabel", "Back to Bread").put("retryLabel", "Retry")
            .put("hintLabel", "Tap Bread to return").put("errorLabel", "Loading failed"));
        dialog = new WebViewDialog(activity, androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar, options, null, new WebView(activity));
        dialog.activity = activity;
        dialog.presentWebView();
        controller = ReflectionHelpers.getField(dialog, "presentation");
        webView = ReflectionHelpers.getField(dialog, "_webView");
    }

    @After public void tearDown() {
        if (dialog != null) dialog.dismiss();
        webkit.close(); features.close();
        activity.finish();
    }

    private boolean fits() { return ReflectionHelpers.callInstanceMethod(dialog.getWindow(), "decorFitsSystemWindows"); }
    private WindowInsetsControllerCompat bars() { return WindowCompat.getInsetsController(dialog.getWindow(), dialog.getWindow().getDecorView()); }
    private void fullscreen() {
        controller.state.configure("doc", true, true);
        controller.render();
        assertFalse(fits());
        assertEquals(2, bars().getSystemBarsBehavior());
    }
    private void assertRestored(boolean fit, int behavior) {
        assertEquals(fit, fits());
        assertEquals(behavior, bars().getSystemBarsBehavior());
    }

    @Test public void browserNavigationRestoresFittingAndOriginalBarBehavior() {
        open(true, true, "default");
        boolean fit = fits(); int behavior = bars().getSystemBarsBehavior();
        assertTrue(fit);
        fullscreen();
        controller.navigate(); controller.state.configure("next", false, false); controller.render();
        assertRestored(fit, behavior);
    }

    @Test public void hideAndForegroundResumeRestoreThenReacquirePolicyWithNewPaint() {
        open(true, true, "default");
        boolean fit = fits(); int behavior = bars().getSystemBarsBehavior();
        fullscreen(); controller.state.ready(); long paint = controller.state.generation();
        controller.state.painted(paint);
        dialog.hide(); assertRestored(fit, behavior);
        dialog.show(); assertFalse(fits()); assertFalse(controller.state.canReveal(paint));
        controller.foreground(false); assertRestored(fit, behavior);
        controller.foreground(true); assertFalse(fits());
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
    }

    @Test public void closeRestoresPolicyAndEmitsOneTerminalEvent() {
        open(true, true, "default");
        boolean fit = fits(); int behavior = bars().getSystemBarsBehavior();
        fullscreen(); dialog.dismiss(); dialog.dismiss();
        assertRestored(fit, behavior);
        verify(callbacks, times(1)).closeEvent(any());
    }

    @Test public void blankToolbarKeepsItsPreviouslySelectedEdgeToEdgePolicy() {
        open(true, true, "blank");
        assertFalse(fits()); int behavior = bars().getSystemBarsBehavior();
        fullscreen(); controller.state.configure("next", false, false); controller.render();
        assertRestored(false, behavior);
    }

    @Test public void resumeDoesNotReplaceOriginalVisibilityWithStaleHiddenInsets() {
        open(true, true, "default");
        try (MockedStatic<ViewCompat> views = mockStatic(ViewCompat.class, CALLS_REAL_METHODS)) {
            views.when(() -> ViewCompat.getRootWindowInsets(any())).thenReturn(
                new WindowInsetsCompat.Builder().setVisible(WindowInsetsCompat.Type.systemBars(), true).build());
            fullscreen();
            dialog.hide();
            views.when(() -> ViewCompat.getRootWindowInsets(any())).thenReturn(
                new WindowInsetsCompat.Builder().setVisible(WindowInsetsCompat.Type.systemBars(), false).build());
            dialog.show();
            controller.state.configure("browser", false, false); controller.render();
            int requested = ReflectionHelpers.callInstanceMethod(dialog.getWindow().getInsetsController(), "getRequestedVisibleTypes");
            assertEquals(3, requested & 3);
        }
    }

    @Test @Config(sdk = 35)
    public void android15RetainsItsBrowserEdgeToEdgePolicy() {
        open(true, true, "default");
        assertFalse(fits()); int behavior = bars().getSystemBarsBehavior();
        fullscreen(); controller.state.configure("next", false, false); controller.render();
        assertRestored(false, behavior);
    }

    private ValueCallback<String> message(String type, String token) {
        String json = new JSObject().put("type", type).put("token", token)
            .put("display", "browser").put("manualReady", true).put("requestId", "request").toString();
        messageListener.onPostMessage(webView, new WebMessageCompat(json), Uri.parse(options.getUrl()), true, null);
        return shadowOf(webView).getLastEvaluatedJavascriptCallback();
    }

    @Test public void initialStartAfterBootstrapMessagesKeepsCurrentDocumentAuthority() {
        open(true, true, "default");
        ValueCallback<String> configure = message("configure", "initial");
        ValueCallback<String> ready = message("ready", "initial");
        shadowOf(webView).getWebViewClient().onPageStarted(webView, options.getUrl(), null);
        finishTokenRead(configure, "initial", "initial"); finishTokenRead(ready, "initial", "initial");
        assertEquals("initial", controller.state.token());
        assertTrue(controller.state.isReady());
    }

    private void rejectsReplacedDocument(String nextUrl) {
        open(true, true, "default");
        shadowOf(webView).getWebViewClient().onPageStarted(webView, options.getUrl(), null);
        message("configure", "old").onReceiveValue("\"old\"");
        ValueCallback<String> ready = message("ready", "old");
        ValueCallback<String> close = message("close", "old");
        shadowOf(webView).getWebViewClient().onPageStarted(webView, nextUrl, null);
        ready.onReceiveValue("\"old\""); close.onReceiveValue("\"old\"");
        assertNull(controller.state.token()); assertFalse(controller.state.isReady());
        verify(callbacks, never()).closeEvent(any());
        message("configure", "new").onReceiveValue("\"new\"");
        message("ready", "new").onReceiveValue("\"new\"");
        assertTrue(controller.state.isReady());
    }

    @Test public void sameUrlReloadRejectsPendingPreviousDocumentReads() { rejectsReplacedDocument("https://fixture.example/first"); }
    @Test public void redirectRejectsPendingPreviousDocumentReads() { rejectsReplacedDocument("https://fixture.example/redirect"); }

    private void finishTokenRead(ValueCallback<String> callback, String result, String current) {
        ValueCallback<String> previousLast = shadowOf(webView).getLastEvaluatedJavascriptCallback();
        callback.onReceiveValue("\"" + result + "\"");
        for (int i = 0; i < 5; i++) {
            ValueCallback<String> next = shadowOf(webView).getLastEvaluatedJavascriptCallback();
            if (next == previousLast || !"window.__breadPresentationToken".equals(shadowOf(webView).getLastEvaluatedJavascript())) return;
            previousLast = next; callback = next; callback.onReceiveValue("\"" + current + "\"");
        }
        fail("Current-document validation did not settle");
    }

    private void initialDocument() {
        open(true, true, "default");
        shadowOf(webView).getWebViewClient().onPageStarted(webView, options.getUrl(), null);
        finishTokenRead(message("configure", "old"), "old", "old");
        finishTokenRead(message("ready", "old"), "old", "old");
    }

    private void replacementBeforeStart(boolean finishBeforeStart) {
        initialDocument();
        ValueCallback<String> configure = message("configure", "replacement");
        ValueCallback<String> ready = message("ready", "replacement");
        if (finishBeforeStart) {
            finishTokenRead(configure, "replacement", "replacement");
            finishTokenRead(ready, "replacement", "replacement");
        }
        long paint = controller.state.generation();
        controller.state.painted(paint);
        shadowOf(webView).getWebViewClient().onPageStarted(webView, options.getUrl(), null);
        assertFalse(controller.state.canReveal(paint));
        if (finishBeforeStart) {
            assertEquals("window.__breadPresentationToken", shadowOf(webView).getLastEvaluatedJavascript());
            finishTokenRead(shadowOf(webView).getLastEvaluatedJavascriptCallback(), "replacement", "replacement");
        } else {
            finishTokenRead(configure, "replacement", "replacement");
            finishTokenRead(ready, "replacement", "replacement");
        }
        assertEquals("replacement", controller.state.token()); assertTrue(controller.state.isReady());
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
        assertTrue(controller.state.canReveal(controller.state.generation()));
        assertEquals(View.VISIBLE, ((View) ReflectionHelpers.getField(controller, "cover")).getVisibility());
    }

    @Test public void replacementBootstrapCompletedBeforeLaterStartGetsFreshPaint() { replacementBeforeStart(true); }
    @Test public void replacementBootstrapReadsCrossingLaterStartGetFreshAuthority() { replacementBeforeStart(false); }

    @Test public void provisionalSameUrlStartRejectsEvenFreshReadsOfPreviousDocument() {
        initialDocument();
        ValueCallback<String> oldReady = message("ready", "old");
        ValueCallback<String> oldClose = message("close", "old");
        long paint = controller.state.generation();
        shadowOf(webView).getWebViewClient().onPageStarted(webView, options.getUrl(), null);
        finishTokenRead(oldReady, "old", "old"); finishTokenRead(oldClose, "old", "old");
        finishTokenRead(message("ready", "old"), "old", "old");
        finishTokenRead(message("close", "old"), "old", "old");
        assertFalse(shadowOf(webView).getLastEvaluatedJavascript().startsWith("window.__breadPresentationRespond"));
        assertFalse(controller.state.canReveal(paint)); assertFalse(controller.state.isReady());
        verify(callbacks, never()).closeEvent(any());
        finishTokenRead(message("configure", "replacement"), "replacement", "replacement");
        finishTokenRead(message("ready", "replacement"), "replacement", "replacement");
        assertTrue(controller.state.isReady());
    }

    @Test public void oldReadsCrossingEarlyReplacementCannotRevealOrCloseIt() {
        initialDocument();
        ValueCallback<String> oldReady = message("ready", "old");
        ValueCallback<String> oldClose = message("close", "old");
        finishTokenRead(message("configure", "replacement"), "replacement", "replacement");
        finishTokenRead(oldReady, "old", "replacement");
        assertFalse(controller.state.isReady());
        shadowOf(webView).getWebViewClient().onPageStarted(webView, options.getUrl(), null);
        finishTokenRead(oldClose, "old", "replacement");
        verify(callbacks, never()).closeEvent(any()); assertFalse(controller.state.isReady());
        finishTokenRead(message("configure", "replacement"), "replacement", "replacement");
        finishTokenRead(message("ready", "replacement"), "replacement", "replacement");
        assertTrue(controller.state.isReady());
    }

    @Test public void oldCloseAcknowledgementCannotCloseAnEarlyReplacement() {
        initialDocument();
        finishTokenRead(message("close", "old"), "old", "old");
        ValueCallback<String> acknowledgement = shadowOf(webView).getLastEvaluatedJavascriptCallback();
        finishTokenRead(message("configure", "replacement"), "replacement", "replacement");
        finishTokenRead(acknowledgement, "null", "replacement");
        verify(callbacks, never()).closeEvent(any());
        assertEquals("replacement", controller.state.token());
    }

    @Test public void currentCloseAcknowledgementCrossingLaterStartRevalidatesAndClosesOnce() {
        initialDocument();
        finishTokenRead(message("configure", "replacement"), "replacement", "replacement");
        finishTokenRead(message("close", "replacement"), "replacement", "replacement");
        ValueCallback<String> acknowledgement = shadowOf(webView).getLastEvaluatedJavascriptCallback();
        shadowOf(webView).getWebViewClient().onPageStarted(webView, options.getUrl(), null);
        finishTokenRead(acknowledgement, "null", "replacement");
        assertTrue(shadowOf(webView).getLastEvaluatedJavascript().startsWith("window.__breadPresentationRespond"));
        shadowOf(webView).getLastEvaluatedJavascriptCallback().onReceiveValue("null");
        dialog.dismiss(); verify(callbacks, times(1)).closeEvent(any());
    }

    @Test public void retryBlocksOldRequestsBeforeReloadStartButKeepsEarlyReplacement() {
        initialDocument(); controller.failed();
        ((Button) ReflectionHelpers.getField(controller, "retry")).performClick();
        finishTokenRead(message("ready", "old"), "old", "old");
        assertFalse(controller.state.isReady());
        finishTokenRead(message("close", "old"), "old", "old");
        assertFalse(shadowOf(webView).getLastEvaluatedJavascript().startsWith("window.__breadPresentationRespond"));
        finishTokenRead(message("configure", "replacement"), "replacement", "replacement");
        finishTokenRead(message("ready", "replacement"), "replacement", "replacement");
        shadowOf(webView).getWebViewClient().onPageStarted(webView, options.getUrl(), null);
        finishTokenRead(shadowOf(webView).getLastEvaluatedJavascriptCallback(), "replacement", "replacement");
        assertEquals("replacement", controller.state.token()); assertTrue(controller.state.isReady());
    }

    @Implements(WebView.class)
    public static class PaintWebView extends ShadowWebView {
        WebView.VisualStateCallback fence;
        long request;
        @Implementation protected void postVisualStateCallback(long request, WebView.VisualStateCallback fence) {
            this.request = request; this.fence = fence;
        }
    }

    @Test @Config(shadows = PaintWebView.class)
    public void replacementRequiresItsOwnNativeVisualFence() {
        initialDocument();
        webView = spy(webView);
        doReturn(390).when(webView).getWidth(); doReturn(650).when(webView).getHeight();
        doAnswer(call -> { ((Runnable) call.getArgument(0)).run(); return true; }).when(webView).post(any());
        ReflectionHelpers.setField(controller, "webView", webView);
        controller.render();
        assertTrue(shadowOf(webView).getLastEvaluatedJavascript().contains("__breadPresentationUpdate"));
        shadowOf(webView).getLastEvaluatedJavascriptCallback().onReceiveValue("true");
        PaintWebView renderer = Shadow.extract(webView);
        WebView.VisualStateCallback oldFence = renderer.fence; long oldRequest = renderer.request;
        assertNotNull(oldFence);
        finishTokenRead(message("configure", "replacement"), "replacement", "replacement");
        finishTokenRead(message("ready", "replacement"), "replacement", "replacement");
        shadowOf(webView).getWebViewClient().onPageStarted(webView, options.getUrl(), null);
        finishTokenRead(shadowOf(webView).getLastEvaluatedJavascriptCallback(), "replacement", "replacement");
        oldFence.onComplete(oldRequest);
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
        assertEquals(View.VISIBLE, ((View) ReflectionHelpers.getField(controller, "cover")).getVisibility());
        assertTrue(shadowOf(webView).getLastEvaluatedJavascript().contains("__breadPresentationUpdate"));
        shadowOf(webView).getLastEvaluatedJavascriptCallback().onReceiveValue("true");
        assertNotEquals(oldRequest, renderer.request);
        renderer.fence.onComplete(renderer.request);
        assertEquals(BreadPresentationState.Phase.VISIBLE, controller.state.phase());
    }

    private void unsupported(boolean documentStart, boolean listener) {
        open(documentStart, listener, "default");
        assertTrue(installed.isEmpty());
        assertEquals("https://fixture.example/first", shadowOf(webView).getLastLoadedUrl());
        assertNull(shadowOf(webView).getLastEvaluatedJavascript());
        FrameLayout cover = ReflectionHelpers.getField(controller, "cover");
        TextView error = ReflectionHelpers.getField(controller, "error");
        ImageButton exit = ReflectionHelpers.getField(controller, "back");
        Button retry = ReflectionHelpers.getField(controller, "retry");
        assertEquals(View.VISIBLE, cover.getVisibility());
        assertEquals(View.VISIBLE, error.getVisibility());
        assertEquals("Loading failed", error.getText().toString());
        assertEquals(View.VISIBLE, exit.getVisibility()); assertTrue(exit.isEnabled());
        assertEquals("Back to Bread", exit.getContentDescription()); assertFalse(retry.isEnabled());
        controller.state.configure("late", true, false); controller.state.ready();
        dialog.hide(); dialog.show(); controller.foreground(false); controller.foreground(true);
        assertFalse(controller.state.canReveal(controller.state.generation()));
        assertEquals(View.VISIBLE, cover.getVisibility());
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, webView.getImportantForAccessibility());
        exit.performClick(); exit.performClick(); dialog.show();
        assertEquals(BreadPresentationState.Phase.CLOSED, controller.state.phase());
        assertFalse(dialog.isShowing()); verify(callbacks, times(1)).closeEvent(any());
    }

    @Test public void noDocumentStartFailsClosedWithoutBridgeOrPublicScript() { unsupported(false, true); }
    @Test public void noMessageListenerFailsClosedWithoutBridgeOrPublicScript() { unsupported(true, false); }
    @Test public void neitherCapabilityFailsClosedWithoutBridgeOrPublicScript() { unsupported(false, false); }

    @Test public void supportedInstallsBothTransportsBeforeFirstNavigation() {
        open(true, true, "default");
        assertEquals(List.of("listener:breadPresentation", "script:window.bread={version:1}"), installed);
        assertEquals("https://fixture.example/first", shadowOf(webView).getLastLoadedUrl());
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
    }

    @Test public void lateSlotUpdatesStayRetainedUntilBrowserRestoration() {
        open(true, true, "default"); fullscreen();
        dialog.updateDimensions(300, 500, 12, 80);
        WindowManager.LayoutParams full = dialog.getWindow().getAttributes();
        assertEquals(-1, full.width); assertEquals(-1, full.height); assertEquals(0, full.x); assertEquals(0, full.y);
        assertEquals(Integer.valueOf(300), options.getWidth()); assertEquals(Integer.valueOf(500), options.getHeight());
        controller.navigate(); controller.state.configure("browser", false, false); controller.render();
        WindowManager.LayoutParams normal = dialog.getWindow().getAttributes();
        float density = activity.getResources().getDisplayMetrics().density;
        int status = activity.getResources().getDimensionPixelSize(activity.getResources().getIdentifier("status_bar_height", "dimen", "android"));
        assertEquals((int)(300*density), normal.width); assertEquals((int)(500*density), normal.height);
        assertEquals((int)(12*density), normal.x); assertEquals((int)(80*density)+status, normal.y);
    }
}
