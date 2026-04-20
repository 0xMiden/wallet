package ee.forgr.capacitor_inappbrowser.navbar;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import ee.forgr.capacitor_inappbrowser.R;

/**
 * Miden patch — Android port of iOS NavbarActionButton.
 *
 * The compact-mode primary action pill (e.g. "Continue" in the Send
 * flow). Renders as a single rounded pill with a centered label,
 * colored orange when enabled and gray when disabled.
 *
 * Visual match with iOS:
 *   - Label font 13sp semibold (iOS uses 13pt)
 *   - Pill background insets top/bottom 13dp inside the 60dp cell
 *     → visible pill height ≈ 34dp, matching the main-row icon
 *     visible height. Both rows read as the same "row size" when
 *     compact mode is engaged.
 *   - Outer button frame stays 60dp so the hit target remains
 *     large and tappable.
 *
 * Used inside {@link NavbarView} as a sibling of {@code navStack}
 * inside the horizontal content stack. Width is driven by
 * LinearLayout weights set at the parent level — default mode has
 * the action at weight=0 (hidden); compact mode flips navStack to
 * weight~1.5 and action to weight~1.5.
 */
public final class NavbarActionButton extends FrameLayout {

    /** Inset on top/bottom from the parent 60dp cell, yielding a 34dp visible pill. */
    private static final int PILL_VERTICAL_INSET_DP = 13;

    /** Horizontal inset so the pill doesn't touch the cell's left/right edges. */
    private static final int PILL_HORIZONTAL_INSET_DP = 8;

    /** Label font size in sp — smaller than the earlier 15sp to fit the 34dp pill. */
    private static final float LABEL_SIZE_SP = 13f;

    private final FrameLayout pillBackground;
    private final TextView labelView;

    private boolean actionEnabled = true;

    public NavbarActionButton(@NonNull Context context) {
        super(context);

        // Pill background — a child View inset from the outer
        // cell's edges to produce the 34dp visible height. Using a
        // child View (not setBackground) is safe here because this
        // button has a FIXED height via minimum height on the
        // parent NavbarButton siblings — the FrameLayout measure
        // loop doesn't need to resolve MATCH_PARENT here (we use
        // explicit child LayoutParams with margins).
        pillBackground = new FrameLayout(context);
        pillBackground.setBackgroundResource(R.drawable.navbar_action_enabled_bg);
        FrameLayout.LayoutParams pillLp = new FrameLayout.LayoutParams(
            LayoutParams.MATCH_PARENT,
            LayoutParams.MATCH_PARENT
        );
        pillLp.topMargin = dp(PILL_VERTICAL_INSET_DP);
        pillLp.bottomMargin = dp(PILL_VERTICAL_INSET_DP);
        pillLp.leftMargin = dp(PILL_HORIZONTAL_INSET_DP);
        pillLp.rightMargin = dp(PILL_HORIZONTAL_INSET_DP);
        addView(pillBackground, pillLp);

        // Label — centered inside the pill background.
        labelView = new TextView(context);
        labelView.setTextSize(TypedValue.COMPLEX_UNIT_SP, LABEL_SIZE_SP);
        labelView.setTypeface(Typeface.DEFAULT_BOLD);
        labelView.setTextColor(Color.WHITE);
        labelView.setGravity(Gravity.CENTER);
        labelView.setSingleLine(true);
        FrameLayout.LayoutParams labelLp = new FrameLayout.LayoutParams(
            LayoutParams.MATCH_PARENT,
            LayoutParams.MATCH_PARENT,
            Gravity.CENTER
        );
        // Pull the label in so it's vertically centered inside the
        // visible pill (not the outer cell) by using the same inset
        // as the pill background's top/bottom.
        labelLp.topMargin = dp(PILL_VERTICAL_INSET_DP);
        labelLp.bottomMargin = dp(PILL_VERTICAL_INSET_DP);
        addView(labelView, labelLp);

        // Match the main-row button height so the action button
        // sits in a 60dp cell just like its navStack siblings.
        setMinimumHeight(dp(NavbarButton.BUTTON_HEIGHT_DP));

        // Ripple feedback — same borderless style as other nav
        // buttons so press feedback is consistent across modes.
        TypedValue outValue = new TypedValue();
        context
            .getTheme()
            .resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, outValue, true);
        setForeground(androidx.core.content.ContextCompat.getDrawable(context, outValue.resourceId));
        setClickable(true);
        setFocusable(true);
    }

    public void bind(@NonNull NavbarState.Action action) {
        labelView.setText(action.label == null ? "" : action.label);
        setActionEnabled(action.enabled);
    }

    public void setActionEnabled(boolean enabled) {
        this.actionEnabled = enabled;
        // Wire the standard View enabled state so the ripple +
        // click-listener combine to gracefully ignore disabled
        // taps (click listeners on disabled views don't fire).
        setEnabled(enabled);
        pillBackground.setBackgroundResource(
            enabled
                ? R.drawable.navbar_action_enabled_bg
                : R.drawable.navbar_action_disabled_bg
        );
        labelView.setAlpha(enabled ? 1.0f : 0.7f);
    }

    public boolean isActionEnabled() {
        return actionEnabled;
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            getResources().getDisplayMetrics()
        );
    }
}
