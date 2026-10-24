package ee.forgr.capacitor_inappbrowser;

import android.graphics.RectF;

final class BreadMorphGeometry {
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
        return out;
    }

    static float progressVelocity(float vx, float vy, RectF card, RectF slot) {
        return 0;
    }

    static float rubberBand(float x, float length) {
        return 0;
    }

    static BreadMorphCard hostToWindow(float x, float y, float width, float height, float radius, float density,
                                       int statusBarPx, int windowX, int windowY) {
        return new BreadMorphCard(new RectF(), 0);
    }
}
