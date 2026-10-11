package ee.forgr.capacitor_inappbrowser;

import android.animation.ValueAnimator;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
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
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.caverock.androidsvg.SVG;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.util.Collections;

final class BreadPresentationController {
    private static final int FALLBACK = Color.rgb(22, 22, 22);
    final BreadPresentationState state;
    private final WebViewDialog owner;
    private final WebView webView;
    private final Options.BreadPresentation options;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final FrameLayout overlay;
    private final FrameLayout cover;
    private final ImageButton back;
    private final TextView hint;
    private final TextView error;
    private final Button retry;
    private final ProgressBar spinner;
    private ScriptHandler script;
    private boolean supported;
    private boolean installed;
    private boolean initialNavigationStarted;
    private long pendingPaint = -1;
    private int layoutWidth;
    private int layoutHeight;
    private int controlTop;
    private int controlLeft;
    private int theme = FALLBACK;
    private boolean hintShown;
    private boolean appliedFullscreen;
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

    BreadPresentationController(WebViewDialog owner, WebView webView, Options.BreadPresentation options) {
        this.owner = owner;
        this.webView = webView;
        this.options = options;
        state = new BreadPresentationState(options.readinessTimeoutMs);
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
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            owner.dismiss();
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
        hint = new TextView(owner.getContext());
        hint.setText(options.hintLabel);
        hint.setTextColor(Color.WHITE);
        hint.setTextSize(14);
        hint.setPadding(dp(12), dp(8), dp(12), dp(8));
        GradientDrawable hintBackground = new GradientDrawable();
        hintBackground.setColor(0xe6292929);
        hintBackground.setCornerRadius(dp(12));
        hint.setBackground(hintBackground);
        overlay.addView(hint, new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.START));
        hint.setVisibility(View.GONE);
        ViewGroup root = owner.findViewById(R.id.coordinator_layout);
        root.addView(overlay, new ViewGroup.LayoutParams(-1, -1));
        webView.addOnLayoutChangeListener((v, l, t, r, b, oldL, oldT, oldR, oldB) -> {
            int width = r - l, height = b - t;
            if (width != layoutWidth || height != layoutHeight) {
                layoutWidth = width;
                layoutHeight = height;
                invalidateLayout();
            }
        });
        ViewCompat.setOnApplyWindowInsetsListener(overlay, (view, insets) -> {
            Insets safe = insets.getInsets(WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.systemBars());
            int top = safe.top + dp(8), left = safe.left + dp(8);
            if (top != controlTop || left != controlLeft) {
                controlTop = top;
                controlLeft = left;
                positionControls();
                invalidateLayout();
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
                WebViewCompat.addWebMessageListener(webView, "breadPresentation", Collections.singleton("*"),
                    (view, message, origin, mainFrame, reply) -> receive(message.getData(), mainFrame));
                script = WebViewCompat.addDocumentStartJavaScript(webView, options.script, Collections.singleton("*"));
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
            String token = message.optString("token", "");
            long generation = state.navigationGeneration();
            webView.evaluateJavascript("window.__breadPresentationToken", result -> {
                try {
                    Object current = new JSONTokener(result).nextValue();
                    if (!(current instanceof String) || !state.authorizes(mainFrame, token, (String) current, generation)) return;
                    String type = message.optString("type");
                    if ("configure".equals(type)) {
                        String display = message.optString("display");
                        if (!"browser".equals(display) && !"fullscreen".equals(display)) return;
                        boolean previous = state.fullscreen();
                        state.configure(token, "fullscreen".equals(display), message.optBoolean("manualReady"));
                        applyTheme(message.optString("themeColor"));
                        if (previous != state.fullscreen()) owner.presentationChanged(state.fullscreen());
                        render();
                    } else if ("ready".equals(type) && token.equals(state.token())) {
                        state.ready();
                        respond(message, null);
                        render();
                    } else if ("close".equals(type)) {
                        respond(message, owner::dismiss);
                    }
                } catch (Exception ignored) { }
            });
        } catch (Exception ignored) { }
    }

    private void respond(JSONObject message, Runnable completion) {
        try {
            JSONObject response = new JSONObject().put("token", message.getString("token"))
                .put("requestId", message.getString("requestId")).put("ok", true);
            long generation = state.navigationGeneration();
            webView.evaluateJavascript("window.__breadPresentationRespond(" + response + ")", result -> {
                if (completion != null && generation == state.navigationGeneration()) completion.run();
            });
        } catch (Exception ignored) { }
    }

    void navigationStarted() {
        // Construction already primes the first document; its bootstrap can beat onPageStarted.
        if (initialNavigationStarted) navigate();
        else initialNavigationStarted = true;
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
    boolean fullscreen() { return state.fullscreen(); }

    void visibility(boolean visible) {
        state.visibility(visible, SystemClock.uptimeMillis());
        cancelPaint();
        render();
    }

    void foreground(boolean foreground) {
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
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    }

    void close() {
        restoreWindow();
        state.close();
        cancelPaint();
        handler.removeCallbacksAndMessages(null);
        if (script != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) script.remove();
        if (supported && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(webView, "breadPresentation");
        }
    }

    void applyWindow() {
        if (!state.active()) return;
        Window window = owner.getWindow();
        if (window == null) return;
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        if (fullscreen()) {
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
        cover.setVisibility(View.VISIBLE);
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        error.setVisibility(failed ? View.VISIBLE : View.GONE);
        retry.setVisibility(failed ? View.VISIBLE : View.GONE);
        retry.setEnabled(supported);
        spinner.setVisibility(failed ? View.GONE : View.VISIBLE);
        back.setVisibility(View.VISIBLE);
    }

    void render() {
        if (state.phase() == BreadPresentationState.Phase.CLOSED) return;
        renderCover();
        if (!state.active()) {
            restoreWindow();
            return;
        }
        applyWindow();
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
            String token = JSONObject.quote(state.token());
            int inset = fullscreen() ? controlTop + back.getHeight() + dp(8) : 0;
            String update = "(()=>{if(window.__breadPresentationToken!==" + token + ")return false;"
                + "window.__breadPresentationUpdate({token:" + token + ",display:"
                + JSONObject.quote(fullscreen() ? "fullscreen" : "browser") + ",controlInsetTop:"
                + inset + "*innerWidth/" + webView.getWidth() + "});return true})()";
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

    private void reveal(long generation) {
        applyWindow();
        if (!state.canReveal(generation)) return;
        state.painted(generation);
        pendingPaint = -1;
        back.setVisibility(fullscreen() ? View.VISIBLE : View.GONE);
        if (fullscreen() && !hintShown) {
            hintShown = true;
            hint.setVisibility(View.VISIBLE);
            handler.postDelayed(() -> hint.setVisibility(View.GONE), 3500);
        }
        if (ValueAnimator.areAnimatorsEnabled()) {
            cover.animate().alpha(0).setDuration(160).withEndAction(() -> {
                finishReveal(generation);
            }).start();
        } else finishReveal(generation);
    }

    private void finishReveal(long generation) {
        if (!state.canReveal(generation)) return;
        cover.setVisibility(View.GONE);
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
        FrameLayout.LayoutParams label = (FrameLayout.LayoutParams) hint.getLayoutParams();
        label.topMargin = controlTop + dp(56);
        label.leftMargin = controlLeft;
        hint.setLayoutParams(label);
    }

    private int dp(int value) { return Math.round(value * owner.getContext().getResources().getDisplayMetrics().density); }
}
