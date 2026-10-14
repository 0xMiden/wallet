package ee.forgr.capacitor_inappbrowser;

import android.app.Activity;
import android.os.Looper;
import android.view.ViewGroup;
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
import android.view.Window;
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
    private org.robolectric.android.controller.ActivityController<Activity> activityController;
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
        activityController = Robolectric.buildActivity(Activity.class).setup().visible();
        activity = activityController.get();
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
        open(documentStart, listener, toolbar, null);
    }

    private void open(boolean documentStart, boolean listener, String toolbar, Boolean initiallyVisible) {
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)).thenReturn(documentStart);
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)).thenReturn(listener);
        options = new Options();
        if (initiallyVisible != null) options.setInitiallyVisible(initiallyVisible);
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

    @Test public void nonPresentationDefaultStillShowsAndQueuedOldLifetimeCannotReachReplacement() {
        open(true, true, "default");
        dialog.forceClose();
        options.setBreadPresentation(null);
        dialog = new WebViewDialog(activity, androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar, options, null, new WebView(activity));
        dialog.activity = activity;
        dialog.presentWebView();
        assertTrue(dialog.isShowing());
        WebViewRegistry.getShared().register("reused", dialog);
        dialog.configureManagedClose("reused", new JSObject().put("token", "outgoing"), ignored -> {});
        List<Runnable> queued = new ArrayList<>();
        InAppBrowserPlugin plugin = spy(new InAppBrowserPlugin());
        androidx.appcompat.app.AppCompatActivity pluginActivity = mock(androidx.appcompat.app.AppCompatActivity.class);
        doAnswer(call -> { queued.add(call.getArgument(0)); return null; }).when(pluginActivity).runOnUiThread(any());
        doReturn(pluginActivity).when(plugin).getActivity();
        PluginCall legacy = mock(PluginCall.class);
        when(legacy.getString("id")).thenReturn("reused");
        when(legacy.getBoolean("visible", true)).thenReturn(false);
        plugin.setVisible(legacy);
        queued.forEach(Runnable::run);
        queued.clear();
        verify(legacy).resolve();
        assertFalse(dialog.isShowing());
        PluginCall request = mock(PluginCall.class);
        when(request.getString("id")).thenReturn("reused");
        when(request.getString("managedHostCloseToken")).thenReturn("outgoing");
        when(request.getBoolean("visible", true)).thenReturn(true);
        when(request.getInt("visibilitySequence")).thenReturn(1);
        plugin.setVisible(request);
        WebViewRegistry.getShared().remove("reused");
        WebViewDialog replacement = mock(WebViewDialog.class);
        WebViewRegistry.getShared().register("reused", replacement);
        queued.forEach(Runnable::run);
        verify(replacement, never()).presentationVisibility(anyBoolean(), any(), any());
        verify(request).resolve();
    }

    @Test public void showBeforeMetadataKeepsNativeSurfaceHiddenButRetainsIntent() {
        open(true, true, "default", false);
        dialog.show();
        assertFalse(dialog.isShowing());
        assertTrue(controller.state.active());
        assertTrue(fits());
        assertFalse(ReflectionHelpers.getField(controller, "appliedFullscreen"));
    }

    @Test public void metadataResolvesBeforeReadyButWaitsForMatchingHostPolicy() {
        open(true, true, "default", false);
        dialog.show();
        controller.state.configure("early", true, true);
        controller.render();
        long revision = controller.state.policyRevision();
        verify(callbacks).presentationChanged(eq(true), eq(true), eq(revision), isNull());
        assertFalse(dialog.isShowing());
        controller.visibility(true, (int) revision - 1, 1);
        assertFalse(dialog.isShowing());
        controller.visibility(true, (int) revision, 2);
        assertTrue(dialog.isShowing());
        assertFalse(fits());
        assertFalse(controller.state.isReady());
        assertEquals(View.VISIBLE, ((View) ReflectionHelpers.getField(controller, "cover")).getVisibility());
        controller.visibility(false, null, 4);
        controller.visibility(true, (int) revision, 3);
        assertFalse(dialog.isShowing());
        controller.navigate();
        verify(callbacks).presentationChanged(eq(true), eq(false), eq(controller.state.policyRevision()), isNull());
        controller.visibility(true, (int) revision, 5);
        assertFalse(dialog.isShowing());
        controller.failed();
        assertTrue(controller.state.policyResolved());
        controller.visibility(true, (int) controller.state.policyRevision(), 6);
        assertTrue(dialog.isShowing());
        assertEquals(View.VISIBLE, ((View) ReflectionHelpers.getField(controller, "retry")).getVisibility());
    }

    @Test public void firstBrowserAndKnownFallbackWaitForHostBoundsAcknowledgement() {
        for (boolean modern : new boolean[] {true, false}) {
            features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.NAVIGATION_LISTENER_V1)).thenReturn(modern);
            open(true, true, "default", false);
            if (modern) controller.state.configure("ordinary", false, false);
            controller.render();
            long revision = controller.state.policyRevision();
            verify(callbacks).presentationChanged(eq(false), eq(true), eq(revision), isNull());
            dialog.show();
            assertFalse(dialog.isShowing());
            dialog.updateDimensions(320, 500, 4, 90);
            int browserY = dialog.getWindow().getAttributes().y;
            controller.visibility(true, (int) revision, 1);
            assertTrue(dialog.isShowing());
            assertEquals(320, dialog.getWindow().getAttributes().width);
            assertEquals(browserY, dialog.getWindow().getAttributes().y);
            assertTrue(fits());
            dialog.forceClose();
        }
    }

    @Test public void initiallyHiddenOpeningWaitsForExplicitShowOnTheSameDialog() {
        open(true, true, "default", false);
        assertFalse(dialog.isShowing());
        assertEquals(BreadPresentationState.Phase.TEMPORARILY_HIDDEN, controller.state.phase());
        verify(options.getPluginCall()).resolve();
        controller.state.configure("opening", true, true);
        controller.render();
        assertTrue(controller.fullscreen());
        assertFalse(dialog.isShowing());
        assertTrue(fits());
        assertFalse(ReflectionHelpers.getField(controller, "appliedFullscreen"));
        WebView original = webView;
        acknowledgePolicy();
        assertTrue(dialog.isShowing());
        assertTrue(controller.fullscreen());
        assertSame(original, ReflectionHelpers.getField(dialog, "_webView"));
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
    }

    @Test public void initiallyHiddenOlderEngineWaitsForShowInBrowserMode() {
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.NAVIGATION_LISTENER_V1)).thenReturn(false);
        open(true, true, "default", false);
        assertFalse(dialog.isShowing());
        assertFalse(controller.fullscreen());
        assertTrue(fits());
        verify(options.getPluginCall()).resolve();
        acknowledgePolicy();
        assertTrue(dialog.isShowing());
        assertFalse(controller.fullscreen());
        assertTrue(fits());
        assertEquals(View.GONE, ((View) ReflectionHelpers.getField(controller, "overlay")).getVisibility());
    }

    @Test public void omittedInitialVisibilityRetainsIntentWhilePolicyIsPending() {
        open(true, true, "default");
        assertTrue(options.isInitiallyVisible());
        assertFalse(dialog.isShowing());
        assertTrue(controller.state.active());
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
        verify(options.getPluginCall()).resolve();
    }

    @After public void tearDown() {
        if (dialog != null) dialog.forceClose();
        WebViewRegistry.getShared().clear();
        webkit.close(); features.close();
        activity.finish();
    }

    @Test public void managedCloseRetainsTheDialogAndRejectsStaleReceipts() {
        open(true, true, "default");
        controller.state.configure("browser", false, false);
        acknowledgePolicy();
        List<JSObject> requests = new ArrayList<>();
        WebViewRegistry.getShared().register("managed", dialog);
        dialog.configureManagedClose("managed", new JSObject().put("token", "lifetime")
            .put("errorLabel", "Error").put("retryLabel", "Retry").put("exitLabel", "Exit now"), requests::add);
        Runnable completion = mock(Runnable.class);
        dialog.requestClose(completion);
        dialog.requestClose(completion);
        assertEquals(1, requests.size());
        assertTrue(dialog.isShowing());
        verify(completion, never()).run();
        dialog.hide();
        assertTrue(dialog.isShowing());
        ManagedHostClose managed = dialog.managedClose();
        assertFalse(managed.complete("old", managed.requestId(), 1));
        String old = managed.requestId();
        managed.retry();
        assertFalse(managed.complete("lifetime", old, 2));
        dialog.forceClose();
        dialog.forceClose();
        assertFalse(dialog.isShowing());
        verify(completion, times(2)).run();
        verify(callbacks, times(1)).closeEvent(anyString());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedClosePausesOnlyTheGameBeforeRequestingHostPaint() {
        open(true, true, "default");
        controller.state.configure("browser", false, false);
        acknowledgePolicy();
        WebView attachedHost = ReflectionHelpers.getField(dialog, "capacitorWebView");
        activity.setContentView(attachedHost, new ViewGroup.LayoutParams(390, 844));
        shadowOf(Looper.getMainLooper()).idle();
        assertTrue(attachedHost.isAttachedToWindow());
        WebView host = spy(attachedHost);
        doReturn(390).when(host).getWidth(); doReturn(844).when(host).getHeight();
        doReturn(false).when(host).isHardwareAccelerated();
        ReflectionHelpers.setField(dialog, "capacitorWebView", host);
        WebView game = webView;
        assertTrue(game.isAttachedToWindow());
        assertFalse(shadowOf(game).wasOnPauseCalled());
        assertFalse(shadowOf(host).wasOnPauseCalled());
        List<Boolean> pausedAtRequest = new ArrayList<>();
        WebViewRegistry.getShared().register("managed", dialog);
        dialog.configureManagedClose("managed", new JSObject().put("token", "lifetime"), request -> {
            pausedAtRequest.add(shadowOf(game).wasOnPauseCalled());
            assertFalse(shadowOf(host).wasOnPauseCalled());
            assertTrue(game.isAttachedToWindow());
            assertEquals(View.VISIBLE, game.getVisibility());
            assertFalse(game.isEnabled());
            assertFalse(shadowOf(game).wasDestroyCalled());
        });
        Runnable completion = mock(Runnable.class);
        dialog.requestClose(completion);
        assertEquals(java.util.Collections.singletonList(true), pausedAtRequest);
        assertTrue(dialog.isShowing());
        verify(completion, never()).run();
        PaintWebView renderer = Shadow.extract(host);
        assertNull(renderer.fence);
        ManagedHostClose managed = dialog.managedClose();
        assertFalse(managed.complete("stale", managed.requestId(), 1));
        assertNull(renderer.fence);
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        assertTrue(managed.complete("lifetime", managed.requestId(), 1));
        assertNotNull(renderer.fence);
        assertTrue(game.isAttachedToWindow());
        assertFalse(shadowOf(game).wasDestroyCalled());
        assertFalse(shadowOf(host).wasOnPauseCalled());
        verify(completion, never()).run();
        renderer.fence.onComplete(renderer.request);
        assertFalse(dialog.isShowing());
        verify(completion, times(1)).run();
        verify(callbacks, times(1)).closeEvent(anyString());
    }

    private WebView managedInsetHost() {
        open(true, true, "default");
        controller.state.configure("browser", false, false);
        acknowledgePolicy();
        WebView original = ReflectionHelpers.getField(dialog, "capacitorWebView");
        original.setLayoutParams(new FrameLayout.LayoutParams(390, 844));
        WebView host = spy(original);
        ReflectionHelpers.setField(dialog, "capacitorWebView", host);
        activity.setContentView(host, new FrameLayout.LayoutParams(390, 844));
        doReturn(390).when(host).getWidth(); doReturn(844).when(host).getHeight();
        doReturn(true).when(host).isAttachedToWindow();
        doReturn(false).when(host).isHardwareAccelerated();
        WebViewRegistry.getShared().register("managed", dialog);
        dialog.configureManagedClose("managed", new JSObject().put("token", "lifetime"), ignored -> {});
        return host;
    }

    private android.view.WindowInsets hiddenHostInsets() {
        return new android.view.WindowInsets.Builder()
            .setInsets(android.view.WindowInsets.Type.systemBars(), android.graphics.Insets.NONE)
            .setInsetsIgnoringVisibility(android.view.WindowInsets.Type.systemBars(), android.graphics.Insets.of(0, 52, 0, 24))
            .setVisible(android.view.WindowInsets.Type.systemBars(), false).build();
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedReturnDeliversOrdinaryInsetsBeforeHostHandoff() {
        WebView host = managedInsetHost();
        List<android.graphics.Insets> handoffInsets = new ArrayList<>();
        dialog.configureManagedClose("managed", new JSObject().put("token", "lifetime"), ignored -> {
            host.dispatchApplyWindowInsets(hiddenHostInsets());
            org.mockito.ArgumentCaptor<android.view.WindowInsets> applied = org.mockito.ArgumentCaptor.forClass(android.view.WindowInsets.class);
            verify(host, atLeastOnce()).onApplyWindowInsets(applied.capture());
            handoffInsets.add(applied.getValue().getInsets(android.view.WindowInsets.Type.systemBars()));
        });
        dialog.requestClose(() -> {});
        assertEquals("Managed return must notify the host once", 1, handoffInsets.size());
        assertEquals(android.graphics.Insets.of(0, 52, 0, 24), handoffInsets.get(0));
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedReturnDoesNotTransferFocusWhileGameRemains() {
        WebView host = managedInsetHost();
        dialog.requestClose(() -> {});
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        ManagedHostClose managed = dialog.managedClose();
        assertTrue(managed.complete("lifetime", managed.requestId(), 1));
        assertEquals(0, dialog.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
        assertTrue(dialog.isShowing());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedReturnFastAcknowledgementWaitsForActualInsetDelivery() {
        WebView host = managedInsetHost();
        dialog.requestClose(() -> {});
        ManagedHostClose managed = dialog.managedClose();
        assertTrue(managed.complete("lifetime", managed.requestId(), 1));
        PaintWebView renderer = Shadow.extract(host);
        assertNull("No fence may certify the hidden-bar host layout", renderer.fence);
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        assertNotNull(renderer.fence);
        renderer.fence.onComplete(renderer.request);
        assertFalse(dialog.isShowing());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedReturnInsetChangeRejectsAlreadySubmittedHardwareFrame() {
        WebView host = managedInsetHost();
        doReturn(true).when(host).isHardwareAccelerated();
        android.view.ViewTreeObserver observer = mock(android.view.ViewTreeObserver.class);
        doReturn(observer).when(host).getViewTreeObserver();
        dialog.requestClose(() -> {});
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        ManagedHostClose managed = dialog.managedClose();
        managed.complete("lifetime", managed.requestId(), 1);
        PaintWebView renderer = Shadow.extract(host);
        long staleRevision = renderer.request;
        renderer.fence.onComplete(renderer.request);
        org.mockito.ArgumentCaptor<Runnable> frames = org.mockito.ArgumentCaptor.forClass(Runnable.class);
        verify(observer).registerFrameCommitCallback(frames.capture());
        Runnable staleFrame = frames.getValue();
        host.dispatchApplyWindowInsets(new android.view.WindowInsets.Builder(hiddenHostInsets())
            .setInsets(android.view.WindowInsets.Type.ime(), android.graphics.Insets.of(0, 0, 0, 280)).build());
        assertNotEquals(staleRevision, renderer.request);
        staleFrame.run(); shadowOf(Looper.getMainLooper()).idle();
        assertTrue(dialog.isShowing());
        renderer.fence.onComplete(renderer.request);
        verify(observer, times(2)).registerFrameCommitCallback(frames.capture());
        frames.getValue().run(); shadowOf(Looper.getMainLooper()).idle();
        assertFalse(dialog.isShowing());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedReturnBackgroundAndRetryRejectOutgoingPaintWithoutResumingGame() {
        WebView host = managedInsetHost();
        dialog.requestClose(() -> {});
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        ManagedHostClose managed = dialog.managedClose();
        managed.complete("lifetime", managed.requestId(), 1);
        PaintWebView renderer = Shadow.extract(host);
        WebView.VisualStateCallback stale = renderer.fence;
        long staleRequest = renderer.request;
        managed.foreground(false);
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(6));
        stale.onComplete(staleRequest);
        assertTrue(dialog.isShowing());
        assertNull(ReflectionHelpers.getField(managed, "failureView"));
        managed.foreground(true);
        managed.retry();
        stale.onComplete(staleRequest);
        assertTrue(dialog.isShowing());
        assertTrue(shadowOf(webView).wasOnPauseCalled());
        assertFalse(shadowOf(webView).wasOnResumeCalled());
        managed.complete("lifetime", managed.requestId(), 2);
        renderer.fence.onComplete(renderer.request);
        assertFalse(dialog.isShowing());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedReturnWithoutInsetsUsesExistingTimeoutAndRetryCanRecover() {
        WebView host = managedInsetHost();
        dialog.requestClose(() -> {});
        ManagedHostClose managed = dialog.managedClose();
        managed.complete("lifetime", managed.requestId(), 1);
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(5100));
        assertNotNull(ReflectionHelpers.getField(managed, "failureView"));
        assertNull(((PaintWebView) Shadow.extract(host)).fence);
        managed.retry();
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        managed.complete("lifetime", managed.requestId(), 2);
        PaintWebView renderer = Shadow.extract(host);
        renderer.fence.onComplete(renderer.request);
        assertFalse(dialog.isShowing());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedReturnCompetingPolicyWaitsAndHiddenCloseDoesNotTouchIt() {
        WebView host = managedInsetHost();
        HostReturnInsets other = HostReturnInsets.acquire(host, () -> true, () -> {});
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        dialog.requestClose(() -> {});
        ManagedHostClose managed = dialog.managedClose();
        managed.complete("lifetime", managed.requestId(), 1);
        assertNull(((PaintWebView) Shadow.extract(host)).fence);
        assertTrue(other.owned());
        dialog.forceClose();
        assertTrue(other.owned());
        other.finish();
        host.dispatchApplyWindowInsets(new android.view.WindowInsets.Builder(hiddenHostInsets())
            .setInsets(android.view.WindowInsets.Type.systemBars(), android.graphics.Insets.of(0, 52, 0, 24)).build());
        assertFalse(other.owned());
        host = managedInsetHost();
        HostReturnInsets foregroundPolicy = HostReturnInsets.acquire(host, () -> true, () -> {});
        dialog.hide();
        assertFalse(dialog.isShowing());
        dialog.requestClose(() -> {});
        managed = dialog.managedClose();
        managed.complete("lifetime", managed.requestId(), 1);
        assertTrue(foregroundPolicy.owned());
        assertFalse(managed.closing());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedReturnDestroyedHostReleasesPolicyAndFinishesWithoutFence() {
        WebView host = managedInsetHost();
        dialog.requestClose(() -> {});
        HostReturnInsets policy = ReflectionHelpers.getField(dialog.managedClose(), "returnInsets");
        assertTrue(policy.owned());
        activity.setContentView(new FrameLayout(activity));
        assertFalse(policy.owned());
        activity.finish();
        activityController.pause().stop().destroy();
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(100));
        assertFalse(dialog.managedClose().closing());
        assertFalse(policy.owned());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedReturnWaitsForCompetingPolicyReleaseThenItsOwnDelivery() {
        WebView host = managedInsetHost();
        HostReturnInsets first = HostReturnInsets.acquire(host, () -> true, () -> {});
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        dialog.requestClose(() -> {});
        ManagedHostClose managed = dialog.managedClose();
        managed.complete("lifetime", managed.requestId(), 1);
        PaintWebView renderer = Shadow.extract(host);
        assertNull(renderer.fence);
        first.finish();
        host.dispatchApplyWindowInsets(new android.view.WindowInsets.Builder(hiddenHostInsets())
            .setInsets(android.view.WindowInsets.Type.systemBars(), android.graphics.Insets.of(0, 52, 0, 24)).build());
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(100));
        assertNull(renderer.fence);
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        renderer.fence.onComplete(renderer.request);
        assertFalse(dialog.isShowing());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void nextOrdinaryCloseRetiresCompletedInsetsAndWaitsForItsOwnPaintFence() {
        WebView host = managedInsetHost();
        dialog.setClosedListener(() -> WebViewRegistry.getShared().remove("managed"));
        Runnable firstCompletion = mock(Runnable.class);
        dialog.requestClose(firstCompletion);
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        ManagedHostClose first = dialog.managedClose();
        assertTrue(first.complete("lifetime", first.requestId(), 1));
        PaintWebView renderer = Shadow.extract(host);
        assertNotNull(renderer.fence);
        renderer.fence.onComplete(renderer.request);
        verify(firstCompletion).run();
        assertFalse(dialog.isShowing());
        assertNull(WebViewRegistry.getShared().get("managed"));
        HostReturnInsets completed = ReflectionHelpers.getField(first, "returnInsets");
        assertTrue(completed.owned());
        assertTrue(completed.ready());
        assertNull(ReflectionHelpers.getField(completed, "current"));
        assertNull(ReflectionHelpers.getField(completed, "changed"));
        verify(callbacks, times(1)).closeEvent(any());

        callbacks = mock(WebViewCallbacks.class);
        options.setCallbacks(callbacks);
        dialog = new WebViewDialog(activity, androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar, options, null, host);
        dialog.activity = activity;
        dialog.presentWebView();
        controller = ReflectionHelpers.getField(dialog, "presentation");
        webView = ReflectionHelpers.getField(dialog, "_webView");
        controller.state.configure("next-browser", false, false); acknowledgePolicy();
        assertFalse(controller.fullscreen());
        assertSame(host, ReflectionHelpers.getField(dialog, "capacitorWebView"));
        WebViewRegistry.getShared().register("next", dialog);
        dialog.setClosedListener(() -> WebViewRegistry.getShared().remove("next"));
        dialog.configureManagedClose("next", new JSObject().put("token", "next-lifetime"), ignored -> {});
        renderer.fence = null;
        Runnable nextCompletion = mock(Runnable.class);
        dialog.requestClose(nextCompletion);
        ManagedHostClose next = dialog.managedClose();
        HostReturnInsets replacement = ReflectionHelpers.getField(next, "returnInsets");
        assertNotNull(replacement);
        assertNotSame(completed, replacement);
        assertFalse(completed.owned());
        assertFalse(replacement.ready());
        assertTrue(next.complete("next-lifetime", next.requestId(), 2));
        assertNull(renderer.fence);
        verify(nextCompletion, never()).run();
        assertTrue(dialog.isShowing());
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        assertTrue(replacement.ready());
        assertNotNull(renderer.fence);
        verify(nextCompletion, never()).run();
        renderer.fence.onComplete(renderer.request);
        verify(nextCompletion, times(1)).run();
        assertFalse(dialog.isShowing());
        assertNull(WebViewRegistry.getShared().get("next"));
        verify(callbacks, times(1)).closeEvent(any());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedReturnReattachedHostCannotReuseOutgoingPolicyFence() {
        WebView host = managedInsetHost();
        dialog.requestClose(() -> {});
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        ManagedHostClose managed = dialog.managedClose();
        managed.complete("lifetime", managed.requestId(), 1);
        PaintWebView renderer = Shadow.extract(host);
        WebView.VisualStateCallback stale = renderer.fence;
        long staleRequest = renderer.request;
        ViewGroup parent = (ViewGroup) host.getParent();
        parent.removeView(host);
        parent.addView(host);
        stale.onComplete(staleRequest);
        assertTrue(dialog.isShowing());
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        HostReturnInsets currentPolicy = ReflectionHelpers.getField(managed, "returnInsets");
        assertTrue("Reattached policy must receive insets", currentPolicy.ready());
        assertNotEquals(staleRequest, renderer.request);
        stale.onComplete(staleRequest);
        assertTrue(dialog.isShowing());
        renderer.fence.onComplete(renderer.request);
        assertFalse(dialog.isShowing());
    }

    @Test @Config(sdk = 29, shadows = PaintWebView.class)
    public void managedReturnOlderApiRetainsOrdinaryFenceWithoutInsetPolicy() {
        WebView host = managedInsetHost();
        dialog.requestClose(() -> {});
        ManagedHostClose managed = dialog.managedClose();
        assertNull(ReflectionHelpers.getField(managed, "returnInsets"));
        managed.complete("lifetime", managed.requestId(), 1);
        PaintWebView renderer = Shadow.extract(host);
        assertNotNull(renderer.fence);
        renderer.fence.onComplete(renderer.request);
        assertFalse(dialog.isShowing());
    }

    @Test public void nativeOpenCannotReplaceManagedIdBeforeOrDuringClose() {
        open(true, true, "default");
        WebViewRegistry.getShared().register("managed", dialog);
        dialog.configureManagedClose("managed", new JSObject().put("token", "reserved"), ignored -> {});
        WebViewRegistry.getShared().register("managed", mock(WebViewDialog.class));
        assertSame(dialog, WebViewRegistry.getShared().get("managed"));
        InAppBrowserPlugin plugin = new InAppBrowserPlugin();
        for (boolean closing : new boolean[]{false, true}) {
            if (closing) dialog.requestClose(() -> {});
            PluginCall call = mock(PluginCall.class);
            when(call.getString("id", WebViewRegistry.DEFAULT_INSTANCE_ID)).thenReturn("managed");
            when(call.getString("url")).thenReturn("https://example.test");
            plugin.openWebView(call);
            verify(call).reject(contains("managed instance"));
            assertSame(dialog, WebViewRegistry.getShared().get("managed"));
        }
        dialog.forceClose();
        WebViewRegistry.getShared().remove("managed");
        WebViewDialog replacement = mock(WebViewDialog.class);
        WebViewRegistry.getShared().register("managed", replacement);
        assertSame(replacement, WebViewRegistry.getShared().get("managed"));
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedCloseWaitsForTheHostFenceAndDiscardsThePreRotationFence() {
        open(true, true, "default");
        controller.state.configure("browser", false, false);
        acknowledgePolicy();
        WebView host = spy((WebView) ReflectionHelpers.getField(dialog, "capacitorWebView"));
        ReflectionHelpers.setField(dialog, "capacitorWebView", host);
        activity.setContentView(host);
        doReturn(390).when(host).getWidth();
        doReturn(844).when(host).getHeight();
        doReturn(true).when(host).isAttachedToWindow();
        doReturn(false).when(host).isHardwareAccelerated();
        WebViewRegistry.getShared().register("managed", dialog);
        dialog.configureManagedClose("managed", new JSObject().put("token", "lifetime"), ignored -> {});
        dialog.dismiss();
        ManagedHostClose managed = dialog.managedClose();
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        assertTrue(managed.complete("lifetime", managed.requestId(), 1));
        PaintWebView renderer = Shadow.extract(host);
        assertNotNull(renderer.fence);
        WebView.VisualStateCallback stale = renderer.fence;
        long staleRequest = renderer.request;
        doReturn(844).when(host).getWidth();
        doReturn(390).when(host).getHeight();
        ReflectionHelpers.callInstanceMethod(managed, "geometryChanged");
        stale.onComplete(staleRequest);
        assertTrue(dialog.isShowing());
        renderer.fence.onComplete(renderer.request);
        assertFalse(dialog.isShowing());
        verify(callbacks, times(1)).closeEvent(anyString());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedCloseWaitsForHardwareFrameCommitAfterHostVisualReadiness() {
        open(true, true, "default");
        controller.state.configure("browser", false, false);
        acknowledgePolicy();
        WebView host = spy((WebView) ReflectionHelpers.getField(dialog, "capacitorWebView"));
        ReflectionHelpers.setField(dialog, "capacitorWebView", host);
        doReturn(390).when(host).getWidth(); doReturn(844).when(host).getHeight();
        doReturn(true).when(host).isAttachedToWindow(); doReturn(true).when(host).isHardwareAccelerated();
        android.view.ViewTreeObserver observer = mock(android.view.ViewTreeObserver.class);
        doReturn(observer).when(host).getViewTreeObserver();
        WebViewRegistry.getShared().register("managed", dialog);
        dialog.configureManagedClose("managed", new JSObject().put("token", "lifetime"), ignored -> {});
        dialog.dismiss();
        ManagedHostClose managed = dialog.managedClose();
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        assertTrue(managed.complete("lifetime", managed.requestId(), 1));
        PaintWebView renderer = Shadow.extract(host);
        renderer.fence.onComplete(renderer.request);
        assertTrue(dialog.isShowing());
        org.mockito.ArgumentCaptor<Runnable> submitted = org.mockito.ArgumentCaptor.forClass(Runnable.class);
        verify(observer).registerFrameCommitCallback(submitted.capture());
        submitted.getValue().run();
        shadowOf(Looper.getMainLooper()).idle();
        assertFalse(dialog.isShowing());
        verify(callbacks, times(1)).closeEvent(anyString());
    }

    @Test public void failedManagedCloseKeepsTheLogoAndExposesExplicitRecovery() {
        open(true, true, "default");
        controller.state.configure("browser", false, false);
        acknowledgePolicy();
        WebViewRegistry.getShared().register("managed", dialog);
        dialog.configureManagedClose("managed", new JSObject().put("token", "lifetime")
            .put("errorLabel", "Error").put("retryLabel", "Retry").put("exitLabel", "Exit now"), ignored -> {});
        WebView game = webView;
        WebView host = ReflectionHelpers.getField(dialog, "capacitorWebView");
        dialog.dismiss();
        assertTrue(shadowOf(game).wasOnPauseCalled());
        dialog.presentationForeground(false);
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(6));
        assertNull(ReflectionHelpers.getField(dialog.managedClose(), "failureView"));
        dialog.presentationForeground(true);
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(6));
        assertTrue(dialog.isShowing());
        View failure = ReflectionHelpers.getField(dialog.managedClose(), "failureView");
        assertNotNull(failure);
        View retry = ((ViewGroup) failure).getChildAt(1);
        assertEquals(-1, shadowOf(retry).lastHapticFeedbackPerformed());
        String request = dialog.managedClose().requestId();
        retry.performClick();
        assertEquals(android.view.HapticFeedbackConstants.VIRTUAL_KEY, shadowOf(retry).lastHapticFeedbackPerformed());
        assertNotEquals(request, dialog.managedClose().requestId());
        assertTrue(shadowOf(game).wasOnPauseCalled());
        assertFalse(shadowOf(game).wasOnResumeCalled());
        assertFalse(shadowOf(host).wasOnPauseCalled());
        assertTrue(game.isAttachedToWindow());
        assertFalse(shadowOf(game).wasDestroyCalled());
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(6));
        ViewGroup retriedFailure = ReflectionHelpers.getField(dialog.managedClose(), "failureView");
        View exit = retriedFailure.getChildAt(2);
        assertEquals(-1, shadowOf(exit).lastHapticFeedbackPerformed());
        assertTrue(exit.performClick());
        assertEquals(android.view.HapticFeedbackConstants.VIRTUAL_KEY, shadowOf(exit).lastHapticFeedbackPerformed());
        assertFalse(dialog.isShowing());
    }

    @Test public void rejectedDuplicateCannotEscapeCloseAllOrActivityDestruction() {
        for (boolean destroy : new boolean[]{false, true}) {
            open(true, true, "default");
            WebViewRegistry.getShared().register("managed", dialog);
            dialog.setClosedListener(() -> WebViewRegistry.getShared().remove("managed"));
            dialog.configureManagedClose("managed", new JSObject().put("token", "reserved"), ignored -> {});
            Runnable completed = mock(Runnable.class);
            dialog.requestClose(completed);
            WebViewRegistry.getShared().register("managed", mock(WebViewDialog.class));
            InAppBrowserPlugin plugin = spy(new InAppBrowserPlugin());
            androidx.appcompat.app.AppCompatActivity pluginActivity = mock(androidx.appcompat.app.AppCompatActivity.class);
            doAnswer(call -> { ((Runnable) call.getArgument(0)).run(); return null; }).when(pluginActivity).runOnUiThread(any());
            doReturn(pluginActivity).when(plugin).getActivity();
            if (destroy) plugin.handleOnDestroy();
            else { plugin.closeAll(mock(PluginCall.class)); shadowOf(Looper.getMainLooper()).idle(); }
            assertFalse(dialog.isShowing());
            verify(completed, times(1)).run();
            assertNull(WebViewRegistry.getShared().get("managed"));
        }
    }

    @Test public void metricsPublishOccupiedBoundsSafeAreaAndCurrentLayoutRevision() throws Exception {
        open(true, true, "default");
        fullscreen();
        controller.visibility(false);
        webView = spy(webView);
        doReturn(400).when(webView).getWidth();
        ReflectionHelpers.setField(controller, "webView", webView);
        ImageButton back = ReflectionHelpers.getField(controller, "back");
        back.layout(12, 62, 76, 110);
        FrameLayout overlay = ReflectionHelpers.getField(controller, "overlay");
        androidx.core.graphics.Insets safe = androidx.core.graphics.Insets.of(0, 54, 0, 34);
        overlay.dispatchApplyWindowInsets(new WindowInsetsCompat.Builder()
            .setInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(), safe)
            .build().toWindowInsets());
        assertEquals("doc", controller.state.token());
        assertEquals(400, webView.getWidth());
        String script = ReflectionHelpers.callInstanceMethod(controller, "metricUpdate");
        org.json.JSONObject metrics = new org.json.JSONObject(script.substring(script.indexOf("metrics=") + 8, script.indexOf(";if")));
        assertEquals(400, metrics.getInt("width"));
        assertEquals(64, metrics.getJSONObject("controlBounds").getInt("width"));
        assertEquals(48, metrics.getJSONObject("controlBounds").getInt("height"));
        assertEquals(54, metrics.getJSONObject("safeAreaInsets").getInt("top"));
        assertEquals(34, metrics.getJSONObject("safeAreaInsets").getInt("bottom"));
        long revision = metrics.getLong("revision");
        doReturn(600).when(webView).getWidth();
        controller.state.layoutChanged();
        String rotated = ReflectionHelpers.callInstanceMethod(controller, "metricUpdate");
        org.json.JSONObject current = new org.json.JSONObject(rotated.substring(rotated.indexOf("metrics=") + 8, rotated.indexOf(";if")));
        assertEquals(600, current.getInt("width"));
        assertTrue(current.getLong("revision") > revision);
        controller.state.configure("doc", false, false);
        controller.render();
        String browser = ReflectionHelpers.callInstanceMethod(controller, "metricUpdate");
        assertTrue(browser.contains("\"controlBounds\":null"));
        assertTrue(browser.contains("\"safeAreaInsets\":null"));
    }

    @Test public void lateFirstAcknowledgementKeepsNeverShownControllerHiddenInBackground() {
        open(true, true, "default", false);
        controller.visibility(true, null, 1);
        controller.state.configure("doc", true, true);
        controller.state.ready();
        assertFalse(controller.state.effectiveVisibility());
        controller.state.painted(controller.state.generation());
        controller.foreground(false);
        controller.visibility(true, (int) controller.state.policyRevision(), 2);
        assertFalse("A never-shown controller cannot inherit background dialog ownership", dialog.isShowing());
    }

    @Test public void breadCapsuleRequestsHostMinimizeWithoutClosingTheRetainedDocument() {
        open(true, true, "default");
        fullscreen();
        long navigation = controller.state.navigationGeneration();
        ImageButton capsule = ReflectionHelpers.getField(controller, "back");
        capsule.performClick();
        verify(callbacks).presentationMinimizeRequested(controller.state.policyRevision(), controller.state.acknowledgedVisibilitySequence(), null);
        verify(callbacks, never()).closeEvent(any());
        assertEquals(navigation, controller.state.navigationGeneration());
        assertEquals("doc", controller.state.token());
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
    }

    @Test public void pausedRetainedFullscreenKeepsCoveredSurfaceAndYieldsToHostOwnership() {
        open(true, true, "default");
        fullscreen();
        controller.state.ready();
        controller.state.painted(controller.state.generation());
        controller.render();
        View cover = ReflectionHelpers.getField(controller, "cover");
        controller.foreground(false);
        assertTrue("First return surface must remain the retained game dialog", dialog.isShowing());
        assertEquals(View.VISIBLE, cover.getVisibility());
        assertEquals(1f, cover.getAlpha(), 0f);
        assertFalse(controller.state.canReveal(controller.state.generation()));
        assertFalse(fits());
        controller.visibility(false);
        assertFalse("Wallet host ownership immediately hides the retained dialog", dialog.isShowing());
        controller.foreground(true);
        assertFalse(dialog.isShowing());
        controller.visibility(true);
        controller.navigate();
        controller.foreground(false);
        assertFalse("Replacement documents cannot borrow retained ownership", dialog.isShowing());
        dialog.forceClose();
        controller.foreground(true);
        assertFalse(dialog.isShowing());
    }

    private boolean fits() { return ReflectionHelpers.callInstanceMethod(dialog.getWindow(), "decorFitsSystemWindows"); }
    private WindowInsetsControllerCompat bars() { return WindowCompat.getInsetsController(dialog.getWindow(), dialog.getWindow().getDecorView()); }
    private int acknowledgementSequence;
    private void acknowledgePolicy() {
        String id = "policy-fixture";
        WebViewRegistry.getShared().register(id, dialog);
        InAppBrowserPlugin plugin = spy(new InAppBrowserPlugin());
        androidx.appcompat.app.AppCompatActivity pluginActivity = mock(androidx.appcompat.app.AppCompatActivity.class);
        doAnswer(call -> { ((Runnable) call.getArgument(0)).run(); return null; }).when(pluginActivity).runOnUiThread(any());
        doReturn(pluginActivity).when(plugin).getActivity();
        PluginCall request = mock(PluginCall.class);
        when(request.getString("id")).thenReturn(id);
        when(request.getBoolean("visible", true)).thenReturn(true);
        when(request.getInt("policyRevision")).thenReturn((int) controller.state.policyRevision());
        when(request.getInt("visibilitySequence")).thenReturn(++acknowledgementSequence);
        if (dialog.managedClose() != null) when(request.getString("managedHostCloseToken")).thenReturn(dialog.managedClose().token);
        plugin.setVisible(request);
        verify(request).resolve();
        WebViewRegistry.getShared().remove(id);
    }
    private void fullscreen() {
        controller.state.configure("doc", true, true);
        acknowledgePolicy();
        assertFalse(fits());
        assertEquals(2, bars().getSystemBarsBehavior());
    }
    private void assertRestored(boolean fit, int behavior) {
        assertEquals(fit, fits());
        assertEquals(behavior, bars().getSystemBarsBehavior());
    }

    private void rotationHint(Window window, int hint) {
        WindowManager.LayoutParams params = window.getAttributes();
        params.rotationAnimation = hint;
        window.setAttributes(params);
    }

    private void assertRotationHints(int host, int page) {
        assertEquals(host, activity.getWindow().getAttributes().rotationAnimation);
        assertEquals(page, dialog.getWindow().getAttributes().rotationAnimation);
    }

    @Test public void fullscreenRotationUpdatesBothWindowsWithoutChangingOtherHostAttributes() {
        open(true, true, "default");
        controller.state.configure("browser", false, false); acknowledgePolicy();
        Window host = activity.getWindow();
        Window page = dialog.getWindow();
        rotationHint(host, 0); rotationHint(page, 0);
        WindowManager.LayoutParams hostBefore = new WindowManager.LayoutParams();
        hostBefore.copyFrom(host.getAttributes());
        int pageFlags = page.getAttributes().flags;
        float pageAlpha = page.getAttributes().alpha;
        int pageSoftInput = page.getAttributes().softInputMode;
        int orientation = activity.getRequestedOrientation();
        fullscreen();
        assertEquals(2, host.getAttributes().rotationAnimation);
        assertEquals(2, page.getAttributes().rotationAnimation);
        WindowManager.LayoutParams hostAfter = new WindowManager.LayoutParams();
        hostAfter.copyFrom(host.getAttributes());
        hostAfter.rotationAnimation = 0;
        assertEquals(0, hostAfter.copyFrom(hostBefore));
        assertEquals(pageFlags, page.getAttributes().flags);
        assertEquals(android.graphics.PixelFormat.OPAQUE, page.getAttributes().format);
        assertEquals(pageAlpha, page.getAttributes().alpha, 0);
        assertEquals(pageSoftInput, page.getAttributes().softInputMode);
        assertEquals(orientation, activity.getRequestedOrientation());
    }

    @Test public void hiddenFullscreenAcquiresOnlyAfterAcknowledgementAndRecapturesOnResume() {
        open(true, true, "default", false);
        rotationHint(activity.getWindow(), 1); rotationHint(dialog.getWindow(), 3);
        controller.state.configure("held", true, true); controller.render();
        assertRotationHints(1, 3);
        acknowledgePolicy();
        assertRotationHints(2, 2);
        dialog.hide();
        assertRotationHints(1, 3);
        rotationHint(activity.getWindow(), 3); rotationHint(dialog.getWindow(), 1);
        WebView retained = webView;
        dialog.show();
        assertRotationHints(2, 2);
        assertSame(retained, ReflectionHelpers.getField(dialog, "_webView"));
        dialog.hide();
        assertRotationHints(3, 1);
    }

    @Test public void rotationPolicyFollowsForegroundLayoutNavigationAndDisposal() {
        open(true, true, "default");
        rotationHint(activity.getWindow(), 1); rotationHint(dialog.getWindow(), 3);
        fullscreen();
        controller.state.ready(); long oldPaint = controller.state.generation();
        controller.state.painted(oldPaint);
        controller.state.layoutChanged(); controller.render();
        assertRotationHints(2, 2);
        assertFalse(controller.state.canReveal(oldPaint));
        dialog.presentationForeground(false);
        assertRotationHints(2, 2);
        dialog.presentationForeground(true);
        assertRotationHints(2, 2);
        controller.navigate();
        assertRotationHints(1, 3);
        controller.state.configure("browser", false, false); acknowledgePolicy();
        assertRotationHints(1, 3);
        fullscreen();
        assertRotationHints(2, 2);
        dialog.forceClose(); dialog.forceClose();
        assertRotationHints(1, 3);
        verify(callbacks, times(1)).closeEvent(any());
    }

    @Test public void overlappingFullscreenDialogsKeepHostPolicyUntilEitherLastDisposal() {
        for (boolean firstFirst : new boolean[] {true, false}) {
            rotationHint(activity.getWindow(), 1);
            open(true, true, "default"); fullscreen();
            WebViewDialog first = dialog;
            open(true, true, "default"); fullscreen();
            WebViewDialog second = dialog;
            try {
                (firstFirst ? first : second).forceClose();
                assertEquals(2, activity.getWindow().getAttributes().rotationAnimation);
                (firstFirst ? second : first).forceClose();
                assertEquals(1, activity.getWindow().getAttributes().rotationAnimation);
            } finally { first.forceClose(); second.forceClose(); }
        }
    }

    @Test @Config(shadows = PaintWebView.class)
    public void managedCloseKeepsRotationPolicyThroughTheActualHostPaintFence() {
        WebView host = managedInsetHost();
        rotationHint(activity.getWindow(), 1); rotationHint(dialog.getWindow(), 3);
        fullscreen();
        dialog.requestClose(() -> {});
        assertRotationHints(2, 2);
        dialog.hide(); controller.render();
        dialog.presentationForeground(false); dialog.presentationForeground(true);
        assertRotationHints(2, 2);
        assertTrue(dialog.isShowing());
        host.dispatchApplyWindowInsets(hiddenHostInsets());
        ManagedHostClose managed = dialog.managedClose();
        assertTrue(managed.complete("lifetime", managed.requestId(), 1));
        PaintWebView renderer = Shadow.extract(host);
        assertNotNull(renderer.fence);
        assertRotationHints(2, 2);
        renderer.fence.onComplete(renderer.request);
        assertFalse(dialog.isShowing());
        assertRotationHints(1, 3);
        verify(callbacks, times(1)).closeEvent(any());
    }

    @Test public void ordinaryAndMissingIdentityPagesKeepTheirRotationPolicy() {
        for (boolean identified : new boolean[] {true, false}) {
            features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.NAVIGATION_LISTENER_V1)).thenReturn(identified);
            rotationHint(activity.getWindow(), 3);
            open(true, true, "default");
            rotationHint(dialog.getWindow(), 1);
            if (identified) controller.state.configure("browser", false, false);
            acknowledgePolicy();
            assertRotationHints(3, 1);
            dialog.hide(); dialog.show();
            dialog.presentationForeground(false); dialog.presentationForeground(true);
            assertRotationHints(3, 1);
            dialog.forceClose();
            assertRotationHints(3, 1);
        }
    }

    @Test public void browserNavigationRestoresFittingAndOriginalBarBehavior() {
        open(true, true, "default");
        boolean fit = fits(); int behavior = bars().getSystemBarsBehavior();
        assertTrue(fit);
        fullscreen();
        controller.navigate(); controller.state.configure("next", false, false); acknowledgePolicy();
        assertRestored(fit, behavior);
    }

    @Test public void hideAndForegroundResumeRestoreThenReacquirePolicyWithNewPaint() {
        open(true, true, "default");
        boolean fit = fits(); int behavior = bars().getSystemBarsBehavior();
        fullscreen(); controller.state.ready(); long paint = controller.state.generation();
        controller.state.painted(paint);
        dialog.hide(); assertRestored(fit, behavior);
        dialog.show(); assertFalse(fits()); assertFalse(controller.state.canReveal(paint));
        controller.foreground(false); assertFalse(fits()); assertTrue(dialog.isShowing());
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
        fullscreen(); controller.state.configure("next", false, false); acknowledgePolicy();
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
            controller.state.configure("browser", false, false); acknowledgePolicy();
            int requested = ReflectionHelpers.callInstanceMethod(dialog.getWindow().getInsetsController(), "getRequestedVisibleTypes");
            assertEquals(3, requested & 3);
        }
    }

    @Test @Config(sdk = 35)
    public void android15RetainsItsBrowserEdgeToEdgePolicy() {
        open(true, true, "default");
        assertFalse(fits()); int behavior = bars().getSystemBarsBehavior();
        fullscreen(); controller.state.configure("next", false, false); acknowledgePolicy();
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
        if (controller.state.active() && controller.state.policyResolved()) acknowledgePolicy();
    }

    private void readyDocument(String token) {
        message("configure", token); message("ready", token); flushTokenReads(token);
        assertEquals(token, controller.state.token()); assertTrue(controller.state.isReady());
    }

    @Test public void expiredCurrentDocumentReadyIsRejected() {
        openIdentified(); commit(startDocument());
        message("configure", "current"); flushTokenReads("current");
        controller.state.tick(android.os.SystemClock.uptimeMillis() + 30_000); controller.render();
        assertEquals(BreadPresentationState.Phase.ERROR, controller.state.phase());
        message("ready", "current"); flushTokenReads("current");
        assertTrue("Expired readiness must reject the page promise",
            shadowOf(webView).getLastEvaluatedJavascript().contains("\"ok\":false"));
        assertFalse(controller.state.isReady());
        assertEquals(BreadPresentationState.Phase.ERROR, controller.state.phase());
        assertEquals(View.VISIBLE, ((View) ReflectionHelpers.getField(controller, "cover")).getVisibility());
    }

    @Test public void currentDocumentReadyAcknowledgesAcceptance() {
        openIdentified(); commit(startDocument());
        readyDocument("current");
        assertTrue("Accepted readiness must resolve the page promise",
            shadowOf(webView).getLastEvaluatedJavascript().contains("\"ok\":true"));
    }

    @Test public void hiddenCurrentDocumentReadyAcknowledgesAcceptanceWithoutReveal() {
        openIdentified(); commit(startDocument());
        message("configure", "current"); flushTokenReads("current");
        controller.visibility(false);
        controller.state.tick(android.os.SystemClock.uptimeMillis() + 60_000);
        message("ready", "current"); flushTokenReads("current");
        assertTrue("Hidden accepted readiness must resolve the page promise",
            shadowOf(webView).getLastEvaluatedJavascript().contains("\"ok\":true"));
        assertTrue(controller.state.isReady());
        assertEquals(BreadPresentationState.Phase.TEMPORARILY_HIDDEN, controller.state.phase());
        assertEquals(View.VISIBLE, ((View) ReflectionHelpers.getField(controller, "cover")).getVisibility());
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
        assertFalse("Current document close must dismiss the dialog", dialog.isShowing());
        assertEquals(BreadPresentationState.Phase.CLOSED, controller.state.phase());
        verify(callbacks, times(1)).closeEvent(any());
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
        assertFalse("Current document close must dismiss the dialog", dialog.isShowing());
        assertEquals(BreadPresentationState.Phase.CLOSED, controller.state.phase());
        verify(callbacks, times(1)).closeEvent(any());
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
        assertFalse("Current document close must dismiss the dialog", dialog.isShowing());
        assertEquals(BreadPresentationState.Phase.CLOSED, controller.state.phase());
        verify(callbacks, times(1)).closeEvent(any());
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
        acknowledgePolicy();
        assertEquals(View.GONE, ((View) ReflectionHelpers.getField(controller, "overlay")).getVisibility());
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO, webView.getImportantForAccessibility());
        assertTrue(fits()); assertFalse(controller.fullscreen());
        String fullscreen = new JSObject().put("type", "configure").put("token", "fallback")
            .put("display", "fullscreen").put("manualReady", true).toString();
        messageListener.onPostMessage(webView, new WebMessageCompat(fullscreen), Uri.parse(options.getUrl()), true, null);
        assertTrue(shadowOf(webView).getLastEvaluatedJavascript().contains("\"display\":\"browser\""));
        verify(callbacks, atLeastOnce()).presentationChanged(eq(false), eq(true), anyLong(), nullable(String.class));
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
        acknowledgePolicy();
        exit.performClick(); exit.performClick();
        verify(callbacks, times(2)).presentationMinimizeRequested(controller.state.policyRevision(), controller.state.acknowledgedVisibilitySequence(), null);
        verify(callbacks, never()).closeEvent(any());
        assertEquals(BreadPresentationState.Phase.ERROR, controller.state.phase());
        controller.visibility(false);
        assertFalse(dialog.isShowing());
        dialog.show();
        assertEquals(BreadPresentationState.Phase.ERROR, controller.state.phase());
        dialog.forceClose();
        assertEquals(BreadPresentationState.Phase.CLOSED, controller.state.phase());
        verify(callbacks, times(1)).closeEvent(any());
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
        controller.navigate(); controller.state.configure("browser", false, false); acknowledgePolicy();
        WindowManager.LayoutParams normal = dialog.getWindow().getAttributes();
        float density = activity.getResources().getDisplayMetrics().density;
        int status = activity.getResources().getDimensionPixelSize(activity.getResources().getIdentifier("status_bar_height", "dimen", "android"));
        assertEquals((int)(300*density), normal.width); assertEquals((int)(500*density), normal.height);
        assertEquals((int)(12*density), normal.x); assertEquals((int)(80*density)+status, normal.y);
    }
}
