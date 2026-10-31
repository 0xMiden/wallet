package ee.forgr.capacitor_inappbrowser;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ObjectAnimator;
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
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
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
    static final int TOUCH_PASS = 0, TOUCH_CONSUME = 1, TOUCH_CANCEL = 2;
    private static final float COMMIT_TRAVEL = 0.30f;
    private static final float PROJECTION_SECONDS = 0.30f;
    private static final float FLICK_DP_PER_SECOND = 450;
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
    private int resizeEpoch;
    private int snapshotHoldEpoch = -1;
    private int savedBackVisibility = View.VISIBLE;
    private boolean capsuleHeld;
    private Runnable collapseFlight;
    private Runnable snapshotFlight;
    private BreadMorphCard collapseLanding;
    private float collapseVelocity;
    private Bitmap proxyBitmap;
    private Bitmap capture;
    private ValueAnimator proxyFade;
    private VelocityTracker tracker;
    private boolean owned;
    private boolean released;
    private boolean cancelledForPage;
    private boolean capsuleGestureOwned;
    private boolean onPage;
    private boolean moved;
    private boolean tracking;
    private boolean capsuleTouchDown;
    private boolean capsuleTouchRejected;
    private boolean capsuleTracking;
    private boolean capsuleReducedMotion;
    private boolean interactiveCollapse;
    private boolean backPreview;
    private float downX;
    private float downY;
    private long downTime;
    private float capsuleDownX;
    private float capsuleDownY;
    private float grabX;
    private float grabY;
    private float grabStart;
    private float grabTarget;
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
            requestAcceptedMinimize();
        });
        back.setOnTouchListener(this::handleCapsuleTouch);
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
                boolean resized = layoutWidth != 0 && layoutHeight != 0;
                layoutWidth = width;
                layoutHeight = height;
                finishMotion();
                if (resized) {
                    // The proxy is a frame of the old size; the next expand must not show it.
                    resizeEpoch++;
                    proxyBitmap = null;
                    state.dropProxy();
                    hideProxy();
                }
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
        cancelInteractiveInput();
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
        float speed = velocity(landing, vx, vy);
        endTracking();
        boolean waiting = collapseFlight != null;
        cancelSnapshotFlight();
        beginFlight(BreadPresentationState.Motion.COLLAPSING, id, sequence);
        headTo(0);
        if (flying) {
            emit("retargeted", 0, false);
            if (waiting) {
                // The queued runnable still copies the capsule-free frame first, then moves toward this landing.
                collapseLanding = landing;
                collapseVelocity = speed;
                return true;
            }
        } else {
            posed = true;
            webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            if (fullscreen()) {
                applyWindow();
                emit("started", 0, false);
                postCollapse(landing, speed);
                return true;
            }
            captureProxy();
            emit("started", 0, false);
        }
        morph.animateTo(0, landing, speed, BreadMorphPhysics.COLLAPSE);
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
        endTracking();
        cancelCollapseFlight();
        beginFlight(BreadPresentationState.Motion.EXPANDING, id, sequence);
        if (resumed) {
            headTo(1);
            BreadMorphCard path = flying ? landing : morph.card();
            emit(flying ? "retargeted" : "started", 1, false);
            morph.animateTo(1, path, velocity(path, vx, vy), BreadMorphPhysics.EXPAND);
            return true;
        }
        posed = true;
        crossfaded = false;
        proxyCovering = state.proxyUsable() && proxyBitmap != null;
        morph.place(landing, 0);
        morphFrame(0);
        if (previous != state.effectiveVisibility()) cancelPaint();
        render();
        emit("started", 1, false);
        morph.animateTo(1, landing, velocity(landing, vx, vy), BreadMorphPhysics.EXPAND);
        return true;
    }

    private boolean flying() { return morph.running() || tracking || collapseFlight != null; }

    private boolean activeExpansion() {
        return flying() && morphId != null && state.motion() == BreadPresentationState.Motion.EXPANDING;
    }

    private void headTo(float end) {
        state.beginMotion(end >= 0.5f ? BreadPresentationState.Motion.EXPANDING : BreadPresentationState.Motion.COLLAPSING);
        if (end < 0.5f) {
            if (fullscreen() && !interactiveCollapse) holdBack(true);
        } else releaseBack();
        if (end < 0.5f && proxyCovering) {
            proxyCovering = false;
            crossfaded = true;
        } else if (end >= 0.5f && crossfaded) {
            crossfaded = false;
            // A page that never hid needs no fence; one invalidated in flight keeps the proxy until it paints.
            if (state.phase() == BreadPresentationState.Phase.VISIBLE) fadeProxyOut();
            else proxyCovering = true;
        }
    }

    private void holdBack(boolean collapse) {
        if (!capsuleHeld) savedBackVisibility = back.getVisibility();
        capsuleHeld = true;
        if (collapse) snapshotHoldEpoch = -1;
        back.setVisibility(View.INVISIBLE);
    }

    private void releaseBack() {
        if (!capsuleHeld) return;
        capsuleHeld = false;
        snapshotHoldEpoch = -1;
        back.setVisibility(savedBackVisibility);
    }

    private void showBack(int visibility) {
        back.setVisibility(capsuleHeld ? View.INVISIBLE : visibility);
    }

    private void postCollapse(BreadMorphCard landing, float velocity) {
        collapseLanding = landing;
        collapseVelocity = velocity;
        collapseFlight = () -> {
            if (collapseFlight == null) return;
            collapseFlight = null;
            captureProxy();
            morph.animateTo(0, collapseLanding, collapseVelocity, BreadMorphPhysics.COLLAPSE);
        };
        container.post(collapseFlight);
    }

    private void cancelCollapseFlight() {
        if (collapseFlight == null) return;
        container.removeCallbacks(collapseFlight);
        collapseFlight = null;
    }

    private void cancelSnapshotFlight() {
        if (snapshotFlight == null) return;
        container.removeCallbacks(snapshotFlight);
        snapshotFlight = null;
        if (capturing || captureWaiters.isEmpty()) return;
        List<Consumer<Bitmap>> waiters = new ArrayList<>(captureWaiters);
        captureWaiters.clear();
        for (Consumer<Bitmap> waiter : waiters) waiter.accept(null);
    }

    private void cancelPostedCaptures() {
        cancelCollapseFlight();
        cancelSnapshotFlight();
    }

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

    private void emit(String phase, float target, boolean tracking) { emit(phase, target, tracking, morph.velocity()); }

    private void emit(String phase, float target, boolean tracking, float velocity) {
        BreadMorphEvent event = event(phase, target, tracking, velocity);
        if (event != null) owner.morphEvent(event);
    }

    private BreadMorphEvent event(String phase, float target, boolean tracking, float velocity) {
        if (morphId == null) return null;
        return new BreadMorphEvent(morphId, phase, target >= 0.5f ? "expanded" : "collapsed", morph.progress(),
            velocity, tracking, morphSequence);
    }

    private String nativeCollapse() {
        boolean expansion = activeExpansion();
        // A posed page that is not expanding already has its id, null once that flight has settled.
        if (posed && !expansion) return morphId;
        BreadMorphCard host = WebViewRegistry.getShared().morphCard();
        String id = expansion ? morphId : "native-" + java.util.UUID.randomUUID();
        return collapse(host == null ? null : owner.hostCardToWindow(host), 0, 0, id, null) ? id : null;
    }

    private void morphFrame(float p) {
        if (fullscreen()) back.setAlpha(Math.max(0f, Math.min(1f, p)));
        boolean collapseEnd = state.motion() == BreadPresentationState.Motion.COLLAPSING
            || (posed && state.motion() == BreadPresentationState.Motion.NONE && p <= CROSSFADE_PROGRESS);
        if (collapseEnd && !crossfaded && p <= CROSSFADE_PROGRESS && proxyBitmap != null && state.proxyUsable()) {
            crossfaded = true;
            proxy.setVisibility(View.VISIBLE);
            proxy.setAlpha(0f);
            fadeProxy(1, COLLAPSE_CROSSFADE_MS, null);
        }
    }

    private void morphSettled(float end) {
        morphFrame(end);
        state.endMotion();
        if (end >= 1) restPose();
        emit("settled", end, false);
        morphId = null;
    }

    private void finishMotion() {
        if (!flying()) return;
        endTracking();
        if (collapseFlight != null && !morph.running()) {
            BreadMorphCard landing = collapseLanding;
            cancelCollapseFlight();
            // No capsule-free frame has been drawn yet, so this park keeps no copy rather than one with the capsule.
            morph.place(landing, 0);
            morph.finishAtNearestEnd();
            return;
        }
        morph.finishAtNearestEnd();
    }

    private void restPose() {
        cancelPostedCaptures();
        if (!posed) {
            releaseBack();
            return;
        }
        endTracking();
        releaseBack();
        posed = false;
        crossfaded = false;
        capture = null;
        morph.reset();
        back.setAlpha(1f);
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
        cancelProxyFade();
        proxy.setVisibility(View.GONE);
        proxy.setAlpha(0f);
    }

    private void fadeProxyOut() {
        proxyCovering = false;
        fadeProxy(0, EXPAND_CROSSFADE_MS, () -> {
            if (!crossfaded && !proxyCovering) proxy.setVisibility(View.GONE);
        });
    }

    private void fadeProxy(float to, long duration, Runnable done) {
        cancelProxyFade();
        if (!ValueAnimator.areAnimatorsEnabled()) {
            proxy.setAlpha(to);
            if (done != null) done.run();
            return;
        }
        ObjectAnimator fade = ObjectAnimator.ofFloat(proxy, View.ALPHA, proxy.getAlpha(), to);
        fade.setDuration(duration);
        fade.setInterpolator(EASE_OUT);
        fade.addListener(new AnimatorListenerAdapter() {
            private boolean cancelled;
            @Override public void onAnimationCancel(Animator animation) { cancelled = true; }
            @Override public void onAnimationEnd(Animator animation) {
                if (proxyFade == animation) proxyFade = null;
                if (!cancelled && done != null) done.run();
            }
        });
        proxyFade = fade;
        fade.start();
    }

    private void cancelProxyFade() {
        ValueAnimator fade = proxyFade;
        proxyFade = null;
        if (fade != null) fade.cancel();
    }

    void snapshot(Consumer<Bitmap> done) {
        if (capturing) { captureWaiters.add(done); return; }
        // In flight the window shows a scaled page, so only the capture the motion took at its start is the page.
        if (posed) { done.accept(capture); return; }
        captureWaiters.add(done);
        if (snapshotFlight != null) return;
        if (fullscreen() && back.getVisibility() == View.VISIBLE) {
            holdBack(false);
            snapshotFlight = () -> {
                if (snapshotFlight == null) return;
                snapshotFlight = null;
                captureProxy(true);
            };
            container.post(snapshotFlight);
            return;
        }
        captureProxy();
    }

    private void captureProxy() { captureProxy(false); }

    private void captureProxy(boolean snapshotOwner) {
        int epoch = ++captureEpoch;
        int sizeEpoch = resizeEpoch;
        if (snapshotOwner) snapshotHoldEpoch = epoch;
        long navigation = state.navigationGeneration();
        Rect page = new Rect(0, 0, webView.getWidth(), webView.getHeight());
        container.offsetDescendantRectToMyCoords(webView, page);
        int dx = page.left - overlay.getLeft(), dy = page.top - overlay.getTop();
        boolean painted = state.phase() == BreadPresentationState.Phase.VISIBLE;
        capturing = true;
        owner.captureWebView(bitmap -> {
            if (epoch == snapshotHoldEpoch) releaseBack();
            if (epoch != captureEpoch) return;
            capturing = false;
            boolean current = bitmap != null && navigation == state.navigationGeneration()
                && state.phase() != BreadPresentationState.Phase.CLOSED;
            // A covered page, a resized WebView, or a size that changed and changed back is not the page.
            boolean sameSize = bitmap != null && bitmap.getWidth() == webView.getWidth() && bitmap.getHeight() == webView.getHeight();
            if (current && painted && sameSize && sizeEpoch == resizeEpoch) adopt(bitmap, dx, dy);
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
        if (posed) morphFrame(morph.progress());
    }

    void stopMotion() {
        morphId = null;
        finishMotion();
    }

    RectF morphPageRect() {
        int[] at = new int[2];
        container.getLocationInWindow(at);
        float scale = container.getScaleX();
        float height = BreadMorphGeometry.pose(morph.progress(), morph.card(), container.getWidth(), container.getHeight()).cropHeight;
        return new RectF(at[0], at[1], at[0] + scale * container.getWidth(), at[1] + scale * height);
    }

    // The dialog routes every touch here first: the posed page owns a gesture that starts on it, and a
    // gesture the page already had when a motion began is cancelled for it, then swallowed.
    private boolean handleCapsuleTouch(View view, MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            capsuleTouchDown = true;
            capsuleTouchRejected = false;
            capsuleReducedMotion = false;
            capsuleDownX = event.getX();
            capsuleDownY = event.getY();
            if (tracker == null) tracker = VelocityTracker.obtain();
            tracker.clear();
            tracker.addMovement(event);
            BreadFrameBoost.hold(view, BreadFrameBoost.DURATION_MS);
            return false;
        }
        if (!capsuleTouchDown) return false;
        if (action == MotionEvent.ACTION_MOVE) {
            if (tracker != null) tracker.addMovement(event);
            if (owner.managedClosing() || state.phase() == BreadPresentationState.Phase.CLOSED) {
                if (capsuleTracking) cancelInteractiveCollapse();
                capsuleTracking = false;
                capsuleReducedMotion = false;
                capsuleTouchRejected = true;
                view.setPressed(false);
                return true;
            }
            if (capsuleTouchRejected) return true;
            if (!capsuleTracking) {
                float dx = event.getX() - capsuleDownX, dy = event.getY() - capsuleDownY;
                float slop = ViewConfiguration.get(owner.getContext()).getScaledTouchSlop();
                if (Math.hypot(dx, dy) < slop) return false;
                if (dy <= 0 || dy <= Math.abs(dx)) {
                    capsuleTouchRejected = true;
                    view.setPressed(false);
                    return true;
                }
                if (!ValueAnimator.areAnimatorsEnabled()) {
                    capsuleReducedMotion = true;
                    grabStart = 1;
                    grabTarget = 1;
                    grabX = capsuleDownX;
                    grabY = capsuleDownY;
                } else if (!beginInteractiveCollapse(capsuleDownX, capsuleDownY)) {
                    capsuleTouchRejected = true;
                    view.setPressed(false);
                    return true;
                }
                capsuleTracking = true;
                view.setPressed(false);
                view.cancelLongPress();
            }
            if (capsuleTouchRejected) return true;
            if (!capsuleReducedMotion) dragCapsule(event.getY());
            return true;
        }
        if (action == MotionEvent.ACTION_UP) {
            if (!capsuleTracking) {
                boolean consumed = capsuleTouchRejected;
                finishCapsuleTouch(view, consumed);
                return consumed;
            }
            if (owner.managedClosing() || state.phase() == BreadPresentationState.Phase.CLOSED) {
                cancelInteractiveCollapse();
                finishCapsuleTouch(view, true);
                return true;
            }
            if (tracker != null) tracker.addMovement(event);
            float end;
            if (capsuleReducedMotion) {
                tracker.computeCurrentVelocity(1000);
                end = releaseEnd(capsuleProgress(event.getY()), capsuleProgressVelocity(tracker.getYVelocity()));
                if (end < 0.5f) minimizeFromBackWithoutPreview();
            } else {
                String collapseId = morphId;
                end = release(true);
                if (end < 0.5f) requestNativeMinimize(collapseId);
            }
            capsuleTracking = false;
            finishCapsuleTouch(view, true);
            return true;
        }
        if (action == MotionEvent.ACTION_CANCEL) {
            boolean consumed = capsuleTracking || capsuleTouchRejected;
            if (capsuleTracking) {
                capsuleTracking = false;
                cancelInteractiveCollapse();
            }
            finishCapsuleTouch(view, consumed);
            return consumed;
        }
        return capsuleTracking;
    }

    private void finishCapsuleTouch(View view, boolean consumed) {
        capsuleTouchDown = false;
        capsuleTouchRejected = false;
        capsuleTracking = false;
        capsuleReducedMotion = false;
        if (consumed) view.setPressed(false);
        BreadFrameBoost.release();
    }

    private boolean beginInteractiveCollapse(float x, float y) {
        if (owner.managedClosing() || !owner.isShowing() || !state.effectiveVisibility()
            || state.phase() != BreadPresentationState.Phase.VISIBLE || posed || flying()) return false;
        container.getLocationInWindow(origin);
        BreadMorphCard host = WebViewRegistry.getShared().morphCard();
        BreadMorphCard nativeCard = host == null ? null : owner.hostCardToWindow(host);
        BreadMorphCard landing = landing(nativeCard);
        String id = "native-" + java.util.UUID.randomUUID();
        interactiveCollapse = true;
        if (!collapse(nativeCard, 0, 0, id, null)) {
            interactiveCollapse = false;
            return false;
        }
        cancelCollapseFlight();
        morph.prepareTracking(landing, 1, 0);
        if (fullscreen()) captureProxy();
        tracking = true;
        released = false;
        grabStart = 1;
        grabTarget = 1;
        grabX = x;
        grabY = y;
        emit("retargeted", 0, true, 0);
        return true;
    }

    private void dragCapsule(float y) {
        morph.track(capsuleProgress(y));
    }

    private float capsuleProgress(float y) {
        float progress = grabStart - (y - grabY) / capsuleCollapseDistance();
        if (progress > 1) return 1 + BreadMorphGeometry.rubberBand(progress - 1, 1);
        if (progress < 0) return BreadMorphGeometry.rubberBand(progress, 1);
        return progress;
    }

    private float capsuleCollapseDistance() {
        BreadMorphCard target = morph.card();
        if (target == null) {
            container.getLocationInWindow(origin);
            BreadMorphCard host = WebViewRegistry.getShared().morphCard();
            target = landing(host == null ? null : owner.hostCardToWindow(host));
        }
        if (target == null) return dp(300);
        float dx = container.getWidth() / 2f - target.rect.centerX();
        float dy = container.getHeight() / 2f - target.rect.centerY();
        return Math.max(dp(180), (float) Math.hypot(dx, dy));
    }

    boolean beginBackPreview() {
        if (backPreview || !ValueAnimator.areAnimatorsEnabled()) return false;
        if (!beginInteractiveCollapse(0, 0)) return false;
        backPreview = true;
        return true;
    }

    void progressBackPreview(float progress) {
        if (!backPreview || !tracking || !Float.isFinite(progress)) return;
        morph.track(1 - Math.max(0, Math.min(1, progress)));
    }

    void cancelBackPreview() {
        if (!backPreview) return;
        backPreview = false;
        cancelInteractiveCollapse();
    }

    void commitBackPreview() {
        if (owner.managedClosing() || state.phase() == BreadPresentationState.Phase.CLOSED) return;
        if (backPreview && tracking) {
            String collapseId = morphId;
            backPreview = false;
            commitInteractiveCollapse();
            requestNativeMinimize(collapseId);
            return;
        }
        if (!owner.isShowing() || !state.effectiveVisibility()
            || state.phase() != BreadPresentationState.Phase.VISIBLE) return;
        requestAcceptedMinimize();
    }

    void minimizeFromBackWithoutPreview() {
        if (owner.managedClosing() || !owner.isShowing() || !state.effectiveVisibility()
            || state.phase() != BreadPresentationState.Phase.VISIBLE) return;
        requestAcceptedMinimize();
    }

    private void requestAcceptedMinimize() {
        // A settled collapse cleared morphId and left the page posed. That null is the current id, chosen before
        // nativeCollapse, so it is not the null collapse returns when the container refuses the flight.
        if (posed && morphId == null && !flying()) {
            sendMinimize(null);
            return;
        }
        String id = nativeCollapse();
        if (id == null) return;
        sendMinimize(reportedCollapseId(id));
    }

    private String reportedCollapseId(String id) {
        return id != null && id.equals(morphId) ? id : null;
    }

    private void sendMinimize(String morphId) {
        owner.presentationMinimizeRequested(state.policyRevision(), state.acknowledgedVisibilitySequence(), morphId);
    }

    boolean canMinimizeFromBack() {
        return !owner.managedClosing() && owner.isShowing() && state.effectiveVisibility()
            && state.phase() == BreadPresentationState.Phase.VISIBLE && !posed && !flying();
    }

    private void commitInteractiveCollapse() {
        tracking = false;
        released = true;
        interactiveCollapse = false;
        headTo(0);
        emit("retargeted", 0, false, 0);
        morph.animateTo(0, morph.card(), 0, BreadMorphPhysics.RELEASE);
    }

    private void cancelInteractiveCollapse() {
        if (!tracking) return;
        tracking = false;
        released = true;
        interactiveCollapse = false;
        if (owner.managedClosing() || state.phase() == BreadPresentationState.Phase.CLOSED) return;
        reverse();
    }

    private void requestNativeMinimize(String collapseId) {
        if (owner.managedClosing() || state.phase() == BreadPresentationState.Phase.CLOSED || collapseId == null) return;
        sendMinimize(reportedCollapseId(collapseId));
    }

    int routeTouch(MotionEvent event) {
        int action = event.getActionMasked();
        boolean last = action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL;
        if (action == MotionEvent.ACTION_DOWN) {
            capsuleGestureOwned = downOnCapsule(event);
            owned = posed;
            released = false;
            cancelledForPage = false;
        }
        if (capsuleGestureOwned) {
            if (last) capsuleGestureOwned = false;
            return TOUCH_PASS;
        }
        if (!owned) {
            if (!posed && !cancelledForPage) return TOUCH_PASS;
            int route = cancelledForPage ? TOUCH_CONSUME : TOUCH_CANCEL;
            cancelledForPage = !last;
            return route;
        }
        if (!released) handleTouch(event, action);
        if (last) owned = false;
        return TOUCH_CONSUME;
    }

    private boolean downOnCapsule(MotionEvent event) {
        if (!back.isShown()) return false;
        int[] location = new int[2];
        back.getLocationOnScreen(location);
        return event.getRawX() >= location[0] && event.getRawX() < location[0] + back.getWidth()
            && event.getRawY() >= location[1] && event.getRawY() < location[1] + back.getHeight();
    }

    private void handleTouch(MotionEvent event, int action) {
        float x = event.getX(), y = event.getY();
        if (tracker == null) tracker = VelocityTracker.obtain();
        if (action == MotionEvent.ACTION_DOWN) {
            tracker.clear();
            downX = x;
            downY = y;
            downTime = event.getEventTime();
            moved = false;
            onPage = morphPageRect().contains(x, y);
        }
        tracker.addMovement(event);
        if (action == MotionEvent.ACTION_MOVE) {
            if (!moved && Math.hypot(x - downX, y - downY) >= ViewConfiguration.get(owner.getContext()).getScaledTouchSlop()) {
                moved = true;
                if (onPage && morph.running() && morph.card() != null) grab(x, y);
            } else if (tracking) drag(x, y);
        } else if (action == MotionEvent.ACTION_UP) {
            if (tracking) release();
            else if (onPage && !moved && morph.running()
                && event.getEventTime() - downTime < ViewConfiguration.getLongPressTimeout()) reverse();
        } else if (action == MotionEvent.ACTION_CANCEL && tracking) {
            tracker.clear();
            release();
        }
    }

    private void grab(float x, float y) {
        grabStart = morph.freeze();
        grabTarget = morph.target();
        grabX = x;
        grabY = y;
        tracking = true;
        emit("retargeted", grabTarget, true, 0);
    }

    private void drag(float x, float y) {
        BreadMorphCard landing = morph.card();
        float p;
        if (landing == null) {
            p = grabStart - (y - grabY) / Math.max(1, dp(300));
        } else {
            RectF card = landing.rect;
            double dx = container.getWidth() / 2f - card.centerX(), dy = container.getHeight() / 2f - card.centerY();
            double length = dx * dx + dy * dy;
            // A card centred on the slot has no path to project onto; keep the grabbed progress, never NaN.
            p = length < 1e-6 ? grabStart : (float) (grabStart + ((x - grabX) * dx + (y - grabY) * dy) / length);
        }
        if (p > 1) p = 1 + BreadMorphGeometry.rubberBand(p - 1, 1);
        else if (p < 0) p = BreadMorphGeometry.rubberBand(p, 1);
        morph.track(p);
    }

    private float release() { return release(false); }

    private float release(boolean capsule) {
        tracker.computeCurrentVelocity(1000);
        float vx = tracker.getXVelocity(), vy = tracker.getYVelocity();
        float velocity = capsule ? capsuleProgressVelocity(vy) : velocity(morph.card(), vx, vy);
        float end = releaseEnd(morph.progress(), velocity);
        tracking = false;
        released = true;
        interactiveCollapse = false;
        headTo(end);
        emit("retargeted", end, false, velocity);
        morph.animateTo(end, morph.card(), velocity, BreadMorphPhysics.RELEASE);
        return end;
    }

    private float releaseEnd(float progress, float progressVelocity) {
        tracker.computeCurrentVelocity(1000);
        float vx = tracker.getXVelocity(), vy = tracker.getYVelocity();
        float speed = (float) Math.hypot(vx, vy) / owner.getContext().getResources().getDisplayMetrics().density;
        float travel = progress + PROJECTION_SECONDS * progressVelocity - grabStart;
        float end = grabTarget;
        if (speed >= FLICK_DP_PER_SECOND && Math.abs(progressVelocity) > 0.01f) end = progressVelocity > 0 ? 1 : 0;
        else if (Math.abs(travel) >= COMMIT_TRAVEL) end = travel > 0 ? 1 : 0;
        return end;
    }

    private float capsuleProgressVelocity(float vy) {
        float velocity = -vy / capsuleCollapseDistance();
        return Math.max(-BreadMorphGeometry.MAX_PROGRESS_VELOCITY,
            Math.min(BreadMorphGeometry.MAX_PROGRESS_VELOCITY, velocity));
    }

    private void reverse() {
        float end = morph.target() >= 0.5f ? 0 : 1;
        headTo(end);
        emit("retargeted", end, false);
        morph.animateTo(end, morph.card(), 0, end >= 0.5f ? BreadMorphPhysics.EXPAND : BreadMorphPhysics.COLLAPSE);
    }

    private void endTracking() {
        if (tracking) released = true;
        tracking = false;
        if (capsuleTracking || backPreview) {
            capsuleTracking = false;
            backPreview = false;
            interactiveCollapse = false;
            if (capsuleTouchDown) capsuleTouchRejected = true;
        }
    }

    private void cancelInteractiveInput() {
        if (!interactiveCollapse && !capsuleTracking && !backPreview) return;
        boolean cancelMorph = interactiveCollapse;
        capsuleTracking = false;
        backPreview = false;
        capsuleReducedMotion = false;
        capsuleTouchRejected = capsuleTouchDown;
        if (cancelMorph) cancelInteractiveCollapse();
    }
    boolean fullscreen() { return state.fullscreen(); }

    void visibility(boolean visible) { visibility(visible, null, null); }

    void visibility(boolean visible, Integer policyRevision, Integer sequence) {
        boolean previous = state.effectiveVisibility();
        BreadMorphEvent cancelled = flying() ? event("cancelled", collapseFlight != null ? 0 : morph.target(), false, morph.velocity()) : null;
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
            cancelProxyFade();
            proxy.setAlpha(1f);
        }
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    }

    void close() {
        morphId = null;
        endTracking();
        cancelPostedCaptures();
        releaseBack();
        if (tracker != null) {
            tracker.recycle();
            tracker = null;
        }
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
            if (posed) {
                // The host shows around the moving page, with its own bars, until the page rests again.
                window.setBackgroundDrawableResource(android.R.color.transparent);
                controller.setSystemBarsBehavior(browserBarsBehavior);
                controller.show(browserVisibleBars);
            } else {
                window.setBackgroundDrawableResource(android.R.color.black);
                controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsetsCompat.Type.systemBars());
            }
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
        showBack(View.VISIBLE);
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
            showBack(fullscreen() ? View.VISIBLE : View.GONE);
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
        showBack(fullscreen() ? View.VISIBLE : View.GONE);
        if (!ValueAnimator.areAnimatorsEnabled()) finishReveal(generation);
        else if (proxyRoute()) fadeProxy(0, EXPAND_CROSSFADE_MS, () -> finishReveal(generation));
        else {
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
