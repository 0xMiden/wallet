package ee.forgr.capacitor_inappbrowser.navbar;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import ee.forgr.capacitor_inappbrowser.R;

/**
 * Miden patch — Android port of iOS NavbarSecondaryButton.
 *
 * Secondary-row button with an inline (horizontal) icon + label,
 * mirroring the compact "quick action" pill style used by iOS
 * Send / Receive / Settings.
 *
 * Key visual differences from {@link NavbarButton}:
 *   - Inline layout (icon at left, label to its right) instead of
 *     icon-over-label
 *   - 32dp fixed height (about half of the main-row 60dp)
 *   - Smaller icon (16dp) and label (12sp)
 *   - Active state uses a pale slate background — icon + label
 *     colors stay heading-gray in both states (matches iOS after
 *     the "revert active pill background" tweak)
 *
 * Extends LinearLayout so the horizontal icon+label arrangement is
 * one-liner: no FrameLayout gravity juggling needed.
 */
public final class NavbarSecondaryButton extends LinearLayout {

    /** Fixed button height in dp — matches iOS NavbarSecondaryButton. */
    public static final int BUTTON_HEIGHT_DP = 32;

    /** Icon size — smaller than the main row (22dp). */
    private static final int ICON_SIZE_DP = 16;

    /** Gap between icon and label. */
    private static final int ICON_LABEL_GAP_DP = 6;

    /** Horizontal padding inside the pill so icon+label don't touch the rounded edges. */
    private static final int PILL_PADDING_HORIZONTAL_DP = 12;

    private final ImageView iconView;
    private final TextView labelView;

    private boolean active;
    private @Nullable String itemId;

    public NavbarSecondaryButton(@NonNull Context context) {
        super(context);
        setOrientation(HORIZONTAL);
        setGravity(Gravity.CENTER);

        // Icon — 16dp square, vertically centered by the parent
        // LinearLayout's gravity.
        iconView = new ImageView(context);
        iconView.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        iconView.setImageTintList(
            ColorStateList.valueOf(ContextCompat.getColor(context, R.color.navbar_inactive))
        );
        LinearLayout.LayoutParams iconLp = new LinearLayout.LayoutParams(dp(ICON_SIZE_DP), dp(ICON_SIZE_DP));
        iconLp.rightMargin = dp(ICON_LABEL_GAP_DP);
        addView(iconView, iconLp);

        // Label — 12sp semibold, matching iOS
        // `label.font = .systemFont(ofSize: 12, weight: .semibold)`.
        labelView = new TextView(context);
        labelView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        labelView.setTypeface(Typeface.DEFAULT_BOLD);
        labelView.setTextColor(ContextCompat.getColor(context, R.color.navbar_inactive));
        labelView.setSingleLine(true);
        addView(
            labelView,
            new LinearLayout.LayoutParams(
                LayoutParams.WRAP_CONTENT,
                LayoutParams.WRAP_CONTENT
            )
        );

        // Fixed height so the secondary row has a deterministic size
        // during the grow/collapse animation. Horizontal padding
        // keeps the icon+label group from crowding the rounded
        // active pill background.
        setMinimumHeight(dp(BUTTON_HEIGHT_DP));
        setPadding(
            dp(PILL_PADDING_HORIZONTAL_DP),
            0,
            dp(PILL_PADDING_HORIZONTAL_DP),
            0
        );

        // Ripple feedback — same borderless style as main-row
        // buttons so press feedback is consistent across rows.
        TypedValue outValue = new TypedValue();
        context
            .getTheme()
            .resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, outValue, true);
        setForeground(ContextCompat.getDrawable(context, outValue.resourceId));
        setClickable(true);
        setFocusable(true);
    }

    public void bind(@NonNull NavbarState.Item item, boolean active) {
        this.itemId = item.id;
        labelView.setText(item.title == null ? "" : item.title);
        int iconRes = resolveIconResource(item.iconDrawableName);
        if (iconRes != 0) iconView.setImageResource(iconRes);
        setActive(active);
    }

    public @Nullable String getItemId() {
        return itemId;
    }

    public void setActive(boolean active) {
        if (this.active == active) return;
        this.active = active;
        // Icon + label color stays heading-gray in both states —
        // only the pale slate pill background fades in/out to
        // indicate which secondary pill is currently active.
        setBackgroundResource(active ? R.drawable.navbar_secondary_active_bg : 0);
    }

    /** Same icon map as NavbarButton — any SF Symbol name or internal id resolves here. */
    private int resolveIconResource(@Nullable String name) {
        if (name == null) return 0;
        switch (name) {
            case "house.fill":
            case "nav_home":
                return R.drawable.nav_home;
            case "chart.line.uptrend.xyaxis":
            case "chart.line":
            case "nav_activity":
                return R.drawable.nav_activity;
            case "globe":
            case "nav_browser":
                return R.drawable.nav_browser;
            case "arrow.up.right":
            case "nav_send":
                return R.drawable.nav_send;
            case "arrow.down.left":
            case "nav_receive":
                return R.drawable.nav_receive;
            case "gearshape.fill":
            case "gearshape":
            case "nav_settings":
                return R.drawable.nav_settings;
            default:
                return 0;
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
