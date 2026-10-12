package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.net.Uri;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowWebView;
import org.robolectric.shadow.api.Shadow;
import android.webkit.ValueCallback;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.Navigation;
import androidx.webkit.NavigationListener;
import androidx.webkit.Page;
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

@androidx.annotation.OptIn(markerClass = androidx.webkit.WebNavigationClient.ExperimentalNavigationCallback.class)
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
    private NavigationListener navigationListener;
    private java.util.concurrent.Executor navigationExecutor;
    private MockedStatic<WebViewFeature> features;
    private MockedStatic<WebViewCompat> webkit;
    private final List<String> installed = new ArrayList<>();

    @Before public void setUp() {
        activity = Robolectric.buildActivity(Activity.class).setup().get();
        activity.setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar);
        features = mockStatic(WebViewFeature.class);
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.NAVIGATION_LISTENER_V1)).thenReturn(true);
        webkit = mockStatic(WebViewCompat.class);
        webkit.when(() -> WebViewCompat.addWebMessageListener(any(), anyString(), anySet(), any()))
            .thenAnswer(call -> {
                assertNull(shadowOf((WebView) call.getArgument(0)).getLastLoadedUrl());
                installed.add("listener:" + call.getArgument(1));
                messageListener = call.getArgument(3);
                return null;
            });
        webkit.when(() -> WebViewCompat.addNavigationListener(any(), any(java.util.concurrent.Executor.class), any(NavigationListener.class)))
            .thenAnswer(call -> {
                assertNull(shadowOf((WebView) call.getArgument(0)).getLastLoadedUrl());
                navigationExecutor = call.getArgument(1); navigationListener = call.getArgument(2); return null;
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

    private final java.util.ArrayDeque<ValueCallback<String>> tokenReads = new java.util.ArrayDeque<>();

    private void openIdentified() {
        open(true, true, "default");
        assertNotNull("Install native navigation identity before first load", navigationListener);
        webView = spy(webView);
        doAnswer(call -> {
            if ("window.__breadPresentationToken".equals(call.getArgument(0))) tokenReads.add(call.getArgument(1));
            return call.callRealMethod();
        }).when(webView).evaluateJavascript(anyString(), any());
        ReflectionHelpers.setField(controller, "webView", webView);
    }

    private Navigation startDocument() {
        Navigation navigation = mock(Navigation.class);
        when(navigation.getUrl()).thenReturn(options.getUrl());
        when(navigation.getPage()).thenReturn(mock(Page.class));
        navigationListener.onNavigationStarted(navigation);
        return navigation;
    }

    private void commit(Navigation navigation) {
        when(navigation.didCommit()).thenReturn(true);
        navigationListener.onNavigationCompleted(navigation);
    }

    private void flushTokenReads(String token) {
        for (int i = 0; !tokenReads.isEmpty() && i < 100; i++) tokenReads.remove().onReceiveValue("\"" + token + "\"");
        assertTrue("Token validation must settle", tokenReads.isEmpty());
    }

    private void readyDocument(String token) {
        message("configure", token); message("ready", token); flushTokenReads(token);
        assertEquals(token, controller.state.token()); assertTrue(controller.state.isReady());
    }

    private void initialDocument() {
        openIdentified(); commit(startDocument()); readyDocument("old");
    }

    private void legacyStart() {
        shadowOf(webView).getWebViewClient().onPageStarted(webView, options.getUrl(), null);
    }

    private void assertCovered() {
        assertFalse(controller.state.isReady());
        assertFalse(controller.state.canReveal(controller.state.generation()));
        assertEquals(View.VISIBLE, ((View) ReflectionHelpers.getField(controller, "cover")).getVisibility());
        verify(callbacks, never()).closeEvent(any());
    }

    @Test public void initialStartAfterBootstrapMessagesKeepsCurrentDocumentAuthority() {
        openIdentified(); Navigation initial = startDocument();
        message("configure", "initial"); message("ready", "initial");
        assertTrue(tokenReads.isEmpty()); assertCovered();
        legacyStart(); commit(initial); flushTokenReads("initial");
        assertEquals("initial", controller.state.token()); assertTrue(controller.state.isReady());
    }

    private void replacementBeforeLegacyStart(boolean finishBeforeStart) {
        initialDocument(); long paint = controller.state.generation();
        Navigation replacement = startDocument(); commit(replacement);
        message("configure", "replacement"); message("ready", "replacement");
        if (finishBeforeStart) flushTokenReads("replacement");
        legacyStart();
        if (!finishBeforeStart) flushTokenReads("replacement");
        assertFalse(controller.state.canReveal(paint));
        assertEquals("replacement", controller.state.token()); assertTrue(controller.state.isReady());
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
    }

    @Test public void replacementBootstrapCompletedBeforeLaterStartGetsFreshPaint() { replacementBeforeLegacyStart(true); }
    @Test public void replacementBootstrapReadsCrossingLaterStartGetFreshAuthority() { replacementBeforeLegacyStart(false); }

    private void rejectsReplacedDocument(boolean redirect) {
        initialDocument(); message("ready", "old"); message("close", "old");
        Navigation current = startDocument();
        if (redirect) { when(current.getUrl()).thenReturn("https://fixture.example/redirect"); navigationListener.onNavigationRedirected(current); }
        flushTokenReads("old"); message("ready", "old"); message("close", "old");
        assertCovered(); assertTrue(tokenReads.isEmpty());
        commit(current); flushTokenReads("new"); assertCovered();
        readyDocument("new");
    }

    @Test public void sameUrlReloadRejectsPendingPreviousDocumentReads() { rejectsReplacedDocument(false); }
    @Test public void redirectRejectsPendingPreviousDocumentReads() { rejectsReplacedDocument(true); }
    @Test public void provisionalSameUrlStartRejectsEvenFreshReadsOfPreviousDocument() { rejectsReplacedDocument(false); }

    @Test public void consecutiveStartsRetireIntermediateReadinessBeforePairingReadCompletes() {
        initialDocument(); Navigation intermediate = startDocument(); commit(intermediate);
        readyDocument("intermediate"); legacyStart();
        message("configure", "intermediate");
        Navigation current = startDocument(); legacyStart();
        commit(intermediate); flushTokenReads("intermediate");
        message("ready", "intermediate"); message("close", "intermediate");
        assertCovered(); assertTrue(tokenReads.isEmpty());
        message("configure", "current"); message("ready", "current");
        commit(current); flushTokenReads("current");
        assertEquals("current", controller.state.token()); assertTrue(controller.state.isReady());
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
    }

    @Test public void consecutiveStartsRetireIntermediateConfigureWhoseFirstReadIsPending() {
        initialDocument(); Navigation intermediate = startDocument(); commit(intermediate);
        message("configure", "intermediate"); message("ready", "intermediate");
        Navigation current = startDocument();
        flushTokenReads("intermediate"); commit(intermediate); assertCovered();
        message("configure", "current"); message("ready", "current");
        commit(current); flushTokenReads("current");
        assertEquals("current", controller.state.token()); assertTrue(controller.state.isReady());
    }

    @Test public void consecutiveStartsRetireIntermediateCloseAndPendingAcknowledgement() {
        initialDocument(); commit(startDocument()); readyDocument("intermediate");
        message("close", "intermediate"); flushTokenReads("intermediate");
        ValueCallback<String> acknowledgement = shadowOf(webView).getLastEvaluatedJavascriptCallback();
        Navigation current = startDocument(); acknowledgement.onReceiveValue("null");
        message("close", "intermediate"); assertCovered(); assertTrue(tokenReads.isEmpty());
        commit(current); flushTokenReads("current"); assertCovered(); readyDocument("current");
        message("close", "current"); flushTokenReads("current");
        shadowOf(webView).getLastEvaluatedJavascriptCallback().onReceiveValue("null");
        dialog.dismiss(); verify(callbacks, times(1)).closeEvent(any());
        webkit.verify(() -> WebViewCompat.removeNavigationListener(webView, navigationListener), times(1));
    }

    @Test public void oldReadsCrossingEarlyReplacementCannotRevealOrCloseIt() {
        initialDocument(); message("ready", "old"); message("close", "old");
        Navigation replacement = startDocument();
        message("configure", "replacement"); message("ready", "replacement");
        commit(replacement); flushTokenReads("replacement"); legacyStart();
        verify(callbacks, never()).closeEvent(any());
        assertEquals("replacement", controller.state.token()); assertTrue(controller.state.isReady());
    }

    @Test public void oldCloseAcknowledgementCannotCloseAnEarlyReplacement() {
        initialDocument(); message("close", "old"); flushTokenReads("old");
        ValueCallback<String> acknowledgement = shadowOf(webView).getLastEvaluatedJavascriptCallback();
        commit(startDocument()); readyDocument("replacement");
        acknowledgement.onReceiveValue("null"); flushTokenReads("replacement");
        verify(callbacks, never()).closeEvent(any());
    }

    @Test public void currentCloseAcknowledgementCrossingLaterLegacyStartClosesOnce() {
        initialDocument(); commit(startDocument()); readyDocument("replacement");
        message("close", "replacement"); flushTokenReads("replacement");
        ValueCallback<String> acknowledgement = shadowOf(webView).getLastEvaluatedJavascriptCallback();
        legacyStart(); acknowledgement.onReceiveValue("null");
        dialog.dismiss(); verify(callbacks, times(1)).closeEvent(any());
    }

    @Test public void retryBlocksOldRequestsBeforeReloadStartButKeepsEarlyReplacement() {
        initialDocument(); controller.failed();
        ((Button) ReflectionHelpers.getField(controller, "retry")).performClick();
        message("ready", "old"); message("close", "old"); assertCovered();
        Navigation replacement = startDocument(); message("configure", "replacement"); message("ready", "replacement");
        commit(replacement); flushTokenReads("replacement"); legacyStart();
        assertEquals("replacement", controller.state.token()); assertTrue(controller.state.isReady());
    }

    private void retry() {
        assertEquals(BreadPresentationState.Phase.ERROR, controller.state.phase());
        ((Button) ReflectionHelpers.getField(controller, "retry")).performClick();
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void retryRetiresQueuedRequestsBeforeOutgoingCompletion() {
        openIdentified(); Navigation outgoing = startDocument();
        message("configure", "outgoing"); message("ready", "outgoing"); message("close", "outgoing");
        controller.state.tick(android.os.SystemClock.uptimeMillis() + 30_000); controller.render(); retry();
        commit(outgoing);
        int outgoingReads = tokenReads.size(); flushTokenReads("outgoing"); assertCovered();
        assertEquals("Retired completion must not evaluate outgoing requests", 0, outgoingReads);
        message("configure", "outgoing"); message("ready", "outgoing"); message("close", "outgoing");
        assertTrue(tokenReads.isEmpty()); assertCovered();
        Navigation current = startDocument(); commit(current);
        assertTrue("Retry must not replay outgoing queued requests on the new commit", tokenReads.isEmpty());
        readyDocument("current");
        doReturn(390).when(webView).getWidth(); doReturn(650).when(webView).getHeight();
        doAnswer(call -> { ((Runnable) call.getArgument(0)).run(); return true; }).when(webView).post(any());
        controller.render();
        PaintWebView renderer = Shadow.extract(webView);
        assertNull(renderer.fence);
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
        assertEquals(View.VISIBLE, ((View) ReflectionHelpers.getField(controller, "cover")).getVisibility());
        assertTrue(shadowOf(webView).getLastEvaluatedJavascript().contains("__breadPresentationUpdate"));
        shadowOf(webView).getLastEvaluatedJavascriptCallback().onReceiveValue("true");
        assertNotNull(renderer.fence);
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
        renderer.fence.onComplete(renderer.request);
        assertEquals(BreadPresentationState.Phase.VISIBLE, controller.state.phase());
        message("close", "current"); flushTokenReads("current");
        shadowOf(webView).getLastEvaluatedJavascriptCallback().onReceiveValue("null");
        dialog.dismiss(); verify(callbacks, times(1)).closeEvent(any());
    }

    @Test public void retryDiscardsRetainedConfigurationAndReadiness() {
        initialDocument(); controller.failed(); retry();
        Navigation current = startDocument(); commit(current);
        assertTrue("A retry must require new document configuration and readiness", tokenReads.isEmpty());
        message("configure", "current"); flushTokenReads("current"); assertCovered();
        message("ready", "current"); flushTokenReads("current");
        assertTrue(controller.state.isReady());
    }

    @Test public void retryDiscardsHeldTokenReadsEvenAfterReplacementCommit() {
        initialDocument();
        message("configure", "old"); message("ready", "old"); message("close", "old");
        List<ValueCallback<String>> heldReads = new ArrayList<>(tokenReads); tokenReads.clear();
        controller.failed(); retry();
        Navigation current = startDocument();
        message("configure", "current"); message("ready", "current"); commit(current); flushTokenReads("current");
        for (ValueCallback<String> read : heldReads) read.onReceiveValue("\"old\"");
        assertTrue("Pre-Retry reads must not requeue validation in the replacement", tokenReads.isEmpty());
        assertEquals("current", controller.state.token()); assertTrue(controller.state.isReady());
        verify(callbacks, never()).closeEvent(any());
    }

    private void retryWithHeldAcknowledgement(boolean afterReplacement) {
        openIdentified(); Navigation outgoing = startDocument(); commit(outgoing); readyDocument("old");
        message("close", "old"); flushTokenReads("old");
        ValueCallback<String> acknowledgement = shadowOf(webView).getLastEvaluatedJavascriptCallback();
        controller.failed(); retry();
        if (afterReplacement) { commit(startDocument()); readyDocument("current"); }
        else commit(outgoing);
        tokenReads.clear();
        acknowledgement.onReceiveValue("null");
        assertTrue("Retired acknowledgement must not reacquire authority", tokenReads.isEmpty());
        verify(callbacks, never()).closeEvent(any());
        if (!afterReplacement) assertCovered();
    }

    @Test public void retryDiscardsHeldCloseAcknowledgementBeforeReplacementStart() { retryWithHeldAcknowledgement(false); }
    @Test public void retryDiscardsHeldCloseAcknowledgementAfterReplacementCommit() { retryWithHeldAcknowledgement(true); }

    private void retryWithFailedOutgoingCompletion(boolean errorPage) {
        openIdentified(); Navigation outgoing = startDocument(); controller.failed(); retry();
        when(outgoing.didCommit()).thenReturn(errorPage);
        when(outgoing.didCommitErrorPage()).thenReturn(errorPage);
        navigationListener.onNavigationCompleted(outgoing);
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
        assertCovered();
        Navigation current = startDocument();
        message("configure", "current"); message("ready", "current"); commit(current); flushTokenReads("current");
        assertEquals("current", controller.state.token()); assertTrue(controller.state.isReady());
    }

    @Test public void retryIgnoresRetiredAbortedCompletion() { retryWithFailedOutgoingCompletion(false); }
    @Test public void retryIgnoresRetiredErrorPageCompletion() { retryWithFailedOutgoingCompletion(true); }

    @Test public void navigationAuthorityInvalidatesSynchronouslyWithNativeStart() {
        initialDocument();
        assertNotNull("Avoid posting authoritative starts behind token read completions", navigationExecutor);
        Navigation replacement = mock(Navigation.class);
        navigationExecutor.execute(() -> navigationListener.onNavigationStarted(replacement));
        assertCovered();
    }

    @Test public void staleCompletionCannotAuthorizeCurrentProvisionalDocument() {
        initialDocument(); Navigation aborted = startDocument(); Navigation current = startDocument();
        message("configure", "old"); message("ready", "old"); commit(aborted); assertCovered();
        assertTrue(tokenReads.isEmpty());
        message("configure", "current"); message("ready", "current"); commit(current); flushTokenReads("current");
        assertEquals("current", controller.state.token()); assertTrue(controller.state.isReady());
    }

    @Test public void cancelledNavigationRemainsCoveredAndSameDocumentNavigationRetainsReadyPage() {
        initialDocument(); Navigation same = mock(Navigation.class); when(same.isSameDocument()).thenReturn(true);
        long paint = controller.state.generation(); navigationListener.onNavigationStarted(same);
        navigationListener.onNavigationCompleted(same); assertTrue(controller.state.canReveal(paint));
        Navigation cancelled = startDocument(); navigationListener.onNavigationCompleted(cancelled);
        assertEquals(BreadPresentationState.Phase.ERROR, controller.state.phase()); assertCovered();
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
    public void consecutiveReplacementRequiresItsOwnNativeVisualFence() {
        initialDocument();
        doReturn(390).when(webView).getWidth(); doReturn(650).when(webView).getHeight();
        doAnswer(call -> { ((Runnable) call.getArgument(0)).run(); return true; }).when(webView).post(any());
        controller.render(); shadowOf(webView).getLastEvaluatedJavascriptCallback().onReceiveValue("true");
        PaintWebView renderer = Shadow.extract(webView);
        WebView.VisualStateCallback oldFence = renderer.fence; long oldRequest = renderer.request;
        Navigation intermediate = startDocument(); commit(intermediate); readyDocument("intermediate");
        message("configure", "intermediate"); Navigation current = startDocument();
        commit(intermediate); flushTokenReads("intermediate"); assertCovered();
        message("configure", "current"); message("ready", "current"); commit(current); flushTokenReads("current");
        oldFence.onComplete(oldRequest);
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
        assertEquals(View.VISIBLE, ((View) ReflectionHelpers.getField(controller, "cover")).getVisibility());
        assertTrue(shadowOf(webView).getLastEvaluatedJavascript().contains("__breadPresentationUpdate"));
        shadowOf(webView).getLastEvaluatedJavascriptCallback().onReceiveValue("true");
        assertNotEquals(oldRequest, renderer.request); renderer.fence.onComplete(renderer.request);
        assertEquals(BreadPresentationState.Phase.VISIBLE, controller.state.phase());
    }

    @Test public void missingNavigationIdentityKeepsBrowserAndRejectsPresentationRequests() {
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.NAVIGATION_LISTENER_V1)).thenReturn(false);
        open(true, true, "default");
        assertEquals(View.GONE, ((View) ReflectionHelpers.getField(controller, "overlay")).getVisibility());
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO, webView.getImportantForAccessibility());
        assertTrue(fits()); assertFalse(controller.fullscreen());
        String fullscreen = new JSObject().put("type", "configure").put("token", "fallback")
            .put("display", "fullscreen").put("manualReady", true).toString();
        messageListener.onPostMessage(webView, new WebMessageCompat(fullscreen), Uri.parse(options.getUrl()), true, null);
        assertTrue(shadowOf(webView).getLastEvaluatedJavascript().contains("\"display\":\"browser\""));
        verify(callbacks, atLeastOnce()).presentationChanged(false);
        message("ready", "fallback");
        assertTrue(shadowOf(webView).getLastEvaluatedJavascript().contains("\"ok\":false"));
        message("close", "fallback");
        assertTrue(shadowOf(webView).getLastEvaluatedJavascript().contains("\"ok\":false"));
        verify(callbacks, never()).closeEvent(any());
        controller.navigationStarted(); controller.foreground(false); controller.foreground(true);
        assertEquals(View.GONE, ((View) ReflectionHelpers.getField(controller, "overlay")).getVisibility());
        assertFalse(controller.fullscreen());
        dialog.dismiss(); verify(callbacks, times(1)).closeEvent(any());
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
