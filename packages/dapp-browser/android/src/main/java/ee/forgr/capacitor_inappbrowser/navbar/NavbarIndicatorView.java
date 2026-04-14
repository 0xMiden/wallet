package ee.forgr.capacitor_inappbrowser.navbar;

import android.content.Context;
import android.graphics.Outline;
import android.view.View;
import android.view.ViewOutlineProvider;
import androidx.annotation.NonNull;

/**
 * Miden patch — shared sliding pill indicator used as the active
 * state marker for the whole navbar (both main row and secondary
 * row). Mirrors the iOS {@code NavbarIndicatorView} subclass — a
 * single view whose frame/color animates to whichever button is
 * currently active, giving the framer-motion `layoutId` behavior
 * the Chrome extension footer ships with.
 *
 * Self-rounding: keeps {@code cornerRadius = height / 2} on every
 * layout pass via an {@link ViewOutlineProvider}, so the pill
 * stays perfectly rounded even while the spring animator is
 * interpolating between the 60dp-tall main row and the 32dp-tall
 * secondary row during a cross-row morph.
 */
public final class NavbarIndicatorView extends View {

    public NavbarIndicatorView(@NonNull Context context) {
        super(context);
        // Dynamic outline provider — cornerRadius is recomputed from
        // the CURRENT bounds every time getOutline is called. Android
        // invalidates the outline whenever the view's size changes,
        // so the rounding stays perfect throughout the spring morph.
        setClipToOutline(true);
        setOutlineProvider(
            new ViewOutlineProvider() {
                @Override
                public void getOutline(View view, Outline outline) {
                    int w = view.getWidth();
                    int h = view.getHeight();
                    if (w <= 0 || h <= 0) {
                        outline.setEmpty();
                        return;
                    }
                    outline.setRoundRect(0, 0, w, h, h / 2.0f);
                }
            }
        );
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        // Nudge the outline provider to re-query with the new bounds.
        invalidateOutline();
    }
}
