package ee.forgr.capacitor_inappbrowser;

import android.graphics.RectF;

final class BreadMorphGeometry {
    static final float MAX_PROGRESS_VELOCITY = 8;
    static final float MISSING_CARD_SCALE = 0.9f;
    static final float CARD_ELEVATION_DP = 12;

    static final class Pose {
        float scale = 1;
        float translationX;
        float translationY;
        float cropHeight;
        float radius;
        float elevationDp;
        float alpha = 1;
    }

    private BreadMorphGeometry() {}

    static Pose pose(float p, BreadMorphCard card, float slotWidth, float slotHeight) {
        return pose(p, card, slotWidth, slotHeight, new Pose());
    }

    static Pose pose(float p, BreadMorphCard card, float slotWidth, float slotHeight, Pose out) {
        if (card == null) {
            out.scale = lerp(MISSING_CARD_SCALE, 1, p);
            out.translationX = (1 - out.scale) * slotWidth / 2;
            out.translationY = (1 - out.scale) * slotHeight / 2;
            out.cropHeight = slotHeight;
            out.radius = 0;
            out.elevationDp = 0;
            out.alpha = Math.max(0, Math.min(1, p));
            return out;
        }
        RectF rect = card.rect;
        float ratio = slotWidth / rect.width();
        out.scale = lerp(rect.width() / slotWidth, 1, p);
        out.translationX = lerp(rect.left, 0, p);
        out.translationY = lerp(rect.top, 0, p);
        out.cropHeight = lerp(rect.height() * ratio, slotHeight, p);
        // A spring overshoots past the slot; a negative radius or elevation is not a pose.
        out.radius = Math.max(0, lerp(card.cornerRadius * ratio, 0, p));
        out.elevationDp = Math.max(0, lerp(CARD_ELEVATION_DP, 0, p));
        out.alpha = 1;
        return out;
    }

    static float progressVelocity(float vx, float vy, RectF card, RectF slot) {
        double dx = slot.centerX() - card.centerX(), dy = slot.centerY() - card.centerY();
        double length = dx * dx + dy * dy;
        if (length < 1e-6) return 0;
        double velocity = (vx * dx + vy * dy) / length;
        return (float) Math.max(-MAX_PROGRESS_VELOCITY, Math.min(MAX_PROGRESS_VELOCITY, velocity));
    }

    static float rubberBand(float x, float length) {
        if (length <= 0) return 0;
        double magnitude = (1 - 1 / (0.55 * Math.abs(x) / length + 1)) * length;
        return (float) Math.copySign(magnitude, x);
    }

    static BreadMorphCard hostToWindow(float x, float y, float width, float height, float radius, float density,
                                       int statusBarPx, int windowX, int windowY) {
        float left = x * density - windowX, top = y * density + statusBarPx - windowY;
        return new BreadMorphCard(new RectF(left, top, left + width * density, top + height * density), radius * density);
    }

    private static float lerp(float from, float to, float p) { return from * (1 - p) + to * p; }
}
