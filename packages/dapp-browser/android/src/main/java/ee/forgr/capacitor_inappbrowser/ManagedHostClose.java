package ee.forgr.capacitor_inappbrowser;

import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;

final class ManagedHostClose {
    final String token;
    private final String id;
    private final WebViewDialog owner;
    private final WebView host;
    private final JSObject options;
    private final Consumer<JSObject> notify;
    private final Runnable finish;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<Runnable> completions = new ArrayList<>();
    private String requestId;
    private boolean finished, failed, visible, foreground = true;
    private long generation, receipt = -1, fence = -1, remaining = 5000, lastTick;
    private View failureView;
    private String geometry;
    private HostReturnInsets returnInsets;
    private final View.OnLayoutChangeListener layoutListener = (view, l, t, r, b, ol, ot, or, ob) -> geometryChanged();

    ManagedHostClose(String id, WebViewDialog owner, WebView host, JSObject options,
                     Consumer<JSObject> notify, Runnable finish) {
        this.id = id;
        this.owner = owner;
        this.host = host;
        this.options = options;
        this.token = options.getString("token", "");
        this.notify = notify;
        this.finish = finish;
    }

    boolean closing() { return requestId != null && !finished; }
    String requestId() { return requestId; }

    void request(Runnable completion) {
        if (finished) { completion.run(); return; }
        completions.add(completion);
        if (closing()) { if (failed) retry(); return; }
        boolean unseenWarm = owner.retireUnseenWarmPresentation();
        visible = owner.isShowing() && !unseenWarm;
        owner.disableClosingPage();
        host.addOnLayoutChangeListener(layoutListener);
        ensureReturnInsets();
        retry();
    }

    void retry() {
        if (finished) return;
        failed = false;
        removeFailure();
        requestId = UUID.randomUUID().toString();
        receipt = -1;
        fence = -1;
        generation++;
        remaining = 5000;
        lastTick = SystemClock.uptimeMillis();
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::tick, 100);
        notify.accept(new JSObject().put("id", id).put("token", token).put("requestId", requestId).put("visible", visible));
    }

    boolean complete(String token, String requestId, long commit) {
        if (!this.token.equals(token) || !java.util.Objects.equals(this.requestId, requestId) || !closing() || failed || commit <= receipt) return false;
        receipt = commit;
        generation++;
        fence = -1;
        if (!visible) { force(); return true; }
        host.requestApplyInsets();
        startFence();
        return true;
    }

    void foreground(boolean value) {
        foreground = value;
        generation++;
        fence = -1;
        lastTick = SystemClock.uptimeMillis();
        if (value) startFence();
    }

    private boolean ensureReturnInsets() {
        if (!visible || Build.VERSION.SDK_INT < 30) return true;
        if (WebViewRegistry.getShared().get(id) != owner) return false;
        if (returnInsets == null || !returnInsets.owned()) {
            generation++;
            fence = -1;
            geometry = null;
            returnInsets = HostReturnInsets.acquire(host,
                () -> !finished && WebViewRegistry.getShared().get(id) == owner, this::geometryChanged);
        }
        return returnInsets != null && returnInsets.ready();
    }

    private String geometry() {
        int[] position = new int[2];
        host.getLocationInWindow(position);
        return host.getWidth() + ":" + host.getHeight() + ":" + position[0] + ":" + position[1] + ":" + host.getRootWindowInsets() + ":" +
            (Build.VERSION.SDK_INT < 30 || returnInsets == null ? 0 : returnInsets.revision());
    }

    private void geometryChanged() {
        if (!closing()) return;
        String next = geometry();
        if (next.equals(geometry)) return;
        geometry = next;
        generation++;
        fence = -1;
        startFence();
    }

    private boolean current(long revision, String dimensions) {
        return closing() && !failed && foreground && generation == revision &&
            (Build.VERSION.SDK_INT < 30 || (returnInsets != null && returnInsets.ready())) && host.isAttachedToWindow() &&
            host.getVisibility() == View.VISIBLE && dimensions.equals(geometry()) &&
            WebViewRegistry.getShared().get(id) == owner;
    }

    private void startFence() {
        if (!closing() || failed || !foreground || receipt < 0 || fence >= 0 ||
            !host.isAttachedToWindow() || host.getVisibility() != View.VISIBLE || host.getWidth() == 0 || host.getHeight() == 0 || !ensureReturnInsets()) return;
        final long revision = generation;
        final String dimensions = geometry();
        geometry = dimensions;
        fence = revision;
        try {
            host.postVisualStateCallback(revision, new WebView.VisualStateCallback() {
                @Override public void onComplete(long request) {
                    if (!current(revision, dimensions)) { restartChangedFence(revision); return; }
                    if (Build.VERSION.SDK_INT >= 29 && host.isHardwareAccelerated()) {
                        host.getViewTreeObserver().registerFrameCommitCallback(() -> handler.post(() -> {
                            if (current(revision, dimensions)) force();
                            else restartChangedFence(revision);
                        }));
                        host.invalidate();
                    } else {
                        // Visual state guarantees the next visible draw includes the committed host content.
                        force();
                    }
                }
            });
            host.invalidate();
        } catch (RuntimeException error) { fail(); }
    }

    private void restartChangedFence(long revision) {
        if (generation != revision) return;
        generation++;
        fence = -1;
        startFence();
    }

    private void tick() {
        if (!closing() || failed) return;
        long now = SystemClock.uptimeMillis();
        if (foreground) remaining -= now - lastTick;
        lastTick = now;
        if (owner.activity == null || owner.activity.isDestroyed()) { force(); return; }
        if (remaining <= 0) { fail(); return; }
        startFence();
        handler.postDelayed(this::tick, 100);
    }

    private void fail() {
        if (!closing() || failed) return;
        if (!visible) { force(); return; }
        failed = true;
        generation++;
        handler.removeCallbacksAndMessages(null);
        LinearLayout panel = new LinearLayout(owner.getContext());
        panel.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(16 * owner.getContext().getResources().getDisplayMetrics().density);
        panel.setPadding(padding, padding, padding, padding);
        panel.setBackgroundColor(android.graphics.Color.rgb(245, 245, 245));
        TextView message = new TextView(owner.getContext());
        message.setText(options.getString("errorLabel", ""));
        message.setTextColor(android.graphics.Color.BLACK);
        Button retry = new Button(owner.getContext());
        retry.setText(options.getString("retryLabel", ""));
        retry.setOnClickListener(view -> { view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); retry(); });
        Button exit = new Button(owner.getContext());
        exit.setText(options.getString("exitLabel", ""));
        exit.setOnClickListener(view -> { view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); force(); });
        panel.addView(message); panel.addView(retry); panel.addView(exit);
        android.widget.FrameLayout.LayoutParams layout = new android.widget.FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        layout.setMargins(padding, padding, padding, padding);
        ((ViewGroup) owner.getWindow().getDecorView()).addView(panel, layout);
        failureView = panel;
        panel.announceForAccessibility(message.getText());
    }

    private void removeFailure() {
        if (failureView != null && failureView.getParent() instanceof ViewGroup) ((ViewGroup) failureView.getParent()).removeView(failureView);
        failureView = null;
    }

    void force() {
        if (finished) return;
        finished = true;
        generation++;
        handler.removeCallbacksAndMessages(null);
        host.removeOnLayoutChangeListener(layoutListener);
        removeFailure();
        if (Build.VERSION.SDK_INT >= 30 && returnInsets != null) returnInsets.finish();
        finish.run();
        if (Build.VERSION.SDK_INT >= 30 && returnInsets != null) returnInsets.requestInsets();
        List<Runnable> callbacks = new ArrayList<>(completions);
        completions.clear();
        for (Runnable callback : callbacks) callback.run();
    }
}
