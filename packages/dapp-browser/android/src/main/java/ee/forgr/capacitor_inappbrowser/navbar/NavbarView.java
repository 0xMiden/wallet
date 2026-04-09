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
import androidx.dynamicanimation.animation.DynamicAnimation;
import androidx.dynamicanimation.animation.SpringAnimation;
import androidx.dynamicanimation.animation.SpringForce;
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

    private final LinearLayout secondaryRow;
    private final LinearLayout navStack;
    private final NavbarActionButton actionButton;
    private final LinearLayout contentStack;
    private final LinearLayout outerVStack;
    private final FrameLayout blurContainer;
    private final FrameLayout shadowWrap;

    /** Map of item id → NavbarButton so we can update active state without rebuilding. */
    private final Map<String, NavbarButton> mainButtons = new HashMap<>();

    /** Map of item id → NavbarSecondaryButton for the secondary row. */
    private final Map<String, NavbarSecondaryButton> secondaryButtons = new HashMap<>();

    /** Animator controlling the secondary row's grow/collapse height transition. */
    private SpringAnimation secondaryHeightAnim;

    /** Last signature of the secondary items list — used to avoid unnecessary rebuilds. */
    private String lastSecondarySignature = "";

    /** Whether we're currently rendering the compact mode layout (action button visible). */
    private boolean compactMode;

    /** Animator that slides the pill off-screen / back for drawer morphs. */
    private SpringAnimation morphTranslationAnim;

    /** Whether we're currently in the morphed-out state. */
    private boolean morphedOut;

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
        // translucent white fill.
        //
        // On Android we can't cleanly replicate iOS's UIGlassEffect
        // backdrop blur. The only reliable Android primitives for
        // backdrop blur (Window.setBackgroundBlurRadius, the
        // BLUR_BEHIND_WINDOW_FLAG) only work on Windows (Dialogs),
        // and we deliberately architected the navbar as a child
        // View of the Activity/Dialog decor view — not its own
        // Window — so it can share the host's z-order for free
        // (see NavbarOverlayManager docs).
        //
        // View.setRenderEffect(createBlurEffect(...)) blurs the
        // view's OWN rendered content (including children), not
        // what's behind it — the opposite of what we want. So we
        // stick with a solid translucent pill, which reads as a
        // native Material surface on Android devices. This is the
        // same compromise the system Material Bottom App Bar
        // makes.
        blurContainer = new FrameLayout(context);
        blurContainer.setBackgroundResource(R.drawable.navbar_pill_bg);
        blurContainer.setClipToOutline(true);
        FrameLayout.LayoutParams blurLp = new FrameLayout.LayoutParams(
            LayoutParams.MATCH_PARENT,
            LayoutParams.WRAP_CONTENT
        );
        shadowWrap.addView(blurContainer, blurLp);

        // Outer vertical stack — holds [secondaryRow, contentStack].
        // Secondary row is GONE by default; setNavbarSecondaryRow
        // populates it and animates it in.
        outerVStack = new LinearLayout(context);
        outerVStack.setOrientation(LinearLayout.VERTICAL);
        FrameLayout.LayoutParams outerLp = new FrameLayout.LayoutParams(
            LayoutParams.MATCH_PARENT,
            LayoutParams.WRAP_CONTENT
        );
        outerLp.setMargins(dp(PILL_PADDING_DP), dp(PILL_PADDING_DP), dp(PILL_PADDING_DP), dp(PILL_PADDING_DP));
        blurContainer.addView(outerVStack, outerLp);

        // Secondary row — horizontal LinearLayout with equal-weight
        // children for Send / Receive / Settings. Collapsed by
        // default via height=0; the spring animation grows it to
        // intrinsic height when populated.
        secondaryRow = new LinearLayout(context);
        secondaryRow.setOrientation(LinearLayout.HORIZONTAL);
        secondaryRow.setWeightSum(3f);
        LinearLayout.LayoutParams secondaryLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0 // Start collapsed; animation will set the target height
        );
        secondaryLp.bottomMargin = 0; // Gap added dynamically in rebuildSecondaryRow
        outerVStack.addView(secondaryRow, secondaryLp);

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
        // default mode; compact mode flips this to 0.5 so the
        // action button gets the other half.
        navStack = new LinearLayout(context);
        navStack.setOrientation(LinearLayout.HORIZONTAL);
        navStack.setWeightSum(3);
        LinearLayout.LayoutParams navLp = new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        );
        contentStack.addView(navStack, navLp);

        // Action button — 0-width in default mode (hidden via weight
        // sum), grows to 50% of the content stack in compact mode
        // when the JS side calls setNavbarAction.
        actionButton = new NavbarActionButton(context);
        actionButton.setVisibility(GONE);
        LinearLayout.LayoutParams actionLp = new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            0f
        );
        contentStack.addView(actionButton, actionLp);
        actionButton.setOnClickListener(v -> {
            if (manager != null && actionButton.isActionEnabled()) {
                manager.dispatchActionTap();
            }
        });

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
        rebuildMainRow(state.items, state.activeId);
        rebuildSecondaryRow(state.secondaryItems, state.secondaryActiveId);
        applyActionState(state.action);
        applyMorphState(state.morphedOut);
        Log.d(
            TAG,
            "onStateChanged: visible=" + state.visible +
            " items=" + state.items.size() +
            " secondary=" + state.secondaryItems.size() +
            " action=" + (state.action != null) +
            " morph=" + state.morphedOut +
            " active=" + state.activeId
        );
    }

    /**
     * Animate the pill off-screen (morph out) or back into view
     * (morph in) in response to drawer-open state. The animation
     * runs on the {@code shadowWrap}'s translationY so the child
     * tree (buttons, labels, icons) moves as one rigid unit.
     *
     * Off-screen target = pill height + bottom margin, so the pill
     * is fully hidden below the screen edge when morphed out.
     */
    private void applyMorphState(boolean newMorphedOut) {
        if (this.morphedOut == newMorphedOut) return;
        this.morphedOut = newMorphedOut;

        // Cancel any in-flight morph so we don't have two springs
        // fighting for the translation property.
        if (morphTranslationAnim != null && morphTranslationAnim.isRunning()) {
            morphTranslationAnim.cancel();
        }

        // Target = 0 when morphed in, pill_height + margin when
        // morphed out. We use the laid-out height at call time; if
        // the pill hasn't been measured yet we fall back to a
        // reasonable constant.
        float targetTranslationY;
        if (newMorphedOut) {
            int pillHeight = shadowWrap.getHeight();
            if (pillHeight <= 0) pillHeight = dp(120); // reasonable fallback
            targetTranslationY = pillHeight + dp(BOTTOM_GAP_DP) + dp(40);
        } else {
            targetTranslationY = 0f;
        }

        morphTranslationAnim = new SpringAnimation(shadowWrap, DynamicAnimation.TRANSLATION_Y);
        morphTranslationAnim.setSpring(
            new SpringForce(targetTranslationY)
                .setDampingRatio(SpringForce.DAMPING_RATIO_LOW_BOUNCY)
                .setStiffness(SpringForce.STIFFNESS_MEDIUM)
        );
        morphTranslationAnim.start();
    }

    /**
     * Apply the {@link NavbarState.Action} to the action button and
     * flip the compact-mode layout accordingly. When action is null
     * we revert to default (full-width nav stack, no action button);
     * when non-null we bind the action button and split the content
     * stack 50/50 between navStack and action.
     */
    private void applyActionState(NavbarState.Action action) {
        if (action == null) {
            if (!compactMode) return; // already default
            compactMode = false;
            setCompactLayout(false);
            return;
        }

        // Bind content before animating so the morph reveals the
        // final content (Continue label, enabled state) rather than
        // an empty pill.
        actionButton.bind(action);

        if (compactMode) {
            // Already in compact mode — just re-bind the action
            // content without re-running the layout flip.
            return;
        }
        compactMode = true;
        setCompactLayout(true);
    }

    /**
     * Switch the contentStack's weight distribution between default
     * mode (navStack 100%, action 0%) and compact mode (navStack
     * 50%, action 50%). Also flips each NavbarButton's internal
     * layout to icon-only compact mode.
     *
     * Phase 4 applies the flip without animation so we can first
     * verify the layout numerics are correct; Phase 5 will wrap this
     * in a SpringAnimation so the morph is smooth.
     */
    private void setCompactLayout(boolean compact) {
        // Flip each main-row button to compact (icon-only) or back
        // to default (icon + label).
        for (NavbarButton button : mainButtons.values()) {
            button.setCompact(compact);
        }

        // Flip weight distribution on navStack vs actionButton.
        LinearLayout.LayoutParams navLp = (LinearLayout.LayoutParams) navStack.getLayoutParams();
        LinearLayout.LayoutParams actionLp = (LinearLayout.LayoutParams) actionButton.getLayoutParams();
        if (compact) {
            navLp.weight = 1f;
            actionLp.weight = 1f;
            actionButton.setVisibility(VISIBLE);
        } else {
            navLp.weight = 1f;
            actionLp.weight = 0f;
            actionButton.setVisibility(GONE);
        }
        navStack.setLayoutParams(navLp);
        actionButton.setLayoutParams(actionLp);
        requestLayout();
    }

    private void rebuildMainRow(List<NavbarState.Item> items, String activeId) {
        navStack.removeAllViews();
        mainButtons.clear();

        for (NavbarState.Item item : items) {
            NavbarButton button = new NavbarButton(getContext());
            boolean isActive = item.id.equals(activeId);
            button.bind(item, isActive);
            // Carry over the current compact mode to the fresh
            // button. Without this, any state update while in
            // compact mode (e.g. setNavbarAction({enabled:false})
            // while action is already showing) would silently
            // revert the main row to default mode because the
            // freshly-built buttons default to compact=false.
            if (compactMode) button.setCompact(true);
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
        }
    }

    /**
     * Rebuild the secondary row on a state change. Handles three
     * scenarios:
     *   1. Empty → empty: no-op (common case, avoids animation
     *      churn)
     *   2. Items present: rebuild content + animate grow to
     *      intrinsic height
     *   3. Items removed: animate collapse to 0
     *
     * Rebuilds are cheap (≤3 buttons) so we don't bother diffing
     * by id unless the signature changes.
     */
    private void rebuildSecondaryRow(List<NavbarState.Item> items, String activeId) {
        // Build a simple signature of the items list to avoid
        // rebuild+reanimate on every state tick when only the main
        // row changed.
        StringBuilder sigBuilder = new StringBuilder();
        for (NavbarState.Item item : items) {
            sigBuilder.append(item.id).append('/').append(item.title).append(';');
        }
        sigBuilder.append("active=").append(activeId);
        String signature = sigBuilder.toString();
        boolean sameSignature = signature.equals(lastSecondarySignature);

        if (sameSignature) {
            // Items/active unchanged — just re-bind active states
            // for safety (cheap) but skip the animation.
            for (NavbarState.Item item : items) {
                NavbarSecondaryButton btn = secondaryButtons.get(item.id);
                if (btn != null) btn.setActive(item.id.equals(activeId));
            }
            return;
        }
        lastSecondarySignature = signature;

        // Rebuild content.
        secondaryRow.removeAllViews();
        secondaryButtons.clear();

        if (items.isEmpty()) {
            // Animate collapse to height=0. The row's content is
            // already empty so there's nothing to see mid-animation;
            // the height transition just retracts the reserved
            // vertical space cleanly.
            animateSecondaryHeight(0);
            return;
        }

        // Dynamic weightSum so rows with N buttons distribute
        // correctly. Matches iOS NavbarSecondaryButton's
        // .fillEqually distribution.
        secondaryRow.setWeightSum((float) items.size());
        for (NavbarState.Item item : items) {
            NavbarSecondaryButton btn = new NavbarSecondaryButton(getContext());
            boolean isActive = item.id.equals(activeId);
            btn.bind(item, isActive);
            btn.setOnClickListener(v -> {
                if (manager != null) manager.dispatchSecondaryTap(item.id);
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.MATCH_PARENT,
                1f
            );
            secondaryRow.addView(btn, lp);
            secondaryButtons.put(item.id, btn);
        }

        // Animate grow to the row's intrinsic height — for a single
        // row of 32dp pills that's 32dp + padding. We use a
        // measured height instead of a hardcoded constant so future
        // content size changes don't need a magic-number update.
        int targetHeight = dp(NavbarSecondaryButton.BUTTON_HEIGHT_DP);
        // Also add the spacing gap between secondary row and
        // content stack so the two rows don't touch.
        addSecondaryBottomMargin();
        animateSecondaryHeight(targetHeight);
    }

    /**
     * Ensure the secondary row has the correct bottom margin so
     * there's a visible gap between it and the main content stack.
     * Idempotent — safe to call on every populated rebuild.
     */
    private void addSecondaryBottomMargin() {
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) secondaryRow.getLayoutParams();
        if (lp.bottomMargin != dp(OUTER_STACK_SPACING_DP)) {
            lp.bottomMargin = dp(OUTER_STACK_SPACING_DP);
            secondaryRow.setLayoutParams(lp);
        }
    }

    /**
     * Animate the secondary row's height to the given target using
     * a spring with iOS-matching parameters (dampingRatio 0.85,
     * medium stiffness). When the target is 0 we also clear the
     * bottom margin on animation end so the collapsed row doesn't
     * leave a ghost gap.
     */
    private void animateSecondaryHeight(int targetHeight) {
        // Cancel any in-flight animation so we don't have two
        // springs fighting for the same property.
        if (secondaryHeightAnim != null && secondaryHeightAnim.isRunning()) {
            secondaryHeightAnim.cancel();
        }

        // Custom property: animate the LinearLayout.LayoutParams
        // height. SpringAnimation wants a FloatPropertyCompat so we
        // wrap the layout height mutation in one.
        secondaryHeightAnim = new SpringAnimation(
            secondaryRow,
            new androidx.dynamicanimation.animation.FloatPropertyCompat<View>("secondaryHeight") {
                @Override
                public float getValue(View object) {
                    return object.getLayoutParams().height;
                }

                @Override
                public void setValue(View object, float value) {
                    ViewGroup.LayoutParams lp = object.getLayoutParams();
                    lp.height = (int) value;
                    object.setLayoutParams(lp);
                }
            }
        );
        secondaryHeightAnim.setSpring(
            new SpringForce(targetHeight)
                .setDampingRatio(SpringForce.DAMPING_RATIO_LOW_BOUNCY) // ~0.75 — iOS uses ~0.85 but this reads smoother on Android
                .setStiffness(SpringForce.STIFFNESS_MEDIUM)
        );
        secondaryHeightAnim.addEndListener((animation, canceled, value, velocity) -> {
            if (targetHeight == 0) {
                // Fully collapsed — clear the bottom margin so the
                // row doesn't leave a reserved gap.
                LinearLayout.LayoutParams lp =
                    (LinearLayout.LayoutParams) secondaryRow.getLayoutParams();
                if (lp.bottomMargin != 0) {
                    lp.bottomMargin = 0;
                    secondaryRow.setLayoutParams(lp);
                }
            }
        });
        secondaryHeightAnim.start();
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            getResources().getDisplayMetrics()
        );
    }
}
