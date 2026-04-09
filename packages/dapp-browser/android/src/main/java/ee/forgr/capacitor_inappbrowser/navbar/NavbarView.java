package ee.forgr.capacitor_inappbrowser.navbar;

import android.content.Context;
import android.graphics.Color;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import androidx.annotation.NonNull;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * Miden patch — Android port of iOS MidenNavbarOverlayWindow.
 *
 * PHASE 1 PLACEHOLDER: this is a minimal FrameLayout subclass that
 * subscribes to {@link NavbarStateHolder} and renders a debug
 * rectangle whose color reflects whether the main-row is populated.
 * Phase 2 will replace the debug rendering with the real view
 * hierarchy (shadowWrap, blurContainer, buttons).
 *
 * Lifecycle contract:
 *   - Created by {@link NavbarOverlayManager} and added to a parent
 *     decor view.
 *   - Subscribes to the state holder in its constructor and
 *     unsubscribes in {@link #onDetachedFromManager()}.
 *   - Toggled between visible and gone via
 *     {@link #setFloatingVisible(boolean)} based on which instance is
 *     currently "on top" per the manager's arbitration logic.
 */
public final class NavbarView extends FrameLayout {

    private static final String TAG = "NavbarView";

    /**
     * Fixed pill height in dp. Matches the iOS
     * {@code NavbarButton.buttonHeight = 60} after accounting for
     * the outer pill's 8pt top/bottom padding plus the secondary
     * row's reserved space. Phase 2 will split this into the
     * proper view tree with its own layout math.
     */
    private static final int PLACEHOLDER_HEIGHT_DP = 76;

    /**
     * Side margin matching the iOS pill's 16pt inset from the screen
     * edges.
     */
    private static final int SIDE_MARGIN_DP = 16;

    /**
     * Gap between the navbar's bottom edge and the home-indicator
     * safe area, matching the iOS pill's 12pt bottom offset.
     */
    private static final int BOTTOM_GAP_DP = 12;

    private final NavbarStateHolder stateHolder;
    private final NavbarStateHolder.Observer stateObserver;
    private boolean subscribed;

    /**
     * Whether this instance should be displayed given the manager's
     * "which view is on top" arbitration. Separate from the global
     * state.visible flag so we can cleanly distinguish "globally
     * hidden" (state says not visible) from "not the active
     * instance" (another instance is on top).
     */
    private boolean floatingVisible;

    public NavbarView(@NonNull Context context, @NonNull NavbarStateHolder stateHolder) {
        super(context);
        this.stateHolder = stateHolder;

        // Placeholder background — a solid red rect so Phase 1 +
        // Phase 2 wiring can be visually differentiated while they
        // stabilize. Phase 2 will replace this with the shadowWrap +
        // blurContainer hierarchy.
        setBackgroundColor(Color.parseColor("#CCFF3300"));
        // Min height so the placeholder has non-zero dimensions
        // before Phase 2 adds real children that drive the intrinsic
        // size via wrap_content.
        setMinimumHeight(dp(PLACEHOLDER_HEIGHT_DP));

        // Subscribe to state changes. The holder fires an initial
        // state on subscribe so we render correctly on first attach
        // without waiting for a mutation.
        stateObserver = this::onStateChanged;
        stateHolder.addObserver(stateObserver);
        subscribed = true;

        // Read the bottom system bar inset so the pill sits above the
        // gesture-nav bar on modern devices. Mirrors iOS's
        // safeAreaLayoutGuide.bottomAnchor - 12.
        ViewCompat.setOnApplyWindowInsetsListener(this, (v, insets) -> {
            int bottomInset = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom;
            ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            if (lp != null) {
                lp.bottomMargin = dp(BOTTOM_GAP_DP) + bottomInset;
                v.setLayoutParams(lp);
            }
            return insets;
        });

        // Default invisible — the manager calls setFloatingVisible()
        // once it decides which instance is on top.
        setVisibility(GONE);
    }

    /**
     * Factory for the layout params used when attaching this view to
     * either the Activity decor view or a Dialog decor view. Kept as
     * a static helper so the manager can supply them at addView()
     * time without instantiating the view first.
     */
    public static FrameLayout.LayoutParams floatingBottomLayoutParams() {
        // NOTE: we use WRAP_CONTENT for width + horizontal margins
        // via the manager — Phase 2 will switch this to a proper
        // constrained width once the real pill hierarchy lands.
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        return lp;
    }

    /**
     * Called by the manager when this view should be visible
     * (i.e. it's the frontmost navbar instance). Phase 5 will
     * animate the show/hide; for now we just flip
     * {@code setVisibility}.
     */
    public void setFloatingVisible(boolean visible) {
        if (this.floatingVisible == visible) return;
        this.floatingVisible = visible;
        setVisibility(visible ? VISIBLE : GONE);
        Log.d(TAG, "setFloatingVisible(" + visible + ")");
    }

    /**
     * Called by the manager before removing this view from its
     * parent. Unsubscribes from the state holder to avoid a leak.
     */
    public void onDetachedFromManager() {
        if (subscribed) {
            stateHolder.removeObserver(stateObserver);
            subscribed = false;
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        // Belt-and-suspenders: if the manager forgets to call
        // onDetachedFromManager() for any reason, still unsubscribe
        // so the state holder's observer list doesn't grow
        // unboundedly.
        if (subscribed) {
            stateHolder.removeObserver(stateObserver);
            subscribed = false;
        }
    }

    /**
     * Bind to a new state snapshot. Phase 2 will rebuild the main
     * row + secondary row + action button from the state; Phase 1
     * just changes the debug fill color so we can tell at a glance
     * whether the state has populated items yet.
     */
    private void onStateChanged(NavbarState state) {
        int color;
        if (state.items.isEmpty()) {
            // No items — red for "unpopulated".
            color = Color.parseColor("#CCFF3300");
        } else if (state.action != null) {
            // Compact mode (Send flow) — purple so it's obvious when
            // we've entered compact.
            color = Color.parseColor("#CC8A2BE2");
        } else if (!state.secondaryItems.isEmpty()) {
            // Main + secondary row populated — teal for
            // "full navbar".
            color = Color.parseColor("#CC00BFA5");
        } else {
            // Main row only — orange.
            color = Color.parseColor("#CCFF8C00");
        }
        setBackgroundColor(color);
        Log.d(
            TAG,
            "state: visible=" + state.visible +
            " morph=" + state.morphedOut +
            " items=" + state.items.size() +
            " secondary=" + state.secondaryItems.size() +
            " action=" + (state.action != null)
        );
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            getResources().getDisplayMetrics()
        );
    }
}
