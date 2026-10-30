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
import android.widget.ImageView;
import android.widget.TextView;
import android.graphics.RectF;
import androidx.core.view.WindowCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.time.Duration;
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

    @Test public void prepareMorphWarmsOnlyRequestedHiddenDialogUntilExpandedOrExpired() {
        open(true, true, "default", false);
        WebViewDialog target = dialog;
        BreadPresentationController targetPresentation = controller;
        BreadPresentationState.Phase parked = targetPresentation.state.phase();
        WebViewRegistry.getShared().register("target", target);
        assertSame(target, WebViewRegistry.getShared().get("target"));
        assertWarmupEligible(target, targetPresentation);

        open(true, true, "default", false);
        WebViewDialog other = dialog;
        WebViewRegistry.getShared().register("other", other);

        InAppBrowserPlugin plugin = spy(new InAppBrowserPlugin());
        androidx.appcompat.app.AppCompatActivity pluginActivity = mock(androidx.appcompat.app.AppCompatActivity.class);
        doAnswer(call -> { ((Runnable) call.getArgument(0)).run(); return null; }).when(pluginActivity).runOnUiThread(any());
        doReturn(pluginActivity).when(plugin).getActivity();
        PluginCall unknown = mock(PluginCall.class);
        when(unknown.getString("id")).thenReturn("missing");
        plugin.prepareMorph(unknown);
        assertFalse(target.isShowing());
        assertFalse(other.isShowing());

        PluginCall warm = mock(PluginCall.class);
        when(warm.getString("id")).thenReturn("target");
        when(warm.getInt("durationMs")).thenReturn(600);
        plugin.prepareMorph(warm);

        assertTrue("only the requested hidden presentation should warm " + warmupState(target, targetPresentation),
            target.isShowing());
        assertEquals(View.INVISIBLE, target.getWindow().getDecorView().getVisibility());
        assertEquals(parked, targetPresentation.state.phase());
        assertFalse(other.isShowing());
        verify(warm).resolve();

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));
        assertTrue(warmupState(target, ReflectionHelpers.getField(target, "presentation")), target.isShowing());
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));
        assertTrue(target.isShowing());
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200));
        assertTrue(target.isShowing());

        BreadMorphCard card = new BreadMorphCard(new RectF(20, 20, 220, 160), 18);
        assertTrue("an expand should take ownership of the warm dialog", targetPresentation.morph(
            "expanded", card, 0, 0, "target", (int) targetPresentation.state.policyRevision(), 1));
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(800));
        assertTrue("the expired warm-up must not hide an expanded dialog", target.isShowing());
        BreadMorphController morph = ReflectionHelpers.getField(targetPresentation, "morph");
        assertEquals(1f, morph.progress(), 0.01f);
        other.forceClose();
    }

    @Test public void prepareMorphCooldownExpiresAt750MsWithoutAnExpand() {
        open(true, true, "default", false);
        WebViewDialog target = dialog;
        BreadPresentationController targetPresentation = ReflectionHelpers.getField(target, "presentation");
        WebViewRegistry.getShared().register("target", target);
        assertSame(target, WebViewRegistry.getShared().get("target"));
        assertWarmupEligible(target, targetPresentation);
        prepareMorph("target", 600);

        assertTrue(target.isShowing());
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(700));
        assertTrue("the warm dialog remains available through 700 ms", target.isShowing());
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50));
        assertFalse("the unclaimed warm dialog cools down at 750 ms", target.isShowing());
    }

    @Test public void prepareMorphCooldownCannotTouchReplacementAfterClose() {
        open(true, true, "default", false);
        WebViewDialog original = dialog;
        BreadPresentationController originalPresentation = ReflectionHelpers.getField(original, "presentation");
        WebViewRegistry.getShared().register("target", original);
        assertSame(original, WebViewRegistry.getShared().get("target"));
        assertWarmupEligible(original, originalPresentation);
        prepareMorph("target", 600);
        assertTrue(warmupState(original, originalPresentation), original.isShowing());

        original.forceClose();
        WebViewRegistry.getShared().remove("target");
        WebViewDialog replacement = mock(WebViewDialog.class);
        WebViewRegistry.getShared().register("target", replacement);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(750));

        assertSame(replacement, WebViewRegistry.getShared().get("target"));
        verifyNoInteractions(replacement);
    }

    @Test public void prepareMorphLeavesAlreadyVisiblePresentationUnchanged() {
        open(true, true, "default");
        controller.state.configure("browser", false, false);
        acknowledgePolicy();
        assertTrue(dialog.isShowing());
        WebViewRegistry.getShared().register("visible", dialog);
        int decorVisibility = dialog.getWindow().getDecorView().getVisibility();
        BreadPresentationState.Phase phase = controller.state.phase();
        prepareMorph("visible", 600);

        assertTrue(dialog.isShowing());
        assertEquals(decorVisibility, dialog.getWindow().getDecorView().getVisibility());
        assertEquals(phase, controller.state.phase());
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(800));
        assertTrue("a cooldown must not hide an already-visible target", dialog.isShowing());
        assertEquals(decorVisibility, dialog.getWindow().getDecorView().getVisibility());
        assertEquals(phase, controller.state.phase());
    }

    private void prepareMorph(String id, int durationMs) {
        InAppBrowserPlugin plugin = spy(new InAppBrowserPlugin());
        androidx.appcompat.app.AppCompatActivity pluginActivity = mock(androidx.appcompat.app.AppCompatActivity.class);
        doAnswer(call -> { ((Runnable) call.getArgument(0)).run(); return null; }).when(pluginActivity).runOnUiThread(any());
        doReturn(pluginActivity).when(plugin).getActivity();
        PluginCall call = mock(PluginCall.class);
        when(call.getString("id")).thenReturn(id);
        when(call.getInt("durationMs")).thenReturn(durationMs);
        plugin.prepareMorph(call);
        verify(call).resolve();
    }

    private void assertWarmupEligible(WebViewDialog target, BreadPresentationController presentation) {
        assertFalse(warmupState(target, presentation), target.isShowing());
        assertFalse(warmupState(target, presentation), target.managedClosing());
        assertFalse(warmupState(target, presentation), presentation.state.surfaceVisibility());
        assertEquals(warmupState(target, presentation), BreadPresentationState.Phase.TEMPORARILY_HIDDEN,
            presentation.state.phase());
        assertFalse(warmupState(target, presentation), ReflectionHelpers.<Boolean>getField(presentation, "warmed"));
        assertFalse(warmupState(target, presentation), ReflectionHelpers.<Boolean>getField(presentation, "capturing"));
        assertFalse(warmupState(target, presentation), ReflectionHelpers.<Boolean>getField(presentation, "tracking"));
        assertNull(warmupState(target, presentation), ReflectionHelpers.getField(presentation, "collapseFlight"));
        assertFalse(warmupState(target, presentation),
            ReflectionHelpers.<BreadMorphController>getField(presentation, "morph").running());
        assertNotNull(warmupState(target, presentation), target.getWindow());
    }

    private String warmupState(WebViewDialog target, BreadPresentationController presentation) {
        return "(phase=" + presentation.state.phase()
            + ", surfaceVisible=" + presentation.state.surfaceVisibility()
            + ", dialogShowing=" + target.isShowing()
            + ", managedClosing=" + target.managedClosing()
            + ", warmed=" + ReflectionHelpers.<Boolean>getField(presentation, "warmed")
            + ", capturing=" + ReflectionHelpers.<Boolean>getField(presentation, "capturing")
            + ", tracking=" + ReflectionHelpers.<Boolean>getField(presentation, "tracking")
            + ", collapseQueued=" + (ReflectionHelpers.getField(presentation, "collapseFlight") != null)
            + ")";
    }

    @After public void tearDown() {
        if (dialog != null) dialog.forceClose();
        WebViewRegistry.getShared().clear();
        WebViewRegistry.getShared().setMorphCard(null);
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

    @Test public void breadCapsuleRequestsHostMinimizeWithoutClosingTheRetainedDocument() throws Exception {
        open(true, true, "default");
        fullscreen();
        morphFixture();
        long navigation = controller.state.navigationGeneration();
        ImageButton capsule = ReflectionHelpers.getField(controller, "back");
        capsule.performClick();
        verify(callbacks).presentationMinimizeRequested(eq(controller.state.policyRevision()),
            eq(controller.state.acknowledgedVisibilitySequence()), isNull(), startsWith("native-"));
        assertEquals(BreadPresentationState.Motion.COLLAPSING, controller.state.motion());
        assertTrue(dialog.isShowing());
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

    @Test public void binaryMessageIsIgnoredWithoutAReply() {
        features.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.NAVIGATION_LISTENER_V1)).thenReturn(false);
        open(true, true, "default");
        String before = shadowOf(webView).getLastEvaluatedJavascript();
        messageListener.onPostMessage(webView, new WebMessageCompat(new byte[] {1}), Uri.parse(options.getUrl()), true, null);
        assertEquals(before, shadowOf(webView).getLastEvaluatedJavascript());
        message("ready", "fallback");
        assertTrue(shadowOf(webView).getLastEvaluatedJavascript().contains("\"ok\":false"));
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
        verify(callbacks, times(2)).presentationMinimizeRequested(eq(controller.state.policyRevision()),
            eq(controller.state.acknowledgedVisibilitySequence()), isNull(), any());
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

    @Test public void supportedInstallsEveryTransportBeforeFirstNavigation() {
        open(true, true, "default");
        assertEquals(List.of("listener:breadAuth", "listener:breadPresentation", "script:window.bread={version:1}"), installed);
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

    static final class FakeSnapshotter implements BreadSnapshotter {
        final List<android.graphics.Rect> captures = new ArrayList<>();
        final List<Runnable> encodes = new ArrayList<>();
        @Override public void capture(Window window, android.graphics.Rect rect, android.graphics.Bitmap into,
                                      java.util.function.IntConsumer done) {
            captures.add(new android.graphics.Rect(rect));
            done.accept(android.view.PixelCopy.SUCCESS);
        }
        @Override public void encode(Runnable work) { encodes.add(work); }
        void runEncodesOffTheMainThread() throws InterruptedException {
            Thread encoder = new Thread(() -> { while (!encodes.isEmpty()) encodes.remove(0).run(); });
            encoder.start();
            encoder.join();
        }
    }

    private FakeSnapshotter snapshots;
    private View root;
    private final int[] rootOrigin = new int[2];
    private final List<ValueCallback<String>> metricsReplies = new ArrayList<>();
    private int gestures;

    private void openMorph(boolean fullscreen) throws Exception {
        open(true, true, "default");
        if (fullscreen) fullscreen();
        else { controller.state.configure("doc", false, true); acknowledgePolicy(); }
        assertTrue(controller.state.ready());
        morphFixture();
    }

    private void morphFixture() throws Exception {
        BreadMorphControllerTest.resetSpringFrames();
        snapshots = new FakeSnapshotter();
        ReflectionHelpers.setField(dialog, "snapshotter", snapshots);
        root = dialog.findViewById(R.id.coordinator_layout);
        BreadMorphControllerTest.advance(50);
        if (root.getWidth() == 0 || root.getHeight() == 0) {
            root.measure(View.MeasureSpec.makeMeasureSpec(390, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(650, View.MeasureSpec.EXACTLY));
            root.layout(0, 0, 390, 650);
            BreadMorphControllerTest.advance(50);
        }
        assertTrue("slot laid out", root.getWidth() > 0 && root.getHeight() > 0);
        webView = spy(webView);
        doReturn(root.getWidth()).when(webView).getWidth();
        doReturn(root.getHeight()).when(webView).getHeight();
        metricsReplies.clear();
        doAnswer(call -> {
            if (String.valueOf((Object) call.getArgument(0)).contains("__breadNativeMetrics")) metricsReplies.add(call.getArgument(1));
            return call.callRealMethod();
        }).when(webView).evaluateJavascript(anyString(), any());
        ReflectionHelpers.setField(controller, "webView", webView);
        ReflectionHelpers.setField(dialog, "_webView", webView);
        root.getLocationInWindow(rootOrigin);
    }

    // A scheduled traversal holds a sync barrier until its vsync, so the fence's posted update waits for a frame.
    private void paintFence() {
        controller.render();
        BreadMorphControllerTest.advance(32);
        assertFalse("metrics before the fence", metricsReplies.isEmpty());
        metricsReplies.get(metricsReplies.size() - 1).onReceiveValue("true");
        PaintWebView renderer = Shadow.extract(webView);
        assertNotNull("visual state fence", renderer.fence);
        renderer.fence.onComplete(renderer.request);
    }

    private void reveal() {
        paintFence();
        BreadMorphControllerTest.advance(300);
        assertEquals(BreadPresentationState.Phase.VISIBLE, controller.state.phase());
    }

    private BreadMorphCard card() {
        int[] at = new int[2];
        root.getLocationInWindow(at);
        float width = root.getWidth(), height = root.getHeight();
        return new BreadMorphCard(new RectF(at[0] + width * 0.70f, at[1] + height * 0.70f,
            at[0] + width * 0.95f, at[1] + height * 0.92f), 16);
    }

    private String motionState() {
        return "motion=" + controller.state.motion() + " phase=" + controller.state.phase()
            + " covering=" + ReflectionHelpers.getField(controller, "proxyCovering")
            + " crossfaded=" + ReflectionHelpers.getField(controller, "crossfaded")
            + " usable=" + controller.state.proxyUsable() + " p=" + driver().progress() + " target=" + driver().target();
    }

    private float cardScale(BreadMorphCard card) { return card.rect.width() / root.getWidth(); }
    private int nextSequence() { return ++acknowledgementSequence; }
    private BreadMorphController driver() { return ReflectionHelpers.getField(controller, "morph"); }

    private boolean collapse(BreadMorphCard card, String id) {
        return controller.morph("collapsed", card, 0, 0, id, null, nextSequence());
    }

    private boolean expand(BreadMorphCard card, String id) {
        return controller.morph("expanded", card, 0, 0, id, (int) controller.state.policyRevision(), nextSequence());
    }

    private void park(BreadMorphCard card) {
        assertTrue(collapse(card, "park"));
        BreadMorphControllerTest.settle();
        controller.visibility(false, null, nextSequence());
        assertFalse(dialog.isShowing());
    }

    private List<BreadMorphEvent> morphEvents(String id) {
        List<BreadMorphEvent> events = new ArrayList<>();
        for (org.mockito.invocation.Invocation invocation : mockingDetails(callbacks).getInvocations()) {
            if (!"presentationMorph".equals(invocation.getMethod().getName())) continue;
            BreadMorphEvent event = invocation.getArgument(0);
            if (id.equals(event.morphId)) events.add(event);
        }
        return events;
    }

    private List<String> phases(String id) {
        List<String> phases = new ArrayList<>();
        for (BreadMorphEvent event : morphEvents(id)) phases.add(event.phase + ":" + event.target);
        return phases;
    }

    @Test @Config(shadows = PaintWebView.class)
    public void expandShowsProxyAtCardAndFadesItAfterTheVisualStateFence() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        park(card);
        assertEquals(1, snapshots.captures.size());
        ImageView proxy = ReflectionHelpers.getField(controller, "proxy");
        View cover = ReflectionHelpers.getField(controller, "cover");
        assertTrue(expand(card, "m2"));
        assertTrue(dialog.isShowing());
        assertEquals(BreadPresentationState.Motion.EXPANDING, controller.state.motion());
        assertEquals(View.VISIBLE, proxy.getVisibility());
        assertEquals(1, proxy.getAlpha(), 0);
        assertEquals(View.GONE, cover.getVisibility());
        assertEquals(cardScale(card), root.getScaleX(), 1e-4f);
        BreadMorphControllerTest.settle();
        assertEquals(View.VISIBLE, proxy.getVisibility());
        assertEquals(1, proxy.getAlpha(), 0);
        assertEquals(1, root.getScaleX(), 0);
        assertEquals(List.of("started:expanded", "settled:expanded"), phases("m2"));
        paintFence();
        BreadMorphControllerTest.advance(220);
        assertEquals(View.GONE, proxy.getVisibility());
        assertEquals(View.GONE, cover.getVisibility());
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO, webView.getImportantForAccessibility());
        assertEquals(BreadPresentationState.Phase.VISIBLE, controller.state.phase());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void expandAfterNavigationUsesTheThemeCover() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        park(card);
        controller.navigate();
        controller.state.configure("next", false, true);
        ImageView proxy = ReflectionHelpers.getField(controller, "proxy");
        View cover = ReflectionHelpers.getField(controller, "cover");
        View spinner = ReflectionHelpers.getField(controller, "spinner");
        assertTrue(expand(card, "m2"));
        assertEquals(View.VISIBLE, cover.getVisibility());
        assertEquals(1, cover.getAlpha(), 0);
        assertEquals(View.VISIBLE, spinner.getVisibility());
        assertNotEquals(View.VISIBLE, proxy.getVisibility());
        BreadMorphControllerTest.settle();
        assertEquals(View.VISIBLE, cover.getVisibility());
        assertNotEquals(View.VISIBLE, proxy.getVisibility());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void invalidationDuringExpandRestoresAnOpaqueProxy() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        park(card);
        ImageView proxy = ReflectionHelpers.getField(controller, "proxy");
        assertTrue(expand(card, "m2"));
        for (int i = 0; i < 4; i++) BreadMorphControllerTest.frame();
        paintFence();
        BreadMorphControllerTest.advance(50);
        assertEquals(View.VISIBLE, proxy.getVisibility());
        assertTrue(proxy.getAlpha() < 1);
        ReflectionHelpers.callInstanceMethod(controller, "invalidateLayout");
        assertEquals(View.VISIBLE, proxy.getVisibility());
        assertEquals(motionState(), 1, proxy.getAlpha(), 0);
        assertEquals(255, proxy.getImageAlpha());
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, webView.getImportantForAccessibility());
        BreadMorphControllerTest.advance(300);
        assertEquals(View.VISIBLE, proxy.getVisibility());
        assertEquals(1, proxy.getAlpha(), 0);
    }

    @Test @Config(shadows = PaintWebView.class)
    public void collapseKeepsTheDialogShownUntilTheHiddenAcknowledgement() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        assertTrue(collapse(card, "m1"));
        BreadMorphControllerTest.settle();
        assertTrue(dialog.isShowing());
        assertEquals(BreadPresentationState.Motion.NONE, controller.state.motion());
        assertEquals(cardScale(card), root.getScaleX(), 1e-4f);
        assertEquals(List.of("started:collapsed", "settled:collapsed"), phases("m1"));
        BreadMorphControllerTest.advance(500);
        assertTrue(dialog.isShowing());
        assertEquals(cardScale(card), root.getScaleX(), 1e-4f);
        controller.visibility(false, null, nextSequence());
        assertFalse(dialog.isShowing());
        assertEquals(1, root.getScaleX(), 0);
        assertEquals(0, root.getTranslationY(), 0);
        assertFalse(root.getClipToOutline());
        assertEquals(List.of("started:collapsed", "settled:collapsed"), phases("m1"));
    }

    @Test @Config(shadows = PaintWebView.class)
    public void collapseCrossfadesToTheProxyBelowThirtyFivePercent() throws Exception {
        openMorph(false);
        reveal();
        ImageView proxy = ReflectionHelpers.getField(controller, "proxy");
        assertTrue(collapse(card(), "m1"));
        BreadMorphController morph = driver();
        for (int i = 0; i < 60 && morph.progress() > 0.5f; i++) BreadMorphControllerTest.frame();
        assertTrue(morph.progress() <= 0.5f);
        assertTrue(proxy.getVisibility() != View.VISIBLE || proxy.getAlpha() == 0);
        for (int i = 0; i < 60 && morph.progress() > 0.35f; i++) BreadMorphControllerTest.frame();
        assertEquals(View.VISIBLE, proxy.getVisibility());
        BreadMorphControllerTest.advance(150);
        assertEquals(1, proxy.getAlpha(), 0.001f);
        assertEquals("the view fades, never the image", 255, proxy.getImageAlpha());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void hiddenRequestMidFlightCancelsAndHides() throws Exception {
        openMorph(false);
        reveal();
        assertTrue(collapse(card(), "m1"));
        for (int i = 0; i < 3; i++) BreadMorphControllerTest.frame();
        controller.visibility(false, null, nextSequence());
        assertFalse(dialog.isShowing());
        assertEquals(List.of("started:collapsed", "cancelled:collapsed"), phases("m1"));
        assertEquals(BreadPresentationState.Motion.NONE, controller.state.motion());
        assertFalse(driver().running());
        assertEquals(1, root.getScaleX(), 0);
        BreadMorphControllerTest.settle();
        assertEquals(List.of("started:collapsed", "cancelled:collapsed"), phases("m1"));
    }

    @Test @Config(shadows = PaintWebView.class)
    public void insetChangeDuringMotionDoesNotCancelPaint() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        FrameLayout overlay = ReflectionHelpers.getField(controller, "overlay");
        View cover = ReflectionHelpers.getField(controller, "cover");
        assertTrue(collapse(card, "m1"));
        BreadMorphControllerTest.frame();
        BreadMorphControllerTest.frame();
        overlay.dispatchApplyWindowInsets(new WindowInsetsCompat.Builder()
            .setInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                androidx.core.graphics.Insets.of(0, 61, 0, 37))
            .build().toWindowInsets());
        assertEquals(BreadPresentationState.Phase.VISIBLE, controller.state.phase());
        assertNotEquals(View.VISIBLE, cover.getVisibility());
        assertTrue(expand(card, "m2"));
        BreadMorphControllerTest.settle();
        assertEquals(List.of("retargeted:expanded", "settled:expanded"), phases("m2"));
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void foregroundLossMidFlightFinishesAtNearestEnd() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        assertTrue(collapse(card, "m1"));
        BreadMorphController morph = driver();
        for (int i = 0; i < 60 && morph.progress() >= 0.5f; i++) BreadMorphControllerTest.frame();
        controller.foreground(false);
        assertEquals(List.of("started:collapsed", "settled:collapsed"), phases("m1"));
        assertFalse(morph.running());
        assertEquals(cardScale(card), root.getScaleX(), 1e-4f);
        controller.foreground(true);
        controller.visibility(false, null, nextSequence());
        assertFalse(dialog.isShowing());
        assertTrue(expand(card, "m2"));
        for (int i = 0; i < 60 && morph.progress() <= 0.5f; i++) BreadMorphControllerTest.frame();
        controller.foreground(false);
        assertEquals(List.of("started:expanded", "settled:expanded"), phases("m2"));
        assertEquals(1, root.getScaleX(), 0);
        assertEquals(BreadPresentationState.Motion.NONE, controller.state.motion());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void accessibilityStaysHiddenUntilTheReveal() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        park(card);
        assertTrue(expand(card, "m2"));
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, webView.getImportantForAccessibility());
        for (int i = 0; i < 6; i++) BreadMorphControllerTest.frame();
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, webView.getImportantForAccessibility());
        BreadMorphControllerTest.settle();
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, webView.getImportantForAccessibility());
        paintFence();
        BreadMorphControllerTest.advance(220);
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO, webView.getImportantForAccessibility());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void snapshotUsesPixelCopyAndEncodesOffTheUiThread() throws Exception {
        openMorph(false);
        reveal();
        List<String> results = new ArrayList<>();
        dialog.takeSnapshotData(0.5f, 0.7f, results::add);
        assertEquals(1, snapshots.captures.size());
        int[] at = new int[2];
        webView.getLocationInWindow(at);
        assertEquals(new android.graphics.Rect(at[0], at[1], at[0] + webView.getWidth(), at[1] + webView.getHeight()),
            snapshots.captures.get(0));
        assertTrue(results.isEmpty());
        snapshots.runEncodesOffTheMainThread();
        assertTrue(results.isEmpty());
        BreadMorphControllerTest.advance(32);
        assertEquals(1, results.size());
        assertTrue(results.get(0).startsWith("data:image/jpeg;base64,"));
        assertTrue(collapse(card(), "m1"));
        assertEquals(2, snapshots.captures.size());
        BreadMorphControllerTest.frame();
        BreadMorphControllerTest.frame();
        dialog.takeSnapshotData(0.5f, 0.7f, results::add);
        assertEquals("a snapshot during a collapse reuses its start capture", 2, snapshots.captures.size());
        snapshots.runEncodesOffTheMainThread();
        BreadMorphControllerTest.advance(32);
        assertEquals(2, results.size());
        assertTrue(results.get(1).startsWith("data:image/jpeg;base64,"));
    }

    @Test @Config(shadows = PaintWebView.class)
    public void morphEventsCarryLifetimeSequenceAndMorphId() throws Exception {
        openMorph(false);
        reveal();
        int sequence = nextSequence();
        assertTrue(controller.morph("collapsed", card(), 0, 0, "m1", null, sequence));
        BreadMorphControllerTest.settle();
        List<BreadMorphEvent> events = morphEvents("m1");
        assertEquals(2, events.size());
        for (BreadMorphEvent event : events) {
            assertEquals("collapsed", event.target);
            assertEquals(sequence, event.sequence);
            assertFalse(event.tracking);
        }
        assertEquals("started", events.get(0).phase);
        assertEquals(1, events.get(0).progress, 0);
        assertEquals("settled", events.get(1).phase);
        assertEquals(0, events.get(1).progress, 0);
        assertEquals(0, events.get(1).velocity, 0);
    }

    @Test @Config(shadows = PaintWebView.class)
    public void newMorphMidFlightRetargetsAndSilencesTheOldMorphId() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        assertTrue(collapse(card, "m1"));
        for (int i = 0; i < 3; i++) BreadMorphControllerTest.frame();
        assertFalse(controller.morph("expanded", card, 0, 0, "stale", (int) controller.state.policyRevision(), acknowledgementSequence));
        assertTrue(driver().running());
        assertTrue(expand(card, "m2"));
        BreadMorphControllerTest.settle();
        assertEquals(List.of("started:collapsed"), phases("m1"));
        assertEquals(List.of(), phases("stale"));
        assertEquals(List.of("retargeted:expanded", "settled:expanded"), phases("m2"));
        assertTrue(dialog.isShowing());
        assertEquals(1, root.getScaleX(), 0);
    }

    @Test @Config(shadows = PaintWebView.class)
    public void closeMidFlightStopsWithoutEvents() throws Exception {
        openMorph(false);
        reveal();
        assertTrue(collapse(card(), "m1"));
        BreadMorphControllerTest.frame();
        dialog.forceClose();
        BreadMorphControllerTest.settle();
        assertEquals(List.of("started:collapsed"), phases("m1"));
        assertFalse(driver().running());
        assertEquals(1, root.getScaleX(), 0);
    }

    private android.view.MotionEvent touch(int action, float x, float y, long time) {
        return android.view.MotionEvent.obtain(0, time, action, x, y, 0);
    }

    private float[] path(BreadMorphCard card) {
        return new float[] {root.getWidth() / 2f - (card.rect.centerX() - rootOrigin[0]),
            root.getHeight() / 2f - (card.rect.centerY() - rootOrigin[1])};
    }

    private float grabAndRelease(BreadMorphCard card, float travel, boolean fast) {
        String id = "grab" + (++gestures);
        assertTrue(collapse(card, id));
        BreadMorphController morph = driver();
        for (int i = 0; i < 60 && morph.progress() > 0.5f; i++) BreadMorphControllerTest.frame();
        RectF page = controller.morphPageRect();
        float[] d = path(card);
        float length = (float) Math.hypot(d[0], d[1]);
        float slop = 2 * android.view.ViewConfiguration.get(activity).getScaledTouchSlop();
        float x = page.centerX(), y = page.centerY();
        float sx = x + d[0] / length * slop, sy = y + d[1] / length * slop;
        float ex = sx + d[0] * travel, ey = sy + d[1] * travel;
        long t = android.os.SystemClock.uptimeMillis();
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_DOWN, x, y, t)));
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_MOVE, sx, sy, t + 8)));
        if (fast) {
            assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_MOVE, ex, ey, t + 24)));
            assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_UP, ex, ey, t + 28)));
        } else {
            assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_MOVE, ex, ey, t + 40)));
            assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_MOVE, ex, ey, t + 400)));
            assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_UP, ex, ey, t + 410)));
        }
        List<BreadMorphEvent> events = morphEvents(id);
        BreadMorphEvent release = events.get(events.size() - 1);
        assertEquals("retargeted", release.phase);
        assertFalse(release.tracking);
        float end = morph.target();
        assertEquals(end >= 0.5f ? "expanded" : "collapsed", release.target);
        BreadMorphControllerTest.settle();
        if (end < 0.5f) controller.visibility(false, null, nextSequence());
        return end;
    }

    @Test @Config(shadows = PaintWebView.class)
    public void tapOnTheMovingPageRetargets() throws Exception {
        openMorph(false);
        reveal();
        assertTrue(collapse(card(), "m1"));
        for (int i = 0; i < 4; i++) BreadMorphControllerTest.frame();
        BreadMorphController morph = driver();
        float before = morph.progress();
        RectF page = controller.morphPageRect();
        assertTrue(page.width() > 0 && page.height() > 0);
        long t = android.os.SystemClock.uptimeMillis();
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_DOWN, page.centerX(), page.centerY(), t)));
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_UP, page.centerX(), page.centerY(), t + 60)));
        List<BreadMorphEvent> events = morphEvents("m1");
        BreadMorphEvent tap = events.get(events.size() - 1);
        assertEquals("retargeted", tap.phase);
        assertEquals("expanded", tap.target);
        assertFalse(tap.tracking);
        assertEquals(before, tap.progress, 1e-6f);
        assertEquals(BreadPresentationState.Motion.EXPANDING, controller.state.motion());
        BreadMorphControllerTest.settle();
        assertEquals(List.of("started:collapsed", "retargeted:expanded", "settled:expanded"), phases("m1"));
        assertTrue(dialog.isShowing());
        assertEquals(1, root.getScaleX(), 0);
    }

    @Test @Config(shadows = PaintWebView.class)
    public void grabTracksThenReleasesWithTheReleaseSpring() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        assertTrue(collapse(card, "m1"));
        BreadMorphController morph = driver();
        for (int i = 0; i < 60 && morph.progress() > 0.5f; i++) BreadMorphControllerTest.frame();
        RectF page = controller.morphPageRect();
        float[] d = path(card);
        float length = (float) Math.hypot(d[0], d[1]);
        float slop = 2 * android.view.ViewConfiguration.get(activity).getScaledTouchSlop();
        float x = page.centerX(), y = page.centerY();
        float sx = x + d[0] / length * slop, sy = y + d[1] / length * slop;
        long t = android.os.SystemClock.uptimeMillis();
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_DOWN, x, y, t)));
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_MOVE, sx, sy, t + 8)));
        assertFalse(morph.running());
        float grabbed = morph.progress();
        List<BreadMorphEvent> events = morphEvents("m1");
        BreadMorphEvent grab = events.get(events.size() - 1);
        assertEquals("retargeted", grab.phase);
        assertTrue(grab.tracking);
        assertEquals("collapsed", grab.target);
        BreadMorphControllerTest.frame();
        assertEquals(grabbed, morph.progress(), 0);
        float ex = sx + d[0] / 4, ey = sy + d[1] / 4;
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_MOVE, ex, ey, t + 40)));
        assertEquals(grabbed + 0.25f, morph.progress(), 1e-3f);
        assertEquals(BreadMorphGeometry.pose(morph.progress(), morph.card(), root.getWidth(), root.getHeight()).scale,
            root.getScaleX(), 1e-5f);
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_MOVE, ex, ey, t + 400)));
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_UP, ex, ey, t + 410)));
        assertTrue(morph.running());
        androidx.dynamicanimation.animation.SpringAnimation spring = ReflectionHelpers.getField(morph, "spring");
        assertEquals(BreadMorphPhysics.RELEASE.stiffness, spring.getSpring().getStiffness(), 0.01f);
        events = morphEvents("m1");
        BreadMorphEvent release = events.get(events.size() - 1);
        assertEquals("retargeted", release.phase);
        assertFalse(release.tracking);
        assertEquals("collapsed", release.target);
        BreadMorphControllerTest.settle();
        assertEquals("settled:collapsed", phases("m1").get(phases("m1").size() - 1));
    }

    @Test @Config(shadows = PaintWebView.class)
    public void releaseCommitsPastThirtyPercentOrFourHundredFiftyDpPerSecond() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        assertEquals("a slow drag past 30 percent commits to the dragged end", 1, grabAndRelease(card, 0.31f, false), 0);
        assertEquals("a fast flick commits to the flicked end", 1, grabAndRelease(card, 0.1f, true), 0);
        assertEquals("a short slow drag springs back", 0, grabAndRelease(card, 0.1f, false), 0);
    }

    @Test @Config(shadows = PaintWebView.class)
    public void touchesOutsideThePageAreConsumedDuringFlight() throws Exception {
        openMorph(false);
        reveal();
        int pass = BreadPresentationController.TOUCH_PASS, consume = BreadPresentationController.TOUCH_CONSUME;
        long t = android.os.SystemClock.uptimeMillis();
        float cx = root.getWidth() / 2f, cy = root.getHeight() / 2f;
        assertEquals(pass, controller.routeTouch(touch(android.view.MotionEvent.ACTION_DOWN, cx, cy, t)));
        assertTrue(collapse(card(), "m1"));
        assertEquals("a gesture the page had is cancelled for it", BreadPresentationController.TOUCH_CANCEL,
            controller.routeTouch(touch(android.view.MotionEvent.ACTION_MOVE, cx, cy + 4, t + 16)));
        assertEquals(consume, controller.routeTouch(touch(android.view.MotionEvent.ACTION_MOVE, cx, cy + 8, t + 32)));
        assertEquals(consume, controller.routeTouch(touch(android.view.MotionEvent.ACTION_UP, cx, cy + 8, t + 48)));
        for (int i = 0; i < 4; i++) BreadMorphControllerTest.frame();
        RectF page = controller.morphPageRect();
        float x = page.left / 2, y = page.top / 2;
        assertFalse(page.contains(x, y));
        assertTrue(x > 0 && y > 0);
        assertEquals(consume, controller.routeTouch(touch(android.view.MotionEvent.ACTION_DOWN, x, y, t + 100)));
        assertEquals(consume, controller.routeTouch(touch(android.view.MotionEvent.ACTION_UP, x, y, t + 140)));
        assertEquals(List.of("started:collapsed"), phases("m1"));
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_DOWN, page.centerX(), page.centerY(), t + 200)));
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_UP, page.centerX(), page.centerY(), t + 240)));
        assertEquals(List.of("started:collapsed", "retargeted:expanded"), phases("m1"));
        BreadMorphControllerTest.settle();
        assertEquals(pass, controller.routeTouch(touch(android.view.MotionEvent.ACTION_DOWN, cx, cy, t + 4000)));
    }

    private BreadMorphCard hostCardInside(float left, float top, float right, float bottom) {
        float density = activity.getResources().getDisplayMetrics().density;
        int status = activity.getResources().getDimensionPixelSize(
            activity.getResources().getIdentifier("status_bar_height", "dimen", "android"));
        WindowManager.LayoutParams params = dialog.getWindow().getAttributes();
        float width = root.getWidth(), height = root.getHeight();
        float ox = rootOrigin[0] + params.x, oy = rootOrigin[1] + params.y - status;
        return new BreadMorphCard(new RectF((ox + width * left) / density, (oy + height * top) / density,
            (ox + width * right) / density, (oy + height * bottom) / density), 16);
    }

    @Test @Config(shadows = PaintWebView.class)
    public void fullscreenCollapseKeepsTheWindowFullUntilTheAcknowledgementAndShowsBars() throws Exception {
        open(true, true, "default");
        boolean fit = fits(); int behavior = bars().getSystemBarsBehavior();
        fullscreen();
        assertTrue(controller.state.ready());
        morphFixture();
        reveal();
        WebViewRegistry.getShared().setMorphCard(hostCardInside(0.6f, 0.6f, 0.9f, 0.85f));
        ImageButton capsule = ReflectionHelpers.getField(controller, "back");
        capsule.performClick();
        assertEquals(BreadPresentationState.Motion.COLLAPSING, controller.state.motion());
        assertEquals(-1, dialog.getWindow().getAttributes().width);
        assertEquals(-1, dialog.getWindow().getAttributes().height);
        int requested = ReflectionHelpers.callInstanceMethod(dialog.getWindow().getInsetsController(), "getRequestedVisibleTypes");
        assertEquals(3, requested & 3);
        android.graphics.drawable.Drawable background = dialog.getWindow().getDecorView().getBackground();
        assertTrue(background instanceof android.graphics.drawable.ColorDrawable);
        assertEquals(android.graphics.Color.TRANSPARENT, ((android.graphics.drawable.ColorDrawable) background).getColor());
        BreadMorphControllerTest.settle();
        assertTrue(dialog.isShowing());
        assertEquals(-1, dialog.getWindow().getAttributes().width);
        assertNotNull(driver().card());
        assertEquals(0.3f, root.getScaleX(), 1e-3f);
        assertEquals(2, activity.getWindow().getAttributes().rotationAnimation);
        controller.visibility(false, null, nextSequence());
        assertFalse(dialog.isShowing());
        assertRestored(fit, behavior);
        assertEquals(1, root.getScaleX(), 0);
        assertEquals(1, capsule.getAlpha(), 0);
        assertEquals(255, capsule.getImageAlpha());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void capsuleWithoutACardFadesAndScales() throws Exception {
        openMorph(true);
        reveal();
        WebViewRegistry.getShared().setMorphCard(null);
        ImageButton capsule = ReflectionHelpers.getField(controller, "back");
        capsule.performClick();
        assertEquals(BreadPresentationState.Motion.COLLAPSING, controller.state.motion());
        BreadMorphControllerTest.settle();
        assertNull(driver().card());
        assertEquals(0.9f, root.getScaleX(), 1e-4f);
        assertEquals(0, root.getAlpha(), 1e-4f);
    }

    @Test @Config(shadows = PaintWebView.class)
    public void hostRejectionSpringsBack() throws Exception {
        openMorph(true);
        reveal();
        WebViewRegistry.getShared().setMorphCard(hostCardInside(0.6f, 0.6f, 0.9f, 0.85f));
        ImageButton capsule = ReflectionHelpers.getField(controller, "back");
        capsule.performClick();
        org.mockito.ArgumentCaptor<String> id = org.mockito.ArgumentCaptor.forClass(String.class);
        verify(callbacks).presentationMinimizeRequested(anyLong(), anyLong(), isNull(), id.capture());
        assertTrue(id.getValue().startsWith("native-"));
        for (int i = 0; i < 3; i++) BreadMorphControllerTest.frame();
        assertTrue(controller.morph("expanded", null, 0, 0, "m2", (int) controller.state.policyRevision(), nextSequence()));
        BreadMorphControllerTest.settle();
        assertEquals(List.of("started:collapsed"), phases(id.getValue()));
        assertEquals(List.of("retargeted:expanded", "settled:expanded"), phases("m2"));
        assertTrue(dialog.isShowing());
        assertEquals(1, root.getScaleX(), 0);
        assertEquals(2, bars().getSystemBarsBehavior());
    }

    private InAppBrowserPlugin morphPlugin() {
        InAppBrowserPlugin plugin = spy(new InAppBrowserPlugin());
        androidx.appcompat.app.AppCompatActivity pluginActivity = mock(androidx.appcompat.app.AppCompatActivity.class);
        doAnswer(call -> { ((Runnable) call.getArgument(0)).run(); return null; }).when(pluginActivity).runOnUiThread(any());
        doReturn(pluginActivity).when(plugin).getActivity();
        return plugin;
    }

    private PluginCall morphCall(String id, String token, Integer sequence, String to, JSObject card) {
        PluginCall call = mock(PluginCall.class);
        when(call.getString("id")).thenReturn(id);
        when(call.getString("managedHostCloseToken")).thenReturn(token);
        when(call.getInt("visibilitySequence")).thenReturn(sequence);
        when(call.getInt("policyRevision")).thenReturn((int) controller.state.policyRevision());
        when(call.getString("to")).thenReturn(to);
        when(call.getString("morphId")).thenReturn("plugin-" + sequence);
        when(call.getObject("card")).thenReturn(card);
        return call;
    }

    private JSObject cardJson(BreadMorphCard host) {
        return new JSObject().put("x", host.rect.left).put("y", host.rect.top).put("width", host.rect.width())
            .put("height", host.rect.height()).put("cornerRadius", host.cornerRadius);
    }

    private boolean accepted(PluginCall call) {
        org.mockito.ArgumentCaptor<JSObject> result = org.mockito.ArgumentCaptor.forClass(JSObject.class);
        verify(call).resolve(result.capture());
        return Boolean.TRUE.equals(result.getValue().getBool("accepted"));
    }

    @Test @Config(shadows = PaintWebView.class)
    public void morphRejectsAStaleLifetimeOrSequence() throws Exception {
        openMorph(false);
        reveal();
        int last = acknowledgementSequence;
        WebViewRegistry.getShared().register("managed", dialog);
        dialog.configureManagedClose("managed", new JSObject().put("token", "lifetime"), ignored -> {});
        InAppBrowserPlugin plugin = morphPlugin();
        PluginCall otherLifetime = morphCall("managed", "other", last + 1, "collapsed", null);
        plugin.morph(otherLifetime);
        assertFalse(accepted(otherLifetime));
        PluginCall unsequenced = morphCall("managed", "lifetime", null, "collapsed", null);
        plugin.morph(unsequenced);
        assertFalse(accepted(unsequenced));
        PluginCall stale = morphCall("managed", "lifetime", last, "collapsed", null);
        plugin.morph(stale);
        assertFalse(accepted(stale));
        PluginCall missing = morphCall("missing", "lifetime", last + 1, "collapsed", null);
        plugin.morph(missing);
        assertFalse(accepted(missing));
        assertEquals(BreadPresentationState.Motion.NONE, controller.state.motion());
        PluginCall current = morphCall("managed", "lifetime", last + 1, "collapsed", null);
        plugin.morph(current);
        assertTrue(accepted(current));
        assertEquals(BreadPresentationState.Motion.COLLAPSING, controller.state.motion());
        List<BreadMorphEvent> events = morphEvents("plugin-" + (last + 1));
        assertEquals("started", events.get(0).phase);
        assertEquals(last + 1, events.get(0).sequence);
    }

    @Test @Config(shadows = PaintWebView.class)
    public void morphNotifiesTheNavbarOnAVisibilityChange() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        park(card);
        WebViewRegistry.getShared().register("navbar", dialog);
        InAppBrowserPlugin plugin = morphPlugin();
        ee.forgr.capacitor_inappbrowser.navbar.NavbarOverlayManager navbar =
            mock(ee.forgr.capacitor_inappbrowser.navbar.NavbarOverlayManager.class);
        ReflectionHelpers.setField(plugin, "navbarManager", navbar);
        PluginCall call = morphCall("navbar", null, nextSequence(), "expanded", cardJson(hostCardInside(0.7f, 0.7f, 0.95f, 0.92f)));
        plugin.morph(call);
        assertTrue(accepted(call));
        assertTrue(dialog.isShowing());
        assertEquals(BreadPresentationState.Motion.EXPANDING, controller.state.motion());
        verify(navbar).notifyDialogVisibilityChanged(dialog);
        assertEquals(0.25f, root.getScaleX(), 1e-3f);
    }

    @Test @Config(shadows = PaintWebView.class)
    public void setMorphTargetIsReadByTheNativeCollapse() throws Exception {
        openMorph(true);
        reveal();
        InAppBrowserPlugin plugin = morphPlugin();
        PluginCall target = mock(PluginCall.class);
        when(target.getObject("card")).thenReturn(cardJson(hostCardInside(0.6f, 0.6f, 0.9f, 0.85f)));
        plugin.setMorphTarget(target);
        verify(target).resolve();
        assertNotNull(WebViewRegistry.getShared().morphCard());
        ImageButton capsule = ReflectionHelpers.getField(controller, "back");
        capsule.performClick();
        BreadMorphControllerTest.frame();
        BreadMorphCard landing = driver().card();
        assertNotNull(landing);
        assertEquals(root.getWidth() * 0.6f, landing.rect.left, 0.5f);
        assertEquals(root.getHeight() * 0.6f, landing.rect.top, 0.5f);
        assertEquals(root.getWidth() * 0.3f, landing.rect.width(), 0.5f);
        assertEquals(root.getHeight() * 0.25f, landing.rect.height(), 0.5f);
        PluginCall clear = mock(PluginCall.class);
        when(clear.getObject("card")).thenReturn(null);
        plugin.setMorphTarget(clear);
        verify(clear).resolve();
        assertNull(WebViewRegistry.getShared().morphCard());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void legacyParkSnapshotLeavesTheProxyForTheNextExpand() throws Exception {
        openMorph(false);
        reveal();
        BreadMorphCard card = card();
        List<String> results = new ArrayList<>();
        dialog.takeSnapshotData(0.5f, 0.7f, results::add);
        snapshots.runEncodesOffTheMainThread();
        BreadMorphControllerTest.advance(32);
        assertEquals(1, results.size());
        controller.visibility(false, null, nextSequence());
        assertFalse(dialog.isShowing());
        ImageView proxy = ReflectionHelpers.getField(controller, "proxy");
        View cover = ReflectionHelpers.getField(controller, "cover");
        assertTrue(expand(card, "x1"));
        assertTrue(dialog.isShowing());
        assertEquals(motionState(), View.VISIBLE, proxy.getVisibility());
        assertEquals(1, proxy.getAlpha(), 0);
        assertEquals(View.GONE, cover.getVisibility());
        assertEquals(cardScale(card), root.getScaleX(), 1e-4f);
    }

    static final class HeldSnapshotter implements BreadSnapshotter {
        final List<java.util.function.IntConsumer> pending = new ArrayList<>();
        @Override public void capture(Window window, android.graphics.Rect rect, android.graphics.Bitmap into,
                                      java.util.function.IntConsumer done) { pending.add(done); }
        @Override public void encode(Runnable work) {}
        void release() { pending.remove(0).accept(android.view.PixelCopy.SUCCESS); }
    }

    @Test @Config(shadows = PaintWebView.class)
    public void centeredCardDragKeepsTheGrabbedProgress() throws Exception {
        openMorph(false);
        reveal();
        float w = root.getWidth(), h = root.getHeight();
        BreadMorphCard card = new BreadMorphCard(new RectF(rootOrigin[0] + w * 0.25f, rootOrigin[1] + h * 0.25f,
            rootOrigin[0] + w * 0.75f, rootOrigin[1] + h * 0.75f), 16);
        assertTrue(collapse(card, "centered"));
        BreadMorphController morph = driver();
        for (int i = 0; i < 60 && morph.progress() > 0.5f; i++) BreadMorphControllerTest.frame();
        RectF page = controller.morphPageRect();
        float slop = 2 * android.view.ViewConfiguration.get(activity).getScaledTouchSlop();
        float x = page.centerX(), y = page.centerY();
        long t = android.os.SystemClock.uptimeMillis();
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_DOWN, x, y, t)));
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_MOVE, x + slop, y, t + 8)));
        assertFalse(morph.running());
        float grabbed = morph.progress();
        assertTrue(dialog.dispatchTouchEvent(touch(android.view.MotionEvent.ACTION_MOVE, x + slop + 40, y + 40, t + 24)));
        assertEquals("centered drag keeps the grabbed progress", grabbed, morph.progress(), 0f);
        assertFalse("container scale is a number", Float.isNaN(root.getScaleX()));
    }

    @Test @Config(shadows = PaintWebView.class)
    public void reducedMotionCollapseRendersTheParkedPose() throws Exception {
        openMorph(true);
        reveal();
        HeldSnapshotter held = new HeldSnapshotter();
        ReflectionHelpers.setField(dialog, "snapshotter", held);
        ImageButton back = ReflectionHelpers.getField(controller, "back");
        ImageView proxy = ReflectionHelpers.getField(controller, "proxy");
        ReflectionHelpers.callStaticMethod(android.animation.ValueAnimator.class, "setDurationScale",
            ReflectionHelpers.ClassParameter.from(float.class, 0f));
        try {
            assertTrue(collapse(card(), "still"));
            BreadMorphControllerTest.frame();
            assertFalse(driver().running());
            assertEquals("reduced-motion collapse leaves the parked end pose", 0f, back.getAlpha(), 0f);
            assertEquals(1, held.pending.size());
            held.release();
            assertEquals("a late capture still crossfades the parked card", View.VISIBLE, proxy.getVisibility());
            assertEquals(1, proxy.getAlpha(), 0f);
        } finally {
            ReflectionHelpers.callStaticMethod(android.animation.ValueAnimator.class, "setDurationScale",
                ReflectionHelpers.ClassParameter.from(float.class, 1f));
        }
    }

    @Test @Config(shadows = PaintWebView.class)
    public void backgroundFinishRendersTheCollapsedEndPose() throws Exception {
        openMorph(true);
        reveal();
        ImageButton back = ReflectionHelpers.getField(controller, "back");
        ImageView proxy = ReflectionHelpers.getField(controller, "proxy");
        assertTrue(collapse(card(), "background"));
        BreadMorphController morph = driver();
        for (int i = 0; i < 60 && morph.progress() > 0.45f; i++) BreadMorphControllerTest.frame();
        assertTrue(back.getAlpha() > 0);
        controller.foreground(false);
        assertFalse(morph.running());
        assertEquals("finishAtNearestEnd leaves the collapsed end pose", 0f, back.getAlpha(), 0f);
        assertEquals(View.VISIBLE, proxy.getVisibility());
    }

    static final class RecordingSnapshotter implements BreadSnapshotter {
        final List<Integer> capsule = new ArrayList<>();
        final List<Float> scale = new ArrayList<>();
        View back;
        View root;
        @Override public void capture(Window window, android.graphics.Rect rect, android.graphics.Bitmap into,
                                      java.util.function.IntConsumer done) {
            capsule.add(back.getVisibility());
            scale.add(root.getScaleX());
            done.accept(android.view.PixelCopy.SUCCESS);
        }
        @Override public void encode(Runnable work) {}
    }

    @Test @Config(shadows = PaintWebView.class)
    public void fullscreenCollapseCopiesACapsuleFreeFrameBeforeTheSpring() throws Exception {
        openMorph(true);
        reveal();
        ImageButton back = ReflectionHelpers.getField(controller, "back");
        RecordingSnapshotter recorder = new RecordingSnapshotter();
        recorder.back = back;
        recorder.root = root;
        ReflectionHelpers.setField(dialog, "snapshotter", recorder);
        assertTrue(collapse(card(), "capsule"));
        assertEquals("capture shows the capsule", View.INVISIBLE, back.getVisibility());
        assertFalse("the spring waits for the copy", driver().running());
        assertTrue(recorder.capsule.isEmpty());
        controller.render();
        assertEquals("a render during the wait keeps the capsule hidden", View.INVISIBLE, back.getVisibility());
        BreadMorphControllerTest.frame();
        assertEquals(List.of(View.INVISIBLE), recorder.capsule);
        assertEquals(1, recorder.scale.get(0), 0f);
        assertTrue(driver().running());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void collapseRetargetDuringTheWaitStillCopiesTheNextFrame() throws Exception {
        openMorph(true);
        reveal();
        ImageButton back = ReflectionHelpers.getField(controller, "back");
        RecordingSnapshotter recorder = new RecordingSnapshotter();
        recorder.back = back;
        recorder.root = root;
        ReflectionHelpers.setField(dialog, "snapshotter", recorder);
        assertTrue(collapse(card(), "first"));
        assertTrue(collapse(card(), "second"));
        assertTrue("a retarget in the wait does not copy before the capsule-free frame", recorder.capsule.isEmpty());
        BreadMorphControllerTest.frame();
        assertEquals(List.of(View.INVISIBLE), recorder.capsule);
        assertTrue(driver().running());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void parkDuringTheCollapseWaitCancelsTheCollapse() throws Exception {
        openMorph(true);
        reveal();
        assertTrue(collapse(card(), "queued"));
        controller.visibility(false, null, nextSequence());
        assertEquals(List.of("started:collapsed", "cancelled:collapsed"), phases("queued"));
    }

    @Test @Config(shadows = PaintWebView.class)
    public void finishDuringTheCollapseWaitParksAtTheCard() throws Exception {
        openMorph(true);
        reveal();
        BreadMorphCard card = card();
        assertTrue(collapse(card, "wait"));
        controller.foreground(false);
        assertEquals("finish during the collapse wait parks at the card", cardScale(card), root.getScaleX(), 1e-4f);
        assertEquals("no copy of a frame that still shows the capsule", 0, snapshots.captures.size());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void fullscreenSnapshotHidesTheCapsuleForOneFrame() throws Exception {
        openMorph(true);
        reveal();
        ImageButton back = ReflectionHelpers.getField(controller, "back");
        HeldSnapshotter held = new HeldSnapshotter();
        ReflectionHelpers.setField(dialog, "snapshotter", held);
        dialog.takeSnapshotData(0.5f, 0.7f, ignored -> {});
        assertEquals(View.INVISIBLE, back.getVisibility());
        assertTrue(held.pending.isEmpty());
        BreadMorphControllerTest.frame();
        assertEquals(1, held.pending.size());
        assertEquals(View.INVISIBLE, back.getVisibility());
        held.release();
        assertEquals("snapshot restore shows the capsule", View.VISIBLE, back.getVisibility());
        dialog.takeSnapshotData(0.5f, 0.7f, ignored -> {});
        BreadMorphControllerTest.frame();
        int epoch = ReflectionHelpers.<Integer>getField(controller, "captureEpoch");
        ReflectionHelpers.setField(controller, "captureEpoch", epoch + 1);
        held.release();
        assertEquals("a stale capture restores the snapshot capsule", View.VISIBLE, back.getVisibility());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void closeRestoresTheCapsuleAndCancelsTheQueuedCopy() throws Exception {
        openMorph(true);
        reveal();
        ImageButton back = ReflectionHelpers.getField(controller, "back");
        HeldSnapshotter held = new HeldSnapshotter();
        ReflectionHelpers.setField(dialog, "snapshotter", held);
        List<android.graphics.Bitmap> delivered = new ArrayList<>();
        controller.snapshot(delivered::add);
        assertEquals(View.INVISIBLE, back.getVisibility());
        controller.close();
        assertEquals("close restores the capsule", View.VISIBLE, back.getVisibility());
        BreadMorphControllerTest.frame();
        assertTrue("close restores the capsule", held.pending.isEmpty());
        assertEquals(1, delivered.size());
        assertNull(delivered.get(0));
    }

    @Test @Config(shadows = PaintWebView.class)
    public void restPoseShowsTheCapsuleAgain() throws Exception {
        openMorph(true);
        reveal();
        ImageButton back = ReflectionHelpers.getField(controller, "back");
        assertTrue(collapse(card(), "rest"));
        BreadMorphControllerTest.frame();
        BreadMorphControllerTest.settle();
        assertEquals(View.INVISIBLE, back.getVisibility());
        controller.visibility(false, null, nextSequence());
        assertEquals("rest pose shows the capsule", View.VISIBLE, back.getVisibility());
        assertEquals(1, back.getAlpha(), 0f);
    }

    @Test @Config(shadows = PaintWebView.class)
    public void captureSpanningAResizeAndBackIsNotTheProxy() throws Exception {
        open(true, true, "default");
        controller.state.configure("doc", false, true);
        acknowledgePolicy();
        assertTrue(controller.state.ready());
        WebView page = webView;
        morphFixture();
        page.layout(0, 0, root.getWidth(), root.getHeight());
        reveal();
        HeldSnapshotter held = new HeldSnapshotter();
        ReflectionHelpers.setField(dialog, "snapshotter", held);
        dialog.takeSnapshotData(0.5f, 0.7f, ignored -> {});
        assertEquals(1, held.pending.size());
        int resizes = ReflectionHelpers.<Integer>getField(controller, "resizeEpoch");
        resizePage(page, root.getWidth() + 40, root.getHeight());
        resizePage(page, root.getWidth(), root.getHeight());
        assertTrue("the page was resized", ReflectionHelpers.<Integer>getField(controller, "resizeEpoch") > resizes);
        held.release();
        assertFalse("a capture from before a resize is not the proxy", controller.state.proxyUsable());
    }

    // The hierarchy can lay the real page out at a zero size between frames, so drive the layout listener directly.
    private void resizePage(View page, int width, int height) {
        Object info = ReflectionHelpers.getField(page, "mListenerInfo");
        assertNotNull("the controller listens for page layout", info);
        List<View.OnLayoutChangeListener> listeners = ReflectionHelpers.getField(info, "mOnLayoutChangeListeners");
        assertFalse("the controller listens for page layout", listeners == null || listeners.isEmpty());
        for (View.OnLayoutChangeListener listener : new ArrayList<>(listeners)) {
            listener.onLayoutChange(page, 0, 0, width, height, 0, 0, 0, 0);
        }
    }

    @Test @Config(shadows = PaintWebView.class)
    public void captureOfAnUnpaintedPageIsNotTheProxy() throws Exception {
        openMorph(false);
        assertEquals(BreadPresentationState.Phase.PREPARING, controller.state.phase());
        assertTrue(collapse(card(), "unpainted"));
        assertEquals(1, snapshots.captures.size());
        assertFalse("proxy holds an unpainted frame", controller.state.proxyUsable());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void sizeChangeDropsTheParkedProxy() throws Exception {
        open(true, true, "default");
        controller.state.configure("doc", false, true);
        acknowledgePolicy();
        assertTrue(controller.state.ready());
        WebView page = webView;
        morphFixture();
        page.layout(0, 0, root.getWidth(), root.getHeight());
        reveal();
        park(card());
        assertTrue(controller.state.proxyUsable());
        resizePage(page, root.getWidth(), root.getHeight());
        resizePage(page, root.getWidth() + 40, root.getHeight());
        assertFalse("proxy holds a frame of the old size", controller.state.proxyUsable());
    }

    @Test @Config(shadows = PaintWebView.class)
    public void captureFinishingAfterASizeChangeIsNotTheProxy() throws Exception {
        open(true, true, "default");
        controller.state.configure("doc", false, true);
        acknowledgePolicy();
        assertTrue(controller.state.ready());
        WebView page = webView;
        morphFixture();
        page.layout(0, 0, root.getWidth(), root.getHeight());
        reveal();
        HeldSnapshotter held = new HeldSnapshotter();
        ReflectionHelpers.setField(dialog, "snapshotter", held);
        List<String> results = new ArrayList<>();
        dialog.takeSnapshotData(0.5f, 0.7f, results::add);
        assertEquals(1, held.pending.size());
        page.layout(0, 0, root.getWidth() + 40, root.getHeight());
        doReturn(root.getWidth() + 40).when(webView).getWidth();
        held.release();
        assertFalse("proxy holds a frame of the old size", controller.state.proxyUsable());
    }

    @Test @Config(sdk = 35, shadows = PaintWebView.class)
    public void breadButtonTouchDownBoostsUntilTheCollapseTakesItOver() throws Exception {
        openMorph(true);
        reveal();
        ImageButton capsule = ReflectionHelpers.getField(controller, "back");
        try {
            capsule.dispatchTouchEvent(android.view.MotionEvent.obtain(0, 0, android.view.MotionEvent.ACTION_DOWN, 10, 10, 0));
            assertTrue(BreadFrameBoost.active());
            assertFalse(driver().running());
            capsule.dispatchTouchEvent(android.view.MotionEvent.obtain(0, 5, android.view.MotionEvent.ACTION_CANCEL, 10, 10, 0));
            assertFalse(BreadFrameBoost.active());
            capsule.dispatchTouchEvent(android.view.MotionEvent.obtain(0, 10, android.view.MotionEvent.ACTION_DOWN, 10, 10, 0));
            assertTrue(BreadFrameBoost.active());
            capsule.performClick();
            BreadMorphControllerTest.frame();
            assertTrue(driver().running());
            assertFalse(BreadFrameBoost.active());
        } finally {
            BreadFrameBoost.release();
        }
    }

    @Test @Config(sdk = 35)
    public void prepareMorphBoostsTheHostWebView() throws Exception {
        InAppBrowserPlugin plugin = morphPlugin();
        com.getcapacitor.Bridge bridge = mock(com.getcapacitor.Bridge.class);
        WebView host = spy(new WebView(org.robolectric.RuntimeEnvironment.getApplication()));
        when(bridge.getWebView()).thenReturn(host);
        doReturn(bridge).when(plugin).getBridge();
        PluginCall call = mock(PluginCall.class);
        when(call.getInt("durationMs")).thenReturn(600);
        try {
            plugin.prepareMorph(call);
            verify(call).resolve();
            assertTrue(BreadFrameBoost.active());
            verify(host).setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_HIGH);
        } finally {
            BreadFrameBoost.release();
        }
    }

    @Test @Config(shadows = PaintWebView.class)
    public void snapshotResolvesAsynchronously() throws Exception {
        openMorph(false);
        reveal();
        WebViewRegistry.getShared().register("snapshot", dialog);
        InAppBrowserPlugin plugin = morphPlugin();
        PluginCall call = mock(PluginCall.class);
        when(call.getString("id")).thenReturn("snapshot");
        when(call.getFloat("scale")).thenReturn(0.5f);
        when(call.getFloat("quality")).thenReturn(0.7f);
        plugin.snapshot(call);
        assertEquals(1, snapshots.captures.size());
        verify(call, never()).resolve(any());
        snapshots.runEncodesOffTheMainThread();
        verify(call, never()).resolve(any());
        BreadMorphControllerTest.advance(32);
        org.mockito.ArgumentCaptor<JSObject> result = org.mockito.ArgumentCaptor.forClass(JSObject.class);
        verify(call).resolve(result.capture());
        assertTrue(result.getValue().getString("data").startsWith("data:image/jpeg;base64,"));
        verify(call, never()).reject(anyString());
    }
}
