package ee.forgr.capacitor_inappbrowser.navbar;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import ee.forgr.capacitor_inappbrowser.R;

/**
 * Miden patch — Android port of iOS NavbarButton.
 *
 * Main-row button with a 22dp icon above a 10sp label. Pinned to a
 * fixed 60dp height so compact mode can't grow the container (mirrors
 * the iOS {@code NavbarButton.buttonHeight = 60} fix).
 *
 * Active state is shown via a rounded-pill background that fills the
 * entire button, matching iOS's {@code pillBackground} view. Inactive
 * state hides the pill and renders the icon + label in heading-gray.
 *
 * Compact mode (Phase 4) will toggle the label's visibility and grow
 * the icon from 22dp to 32dp. This class already has the constraint
 * hooks for that — {@link #setCompact(boolean)} — but the actual
 * width-flip animation happens at the parent level.
 */
public final class NavbarButton extends FrameLayout {

    /** Fixed button height in dp. Matches iOS NavbarButton.buttonHeight = 60. */
    public static final int BUTTON_HEIGHT_DP = 60;

    /** Default-mode icon size. */
    private static final int ICON_DEFAULT_DP = 22;
    /** Compact-mode icon size. */
    private static final int ICON_COMPACT_DP = 32;

    private final ImageView iconView;
    private final TextView labelView;

    private boolean active;
    private boolean compact;
    private @Nullable String itemId;

    public NavbarButton(@NonNull Context context) {
        super(context);

        // Active-state background is set directly on this FrameLayout
        // via setBackground() — NOT as a child View. Earlier I used a
        // child View with MATCH_PARENT x MATCH_PARENT, but a MATCH
        // child in a WRAP_CONTENT FrameLayout causes the measure pass
        // to inflate the parent to the ancestor's AT_MOST (screen
        // height), producing ~1900px-tall buttons. Using a background
        // drawable keeps the measurement clean: the drawable tracks
        // the button's final laid-out size without participating in
        // the measure loop.

        // Icon — 22dp top-anchored in default mode. Tint applied via
        // setImageTintList so the same drawable works for active +
        // inactive states without a second XML.
        iconView = new ImageView(context);
        iconView.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        iconView.setImageTintList(
            ColorStateList.valueOf(ContextCompat.getColor(context, R.color.navbar_inactive))
        );
        FrameLayout.LayoutParams iconLp = new FrameLayout.LayoutParams(
            dp(ICON_DEFAULT_DP),
            dp(ICON_DEFAULT_DP),
            Gravity.CENTER_HORIZONTAL | Gravity.TOP
        );
        iconLp.topMargin = dp(8);
        addView(iconView, iconLp);

        // Label — 10sp bold, uppercase, centered below the icon.
        // Matches iOS `text-[10px] font-semibold uppercase`.
        labelView = new TextView(context);
        labelView.setAllCaps(true);
        labelView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f);
        labelView.setTypeface(Typeface.DEFAULT_BOLD);
        labelView.setTextColor(ContextCompat.getColor(context, R.color.navbar_inactive));
        labelView.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams labelLp = new FrameLayout.LayoutParams(
            LayoutParams.MATCH_PARENT,
            LayoutParams.WRAP_CONTENT,
            Gravity.CENTER_HORIZONTAL | Gravity.BOTTOM
        );
        labelLp.bottomMargin = dp(8);
        addView(labelView, labelLp);

        // Fixed button height — the critical fix that lets compact
        // mode change layout without growing the toolbar.
        setMinimumHeight(dp(BUTTON_HEIGHT_DP));

        // Ripple feedback on press — applied as the FOREGROUND so it
        // composes over our background drawable. Uses borderless
        // ripple so it bleeds outside the pill outline on tap.
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
        // Resolve the icon drawable by name. The JS side sends the
        // iOS SF Symbol name (e.g. "house.fill"); we map that to our
        // local drawable resource names (nav_home, nav_activity,
        // etc). Unknown names fall back to a plain circle drawable
        // so layout doesn't break.
        int iconRes = resolveIconResource(item.iconDrawableName);
        if (iconRes != 0) {
            iconView.setImageResource(iconRes);
        }
        setActive(active);
    }

    public @Nullable String getItemId() {
        return itemId;
    }

    public void setActive(boolean active) {
        if (this.active == active) return;
        this.active = active;
        // Toggle the pill background drawable as the FrameLayout's
        // actual background so the measure pass isn't disturbed.
        setBackgroundResource(active ? R.drawable.navbar_button_active_bg : 0);
        int colorAttr = active ? R.color.navbar_active : R.color.navbar_inactive;
        int color = ContextCompat.getColor(getContext(), colorAttr);
        iconView.setImageTintList(ColorStateList.valueOf(color));
        labelView.setTextColor(color);
    }

    /**
     * Toggle compact mode. Default mode shows the icon + label;
     * compact mode hides the label and grows the icon. The parent
     * {@link NavbarView} handles the width morphing via spring
     * animation in Phase 4; this method only flips the internal
     * layout so the button is ready for the new constraints.
     */
    public void setCompact(boolean compact) {
        if (this.compact == compact) return;
        this.compact = compact;
        labelView.setVisibility(compact ? GONE : VISIBLE);
        FrameLayout.LayoutParams iconLp = (FrameLayout.LayoutParams) iconView.getLayoutParams();
        int targetSize = compact ? dp(ICON_COMPACT_DP) : dp(ICON_DEFAULT_DP);
        iconLp.width = targetSize;
        iconLp.height = targetSize;
        iconLp.gravity = compact
            ? (Gravity.CENTER_HORIZONTAL | Gravity.CENTER_VERTICAL)
            : (Gravity.CENTER_HORIZONTAL | Gravity.TOP);
        iconLp.topMargin = compact ? 0 : dp(8);
        iconView.setLayoutParams(iconLp);
    }

    /**
     * Map the JS-supplied SF Symbol name (or iconDrawableName) to a
     * local Android drawable resource id. Mirrors the iOS → Android
     * icon bridge lookup table from the plan.
     */
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
