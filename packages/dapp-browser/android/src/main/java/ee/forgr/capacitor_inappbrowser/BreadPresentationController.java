package ee.forgr.capacitor_inappbrowser;

import android.animation.ValueAnimator;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.Interpolator;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.ScriptHandler;
import androidx.webkit.Navigation;
import androidx.webkit.NavigationListener;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.caverock.androidsvg.SVG;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.util.Collections;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

@androidx.annotation.OptIn(markerClass = androidx.webkit.WebNavigationClient.ExperimentalNavigationCallback.class)
final class BreadPresentationController {
    private static final int FALLBACK = Color.rgb(22, 22, 22);
    private static final float CROSSFADE_PROGRESS = 0.35f;
    private static final long COLLAPSE_CROSSFADE_MS = 100;
    private static final long EXPAND_CROSSFADE_MS = 120;
    private static final Interpolator EASE_OUT = new DecelerateInterpolator();
    final BreadPresentationState state;
    private final WebViewDialog owner;
    private final WebView webView;
    private final Options.BreadPresentation options;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final FrameLayout overlay;
    private final FrameLayout cover;
    private final ImageButton back;
    private final TextView error;
    private final Button retry;
    private final ProgressBar spinner;
    private final ImageView proxy;
    private final BreadMorphController morph;
    private final ViewGroup container;
    private final int[] origin = new int[2];
    private final List<Consumer<Bitmap>> captureWaiters = new ArrayList<>();
    private String morphId;
    private long morphSequence;
    private boolean posed;
    private boolean proxyCovering;
    private boolean crossfaded;
    private boolean insetsDeferred;
    private boolean capturing;
    private int captureEpoch;
    private Bitmap proxyBitmap;
    private Bitmap capture;
    private ScriptHandler script;
    private boolean supported;
    private boolean installed;
    private long notifiedPolicyRevision = -1;
    private String documentToken;
    private NavigationListener navigationListener;
    private Navigation currentNavigation;
    private boolean committed;
    private long retryEpoch;
    private final List<JSONObject> pendingMessages = new ArrayList<>();
    private JSONObject configuration;
    private JSONObject readiness;
    private long pendingPaint = -1;
    private int layoutWidth;
    private int layoutHeight;
    private int controlTop;
    private int controlLeft;
    private Insets safeArea = Insets.NONE;
    private int theme = FALLBACK;
    private boolean appliedFullscreen;
    private final FullscreenRotation dialogRotation = new FullscreenRotation();
    private final FullscreenRotation hostRotation = new FullscreenRotation();
    // Resume insets can still describe the hidden fullscreen frame; keep the browser snapshot.
    private boolean browserPolicyCaptured;
    private int browserBarsBehavior;
    private int browserSystemUiVisibility;
    private int browserVisibleBars;
    private android.graphics.drawable.Drawable browserBackground;
    private final int browserAppBarVisibility;
    private final int browserStatusVisibility;
    private final int browserCutoutMode;
    private final androidx.coordinatorlayout.widget.CoordinatorLayout.Behavior browserBehavior;
    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            if (state.phase() == BreadPresentationState.Phase.CLOSED) return;
            BreadPresentationState.Phase previous = state.phase();
            state.tick(SystemClock.uptimeMillis());
            if (state.phase() != previous) render();
            handler.postDelayed(this, 200);
        }
    };

    BreadPresentationController(WebViewDialog owner, WebView webView, Options.BreadPresentation options, boolean initiallyVisible) {
        this.owner = owner;
        this.webView = webView;
        this.options = options;
        state = new BreadPresentationState(options.readinessTimeoutMs, initiallyVisible);
        browserAppBarVisibility = owner.findViewById(R.id.app_bar_layout).getVisibility();
        browserStatusVisibility = owner.findViewById(R.id.status_bar_color_view).getVisibility();
        browserCutoutMode = owner.getWindow().getAttributes().layoutInDisplayCutoutMode;
        browserBehavior = ((androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams)
            owner.findViewById(R.id.content_browser_layout).getLayoutParams()).getBehavior();
        overlay = new FrameLayout(owner.getContext());
        cover = new FrameLayout(owner.getContext());
        cover.setClickable(true);
        cover.setBackgroundColor(FALLBACK);
        overlay.addView(cover, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout message = new LinearLayout(owner.getContext());
        message.setOrientation(LinearLayout.VERTICAL);
        message.setGravity(Gravity.CENTER);
        message.setPadding(dp(24), dp(72), dp(24), dp(24));
        cover.addView(message, new FrameLayout.LayoutParams(-1, -1));
        spinner = new ProgressBar(owner.getContext());
        message.addView(spinner);
        error = new TextView(owner.getContext());
        error.setText(options.errorLabel);
        error.setTextSize(18);
        error.setGravity(Gravity.CENTER);
        error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        message.addView(error);
        retry = new Button(owner.getContext());
        retry.setText(options.retryLabel);
        retry.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            retryEpoch++;
            currentNavigation = null;
            committed = false;
            pendingMessages.clear();
            configuration = readiness = null;
            documentToken = null;
            navigate();
            if (supported) webView.reload();
        });
        LinearLayout.LayoutParams retryLayout = new LinearLayout.LayoutParams(-2, -2);
        retryLayout.topMargin = dp(16);
        message.addView(retry, retryLayout);
        back = new ImageButton(owner.getContext());
        back.setContentDescription(options.backLabel);
        back.setTooltipText(options.backLabel);
        back.setPadding(dp(14), dp(10), dp(14), dp(10));
        back.setScaleType(ImageView.ScaleType.FIT_CENTER);
        back.setOnClickListener(v -> {
            if (!state.effectiveVisibility() || owner.managedClosing()) return;
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            owner.presentationMinimizeRequested(state.policyRevision(), state.acknowledgedVisibilitySequence());
        });
        GradientDrawable capsule = new GradientDrawable();
        capsule.setColor(0xcc292929);
        capsule.setCornerRadius(dp(28));
        back.setBackground(capsule);
        try {
            SVG svg = SVG.getFromString(options.logoSvg);
            svg.setDocumentWidth(dp(48));
            svg.setDocumentHeight(dp(28));
            Bitmap bitmap = Bitmap.createBitmap(dp(48), dp(28), Bitmap.Config.ARGB_8888);
            svg.renderToCanvas(new Canvas(bitmap));
            back.setImageBitmap(bitmap);
        } catch (Exception ex) {
            // The supplied asset is trusted host data; keep an accessible exit if it is invalid.
            back.setImageResource(android.R.drawable.ic_menu_revert);
        }
        back.clearColorFilter();
        back.setImageTintList(null);
        overlay.addView(back, new FrameLayout.LayoutParams(dp(76), dp(48), Gravity.TOP | Gravity.START));
        ViewGroup root = owner.findViewById(R.id.coordinator_layout);
        root.addView(overlay, new ViewGroup.LayoutParams(-1, -1));
        container = root;
        proxy = new ImageView(owner.getContext());
        proxy.setScaleType(ImageView.ScaleType.MATRIX);
        proxy.setClickable(true);
        proxy.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        proxy.setVisibility(View.GONE);
        overlay.addView(proxy, 0, new FrameLayout.LayoutParams(-1, -1));
        morph = new BreadMorphController(root, new BreadMorphController.Listener() {
            @Override public void onFrame(float p) { morphFrame(p); }
            @Override public void onSettled(float end) { morphSettled(end); }
        });
        webView.addOnLayoutChangeListener((v, l, t, r, b, oldL, oldT, oldR, oldB) -> {
            int width = r - l, height = b - t;
            if (width != layoutWidth || height != layoutHeight) {
                layoutWidth = width;
                layoutHeight = height;
                finishMotion();
                invalidateLayout();
            }
        });
        ViewCompat.setOnApplyWindowInsetsListener(overlay, (view, insets) -> {
            Insets safe = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.systemBars());
            int top = safe.top + dp(8), left = safe.left + dp(8);
            if (!safe.equals(safeArea) || top != controlTop || left != controlLeft) {
                safeArea = safe;
                controlTop = top;
                controlLeft = left;
                positionControls();
                // A real change waits for the motion to land, then invalidates like any other.
                if (posed) insetsDeferred = true;
                else invalidateLayout();
            }
            return insets;
        });
        positionControls();
        navigate();
        handler.post(ticker);
    }

    void install() {
        installed = true;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                supported = true;
                if (WebViewFeature.isFeatureSupported(WebViewFeature.NAVIGATION_LISTENER_V1)) {
                    navigationListener = new NavigationListener() {
                        @Override public void onNavigationStarted(Navigation navigation) {
                            if (navigation.isSameDocument() || state.phase() == BreadPresentationState.Phase.CLOSED) return;
                            currentNavigation = navigation;
                            committed = false;
                            navigate();
                        }
                        @Override public void onNavigationCompleted(Navigation navigation) {
                            if (!navigation.equals(currentNavigation) || state.phase() == BreadPresentationState.Phase.CLOSED) return;
                            if (!navigation.didCommit() || navigation.didCommitErrorPage()) { failed(); return; }
                            committed = true;
                            List<JSONObject> messages = new ArrayList<>(pendingMessages);
                            pendingMessages.clear();
                            if (configuration != null) messages.add(configuration);
                            if (readiness != null) messages.add(readiness);
                            for (JSONObject message : messages) validate(message);
                        }
                    };
                    // Native navigation callbacks already run on the UI thread; do not queue authority changes.
                    WebViewCompat.addNavigationListener(webView, Runnable::run, navigationListener);
                }
                WebViewCompat.addWebMessageListener(webView, "breadPresentation", Collections.singleton("*"),
                    (view, message, origin, mainFrame, reply) -> {
                        // getData() throws for an ArrayBuffer, which any frame may post.
                        if (message.getType() == WebMessageCompat.TYPE_STRING) receive(message.getData(), mainFrame);
                    });
                script = WebViewCompat.addDocumentStartJavaScript(webView, options.script, Collections.singleton("*"));
                if (navigationListener == null) { state.browserFallback(); render(); }
                return;
            }
        }
        state.fail();
        render();
    }

    private void receive(String raw, boolean mainFrame) {
        if (!mainFrame || state.phase() == BreadPresentationState.Phase.CLOSED) return;
        try {
            JSONObject message = new JSONObject(raw);
            if (supported && navigationListener == null) {
                String type = message.optString("type");
                if ("configure".equals(type)) {
                    JSONObject update = new JSONObject().put("token", message.optString("token"))
                        .put("display", "browser").put("controlInsetTop", 0);
                    webView.evaluateJavascript("window.__breadPresentationUpdate(" + update + ")", null);
                    render();
                } else if ("ready".equals(type) || "close".equals(type)) {
                    JSONObject response = new JSONObject().put("token", message.optString("token"))
                        .put("requestId", message.optString("requestId")).put("ok", false)
                        .put("error", "Native presentation is unsupported in this WebView");
                    webView.evaluateJavascript("window.__breadPresentationRespond(" + response + ")", null);
                }
                return;
            }
            validate(message);
        } catch (Exception ignored) { }
    }

    private void validate(JSONObject message) {
        if (owner.managedClosing()) return;
        if (currentNavigation == null || state.phase() == BreadPresentationState.Phase.CLOSED) return;
        if (!committed) {
            if (!pendingMessages.contains(message)) pendingMessages.add(message);
            return;
        }
        String token = message.optString("token", "");
        long generation = state.navigationGeneration();
        long epoch = retryEpoch;
        webView.evaluateJavascript("window.__breadPresentationToken", result -> {
            if (owner.managedClosing() || epoch != retryEpoch || state.phase() == BreadPresentationState.Phase.CLOSED) return;
            if (generation != state.navigationGeneration()) {
                // Discard the old read; only a new read in this generation can grant authority.
                validate(message);
                return;
            }
            try {
                Object current = new JSONTokener(result).nextValue();
                if (!(current instanceof String) || !state.authorizes(true, token, (String) current, generation)) return;
                String type = message.optString("type");
                if (!"configure".equals(type) && !"ready".equals(type) && !"close".equals(type)) return;
                if (!token.equals(documentToken)) {
                    documentToken = token;
                    configuration = readiness = null;
                    navigate();
                }
                if ("configure".equals(type)) {
                    String display = message.optString("display");
                    if (!"browser".equals(display) && !"fullscreen".equals(display)) return;
                    configuration = message;
                    long previousPolicy = state.policyRevision();
                    state.configure(token, "fullscreen".equals(display), message.optBoolean("manualReady"));
                    applyTheme(message.optString("themeColor"));
                    if (previousPolicy != state.policyRevision()) cancelPaint();
                    applyReadiness();
                    render();
                } else if ("ready".equals(type)) {
                    readiness = message;
                    applyReadiness();
                    render();
                } else respond(message, owner::dismiss);
            } catch (Exception ignored) { }
        });
    }

    private void applyReadiness() {
        if (configuration == null || readiness == null) return;
        respond(readiness, state.ready(), null);
    }

    private void respond(JSONObject message, Runnable completion) {
        respond(message, true, completion);
    }

    private void respond(JSONObject message, boolean accepted, Runnable completion) {
        try {
            JSONObject response = new JSONObject().put("token", message.getString("token"))
                .put("requestId", message.getString("requestId")).put("ok", accepted);
            long generation = state.navigationGeneration();
            long epoch = retryEpoch;
            webView.evaluateJavascript("window.__breadPresentationRespond(" + response + ")", result -> {
                if (completion == null || epoch != retryEpoch) return;
                if (generation == state.navigationGeneration()) completion.run();
                else validate(message);
            });
        } catch (Exception ignored) { }
    }

    void navigationStarted() {
        // URL-only callbacks cannot pair overlapping or same-URL documents.
        if (!supported) navigate();
    }

    void navigate() {
        state.navigate(SystemClock.uptimeMillis());
        applyTheme(null);
        cancelPaint();
        if (installed && !supported) state.fail();
        if (installed) render();
        else renderCover();
    }

    void failed() { state.fail(); cancelPaint(); render(); }

    boolean morph(String to, BreadMorphCard card, float vx, float vy, String id, Integer revision, Integer sequence) {
        if (id == null || owner.managedClosing() || state.phase() == BreadPresentationState.Phase.CLOSED) return false;
        if ("collapsed".equals(to)) return collapse(card, vx, vy, id, sequence);
        if ("expanded".equals(to)) return expand(card, vx, vy, id, revision, sequence);
        return false;
    }

    private boolean collapse(BreadMorphCard card, float vx, float vy, String id, Integer sequence) {
        boolean flying = flying();
        if (!flying && (posed || !owner.isShowing() || !state.surfaceVisibility())) return false;
        if (container.getWidth() == 0 || container.getHeight() == 0) return false;
        if (!state.requestVisibility(true, null, sequence, SystemClock.uptimeMillis())) return false;
        if (!flying) container.getLocationInWindow(origin);
        BreadMorphCard landing = landing(card);
        beginFlight(BreadPresentationState.Motion.COLLAPSING, id, sequence);
        if (proxyCovering) {
            proxyCovering = false;
            crossfaded = true;
        }
        if (flying) emit("retargeted", 0, false);
        else {
            posed = true;
            webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            captureProxy();
            emit("started", 0, false);
        }
        morph.animateTo(0, landing, velocity(landing, vx, vy), BreadMorphPhysics.COLLAPSE);
        return true;
    }

    private boolean expand(BreadMorphCard card, float vx, float vy, String id, Integer revision, Integer sequence) {
        boolean flying = flying();
        if (!posed && owner.isShowing()) return false;
        boolean previous = state.effectiveVisibility();
        if (!state.requestVisibility(true, revision, sequence, SystemClock.uptimeMillis())) return false;
        if (!state.surfaceVisibility() || container.getWidth() == 0 || container.getHeight() == 0) {
            if (previous != state.effectiveVisibility()) cancelPaint();
            render();
            return false;
        }
        boolean resumed = posed;
        if (!resumed) container.getLocationInWindow(origin);
        BreadMorphCard landing = landing(card);
        beginFlight(BreadPresentationState.Motion.EXPANDING, id, sequence);
        if (resumed) {
            if (crossfaded) {
                crossfaded = false;
                // A page that never hid needs no fence; one invalidated in flight keeps the proxy until it paints.
                if (state.phase() == BreadPresentationState.Phase.VISIBLE) fadeProxyOut();
                else proxyCovering = true;
            }
            BreadMorphCard path = flying ? landing : morph.card();
            emit(flying ? "retargeted" : "started", 1, false);
            morph.animateTo(1, path, velocity(path, vx, vy), BreadMorphPhysics.EXPAND);
            return true;
        }
        posed = true;
        crossfaded = false;
        proxyCovering = state.proxyUsable() && proxyBitmap != null;
        morph.place(landing, 0);
        if (previous != state.effectiveVisibility()) cancelPaint();
        render();
        emit("started", 1, false);
        morph.animateTo(1, landing, velocity(landing, vx, vy), BreadMorphPhysics.EXPAND);
        return true;
    }

    private boolean flying() { return morph.running(); }

    private void beginFlight(BreadPresentationState.Motion motion, String id, Integer sequence) {
        state.beginMotion(motion);
        morphId = id;
        morphSequence = sequence == null ? state.acknowledgedVisibilitySequence() : sequence;
    }

    private BreadMorphCard landing(BreadMorphCard card) {
        if (card == null) return null;
        RectF rect = new RectF(card.rect);
        rect.offset(-origin[0], -origin[1]);
        boolean inside = rect.width() > 0 && rect.height() > 0 && rect.left >= -0.5f && rect.top >= -0.5f
            && rect.right <= container.getWidth() + 0.5f && rect.bottom <= container.getHeight() + 0.5f;
        return inside ? new BreadMorphCard(rect, Math.max(0, card.cornerRadius)) : null;
    }

    private float velocity(BreadMorphCard landing, float vx, float vy) {
        if (landing == null) return 0;
        return BreadMorphGeometry.progressVelocity(vx, vy, landing.rect, new RectF(0, 0, container.getWidth(), container.getHeight()));
    }

    private void emit(String phase, float target, boolean tracking) {
        BreadMorphEvent event = event(phase, target, tracking);
        if (event != null) owner.morphEvent(event);
    }

    private BreadMorphEvent event(String phase, float target, boolean tracking) {
        if (morphId == null) return null;
        return new BreadMorphEvent(morphId, phase, target >= 0.5f ? "expanded" : "collapsed", morph.progress(),
            morph.velocity(), tracking, morphSequence);
    }

    private void morphFrame(float p) {
        if (state.motion() == BreadPresentationState.Motion.COLLAPSING && !crossfaded && p <= CROSSFADE_PROGRESS
            && proxyBitmap != null && state.proxyUsable()) {
            crossfaded = true;
            proxy.animate().cancel();
            proxy.setVisibility(View.VISIBLE);
            if (ValueAnimator.areAnimatorsEnabled()) {
                proxy.setAlpha(0);
                proxy.animate().alpha(1).setDuration(COLLAPSE_CROSSFADE_MS).setInterpolator(EASE_OUT).start();
            } else proxy.setAlpha(1);
        }
    }

    private void morphSettled(float end) {
        state.endMotion();
        if (end >= 1) restPose();
        emit("settled", end, false);
        morphId = null;
    }

    private void finishMotion() { if (flying()) morph.finishAtNearestEnd(); }

    private void restPose() {
        if (!posed) return;
        posed = false;
        crossfaded = false;
        capture = null;
        morph.reset();
        if (!state.surfaceVisibility()) { insetsDeferred = false; return; }
        if (insetsDeferred) {
            insetsDeferred = false;
            invalidateLayout();
        } else render();
    }

    private boolean proxyRoute() {
        if (proxyCovering && (!state.proxyUsable() || proxyBitmap == null)) proxyCovering = false;
        return proxyCovering;
    }

    private void hideProxy() {
        proxyCovering = false;
        proxy.animate().cancel();
        proxy.setVisibility(View.GONE);
        proxy.setAlpha(0);
    }

    private void fadeProxyOut() {
        proxyCovering = false;
        proxy.animate().cancel();
        if (!ValueAnimator.areAnimatorsEnabled()) { hideProxy(); return; }
        proxy.animate().alpha(0).setDuration(EXPAND_CROSSFADE_MS).setInterpolator(EASE_OUT).withEndAction(() -> {
            if (!crossfaded && !proxyCovering) proxy.setVisibility(View.GONE);
        }).start();
    }

    void snapshot(Consumer<Bitmap> done) {
        if (capturing) { captureWaiters.add(done); return; }
        // In flight the window shows a scaled page, so only the capture the motion took at its start is the page.
        if (posed) { done.accept(capture); return; }
        captureWaiters.add(done);
        captureProxy();
    }

    private void captureProxy() {
        int epoch = ++captureEpoch;
        long navigation = state.navigationGeneration();
        Rect page = new Rect(0, 0, webView.getWidth(), webView.getHeight());
        container.offsetDescendantRectToMyCoords(webView, page);
        int dx = page.left - overlay.getLeft(), dy = page.top - overlay.getTop();
        capturing = true;
        owner.captureWebView(bitmap -> {
            if (epoch != captureEpoch) return;
            capturing = false;
            boolean current = bitmap != null && navigation == state.navigationGeneration()
                && state.phase() != BreadPresentationState.Phase.CLOSED;
            if (current) adopt(bitmap, dx, dy);
            List<Consumer<Bitmap>> waiters = new ArrayList<>(captureWaiters);
            captureWaiters.clear();
            for (Consumer<Bitmap> waiter : waiters) waiter.accept(current ? bitmap : null);
        });
    }

    private void adopt(Bitmap bitmap, int dx, int dy) {
        capture = bitmap;
        proxyBitmap = bitmap;
        state.captureProxy();
        Matrix matrix = new Matrix();
        matrix.setTranslate(dx, dy);
        proxy.setImageMatrix(matrix);
        proxy.setImageBitmap(bitmap);
        int epoch = captureEpoch;
        owner.hardwareCopy(bitmap, copy -> {
            if (epoch != captureEpoch || proxyBitmap != bitmap) return;
            proxyBitmap = copy;
            proxy.setImageBitmap(copy);
        });
    }

    void stopMotion() {
        morphId = null;
        finishMotion();
    }

    android.graphics.RectF morphPageRect() { return new android.graphics.RectF(); }
    boolean fullscreen() { return state.fullscreen(); }

    void visibility(boolean visible) { visibility(visible, null, null); }

    void visibility(boolean visible, Integer policyRevision, Integer sequence) {
        boolean previous = state.effectiveVisibility();
        BreadMorphEvent cancelled = flying() ? event("cancelled", morph.target(), false) : null;
        if (!state.requestVisibility(visible, policyRevision, sequence, SystemClock.uptimeMillis())) return;
        if (!visible) {
            morphId = null;
            hideProxy();
        }
        if (previous != state.effectiveVisibility()) cancelPaint();
        render();
        if (visible) return;
        // The window is already hidden, so leaving the pose shows no frame of the page at rest.
        restPose();
        if (cancelled != null) owner.morphEvent(cancelled);
    }

    void foreground(boolean foreground) {
        if (!foreground) finishMotion();
        state.foreground(foreground, SystemClock.uptimeMillis());
        cancelPaint();
        render();
    }

    private void invalidateLayout() {
        state.layoutChanged();
        cancelPaint();
        render();
    }

    private void cancelPaint() {
        pendingPaint = -1;
        cover.animate().cancel();
        cover.setAlpha(1);
        if (proxyRoute()) {
            proxy.animate().cancel();
            proxy.setAlpha(1);
        }
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    }

    void close() {
        morphId = null;
        morph.reset();
        posed = false;
        crossfaded = false;
        capture = null;
        proxyBitmap = null;
        hideProxy();
        captureEpoch++;
        capturing = false;
        List<Consumer<Bitmap>> waiters = new ArrayList<>(captureWaiters);
        captureWaiters.clear();
        for (Consumer<Bitmap> waiter : waiters) waiter.accept(null);
        restoreWindow();
        state.close();
        cancelPaint();
        handler.removeCallbacksAndMessages(null);
        pendingMessages.clear();
        if (navigationListener != null && WebViewFeature.isFeatureSupported(WebViewFeature.NAVIGATION_LISTENER_V1)) {
            WebViewCompat.removeNavigationListener(webView, navigationListener);
        }
        if (script != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) script.remove();
        if (supported && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(webView, "breadPresentation");
        }
    }

    void applyWindow() {
        if (owner.managedClosing()) return;
        if (!state.surfaceVisibility()) return;
        Window window = owner.getWindow();
        if (window == null) return;
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        if (fullscreen()) {
            if (supported && navigationListener != null) {
                dialogRotation.acquire(window);
                hostRotation.acquire(owner.activity == null ? null : owner.activity.getWindow());
            }
            if (!browserPolicyCaptured) {
                browserBarsBehavior = controller.getSystemBarsBehavior();
                browserSystemUiVisibility = window.getDecorView().getSystemUiVisibility();
                browserBackground = window.getDecorView().getBackground();
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(window.getDecorView());
                browserVisibleBars = 0;
                if (insets == null || insets.isVisible(WindowInsetsCompat.Type.statusBars())) {
                    browserVisibleBars |= WindowInsetsCompat.Type.statusBars();
                }
                if (insets == null || insets.isVisible(WindowInsetsCompat.Type.navigationBars())) {
                    browserVisibleBars |= WindowInsetsCompat.Type.navigationBars();
                }
                browserPolicyCaptured = true;
            }
            appliedFullscreen = true;
            WindowManager.LayoutParams params = window.getAttributes();
            params.width = params.height = WindowManager.LayoutParams.MATCH_PARENT;
            params.x = params.y = 0;
            params.gravity = Gravity.TOP | Gravity.START;
            params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(params);
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.setBackgroundDrawableResource(android.R.color.black);
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
            owner.findViewById(R.id.status_bar_color_view).setVisibility(View.GONE);
            owner.findViewById(R.id.app_bar_layout).setVisibility(View.GONE);
            View content = owner.findViewById(R.id.content_browser_layout);
            androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams lp =
                (androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams) content.getLayoutParams();
            lp.setBehavior(null);
            lp.width = lp.height = -1;
            lp.setMargins(0, 0, 0, 0);
            content.setLayoutParams(lp);
        } else {
            restoreWindow();
            browserPolicyCaptured = false;
            owner.applyBrowserDimensions();
        }
        ViewCompat.requestApplyInsets(webView);
    }

    private void restoreWindow() {
        dialogRotation.release();
        hostRotation.release();
        if (!appliedFullscreen) return;
        appliedFullscreen = false;
        Window window = owner.getWindow();
        owner.findViewById(R.id.app_bar_layout).setVisibility(browserAppBarVisibility);
        owner.findViewById(R.id.status_bar_color_view).setVisibility(browserStatusVisibility);
        View content = owner.findViewById(R.id.content_browser_layout);
        androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams lp =
            (androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams) content.getLayoutParams();
        lp.setBehavior(browserBehavior);
        content.setLayoutParams(lp);
        WindowManager.LayoutParams params = window.getAttributes();
        params.layoutInDisplayCutoutMode = browserCutoutMode;
        window.setAttributes(params);
        WindowCompat.setDecorFitsSystemWindows(window, owner.browserDecorFitsSystemWindows());
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setSystemBarsBehavior(browserBarsBehavior);
        controller.show(browserVisibleBars);
        controller.hide(WindowInsetsCompat.Type.systemBars() & ~browserVisibleBars);
        window.getDecorView().setSystemUiVisibility(browserSystemUiVisibility);
        window.setBackgroundDrawable(browserBackground);
        ViewCompat.requestApplyInsets(webView);
    }

    private void renderCover() {
        boolean failed = state.phase() == BreadPresentationState.Phase.ERROR;
        if (!failed && proxyRoute()) {
            proxy.setVisibility(View.VISIBLE);
            cover.setVisibility(View.GONE);
        } else {
            if (!crossfaded) hideProxy();
            cover.setVisibility(View.VISIBLE);
        }
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        error.setVisibility(failed ? View.VISIBLE : View.GONE);
        retry.setVisibility(failed ? View.VISIBLE : View.GONE);
        retry.setEnabled(supported);
        spinner.setVisibility(failed ? View.GONE : View.VISIBLE);
        back.setVisibility(View.VISIBLE);
    }

    void render() {
        if (owner.managedClosing()) return;
        if (state.phase() == BreadPresentationState.Phase.CLOSED) return;
        if (notifiedPolicyRevision != state.policyRevision()) {
            notifiedPolicyRevision = state.policyRevision();
            owner.presentationChanged(state.fullscreen(), state.policyResolved(), state.policyRevision());
        }
        if (!state.surfaceVisibility()) {
            owner.applyPresentationVisibility(false);
            restoreWindow();
            renderCover();
            return;
        }
        applyWindow();
        owner.applyPresentationVisibility(true);
        if (supported && navigationListener == null) {
            overlay.setVisibility(View.GONE);
            webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            return;
        }
        renderCover();
        if (state.phase() == BreadPresentationState.Phase.VISIBLE) {
            cover.setVisibility(View.GONE);
            webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            back.setVisibility(fullscreen() ? View.VISIBLE : View.GONE);
            return;
        }
        long generation = state.generation();
        if (!state.canReveal(generation) || pendingPaint == generation || webView.getWidth() == 0 || webView.getHeight() == 0) return;
        pendingPaint = generation;
        // Update CSS only after the WebView has its final native dimensions, then fence its paint.
        webView.post(() -> {
            if (!state.canReveal(generation)) return;
            String update = metricUpdate();
            if (update == null) { pendingPaint = -1; return; }
            webView.evaluateJavascript(update, result -> {
                if (!"true".equals(result) || !state.canReveal(generation)) return;
                webView.postVisualStateCallback(generation, new WebView.VisualStateCallback() {
                    @Override public void onComplete(long requestId) {
                        if (state.canReveal(requestId)) reveal(requestId);
                    }
                });
            });
        });
    }

    private String metricUpdate() {
        if (state.token() == null || webView.getWidth() == 0) return null;
        int[] controlPosition = new int[2], webPosition = new int[2];
        back.getLocationInWindow(controlPosition);
        webView.getLocationInWindow(webPosition);
        boolean fullscreen = fullscreen();
        try {
            JSONObject bounds = new JSONObject().put("left", Math.max(0, controlPosition[0] - webPosition[0]))
                .put("top", Math.max(0, controlPosition[1] - webPosition[1]))
                .put("width", back.getWidth()).put("height", back.getHeight());
            JSONObject safe = new JSONObject().put("top", safeArea.top).put("left", safeArea.left)
                .put("right", safeArea.right).put("bottom", safeArea.bottom);
            JSONObject metrics = new JSONObject().put("token", state.token()).put("revision", state.generation())
                .put("display", fullscreen ? "fullscreen" : "browser").put("width", webView.getWidth())
                .put("inset", fullscreen ? bounds.getInt("top") + back.getHeight() + dp(8) : 0)
                .put("controlBounds", fullscreen ? bounds : JSONObject.NULL)
                .put("safeAreaInsets", fullscreen ? safe : JSONObject.NULL);
            return "(()=>{const metrics=" + metrics + ";" + METRIC_SCRIPT + "})()";
        } catch (org.json.JSONException ignored) { return null; }
    }

    static final String METRIC_SCRIPT = """
        if (window.__breadPresentationToken !== metrics.token) return false;
        const previous = window.__breadNativeMetrics;
        if (previous?.token === metrics.token && previous.revision > metrics.revision) return false;
        window.__breadNativeMetrics = metrics;
        if (!window.__breadReprojectMetrics) {
            window.__breadReprojectMetrics = () => {
                const current = window.__breadNativeMetrics;
                if (!current || window.__breadPresentationToken !== current.token) return;
                const scale = innerWidth / current.width;
                const project = value => value && Object.fromEntries(Object.entries(value).map(([key, value]) => [key, value * scale]));
                const update = {token: current.token, display: current.display, controlInsetTop: current.inset * scale,
                    controlBounds: project(current.controlBounds), safeAreaInsets: project(current.safeAreaInsets)};
                const key = JSON.stringify(update);
                if (current.projectedKey === key) return;
                current.projectedKey = key;
                window.__breadPresentationUpdate(update);
            };
            addEventListener('resize', window.__breadReprojectMetrics);
            if (window.visualViewport) visualViewport.addEventListener('resize', window.__breadReprojectMetrics);
        }
        window.__breadReprojectMetrics();
        return true;
        """;

    private void reveal(long generation) {
        applyWindow();
        if (!state.canReveal(generation)) return;
        state.painted(generation);
        pendingPaint = -1;
        back.setVisibility(fullscreen() ? View.VISIBLE : View.GONE);
        if (!ValueAnimator.areAnimatorsEnabled()) finishReveal(generation);
        else if (proxyRoute()) {
            proxy.animate().alpha(0).setDuration(EXPAND_CROSSFADE_MS).setInterpolator(EASE_OUT)
                .withEndAction(() -> finishReveal(generation)).start();
        } else {
            cover.animate().alpha(0).setDuration(160).withEndAction(() -> {
                finishReveal(generation);
            }).start();
        }
    }

    private void finishReveal(long generation) {
        if (!state.canReveal(generation)) return;
        cover.setVisibility(View.GONE);
        if (!crossfaded) hideProxy();
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
    }

    private void applyTheme(String color) {
        theme = FALLBACK;
        if (color != null && color.matches("#[0-9a-fA-F]{6}")) theme = Color.parseColor(color);
        cover.setBackgroundColor(theme);
        double luminance = Color.red(theme) * .299 + Color.green(theme) * .587 + Color.blue(theme) * .114;
        error.setTextColor(luminance > 160 ? Color.BLACK : Color.WHITE);
    }

    private void positionControls() {
        FrameLayout.LayoutParams button = (FrameLayout.LayoutParams) back.getLayoutParams();
        button.topMargin = controlTop;
        button.leftMargin = controlLeft;
        back.setLayoutParams(button);
    }

    private int dp(int value) { return Math.round(value * owner.getContext().getResources().getDisplayMetrics().density); }
}
