package ee.forgr.capacitor_inappbrowser.navbar;

import android.content.Context;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import androidx.annotation.NonNull;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import ee.forgr.capacitor_inappbrowser.R;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Miden patch — Android port of iOS MidenNavbarOverlayWindow view
 * tree.
 *
 * Layout hierarchy mirrors iOS:
 *
 *   NavbarView (FrameLayout, floats at bottom gravity)
 *     shadowWrap (FrameLayout — elevation 20dp, 26dp radius)
 *       blurContainer (FrameLayout — rounded corners, blur in Phase 5)
 *         outerVStack (LinearLayout VERTICAL, gap 6dp)
 *           secondaryRow (LinearLayout HORIZONTAL, weightSum=3) [Phase 3]
 *             NavbarSecondaryButton ×N
 *           contentStack (LinearLayout HORIZONTAL)
 *             navStack (LinearLayout HORIZONTAL, weight=1, weightSum=3)
 *               NavbarButton ×3
 *             NavbarActionButton [Phase 4, 0-width default]
 *
 * Phase 2 scope: everything visible except the secondary row (hidden)
 * and action button (hidden). Main row renders 3 real NavbarButtons
 * bound to state items with correct icons, active states, and tap
 * handlers.
 */
public final class NavbarView extends FrameLayout {

    private static final String TAG = "NavbarView";

    /** Side inset from the screen edges (matches iOS 16pt). */
    private static final int SIDE_MARGIN_DP = 16;

    /** Gap above the home-indicator safe area (matches iOS 12pt). */
    private static final int BOTTOM_GAP_DP = 12;

    /** Inner pill padding (matches iOS px-2 py-2 = 8pt). */
    private static final int PILL_PADDING_DP = 8;

    /** Vertical gap between secondary row and content stack. */
    private static final int OUTER_STACK_SPACING_DP = 6;

    // ─── View refs ────────────────────────────────────────────────────

    private final LinearLayout navStack;
    private final LinearLayout contentStack;
    private final LinearLayout outerVStack;
    private final FrameLayout blurContainer;
    private final FrameLayout shadowWrap;

    /** Map of item id → NavbarButton so we can update active state without rebuilding. */
    private final Map<String, NavbarButton> mainButtons = new HashMap<>();

    // ─── State wiring ─────────────────────────────────────────────────

    private final NavbarStateHolder stateHolder;
    private final NavbarStateHolder.Observer stateObserver;
    private boolean subscribed;
    private boolean floatingVisible;

    /**
     * Optional callback set by {@link NavbarOverlayManager} so taps
     * can be forwarded up to the plugin → JS bridge.
     */
    private NavbarOverlayManager manager;

    public NavbarView(@NonNull Context context, @NonNull NavbarStateHolder stateHolder) {
        super(context);
        this.stateHolder = stateHolder;

        // ─── Build the pill hierarchy ────────────────────────────

        // Shadow wrap — outer view that hosts elevation so the blur
        // container can clip its own contents without clipping the
        // drop shadow. Matches iOS `shadowWrap`.
        shadowWrap = new FrameLayout(context);
        shadowWrap.setElevation(dp(8));
        shadowWrap.setClipChildren(false);
        addView(
            shadowWrap,
            new FrameLayout.LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.WRAP_CONTENT
            )
        );

        // Blur container — the actual pill. Rounded 26dp corners,
        // translucent white fill. Phase 5 adds RenderEffect blur
        // on API 31+.
        blurContainer = new FrameLayout(context);
        blurContainer.setBackgroundResource(R.drawable.navbar_pill_bg);
        blurContainer.setClipToOutline(true);
        FrameLayout.LayoutParams blurLp = new FrameLayout.LayoutParams(
            LayoutParams.MATCH_PARENT,
            LayoutParams.WRAP_CONTENT
        );
        shadowWrap.addView(blurContainer, blurLp);

        // Outer vertical stack — holds [secondaryRow, contentStack].
        // Secondary row is hidden in Phase 2.
        outerVStack = new LinearLayout(context);
        outerVStack.setOrientation(LinearLayout.VERTICAL);
        FrameLayout.LayoutParams outerLp = new FrameLayout.LayoutParams(
            LayoutParams.MATCH_PARENT,
            LayoutParams.WRAP_CONTENT
        );
        outerLp.setMargins(dp(PILL_PADDING_DP), dp(PILL_PADDING_DP), dp(PILL_PADDING_DP), dp(PILL_PADDING_DP));
        blurContainer.addView(outerVStack, outerLp);

        // Content stack — holds [navStack, actionButton]. Phase 4
        // will add the action button as a sibling.
        contentStack = new LinearLayout(context);
        contentStack.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams contentLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        outerVStack.addView(contentStack, contentLp);

        // Nav stack — holds the main-row buttons (Home/Activity/
        // Browser). Weight=1 so it expands to fill contentStack in
        // default mode.
        navStack = new LinearLayout(context);
        navStack.setOrientation(LinearLayout.HORIZONTAL);
        navStack.setWeightSum(3);
        LinearLayout.LayoutParams navLp = new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        );
        contentStack.addView(navStack, navLp);

        // ─── Subscribe to state ──────────────────────────────────

        stateObserver = this::onStateChanged;
        stateHolder.addObserver(stateObserver);
        subscribed = true;

        // ─── Window insets for safe-area-aware bottom gap ────────

        ViewCompat.setOnApplyWindowInsetsListener(this, (v, insets) -> {
            int bottomInset = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom;
            ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            if (lp != null) {
                lp.bottomMargin = dp(BOTTOM_GAP_DP) + bottomInset;
                lp.leftMargin = dp(SIDE_MARGIN_DP);
                lp.rightMargin = dp(SIDE_MARGIN_DP);
                v.setLayoutParams(lp);
            }
            return insets;
        });

        // Hidden by default — manager calls setFloatingVisible() to
        // pick which instance is on top.
        setVisibility(GONE);
    }

    /**
     * Factory for the layout params used when attaching this view to
     * either the Activity decor view or a Dialog decor view.
     */
    public static FrameLayout.LayoutParams floatingBottomLayoutParams() {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        lp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        return lp;
    }

    /** Called by the manager to attach its tap callback plumbing. */
    public void attachManager(NavbarOverlayManager manager) {
        this.manager = manager;
    }

    // ─── Visibility arbitration hook ──────────────────────────────────

    public void setFloatingVisible(boolean visible) {
        if (this.floatingVisible == visible) return;
        this.floatingVisible = visible;
        setVisibility(visible ? VISIBLE : GONE);
    }

    public void onDetachedFromManager() {
        if (subscribed) {
            stateHolder.removeObserver(stateObserver);
            subscribed = false;
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        if (subscribed) {
            stateHolder.removeObserver(stateObserver);
            subscribed = false;
        }
    }

    // ─── State binding ────────────────────────────────────────────────

    private void onStateChanged(NavbarState state) {
        // Rebuild the main row if the items list has changed, else
        // just update active state. For now (Phase 2) we rebuild
        // every time because diffing adds complexity without a
        // measurable benefit at 3 items.
        rebuildMainRow(state.items, state.activeId);
        Log.d(
            TAG,
            "onStateChanged: visible=" + state.visible +
            " items=" + state.items.size() +
            " active=" + state.activeId
        );
    }

    private void rebuildMainRow(List<NavbarState.Item> items, String activeId) {
        // Remove previous buttons. Phase 3 will make this smarter
        // (diff on id) but the current impl is correct.
        navStack.removeAllViews();
        mainButtons.clear();

        List<NavbarButton> built = new ArrayList<>(items.size());
        for (NavbarState.Item item : items) {
            NavbarButton button = new NavbarButton(getContext());
            boolean isActive = item.id.equals(activeId);
            button.bind(item, isActive);
            button.setOnClickListener(v -> {
                if (manager != null) manager.dispatchItemTap(item.id);
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            );
            navStack.addView(button, lp);
            mainButtons.put(item.id, button);
            built.add(button);
        }
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            getResources().getDisplayMetrics()
        );
    }
}
